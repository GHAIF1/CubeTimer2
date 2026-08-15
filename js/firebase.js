/*!
* CubeTimer — Online Accounts, Solves & Friends (Firebase)
*
* Online layer on top of the local timer. The stopwatch, local solves and
* local statistics in js/timer.js never depend on this file: if Firebase
* fails or is missing, the timer keeps working exactly as before.
*
* Accounts are shared across devices. A user creates an account and receives
* a Friend Code (the account id, e.g. "CUBE-1234") plus a 4-digit unlock key.
* To reach the same account from another device the user signs in with the
* Friend Code + unlock key; the key is verified server-side by Firestore
* rules when the new device registers itself.
*
* ---------------------------------------------------------------------------
* Firestore data structure (mirrored by firestore.rules):
*
*   accounts/{accountId}       Public profile + aggregate statistics. The
*                              document id IS the Friend Code. Fields:
*                              accountId, friendCode, ownerUid, username,
*                              usernameLower, personalBest (ms, null when
*                              empty), averageTime (ms, null when empty),
*                              totalSolves, totalTime (ms), createdAt,
*                              updatedAt. Readable by any signed-in user so
*                              friend codes can be looked up and the Friends
*                              Leaderboard can show friends' stats.
*
*   accounts/{accountId}/secret  The 4-digit unlock key. Never readable by
*                              clients — only the device-sign-in rule reads it
*                              (rules get()/exists() bypass read rules).
*                              Written exactly once at account creation.
*
*   accounts/{accountId}/devices/{uid}  Device authorisations. The document
*                              id is an anonymous-auth uid. A device "logs in"
*                              by creating its own entry and proving it knows
*                              the unlock key (the account owner is
*                              pre-authorised). Only the account's devices can
*                              read/write the account's solves and friends.
*
*   accounts/{accountId}/solves/{solveId}  One document per solve. The doc id
*                              is the SAME id as the local solve, which makes
*                              deletion a direct document delete. Fields:
*                              accountId, time (ms), date (ISO string).
*
*   accounts/{accountId}/friends/{friendAccountId}  One-way friend entries;
*                              the doc id is the friend's account id.
*
*   usernames/{name}           Uniqueness registry. The document id is the
*                              lowercased username, so two accounts can never
*                              claim the same name. Fields: accountId, name,
*                              displayName, createdAt.
*
* Authorization NEVER comes from the client - it comes from Firebase
* Authentication + Firestore Security Rules (firestore.rules).
* ---------------------------------------------------------------------------
*/

import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, signOut, deleteUser } from 'firebase/auth';
import {
    getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
    collection, getDocs, writeBatch, serverTimestamp
} from 'firebase/firestore';

// ---------------------------------------------------------------------------
// Firebase web app configuration
// (Firebase Console → Project settings → Your apps → Web app)
// ---------------------------------------------------------------------------

