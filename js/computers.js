// Computers: approve a link request (computers/#link=CODE), and see or unlink your computers.
import {
  requireUser, db, doc, getDoc, deleteDoc, updateDoc, onSnapshot, collection, query, where, writeBatch,
  serverTimestamp, deleteField, esc, ago, millis, nameOf, problem, fillDownloads, ROOT,
} from './cloud.js';
import { deleteAccount } from './account.js';
import { approveLink } from './link.js';

const user = await requireUser('computers');
fillDownloads();
const $ = (id) => document.getElementById(id);
const PC_ICON = '<span class="pc-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg></span>';
const PHONE_ICON = '<span class="pc-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg></span>';

let devices = [];
let uploads = {}; // device id -> last upload time

// ---------- a link request ----------
const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const codeFromHash = () => {
  const m = /(?:^#|&)link=([^&]+)/.exec(location.hash);
  return m ? cleanCode(decodeURIComponent(m[1])) : '';
};
const pretty = (c) => `${c.slice(0, 5)}-${c.slice(5)}`;

function approveBox(html) {
  const box = $('approve');
  box.innerHTML = html;
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
}

async function showRequest(code) {
  if (!/^[2-9A-HJKMNP-Z]{10}$/.test(code)) return approveBox(`<h2>That code doesn't look right</h2><p class="desc">Link codes are 10 letters and numbers, like ABCDE-23456.</p>`);
  let link;
  try {
    const d = await getDoc(doc(db, 'links', code));
    link = d.exists() ? d.data() : null;
  } catch {
    link = null;
  }
  if (!link) return approveBox(`<h2>That request has expired or was already used</h2><p class="desc">Requests last 20 minutes. On your computer, open <b>Limit</b> from the Start menu (or Applications on a Mac) and it asks again.</p>`);
  const phone = link.kind === 'phone';
  if (link.owner === user.uid) return approveBox(`<h2>${esc(link.name)} is linked</h2><p class="desc">${phone ? 'The Limit app on it shows your figures in a few seconds.' : 'It sends its figures within a minute or two.'}</p>`);
  if (link.owner) return approveBox(`<h2>That ${phone ? 'phone' : 'computer'} is already linked to another account</h2><p class="desc">If it's yours, unlink it there first, or ${phone ? 'unlink it in the app\'s Settings' : 'reinstall'} to get a new code.</p>`);
  const what = phone ? 'phone' : 'computer';
  approveBox(`<h2>Is this your ${what}?</h2>
    <div class="device-ask">${phone ? PHONE_ICON : PC_ICON}<div><b>${esc(link.name || `Your ${what}`)}</b><span>${esc(link.platform || '')}${link.platform ? ' · ' : ''}${phone ? 'Limit app just opened on it' : 'Limit just installed on it'}</span></div></div>
    <p class="desc">${phone
    ? `Say yes and the Limit app on it shows your figures and friends from ${esc(user.email)}. It can only look, never change anything.`
    : `Say yes and it sends its Claude Code usage to your account (${esc(user.email)}), so you can see it here and on your phone. That name is what your ${what} calls itself.`}
    Only say yes if you just set Limit up on it yourself.</p>
    <div class="row-actions" style="margin-top:14px"><button class="primary" type="button" id="do-link">Yes, it's mine</button><button type="button" id="not-mine">No</button></div>
    <p class="desc" style="margin-top:10px;font-size:12px">Check code: <b>${esc(pretty(code))}</b> (also shown on the ${what})</p>
    <p class="msg bad" id="link-err" hidden></p>`);
  $('do-link').addEventListener('click', async () => {
    $('do-link').disabled = true;
    try {
      await approveLink(user, code, link);
      history.replaceState(null, '', location.pathname);
      approveBox(phone
        ? `<h2>Done: ${esc(link.name || 'your phone')} is added</h2><p class="desc">Go back to the Limit app. It moves on by itself in a few seconds.</p>`
        : `<h2>Done: ${esc(link.name || 'your computer')} is added</h2><p class="desc">You can close this tab. Its figures arrive in a minute or two; open <a href="../dashboard/">Claude Code</a> to watch them come in, here or on your phone.</p>`);
    } catch (e) {
      $('do-link').disabled = false;
      const err = $('link-err');
      err.textContent = e.code === 'permission-denied' ? 'That code has expired. Open Limit on your computer again for a new one.' : problem(e);
      err.hidden = false;
    }
  });
  $('not-mine').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    approveBox('<h2>Not added</h2><p class="desc">Nothing was changed. The request expires by itself.</p>');
  });
}

