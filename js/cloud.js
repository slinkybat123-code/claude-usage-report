// Limit: Google sign-in and the database, shared by every page.
// Config comes from ../config.js (window.FIREBASE_CONFIG; window.FIREBASE_EMULATOR when testing locally).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  signOut as firebaseSignOut, connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
  collection, query, where, getDocs, writeBatch, serverTimestamp, deleteField,
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';

export { doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, collection, query, where, getDocs, writeBatch, serverTimestamp, deleteField };

/** The site's root folder (pages link relative to it). */
export const ROOT = new URL('../', import.meta.url);
export const page = (path) => new URL(path, ROOT).href;

const config = window.FIREBASE_CONFIG;
if (!config || !config.apiKey) {
  document.body.innerHTML = '<p style="padding:24px;font:16px system-ui">This site is not set up yet (no Firebase config).</p>';
  throw new Error('No FIREBASE_CONFIG');
}
export const app = initializeApp(config);
export const auth = getAuth(app);
export const db = getFirestore(app);
const emulator = window.FIREBASE_EMULATOR;
if (emulator) {
  connectAuthEmulator(auth, emulator.auth, { disableWarnings: true });
  const [host, port] = emulator.firestore.split(':');
  connectFirestoreEmulator(db, host, Number(port));
}

/** The signed-in user once Firebase has restored the session (null when signed out). */
export const ready = new Promise((resolve) => {
  const stop = onAuthStateChanged(auth, (user) => {
    stop();
    resolve(user);
  });
});

/** Google sign-in: a popup, or a full-page redirect where popups are blocked. */
export async function signIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    return (await signInWithPopup(auth, provider)).user;
  } catch (e) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported'].includes(e.code)) {
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw e;
  }
}
export const redirectResult = () => getRedirectResult(auth).catch(() => null);

export async function signOut() {
  await firebaseSignOut(auth);
  location.href = ROOT.href;
}

/** For every page but the sign-in page: the signed-in Google user, or off to sign in (and back here after). */
export async function requireUser(current) {
  const user = await ready;
  if (!user || user.isAnonymous) {
    const next = location.pathname + location.search + location.hash;
    location.replace(`${ROOT.href}?next=${encodeURIComponent(next)}`);
    return new Promise(() => {});
  }
  renderNav(user, current);
  ensureProfile(user).catch((e) => console.warn('profile', e));
  watchInvites(user);
  return user;
}

export const emailOf = (user) => String(user.email || '').toLowerCase();
export const nameOf = (user) => user.displayName || emailOf(user).split('@')[0] || 'You';

/** Your profile and the card friends see; the card starts empty and your computers fill it in. */
async function ensureProfile(user) {
  const name = nameOf(user);
  const photo = user.photoURL || null;
  await setDoc(doc(db, 'users', user.uid), { name, email: emailOf(user), photo, lastSeen: serverTimestamp() }, { merge: true });
  const ref = doc(db, 'cards', user.uid);
  const card = await getDoc(ref);
  if (!card.exists()) await setDoc(ref, { name, photo, pcs: {}, ai: {}, updatedAt: serverTimestamp() });
  else if (card.data().name !== name || card.data().photo !== photo) await updateDoc(ref, { name, photo });
}

// ---------- navigation ----------
const LINKS = [
  ['dashboard', 'dashboard/', 'Claude Code'],
  ['ai', 'ai/', 'All your AIs'],
  ['friends', 'friends/', 'Friends'],
  ['computers', 'computers/', 'Computers'],
];

export function avatar(name, photo, cls = '') {
  const initial = esc(String(name || '?').trim().charAt(0).toUpperCase() || '?');
  return photo
    ? `<img class="avatar ${cls}" src="${esc(photo)}" alt="" referrerpolicy="no-referrer" loading="lazy">`
    : `<span class="avatar ${cls}" aria-hidden="true">${initial}</span>`;
}

function renderNav(user, current) {
  const nav = document.getElementById('site-nav');
  if (!nav) return;
  nav.innerHTML = `<div class="in">
    <a class="brand" href="${page('dashboard/')}"><span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>Limit</a>
    <div class="links">${LINKS.map(([id, href, label]) => `<a href="${page(href)}"${id === current ? ' aria-current="page"' : ''} data-nav="${id}">${label}</a>`).join('')}</div>
    <div class="me">${avatar(nameOf(user), user.photoURL)}<span class="who">${esc(nameOf(user))}</span><button type="button" id="sign-out">Sign out</button></div>
  </div>`;
  nav.querySelector('#sign-out').addEventListener('click', signOut);
}

/** A badge on Friends when someone has invited you. */
function watchInvites(user) {
  const q = query(collection(db, 'invites'), where('toEmail', '==', emailOf(user)), where('status', '==', 'pending'));
  onSnapshot(q, (snap) => {
    const link = document.querySelector('[data-nav="friends"]');
    if (!link) return;
    const old = link.querySelector('.badge');
    if (old) old.remove();
    if (snap.size) link.insertAdjacentHTML('beforeend', `<span class="badge" aria-label="${snap.size} new">${snap.size}</span>`);
  }, () => {});
}

/** Points every [data-dl="<file>"] link at the latest release (window.DOWNLOADS, from config.js). */
export function fillDownloads(root = document) {
  const base = window.DOWNLOADS || '';
  root.querySelectorAll('[data-dl]').forEach((a) => {
    a.href = base + a.dataset.dl;
    a.setAttribute('download', '');
  });
}

// ---------- small helpers ----------
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const millis = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : t ? Date.parse(t) || 0 : 0);
export function ago(ms) {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
export const usd = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export function compact(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${+(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}
/** A readable sentence for a Firebase error. */
export function problem(e) {
  const code = (e && e.code) || '';
  if (code === 'permission-denied' || code === 'firestore/permission-denied') return 'Not allowed. Try signing out and in again.';
  if (code === 'unavailable') return 'Can\'t reach the database. Check your connection.';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Sign-in was closed before it finished.';
  if (code === 'auth/unauthorized-domain') return 'This web address is not allowed to sign in yet (Firebase → Authentication → Settings → Authorized domains).';
  if (code === 'auth/network-request-failed') return 'Can\'t reach Google. Check your connection.';
  return (e && e.message) || String(e);
}