var firebaseConfig = {
    apiKey: 'AIzaSyAao4Q90VL6D4AktWrllHa9Gi4hUUODA9Y',
    authDomain: 'cubetimer-d7031.firebaseapp.com',
    projectId: 'cubetimer-d7031',
    storageBucket: 'cubetimer-d7031.firebasestorage.app',
    messagingSenderId: '150262671469',
    appId: '1:150262671469:web:244e10170d306cae777764'
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// localStorage keys (mirror the ones used in js/timer.js).
var SOLVES_KEY = 'cubeTimer.solves';
var SYNC_KEY = 'cubeTimer.onlineSync'; // { accountId, synced: [ids], pendingDeletes: [ids] }
var ACCOUNT_KEY = 'cubeTimer.account'; // { accountId, friendCode, unlockKey }

var app = null;
var auth = null;
var db = null;
var currentUid = null;      // Firebase UID of this device's anonymous session
var accountId = null;       // signed-in account id (== the friend code)
var profile = null;         // cached accounts/{accountId} document data
var friends = [];           // cached friend documents
var firebaseReady = false;  // SDK initialised
var authSettled = false;    // first onAuthStateChanged callback has fired

// Hooks called by js/timer.js whenever a solve is saved or deleted locally.
// They are a no-op while the user has no online account.
window.CubeTimer = window.CubeTimer || {};
window.CubeTimer.onSolveSaved = handleSolveSaved;
window.CubeTimer.onSolveDeleted = handleSolveDeleted;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function init() {
    try {
        app = initializeApp(firebaseConfig);
        auth = getAuth(app);
        db = getFirestore(app);
        firebaseReady = true;
    } catch (e) {
        // Firebase failed to load — online features stay off, timer works.
        firebaseReady = false;
        renderProfile();
        renderFriends();
        renderLeaderboard();
        return;
    }

    // Restores an existing anonymous session if there is one. No account is
    // ever created here — that only happens when the user clicks
    // "Create Account" (see createAccount).
    onAuthStateChanged(auth, handleAuthState);

    // When the connection comes back, restore the session (if needed) and
    // sync anything that is pending.
    window.addEventListener('online', function () {
        if (!currentUid) {
            return;
        }
        setProfileStatus('Back online — syncing solves…', 'ok');
        var restore = accountId ? Promise.resolve() : restoreSession();
        restore.then(function () {
            return syncPendingSolves();
        }).then(function () {
            renderAllOnline();
            setTimeout(function () {
                setProfileStatus('', '');
            }, 4000);
        });
    });
    window.addEventListener('offline', function () {
        if (accountId) {
            setProfileStatus('You are offline — solves stay local and sync when you are back.', '');
        }
    });

    renderProfile();
    renderFriends();
    renderLeaderboard();
}

function handleAuthState(user) {
    authSettled = true;
    if (user && user.uid) {
        currentUid = user.uid;
        restoreSession().then(function () {
            renderAllOnline();
        }).catch(function () {
            // Non-fatal — the UI stays in a safe state.
            renderAllOnline();
        });
    } else {
        currentUid = null;
        accountId = null;
        profile = null;
        friends = [];
        renderAllOnline();
    }
}

// ---------------------------------------------------------------------------
// Session (account link) storage & restore
// ---------------------------------------------------------------------------

function accountFromStorage() {
    try {
        var raw = localStorage.getItem(ACCOUNT_KEY);
        if (!raw) {
            return null;
        }
        var a = JSON.parse(raw);
        if (a && typeof a.accountId === 'string') {
            return a;
        }
        return null;
    } catch (e) {
        return null;
    }
}

function saveAccount(a) {
    try {
        if (a) {
            localStorage.setItem(ACCOUNT_KEY, JSON.stringify(a));
        } else {
            localStorage.removeItem(ACCOUNT_KEY);
        }
    } catch (e) {
        /* ignore — the stored link is best-effort */
    }
}

function clearAccountState() {
    accountId = null;
    profile = null;
    friends = [];
    saveAccount(null);
    resetSyncState();
}

// Restores the signed-in account for this device after a reload. The account
// must still exist AND this device's uid must still be in its device list
// (a logout elsewhere removes it).
function restoreSession() {
    var stored = accountFromStorage();
    if (!db || !currentUid || !stored) {
        return Promise.resolve(null);
    }
    return getDoc(doc(db, 'accounts', stored.accountId)).then(function (accSnap) {
        if (!accSnap.exists()) {
            clearAccountState();
            return null;
        }
        return getDoc(doc(db, 'accounts', stored.accountId, 'devices', currentUid)).then(function (devSnap) {
            if (!devSnap.exists()) {
                clearAccountState();
                return null;
            }
            accountId = stored.accountId;
            profile = accSnap.data();
            profile.unlockKey = stored.unlockKey || '';
            return loadFriends().then(function () {
                return syncPendingSolves();
            }).then(function () {
                renderLeaderboard();
                return profile;
            });
        });
    }).catch(function () {
        // Offline or transient — keep the stored link and retry on 'online'.
        return null;
    });
}

// ---------------------------------------------------------------------------
// Account creation
// ---------------------------------------------------------------------------

function validateUsername(name) {
    if (!name) {
        return 'Please choose a username.';
    }
    if (!/^[A-Za-z0-9_-]{2,16}$/.test(name)) {
        return 'Use 2-16 letters, numbers, dashes or underscores.';
    }
    return null;
}

function generateFriendCode() {
    return 'CUBE-' + (1000 + Math.floor(Math.random() * 9000));
}

function generateUnlockKey() {
    return String(1000 + Math.floor(Math.random() * 9000));
}

function isTransientError(err) {
    var code = err && err.code;
    if (!code) {
        return false;
    }
    // Friend-code collisions, already-taken usernames and network blips are
    // all retryable; permanent rule violations are not.
    return ['aborted', 'already-exists', 'permission-denied', 'unavailable',
        'deadline-exceeded', 'network-error', 'internal', 'resource-exhausted'
    ].indexOf(code) !== -1;
}

function createAccount() {
    if (!firebaseReady || !db) {
        setProfileStatus('Online features are unavailable right now — the timer keeps working.', 'error');
        return;
    }

    var input = document.getElementById('createUsername');
    var username = input ? input.value.trim() : '';
    var validation = validateUsername(username);
    if (validation) {
        setProfileStatus(validation, 'error');
        return;
    }

    setProfileBusy(true);
    setProfileStatus('Creating your account…', 'ok');
    var nameId = username.toLowerCase();
    var attempts = 0;
    var MAX_ATTEMPTS = 5;
    var theUser = null;

    var proceed = function (user) {
        theUser = user;
        currentUid = user.uid;
        var code = generateFriendCode();
        var key = generateUnlockKey();
        var accId = code; // the friend code IS the account id

        // 1) Username availability — the real guarantee is the document id
        //    itself (a second account can never create the same id).
        getDoc(doc(db, 'usernames', nameId)).then(function (snap) {
            if (snap.exists()) {
                throw { code: 'username-taken' };
            }
            // 2) Create the account + username registry in one atomic batch.
            var batch = writeBatch(db);
            batch.set(doc(db, 'accounts', accId), {
                accountId: accId,
                friendCode: code,
                ownerUid: currentUid,
                username: username,
                usernameLower: nameId,
                personalBest: null,
                averageTime: null,
                totalSolves: 0,
                totalTime: 0,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            batch.set(doc(db, 'usernames', nameId), {
                accountId: accId,
                name: nameId,
                displayName: username,
                createdAt: serverTimestamp()
            });
            return batch.commit();
        }).then(function () {
            // 3) Secret (its own commit so the device rule below can read it).
            return setDoc(doc(db, 'accounts', accId, 'secret'), { unlockKey: key });
        }).then(function () {
            // 4) This device's authorisation. The owner is pre-authorised by
            //    the rules (its uid matches the account's ownerUid).
            return setDoc(doc(db, 'accounts', accId, 'devices', currentUid), {
                unlockKey: key,
                addedAt: serverTimestamp()
            });
        }).then(function () {
            accountId = accId;
            profile = {
                accountId: accId,
                friendCode: code,
                unlockKey: key,
                username: username,
                usernameLower: nameId,
                personalBest: null,
                averageTime: null,
                totalSolves: 0,
                totalTime: 0
            };
            saveAccount({ accountId: accId, friendCode: code, unlockKey: key });
            resetSyncState(); // new account → sync every local solve to it
            renderProfile();
            renderFriends();
            renderLeaderboard();
            setProfileBusy(false);
            setProfileStatus('Account created — syncing your solves…', 'ok');
            return syncPendingSolves();
        }).then(function () {
            renderLeaderboard();
            setProfileStatus('Account created! Save your Friend Code and unlock key to sign in on other devices.', 'ok');
        }).catch(function (err) {
            setProfileBusy(false);
            if (err && err.code === 'username-taken') {
                setProfileStatus('That username is already taken. Try another.', 'error');
                return;
            }
            // A failed batch can mean another account just claimed this
            // username (or a friend-code collision) — re-check before retrying.
            getDoc(doc(db, 'usernames', nameId)).then(function (snap) {
                if (snap.exists()) {
                    setProfileStatus('That username is already taken. Try another.', 'error');
                    return;
                }
                if (attempts < MAX_ATTEMPTS && isTransientError(err)) {
                    // Most likely a friend-code collision — retry with a new code.
                    attempts += 1;
                    proceed(theUser);
                    return;
                }
                setProfileStatus('Could not create your account — check your connection.', 'error');
            }).catch(function () {
                setProfileStatus('Could not create your account — check your connection.', 'error');
            });
        });
    };

    if (auth.currentUser) {
        proceed(auth.currentUser);
        return;
    }
    // Anonymous sign-in happens only here — never automatically on page load.
    signInAnonymously(auth).then(function (credential) {
        proceed(credential.user);
    }).catch(function (err) {
        setProfileBusy(false);
        if (err && err.code === 'auth/operation-not-allowed') {
            setProfileStatus('Anonymous sign-in is not enabled in the Firebase Console.', 'error');
        } else if (err && err.code === 'auth/invalid-api-key') {
            setProfileStatus('Firebase config looks wrong — check the apiKey in js/firebase.js.', 'error');
        } else {
            setProfileStatus('Could not sign in — check your connection.', 'error');
        }
    });
}

// ---------------------------------------------------------------------------
// Login (sign in on another device)
// ---------------------------------------------------------------------------

function login() {
    if (!firebaseReady || !db) {
        setProfileStatus('Online features are unavailable right now — the timer keeps working.', 'error');
        return;
    }

    var codeInput = document.getElementById('loginFriendCode');
    var keyInput = document.getElementById('loginUnlockKey');
    var code = codeInput ? codeInput.value.trim().toUpperCase() : '';
    var key = keyInput ? keyInput.value.trim() : '';

    if (/^\d{4}$/.test(code)) {
        code = 'CUBE-' + code; // accept a bare "4821" too
    }
    if (!/^CUBE-\d{4}$/.test(code)) {
        setProfileStatus('Enter a friend code like CUBE-1234.', 'error');
        return;
    }
    if (!/^\d{4}$/.test(key)) {
        setProfileStatus('Enter your 4-digit unlock key.', 'error');
        return;
    }

    setProfileBusy(true);
    setProfileStatus('Signing in…', 'ok');

    var proceed = function (user) {
        currentUid = user.uid;
        var accId = code;
        var accountData = null;
        getDoc(doc(db, 'accounts', accId)).then(function (snap) {
            if (!snap.exists()) {
                throw { code: 'no-account' };
            }
            accountData = snap.data();
            // Register this device; the rules verify the unlock key against
            // the account secret. A wrong key surfaces as permission-denied.
            return setDoc(doc(db, 'accounts', accId, 'devices', currentUid), {
                unlockKey: key,
                addedAt: serverTimestamp()
            });
        }).then(function () {
            accountData.unlockKey = key;
            profile = accountData;
            accountId = accId;
            saveAccount({ accountId: accId, friendCode: accId, unlockKey: key });
            resetSyncState(); // re-sync this device's solves against the account
            renderProfile();
            renderFriends();
            renderLeaderboard();
            setProfileBusy(false);
            setProfileStatus('Signed in — syncing your solves…', 'ok');
            return loadFriends();
        }).then(function () {
            return syncPendingSolves();
        }).then(function () {
            renderAllOnline();
            setProfileStatus('Signed in!', 'ok');
        }).catch(function (err) {
            setProfileBusy(false);
            if (err && err.code === 'no-account') {
                setProfileStatus('No account has that friend code.', 'error');
            } else if (err && err.code === 'permission-denied') {
                setProfileStatus('Incorrect unlock key — check it and try again.', 'error');
            } else {
                setProfileStatus('Could not sign in — check your connection.', 'error');
            }
        });
    };

    if (auth.currentUser) {
        proceed(auth.currentUser);
        return;
    }
    signInAnonymously(auth).then(function (credential) {
        proceed(credential.user);
    }).catch(function (err) {
        setProfileBusy(false);
        if (err && err.code === 'auth/operation-not-allowed') {
            setProfileStatus('Anonymous sign-in is not enabled in the Firebase Console.', 'error');
        } else if (err && err.code === 'auth/invalid-api-key') {
            setProfileStatus('Firebase config looks wrong — check the apiKey in js/firebase.js.', 'error');
        } else {
            setProfileStatus('Could not sign in — check your connection.', 'error');
        }
    });
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

// Removes this device's authorisation and ends the anonymous session. Unlike
// the old anonymous-only model this is safe: the account still exists and can
// be reached again from any device with the Friend Code + unlock key.
function logout() {
    if (db && accountId && currentUid) {
        deleteDoc(doc(db, 'accounts', accountId, 'devices', currentUid)).catch(function () {
            /* best-effort — a stale device entry is harmless */
        });
    }
    clearAccountState();
    renderAllOnline();
    if (auth && auth.currentUser) {
        signOut(auth).catch(function () {
            /* best-effort */
        });
    }
}

// ---------------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------------

function addFriend() {
    if (!accountId || !profile) {
        setFriendsStatus('Log in or create an account first.', 'error');
        return;
    }
    if (!navigator.onLine) {
        setFriendsStatus('You are offline — try again when you are back online.', 'error');
        return;
    }

    var input = document.getElementById('onlineFriendCode');
    var code = input ? input.value.trim().toUpperCase() : '';
    if (/^\d{4}$/.test(code)) {
        code = 'CUBE-' + code; // accept a bare "4821" too
    }
    if (!/^CUBE-\d{4}$/.test(code)) {
        setFriendsStatus('Enter a friend code like CUBE-1234.', 'error');
        return;
    }
    if (code === profile.friendCode) {
        setFriendsStatus('That is your own friend code.', 'error');
        return;
    }

    setFriendsBusy(true);
    var friendAccountId = code;
    getDoc(doc(db, 'accounts', friendAccountId)).then(function (snap) {
        if (!snap.exists()) {
            throw { code: 'code-not-found' };
        }
        return getDoc(doc(db, 'accounts', accountId, 'friends', friendAccountId));
    }).then(function (existing) {
        if (existing.exists()) {
            throw { code: 'already-friends' };
        }
        return setDoc(doc(db, 'accounts', accountId, 'friends', friendAccountId), {
            addedAt: serverTimestamp()
        });
    }).then(function () {
        setFriendsBusy(false);
        if (input) {
            input.value = '';
        }
        setFriendsStatus('Friend added!', 'ok');
        return loadFriends();
    }).then(function () {
        renderFriends();
        renderLeaderboard();
    }).catch(function (err) {
        setFriendsBusy(false);
        var messages = {
            'code-not-found': 'No account has that friend code.',
            'already-friends': 'You are already friends with that code.'
        };
        setFriendsStatus(
            messages[err && err.code] || 'Could not add friend — check your connection.',
            'error'
        );
    });
}

function removeFriend(friendAccountId) {
    if (!db || !accountId) {
        return;
    }
    // Deletes by the friend ENTRY document id (== the friend's account id) so
    // a mismatch could never leave a hidden entry behind.
    deleteDoc(doc(db, 'accounts', accountId, 'friends', friendAccountId)).then(function () {
        return loadFriends();
    }).then(function () {
        renderFriends();
        renderLeaderboard();
        setFriendsStatus('Friend removed.', 'ok');
    }).catch(function () {
        setFriendsStatus('Could not remove friend — check your connection.', 'error');
    });
}

function toggleAddFriend() {
    var input = document.getElementById('onlineFriendCode');
    if (input) {
        input.focus();
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function loadFriends() {
    if (!db || !accountId) {
        friends = [];
        return Promise.resolve(friends);
    }
    return getDocs(collection(db, 'accounts', accountId, 'friends')).then(function (snap) {
        return Promise.all(snap.docs.map(function (d) {
            return getDoc(doc(db, 'accounts', d.id)).then(function (s) {
                return { entryId: d.id, doc: s.exists() ? s.data() : null, gone: !s.exists() };
            }).catch(function () {
                // Transient read failure (offline etc.) — keep the entry, just
                // do not show it this time.
                return { entryId: d.id, doc: null, gone: false };
            });
        }));
    }).then(function (results) {
        friends = [];
        var cleanups = [];
        results.forEach(function (r) {
            if (r.doc) {
                // Keep the entry document id alongside the friend's profile,
                // so removing a friend always targets the real entry.
                r.doc.id = r.entryId;
                r.doc.accountId = r.entryId;
                friends.push(r.doc);
            } else if (r.gone) {
                // The friend's account no longer exists — remove the stale
                // entry so it can never linger invisibly and block re-adding.
                cleanups.push(deleteDoc(doc(db, 'accounts', accountId, 'friends', r.entryId)).catch(function () {
                    /* best-effort cleanup — retried on the next load */
                }));
            }
        });
        return Promise.all(cleanups).then(function () {
            return friends;
        });
    }).catch(function () {
        friends = [];
        return friends;
    });
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

function copyFriendCode() {
    if (!profile || !profile.friendCode) {
        return;
    }
    var text = profile.friendCode;
    var done = function () {
        setProfileStatus('Friend code copied!', 'ok');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
            legacyCopy(text, done);
        });
    } else {
        legacyCopy(text, done);
    }
}

function copyUnlockKey() {
    if (!profile || !profile.unlockKey) {
        return;
    }
    var text = profile.unlockKey;
    var done = function () {
        setProfileStatus('Unlock key copied!', 'ok');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
            legacyCopy(text, done);
        });
    } else {
        legacyCopy(text, done);
    }
}

function legacyCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
        done();
    } catch (e) {
        setProfileStatus('Could not copy — copy it manually.', 'error');
    }
    document.body.removeChild(ta);
}

// ---------------------------------------------------------------------------
// Account deletion
// ---------------------------------------------------------------------------

// Two-step inline confirmation: the first click arms the button, the second
// click performs the deletion (it resets after a few seconds if not clicked).
var deleteArmed = false;
var deleteArmedTimer = null;

function resetDeleteArmed() {
    deleteArmed = false;
    if (deleteArmedTimer) {
        clearTimeout(deleteArmedTimer);
        deleteArmedTimer = null;
    }
}

function handleDeleteClick(btn) {
    if (!deleteArmed) {
        deleteArmed = true;
        btn.textContent = 'Click again to confirm';
        btn.classList.add('danger-armed');
        deleteArmedTimer = setTimeout(function () {
            resetDeleteArmed();
            renderProfile(); // re-render → button back to normal
        }, 5000);
        return;
    }
    resetDeleteArmed();
    deleteAccount();
}

// Deletes the online account: solves, friends, devices, secret, profile and
// username registry, then the Firebase anonymous account itself. Local solves
// on this device are intentionally kept.
function deleteAccount() {
    if (!db || !accountId || !profile) {
        setProfileStatus('Log in or create an account first.', 'error');
        return;
    }
    if (!navigator.onLine) {
        setProfileStatus('You are offline — try again when you are back online.', 'error');
        return;
    }

    var accId = accountId;
    var nameId = profile.usernameLower || (profile.username || '').toLowerCase();
    setProfileStatus('Deleting your account…', 'ok');
    setDeleteBusy(true);

    var solveIds = [];
    var friendIds = [];
    var deviceIds = [];

    getDocs(collection(db, 'accounts', accId, 'solves')).then(function (snap) {
        solveIds = snap.docs.map(function (d) { return d.id; });
        return getDocs(collection(db, 'accounts', accId, 'friends'));
    }).then(function (snap) {
        friendIds = snap.docs.map(function (d) { return d.id; });
        return getDocs(collection(db, 'accounts', accId, 'devices'));
    }).then(function (snap) {
        deviceIds = snap.docs.map(function (d) { return d.id; });
        return deleteDocsInChunks(accId, 'solves', solveIds);
    }).then(function () {
        return deleteDocsInChunks(accId, 'friends', friendIds);
    }).then(function () {
        // Remove other devices first, keeping this one so its own
        // authorisation stays valid while the remaining docs are deleted.
        var selfId = currentUid;
        var others = deviceIds.filter(function (id) { return id !== selfId; });
        return deleteDocsInChunks(accId, 'devices', others);
    }).then(function () {
        // Account + secret + username, while this device is still authorised.
        var batch = writeBatch(db);
        batch.delete(doc(db, 'accounts', accId, 'secret'));
        if (nameId) {
            batch.delete(doc(db, 'usernames', nameId));
        }
        batch.delete(doc(db, 'accounts', accId));
        return batch.commit();
    }).then(function () {
        // Finally remove this device's own entry (no longer needs isDevice —
        // the self-delete clause in the rules covers it).
        return deleteDoc(doc(db, 'accounts', accId, 'devices', currentUid)).catch(function () {
            /* best-effort — an orphaned device entry is harmless */
        });
    }).then(function () {
        // The online data is gone — reset local state and the UI first, so a
        // failure of the final step never leaves a stale account on screen.
        clearAccountState();
        setDeleteBusy(false);
        renderAllOnline();

        // Remove the anonymous authentication account itself.
        if (!auth.currentUser) {
            setProfileStatus('Account deleted — your local solves stay on this device.', 'ok');
            return;
        }
        deleteUser(auth.currentUser).then(function () {
            setProfileStatus('Account deleted — your local solves stay on this device.', 'ok');
        }).catch(function () {
            setProfileStatus('Account deleted.', 'ok');
        });
    }).catch(function (err) {
        setDeleteBusy(false);
        if (err && err.code === 'permission-denied') {
            setProfileStatus('Could not delete — publish the updated firestore.rules in the Firebase console, then try again.', 'error');
        } else {
            setProfileStatus('Could not delete your account — check your connection.', 'error');
        }
    });
}

// Deletes documents in chunks of 400 (Firestore batches cap at 500 writes) so
// account deletion also works for accounts with many solves/friends/devices.
function deleteDocsInChunks(accountId, subcollection, ids) {
    var CHUNK = 400;
    var chunks = [];
    for (var i = 0; i < ids.length; i += CHUNK) {
        chunks.push(ids.slice(i, i + CHUNK));
    }
    return chunks.reduce(function (chain, chunkIds) {
        return chain.then(function () {
            return Promise.all(chunkIds.map(function (id) {
                return deleteDoc(doc(db, 'accounts', accountId, subcollection, id));
            }));
        });
    }, Promise.resolve());
}

// ---------------------------------------------------------------------------
// Solve synchronisation
// ---------------------------------------------------------------------------

function loadLocalSolves() {
    try {
        var raw = localStorage.getItem(SOLVES_KEY);
        if (!raw) {
            return [];
        }
        var arr = JSON.parse(raw);
        if (!Array.isArray(arr)) {
            return [];
        }
        return arr.filter(function (s) {
            return s && typeof s.time === 'number' && isFinite(s.time) && s.time >= 0 &&
                typeof s.date === 'string' && typeof s.id === 'string';
        });
    } catch (e) {
        return [];
    }
}

function saveLocalSolves(arr) {
    try {
        localStorage.setItem(SOLVES_KEY, JSON.stringify(arr));
    } catch (e) {
        /* storage unavailable — solves stay in memory only */
    }
}

function computeStats(solves) {
    if (!solves.length) {
        return { personalBest: null, averageTime: null, totalSolves: 0, totalTime: 0 };
    }
    var total = solves.reduce(function (a, b) {
        return a + b.time;
    }, 0);
    return {
        personalBest: Math.min.apply(null, solves.map(function (s) {
            return s.time;
        })),
        averageTime: total / solves.length,
        totalSolves: solves.length,
        totalTime: total
    };
}

function applyStats(target, stats) {
    target.personalBest = stats.personalBest;
    target.averageTime = stats.averageTime;
    target.totalSolves = stats.totalSolves;
    target.totalTime = stats.totalTime;
}

function loadSyncState() {
    try {
        var raw = localStorage.getItem(SYNC_KEY);
        if (!raw) {
            return { accountId: null, synced: [], pendingDeletes: [] };
        }
        var st = JSON.parse(raw);
        return {
            accountId: st.accountId || st.uid || null,
            synced: Array.isArray(st.synced) ? st.synced : [],
            pendingDeletes: Array.isArray(st.pendingDeletes) ? st.pendingDeletes : []
        };
    } catch (e) {
        return { accountId: null, synced: [], pendingDeletes: [] };
    }
}

function saveSyncState(state) {
    try {
        localStorage.setItem(SYNC_KEY, JSON.stringify(state));
    } catch (e) {
        /* ignore — sync bookkeeping is best-effort */
    }
}

function resetSyncState() {
    saveSyncState({ accountId: accountId, synced: [], pendingDeletes: [] });
}

function chunk(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}

// Writes the aggregate statistics into accounts/{accountId} from the local
// solve list. One cheap document write per sync — no reads required.
function pushStats() {
    if (!db || !accountId || !navigator.onLine) {
        return Promise.resolve(false);
    }
    var stats = computeStats(loadLocalSolves());
    return updateDoc(doc(db, 'accounts', accountId), {
        personalBest: stats.personalBest,
        averageTime: stats.averageTime,
        totalSolves: stats.totalSolves,
        totalTime: stats.totalTime,
        updatedAt: serverTimestamp()
    }).then(function () {
        if (profile) {
            applyStats(profile, stats);
        }
        return true;
    }).catch(function () {
        return false;
    });
}

// Two-way synchronisation: pending deletions first, then download solves this
// device is missing (saves made on other devices), then upload local solves
// the account does not have yet, then the aggregate statistics. Called on
// login, on the 'online' event and after account changes. Never throws.
function syncPendingSolves() {
    if (!db || !accountId || !navigator.onLine) {
        return Promise.resolve(false);
    }
    var state = loadSyncState();
    if (state.accountId !== accountId) {
        state = { accountId: accountId, synced: [], pendingDeletes: [] };
    }
    var local = loadLocalSolves();

    // 1) Push any pending deletions.
    var deletes = state.pendingDeletes.slice().map(function (id) {
        return deleteDoc(doc(db, 'accounts', accountId, 'solves', id)).then(function () {
            state.synced = state.synced.filter(function (x) {
                return x !== id;
            });
            state.pendingDeletes = state.pendingDeletes.filter(function (x) {
                return x !== id;
            });
        }).catch(function () {
            /* still offline — stays pending for the next attempt */
        });
    });

    return Promise.all(deletes).then(function () {
        // 2) List the account's solves.
        return getDocs(collection(db, 'accounts', accountId, 'solves')).then(function (snap) {
            var remote = {};
            snap.docs.forEach(function (d) {
                var data = d.data();
                remote[d.id] = { id: d.id, time: data.time, date: data.date };
            });
            return remote;
        }).catch(function () {
            return null; // can't list right now — skip the pull, still try the push
        });
    }).then(function (remote) {
        // 3) Merge local and remote.
        var localById = {};
        local.forEach(function (s) {
            localById[s.id] = s;
        });

        var changed = false;
        var toUpload = [];

        if (remote) {
            var remoteIds = Object.keys(remote);
            // Download solves made on other devices.
            remoteIds.forEach(function (id) {
                if (!localById[id]) {
                    local.push(remote[id]);
                    localById[id] = remote[id];
                    if (state.synced.indexOf(id) === -1) {
                        state.synced.push(id); // it's remote — treat as synced
                    }
                    changed = true;
                }
            });
            // A solve that was synced before but is now missing remotely was
            // deleted on another device — remove it locally too.
            state.synced.forEach(function (id) {
                if (remoteIds.indexOf(id) === -1 && localById[id] &&
                        state.pendingDeletes.indexOf(id) === -1) {
                    local = local.filter(function (s) {
                        return s.id !== id;
                    });
                    delete localById[id];
                    changed = true;
                }
            });
        }

        // Upload local solves the account does not have yet.
        local.forEach(function (s) {
            var isRemote = remote && remote[s.id];
            var isSynced = state.synced.indexOf(s.id) !== -1;
            if (!isRemote && !isSynced && state.pendingDeletes.indexOf(s.id) === -1) {
                toUpload.push(s);
            }
        });

        if (changed) {
            saveLocalSolves(local);
        }

        // Upload in small chunks so a large backlog stays polite.
        return chunk(toUpload, 20).reduce(function (chain, batchSolves) {
            return chain.then(function () {
                return Promise.all(batchSolves.map(function (s) {
                    return setDoc(doc(db, 'accounts', accountId, 'solves', s.id), {
                        accountId: accountId,
                        time: s.time,
                        date: s.date
                    }).then(function () {
                        state.synced.push(s.id);
                    }).catch(function () {
                        /* offline — retried on the next sync */
                    });
                }));
            });
        }, Promise.resolve());
    }).then(function () {
        saveSyncState(state);
        // Re-read storage into the timer UI so downloaded solves show up.
        if (window.CubeTimer && typeof window.CubeTimer.reload === 'function') {
            window.CubeTimer.reload();
        }
        return pushStats();
    });
}

// Called by js/timer.js right after a solve is saved locally.
function handleSolveSaved(solve) {
    if (!db || !accountId || !solve) {
        return;
    }
    if (profile) {
        applyStats(profile, computeStats(loadLocalSolves()));
        renderLeaderboard();
    }
    if (!navigator.onLine) {
        return; // picked up later by syncPendingSolves
    }
    var state = loadSyncState();
    if (state.accountId !== accountId) {
        state = { accountId: accountId, synced: [], pendingDeletes: [] };
    }
    if (state.synced.indexOf(solve.id) !== -1) {
        return;
    }
    setDoc(doc(db, 'accounts', accountId, 'solves', solve.id), {
        accountId: accountId,
        time: solve.time,
        date: solve.date
    }).then(function () {
        state.synced.push(solve.id);
        saveSyncState(state);
        return pushStats();
    }).then(function () {
        renderLeaderboard();
    }).catch(function () {
        /* offline or denied — syncPendingSolves retries later */
    });
}

// Called by js/timer.js right after a solve is deleted locally.
function handleSolveDeleted(id) {
    if (!db || !accountId || !id) {
        return;
    }
    if (profile) {
        applyStats(profile, computeStats(loadLocalSolves()));
    }
    var state = loadSyncState();
    if (state.accountId !== accountId) {
        state = { accountId: accountId, synced: [], pendingDeletes: [] };
    }
    var wasSynced = state.synced.indexOf(id) !== -1;
    if (wasSynced) {
        state.synced = state.synced.filter(function (x) {
            return x !== id;
        });
        state.pendingDeletes.push(id);
        saveSyncState(state);
        if (navigator.onLine) {
            deleteDoc(doc(db, 'accounts', accountId, 'solves', id)).then(function () {
                state.pendingDeletes = state.pendingDeletes.filter(function (x) {
                    return x !== id;
                });
                saveSyncState(state);
                return pushStats();
            }).then(function () {
                renderLeaderboard();
            }).catch(function () {
                /* retried on the next sync */
            });
        }
    }
    renderLeaderboard();
}

// ---------------------------------------------------------------------------
// Rendering (all text is inserted via textContent — friend-supplied strings
// are never treated as HTML)
// ---------------------------------------------------------------------------

function renderAllOnline() {
    renderProfile();
    renderFriends();
    renderLeaderboard();
}

function renderProfile() {
    var box = document.getElementById('onlineProfile');
    if (!box) {
        return;
    }
    resetDeleteArmed(); // any re-render cancels a pending delete confirmation
    box.textContent = '';

    if (!firebaseReady) {
        box.appendChild(emptyNote('Online features are unavailable right now — the timer keeps working.'));
        return;
    }
    if (!authSettled) {
        box.appendChild(emptyNote('Loading online profile…'));
        return;
    }
    if (!accountId || !profile) {
        renderAuthBox(box);
        return;
    }

    // Signed in with an account.
    var user = makeEl('div', 'online-user');

    var name = makeEl('div', 'online-user-name', profile.username);

    var codeRow = makeEl('div', 'online-code-row');
    codeRow.appendChild(makeEl('span', 'online-code-label', 'Friend Code: '));
    codeRow.appendChild(makeEl('span', 'online-code', profile.friendCode));

    var keyRow = makeEl('div', 'online-code-row');
    keyRow.appendChild(makeEl('span', 'online-code-label', 'Unlock Key: '));
    keyRow.appendChild(makeEl('span', 'online-code', profile.unlockKey || '—'));

    user.appendChild(name);
    user.appendChild(codeRow);
    user.appendChild(keyRow);
    box.appendChild(user);

    var statsLine = makeEl('div', 'online-user-stats',
        'Best ' + formatTime(profile.personalBest) +
        ' · Avg ' + formatTime(profile.averageTime) +
        ' · ' + (profile.totalSolves || 0) + ' solves' +
        ' · ' + formatDuration(profile.totalTime || 0));
    box.appendChild(statsLine);

    var actions = makeEl('div', 'online-actions');
    actions.appendChild(button('online-btn', 'Copy Code', copyFriendCode));
    actions.appendChild(button('online-btn', 'Copy Key', copyUnlockKey));
    actions.appendChild(button('online-btn', 'Add Friend', toggleAddFriend));
    actions.appendChild(button('online-btn ghost', 'Log Out', logout));
    box.appendChild(actions);

    var danger = makeEl('div', 'online-danger-zone');
    var delBtn = button('online-btn danger', 'Delete Account', function () {
        handleDeleteClick(delBtn);
    });
    danger.appendChild(delBtn);
    danger.appendChild(makeEl('p', 'panel-footnote',
        'Deletes your account, friends and online solves. Your local solves on this device stay.'));
    box.appendChild(danger);
    box.appendChild(statusEl('onlineProfileStatus'));
}

// The signed-out view: a toggle between "Create Account" and "Log In".
function renderAuthBox(box) {
    box.appendChild(makeEl('p', 'online-intro',
        'Save your solves online and reach them from any device. Create an account to get a Friend Code and unlock key — or log in if you already have one.'));

    var tabs = makeEl('div', 'online-tabs');
    tabs.appendChild(authTab('Create Account', 'create'));
    tabs.appendChild(authTab('Log In', 'login'));
    box.appendChild(tabs);

    // Create Account form.
    var createForm = makeEl('div', 'online-form auth-form create');
    var username = makeInput('createUsername', 'Username', 16);
    username.addEventListener('keydown', enterHandler(createAccount));
    var createBtn = makeEl('button', 'online-btn primary');
    createBtn.type = 'button';
    createBtn.id = 'createBtn';
    createBtn.textContent = 'Create Account';
    createBtn.addEventListener('click', createAccount);
    createForm.appendChild(username);
    createForm.appendChild(createBtn);
    box.appendChild(createForm);

    // Log In form.
    var loginForm = makeEl('div', 'online-form auth-form login');
    var codeInput = makeInput('loginFriendCode', 'Friend Code (CUBE-1234)', 10);
    var keyInput = makeInput('loginUnlockKey', '4-digit unlock key', 4);
    keyInput.inputMode = 'numeric';
    codeInput.addEventListener('keydown', enterHandler(login));
    keyInput.addEventListener('keydown', enterHandler(login));
    var loginBtn = makeEl('button', 'online-btn');
    loginBtn.type = 'button';
    loginBtn.id = 'loginBtn';
    loginBtn.textContent = 'Log In';
    loginBtn.addEventListener('click', login);
    loginForm.appendChild(codeInput);
    loginForm.appendChild(keyInput);
    loginForm.appendChild(loginBtn);
    box.appendChild(loginForm);

    box.appendChild(statusEl('onlineProfileStatus'));
    box.appendChild(footnote(
        'Anonymous account — no email or password needed. Keep your unlock key safe: anyone with your Friend Code and key can open your account.'));

    syncAuthMode();
}

function renderFriends() {
    var box = document.getElementById('onlineFriends');
    if (!box) {
        return;
    }
    box.textContent = '';

    if (!firebaseReady) {
        box.appendChild(emptyNote('Online features are unavailable right now.'));
        return;
    }
    if (!authSettled) {
        box.appendChild(emptyNote('Loading…'));
        return;
    }
    if (!accountId || !profile) {
        box.appendChild(emptyNote('Log in or create an account to add friends.'));
        return;
    }

    var form = makeEl('div', 'online-form');
    var input = makeInput('onlineFriendCode', 'CUBE-1234', 10);
    input.addEventListener('keydown', enterHandler(addFriend));
    var addBtn = makeEl('button', 'online-btn');
    addBtn.type = 'button';
    addBtn.id = 'onlineAddBtn';
    addBtn.textContent = 'Add';
    addBtn.addEventListener('click', addFriend);
    form.appendChild(input);
    form.appendChild(addBtn);
    box.appendChild(form);
    box.appendChild(statusEl('onlineFriendsStatus'));

    if (!friends.length) {
        box.appendChild(emptyNote('No friends yet — share your Friend Code so others can add you.'));
        return;
    }

    var ul = makeEl('ul', 'online-friends');
    friends.forEach(function (f) {
        var li = makeEl('li', 'online-friend');

        var name = makeEl('span', 'online-friend-name', f.username || 'Unknown');

        var stats = makeEl('span', 'online-friend-stats',
            'Best ' + formatTime(f.personalBest) +
            ' · Avg ' + formatTime(f.averageTime) +
            ' · ' + (f.totalSolves || 0) + ' solves');

        var rm = makeEl('button', 'solve-delete');
        rm.type = 'button';
        rm.setAttribute('aria-label', 'Remove ' + (f.username || 'friend'));
        var icon = makeEl('i', 'fas fa-trash-alt');
        rm.appendChild(icon);
        rm.addEventListener('click', function () {
            removeFriend(f.accountId);
        });

        li.appendChild(name);
        li.appendChild(stats);
        li.appendChild(rm);
        ul.appendChild(li);
    });
    box.appendChild(ul);
}

function renderLeaderboard() {
    var box = document.getElementById('onlineLeaderboard');
    if (!box) {
        return;
    }
    box.textContent = '';

    if (!firebaseReady) {
        box.appendChild(emptyNote('Online features are unavailable right now.'));
        return;
    }
    if (!authSettled) {
        box.appendChild(emptyNote('Loading…'));
        return;
    }
    if (!accountId || !profile) {
        box.appendChild(emptyNote('Log in or create an account to compete with friends.'));
        return;
    }

    var rows = [{ // the current user always takes part
        accountId: accountId,
        username: profile.username,
        personalBest: profile.personalBest,
        averageTime: profile.averageTime,
        totalSolves: profile.totalSolves,
        you: true
    }];
    friends.forEach(function (f) {
        rows.push({
            accountId: f.accountId,
            username: f.username,
            personalBest: f.personalBest,
            averageTime: f.averageTime,
            totalSolves: f.totalSolves,
            you: false
        });
    });

    // Fastest personal best first; users without solves go to the end.
    rows.sort(function (a, b) {
        var ab = a.personalBest == null ? Infinity : a.personalBest;
        var bb = b.personalBest == null ? Infinity : b.personalBest;
        if (ab !== bb) {
            return ab - bb;
        }
        return (a.username || '').localeCompare(b.username || '');
    });

    var ol = makeEl('ol', 'online-leaderboard');
    rows.forEach(function (r, i) {
        var li = makeEl('li', 'online-lb-row' + (r.you ? ' you' : ''));

        var rank = makeEl('span', 'rank rank-' + (i + 1), String(i + 1));

        var nameWrap = makeEl('span', 'online-lb-name', r.username || 'Unknown');
        if (r.you) {
            var tag = makeEl('span', 'you-tag', 'you');
            nameWrap.appendChild(tag);
        }

        var best = makeEl('span', 'online-lb-meta online-lb-best', formatTime(r.personalBest));
        var avg = makeEl('span', 'online-lb-meta online-lb-avg', formatTime(r.averageTime));
        var count = makeEl('span', 'online-lb-meta online-lb-count', (r.totalSolves || 0) + ' solves');

        li.appendChild(rank);
        li.appendChild(nameWrap);
        li.appendChild(best);
        li.appendChild(avg);
        li.appendChild(count);
        ol.appendChild(li);
    });
    box.appendChild(ol);
}

// ---------------------------------------------------------------------------
// Small DOM / formatting helpers
// ---------------------------------------------------------------------------

function emptyNote(text) {
    var p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = text;
    return p;
}

function footnote(text) {
    var p = document.createElement('p');
    p.className = 'panel-footnote';
    p.textContent = text;
    return p;
}

function statusEl(id) {
    var p = document.createElement('p');
    p.id = id;
    p.className = 'online-status';
    p.setAttribute('role', 'status');
    return p;
}

function button(cls, text, handler) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', handler);
    return b;
}