$('code-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const code = cleanCode(ev.target.code.value);
  if (code) location.hash = `link=${code}`;
});
window.addEventListener('hashchange', () => codeFromHash() && showRequest(codeFromHash()));
if (codeFromHash()) showRequest(codeFromHash());

// ---------- your computers ----------
function render() {
  $('devices').innerHTML = devices.length
    ? devices.map((d) => {
      const at = uploads[d.id];
      const phone = d.kind === 'phone';
      const state = phone ? 'Phone app, reads your figures' : at ? (Date.now() - at < 6 * 60e3 ? 'Sending now' : `Last sent ${ago(at)}`) : 'Linked, no figures yet';
      return `<li>${phone ? PHONE_ICON : PC_ICON}<div class="who"><b>${esc(d.name)}</b><span>${esc(d.platform || '')}${d.platform ? ' · ' : ''}${state} · linked ${ago(millis(d.linkedAt))}</span></div>
        <div class="row-actions"><button type="button" data-unlink="${esc(d.id)}">Unlink</button></div></li>`;
    }).join('')
    : '<li><p class="empty">None yet. Install Limit on the computer where you use Claude Code (below).</p></li>';
}

onSnapshot(query(collection(db, 'devices'), where('owner', '==', user.uid)), (snap) => {
  devices = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => millis(b.linkedAt) - millis(a.linkedAt));
  render();
}, (e) => ($('devices').innerHTML = `<li><p class="empty">${esc(problem(e))}</p></li>`));
onSnapshot(collection(db, 'users', user.uid, 'reports'), (snap) => {
  uploads = Object.fromEntries(snap.docs.filter((d) => d.data().kind === 'pc').map((d) => [d.id, millis(d.data().updatedAt)]));
  render();
}, () => {});

$('devices').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-unlink]');
  if (!b) return;
  const d = devices.find((x) => x.id === b.dataset.unlink);
  const phone = d && d.kind === 'phone';
  if (!confirm(phone
    ? `Unlink ${d.name}? The Limit app on it stops showing your figures and friends. To link it again, open the app.`
    : `Unlink ${d ? d.name : 'this computer'}? It stops sending, and its figures are removed from your account. To link it again, reinstall Limit on it.`)) return;
  b.disabled = true;
  try {
    await deleteDoc(doc(db, 'devices', b.dataset.unlink));
    await deleteDoc(doc(db, 'users', user.uid, 'reports', b.dataset.unlink)).catch(() => {});
    await updateDoc(doc(db, 'cards', user.uid), { [`pcs.${b.dataset.unlink}`]: deleteField() }).catch(() => {});
  } catch (e) {
    b.disabled = false;
    alert(problem(e));
  }
});
setInterval(() => document.hidden || render(), 60000);

// ---------- Your account ----------
$('acct-email').textContent = user.email || '';
let confirmed = false;
$('delete-account').addEventListener('click', async () => {
  const btn = $('delete-account');
  const err = $('delete-err');
  if (!confirmed && !confirm(`Delete your Limit account (${user.email})?

Your figures, saved keys, computers, friend card, shares and invites are removed, and you're signed out. Your computers stop sending. This can't be undone.`)) return;
  confirmed = true;
  btn.disabled = true;
  err.hidden = true;
  btn.textContent = 'Deleting…';
  try {
    await deleteAccount(user);
    location.replace(`${ROOT.href}?deleted=1`);
  } catch (e) {
    btn.disabled = false;
    if (e.code === 'auth/popup-blocked') {
      btn.textContent = 'Confirm with Google and delete';
      err.textContent = 'Google needs you to sign in again first. Click the button once more to open the sign-in window.';
    } else {
      btn.textContent = 'Delete my account';
      confirmed = false;
      err.textContent = e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request' ? 'Sign-in was closed, so nothing was deleted.' : problem(e);
    }
    err.hidden = false;
  }
});
