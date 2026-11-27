// Limit: Google sign-in and the database, shared by every page.
// Config comes from ../config.js (window.FIREBASE_CONFIG; window.FIREBASE_EMULATOR when testing locally).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {
  getAuth, initializeAuth, browserLocalPersistence, browserPopupRedirectResolver, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
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
/**
 * Inside the Limit app (Android 3 and later) the page has no Google sign-in of its own: Google
 * doesn't allow it in an app's built-in browser. You sign in once on app/signin/ in a real browser
 * tab, the app keeps that session and hands it to every page here (LimitApp.session()).
 */
export const IN_APP = typeof window.LimitApp === 'object' && navigator.userAgent.indexOf('LimitApp/3') >= 0;
function appAuth() {
  const key = `firebase:authUser:${config.apiKey}:[DEFAULT]`;
  try {
    const raw = window.LimitApp.session();
    const got = raw ? JSON.parse(raw) : null;
    const have = JSON.parse(localStorage.getItem(key) || 'null');
    if (!got) localStorage.removeItem(key);
    else if (!have || have.uid !== got.uid) localStorage.setItem(key, raw);
  } catch (e) {
    console.warn('app session', e);
  }
  return initializeAuth(app, { persistence: browserLocalPersistence, popupRedirectResolver: browserPopupRedirectResolver });
}
export const auth = IN_APP ? appAuth() : getAuth(app);
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
  if (IN_APP) return window.LimitApp.signedOut();
  location.href = ROOT.href;
}

/** For every page but the sign-in page: the signed-in Google user, or off to sign in (and back here after). */
export async function requireUser(current) {
  const user = await ready;
  if ((!user || user.isAnonymous) && IN_APP) {
    window.LimitApp.signIn(); // the app opens app/signin/ and comes back here
    return new Promise(() => {});
  }
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
    <div class="me"><button type="button" id="nav-theme" aria-label="Switch color theme"></button>${avatar(nameOf(user), user.photoURL)}<span class="who">${esc(nameOf(user))}</span><button type="button" id="sign-out">Sign out</button></div>
  </div>`;
  nav.querySelector('#sign-out').addEventListener('click', signOut);
  const btn = nav.querySelector('#nav-theme');
  const show = () => (btn.textContent = `Theme: ${savedTheme()}`);
  btn.addEventListener('click', () => {
    setTheme(THEMES[(THEMES.indexOf(savedTheme()) + 1) % THEMES.length]);
    show();
  });
  show();
}

// ---------- theme: one choice for every page (each page applies it before drawing, see site-template.js) ----------
const THEMES = ['system', 'light', 'dark'];
export function savedTheme() {
  try {
    const t = localStorage.getItem('theme');
    return THEMES.includes(t) ? t : 'system';
  } catch {
    return 'system';
  }
}
export function setTheme(t) {
  try {
    localStorage.setItem('theme', t);
  } catch { /* private window: this page only */ }
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const old = document.getElementById('theme'); // the dashboard's own button
  if (old) old.textContent = `Theme: ${t}`;
}
// Another tab changed it: follow.
window.addEventListener('storage', (e) => {
  if (e.key !== 'theme') return;
  setTheme(savedTheme());
  const btn = document.getElementById('nav-theme');
  if (btn) btn.textContent = `Theme: ${savedTheme()}`;
});

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

// ---------- counting figures: dollar amounts count up from zero on open, then from what was shown ----------
const counted = new Map(); // key -> the value now on screen
const calmMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** A dollar figure that countUp() animates. key: stable id, so a redraw counts from the old value. */
export function counter(key, value) {
  if (value == null || !Number.isFinite(Number(value))) return usd(null);
  const from = counted.has(key) ? counted.get(key) : 0;
  return `<span class="count" data-count="${Number(value)}" data-key="${esc(key)}">${usd(from)}</span>`;
}
/** Runs every counter under root (waits for the opening logo to go first). */
export function countUp(root = document) {
  const run = () => root.querySelectorAll('[data-count]').forEach((el) => {
    const key = el.dataset.key;
    const to = Number(el.dataset.count);
    const from = counted.has(key) ? counted.get(key) : 0;
    counted.set(key, to);
    el.removeAttribute('data-count');
    if (calmMotion() || from === to) return void (el.textContent = usd(to));
    const t0 = performance.now();
    const dur = from === 0 ? 1300 : 700;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      el.textContent = usd(from + (to - from) * (1 - Math.pow(1 - p, 4)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  if (window.LimitSplash && !window.LimitSplash.done) window.addEventListener('limit-splash-done', run, { once: true });
  else run();
}