function makeEl(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) {
        e.className = cls;
    }
    if (text != null) {
        e.textContent = text;
    }
    return e;
}

function makeInput(id, placeholder, maxLength) {
    var input = makeEl('input', 'online-input');
    input.id = id;
    input.type = 'text';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (maxLength) {
        input.maxLength = maxLength;
    }
    return input;
}

function enterHandler(fn) {
    return function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            fn();
        }
    };
}

// The signed-out view toggles between the Create Account and Log In forms.
var AUTH_MODE = 'create';

function authTab(label, mode) {
    var b = makeEl('button', 'online-tab');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('data-mode', mode);
    b.addEventListener('click', function () {
        AUTH_MODE = mode === 'login' ? 'login' : 'create';
        syncAuthMode();
    });
    return b;
}

function syncAuthMode() {
    var tabs = document.querySelectorAll('#onlineProfile .online-tab');
    [].forEach.call(tabs, function (t) {
        t.classList.toggle('active', t.getAttribute('data-mode') === AUTH_MODE);
    });
    var createForm = document.querySelector('#onlineProfile .auth-form.create');
    var loginForm = document.querySelector('#onlineProfile .auth-form.login');
    if (createForm) {
        createForm.style.display = AUTH_MODE === 'create' ? '' : 'none';
    }
    if (loginForm) {
        loginForm.style.display = AUTH_MODE === 'login' ? '' : 'none';
    }
}

