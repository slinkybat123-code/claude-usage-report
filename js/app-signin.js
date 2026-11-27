// Sign in to the Limit app (Android 3 and later). The app opens this page in a browser tab, because
// Google doesn't allow its sign-in inside an app's own web view:
//   app/signin/#code=<the phone's link code>&state=<a one-time value from the app>
// You sign in with Google here, tap Continue, and the page hands your session straight back to the
// Limit app (an intent: link that only that app can open) and approves the phone's link code so its
// widgets keep working too.
import { signOut as firebaseSignOut } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import { auth, ready, signIn, redirectResult, problem, nameOf, esc, avatar } from './cloud.js';
import { LINK_CODE, readLink, approveLink } from './link.js';

const PACKAGE = 'dev.usagemonitor.claude';
const params = new URLSearchParams(location.hash.slice(1));
const code = String(params.get('code') || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const state = String(params.get('state') || '');
const step = document.getElementById('step');
const GOOGLE_ICON = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

/** Swaps the card's content with a short fade, so each step eases in. */
function show(html) {
  step.classList.remove('in');
  step.innerHTML = html;
  void step.offsetWidth;
  step.classList.add('in');
}
const fail = (text) => {
  const err = document.getElementById('err');
  if (!err) return;
  err.textContent = text;
  err.hidden = false;
};

/** The link back into the app. Chrome opens only the Limit app with it, never another app. */
function backToApp(session) {
  const extra = (k, v) => `S.${k}=${encodeURIComponent(v)};`;
  return `intent://signin#Intent;scheme=limitapp;package=${PACKAGE};${extra('state', state)}${extra('session', session)}end`;
}

function askSignIn() {
  show(`<h1>Sign in to the Limit app</h1>
    <p class="lede">Use the Google account you use Limit with on your computer.</p>
    <button class="google-btn" type="button" id="google">${GOOGLE_ICON}<span>Sign in with Google</span></button>
    <p class="err" id="err" role="alert" hidden></p>`);
  const btn = document.getElementById('google');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const u = await signIn();
      if (u) confirmStep(u);
    } catch (e) {
      btn.disabled = false;
      if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') fail(problem(e));
    }
  });
}

function confirmStep(user) {
  show(`<h1>Continue to the app?</h1>
    <div class="as-who">${avatar(nameOf(user), user.photoURL, 'lg')}<div><b>${esc(nameOf(user))}</b><span>${esc(user.email || '')}</span></div></div>
    <button class="primary as-go" type="button" id="go">Continue as ${esc(nameOf(user).split(' ')[0])}</button>
    <button type="button" class="as-other" id="other">Use another account</button>
    <p class="err" id="err" role="alert" hidden></p>`);
  document.getElementById('other').addEventListener('click', async () => {
    await firebaseSignOut(auth);
    askSignIn();
  });
  const go = document.getElementById('go');
  go.addEventListener('click', async () => {
    go.disabled = true;
    go.textContent = 'Signing you in…';
    try {
      if (LINK_CODE.test(code)) {
        const link = await readLink(code);
        if (link && link.owner && link.owner !== user.uid) throw new Error('This phone is linked to another Limit account. Unlink it in that account first.');
        if (link && !link.owner && link.kind === 'phone') await approveLink(user, code, link);
      }
      const url = backToApp(JSON.stringify(auth.currentUser.toJSON()));
      location.href = url;
      show(`<h1>You're signed in</h1>
        <p class="lede">Going back to the Limit app…</p>
        <a class="btn primary as-go" href="${esc(url)}">Open the Limit app</a>`);
    } catch (e) {
      go.disabled = false;
      go.textContent = `Continue as ${nameOf(user).split(' ')[0]}`;
      fail(e.code ? problem(e) : e.message);
    }
  });
}

if (!/^[A-Za-z0-9_-]{16,64}$/.test(state)) {
  show(`<h1>Open this from the Limit app</h1>
    <p class="lede">This page signs the Limit app on your phone in. Open the app and tap <b>Sign in with Google</b>.</p>
    <a class="btn" href="../../get/">Get the app</a>`);
} else {
  await redirectResult();
  const user = await ready;
  if (user && !user.isAnonymous) confirmStep(user);
  else askSignIn();
}
