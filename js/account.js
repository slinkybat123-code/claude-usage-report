// Delete my account: everything in the database, then the sign-in itself.
import { deleteUser, reauthenticateWithPopup, GoogleAuthProvider } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import { db, doc, collection, query, where, getDocs, writeBatch, deleteDoc, emailOf } from './cloud.js';
import { deleteAccountData } from './account-data.js';

// Firebase only deletes a sign-in that is a few minutes old; older ones must sign in again first.
const RECENT = 4 * 60 * 1000;
const fresh = (user) => Date.now() - Date.parse(user.metadata.lastSignInTime || 0) < RECENT;
const signInAgain = (user) => reauthenticateWithPopup(user, new GoogleAuthProvider());

/** Returns the number of documents deleted. Call it straight from a click, so the sign-in popup may open. */
export async function deleteAccount(user) {
  // Sign in again before deleting anything, so the data and the sign-in go together.
  if (!fresh(user)) await signInAgain(user);
  const n = await deleteAccountData(db, { collection, query, where, getDocs, doc, writeBatch, deleteDoc }, user.uid, emailOf(user));
  try {
    await deleteUser(user);
  } catch (e) {
    if (e.code !== 'auth/requires-recent-login') throw e;
    await signInAgain(user);
    await deleteUser(user);
  }
  return n;
}