function setStatus(id, message, kind) {
    var el = document.getElementById(id);
    if (!el) {
        return;
    }
    el.textContent = message || '';
    el.className = 'online-status' + (kind ? ' ' + kind : '');
}

function setProfileStatus(message, kind) {
    setStatus('onlineProfileStatus', message, kind);
}

function setFriendsStatus(message, kind) {
    setStatus('onlineFriendsStatus', message, kind);
}

function setProfileBusy(busy) {
    var create = document.getElementById('createBtn');
    if (create) {
        create.disabled = busy;
        create.textContent = busy ? 'Creating…' : 'Create Account';
    }
    var login = document.getElementById('loginBtn');
    if (login) {
        login.disabled = busy;
        login.textContent = busy ? 'Signing in…' : 'Log In';
    }
}

function setFriendsBusy(busy) {
    var btn = document.getElementById('onlineAddBtn');
    if (btn) {
        btn.disabled = busy;
        btn.textContent = busy ? 'Adding…' : 'Add';
    }
}

function setDeleteBusy(busy) {
    var btn = document.querySelector('.online-btn.danger');
    if (btn) {
        btn.disabled = busy;
        btn.textContent = busy ? 'Deleting…' : 'Delete Account';
        btn.classList.remove('danger-armed');
    }
}

function formatTime(ms) {
    if (ms == null || isNaN(ms)) {
        return '—';
    }
    var totalSec = ms / 1000;
    if (ms < 60000) {
        return totalSec.toFixed(2) + 's';
    }
    var m = Math.floor(totalSec / 60);
    return m + 'm ' + (totalSec - m * 60).toFixed(2) + 's';
}

function formatDuration(ms) {
    var sec = Math.round(ms / 1000);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (h > 0) {
        return h + 'h ' + m + 'm';
    }
    if (m > 0) {
        return m + 'm ' + String(s).padStart(2, '0') + 's';
    }
    return s + 's';
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

init();
