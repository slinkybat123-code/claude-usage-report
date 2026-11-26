// Computers: approve a link request (computers/#link=CODE), and see or unlink your computers.
import {
  requireUser, db, doc, getDoc, deleteDoc, updateDoc, onSnapshot, collection, query, where, writeBatch,
  serverTimestamp, deleteField, esc, ago, millis, nameOf, problem, fillDownloads, ROOT,
} from './cloud.js';
import { deleteAccount } from './account.js';

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
  if (!link) return approveBox(`<h2>Link code ${esc(pretty(code))} has expired or was already used</h2><p class="desc">Codes last 20 minutes. On your computer, open <b>Limit</b> from the Start menu (or Applications on a Mac) to get a new one.</p>`);
  const phone = link.kind === 'phone';
  if (link.owner === user.uid) return approveBox(`<h2>${esc(link.name)} is linked</h2><p class="desc">${phone ? 'The Limit app on it shows your figures in a few seconds.' : 'It sends its figures within a minute or two.'}</p>`);
  if (link.owner) return approveBox(`<h2>That ${phone ? 'phone' : 'computer'} is already linked to another account</h2><p class="desc">If it's yours, unlink it there first, or ${phone ? 'unlink it in the app\'s Settings' : 'reinstall'} to get a new code.</p>`);
  approveBox(`<h2>Link ${esc(link.name || (phone ? 'this phone' : 'this computer'))} to your account?</h2>
    <p class="desc">${esc(link.platform || (phone ? 'A phone' : 'A computer'))} · code <span class="code">${esc(pretty(code))}</span>. ${phone
    ? `The Limit app on it will show the figures your computers send to ${esc(user.email)}, and the friends who share with you. It can only read them, never change them. Only link a phone you just opened Limit on.`
    : `It will send its Claude Code figures to ${esc(user.email)}. Only link a computer you just installed Limit on.`}</p>
    <div class="row-actions" style="margin-top:14px"><button class="primary" type="button" id="do-link">Link</button><button type="button" id="not-mine">It's not mine</button></div>
    <p class="msg bad" id="link-err" hidden></p>`);
  $('do-link').addEventListener('click', async () => {
    $('do-link').disabled = true;
    try {
      const b = writeBatch(db);
      b.update(doc(db, 'links', code), { owner: user.uid, ownerName: nameOf(user) });
      b.set(doc(db, 'devices', link.device), { owner: user.uid, kind: link.kind || 'pc', name: link.name || 'Computer', platform: link.platform || '', link: code, linkedAt: serverTimestamp() });
      await b.commit();
      history.replaceState(null, '', location.pathname);
      approveBox(phone
        ? `<h2>Linked ${esc(link.name || 'your phone')}</h2><p class="desc">Go back to the Limit app: it moves on by itself in a few seconds.</p>`
        : `<h2>Linked ${esc(link.name || 'your computer')}</h2><p class="desc">Its first figures arrive in a minute or two. Open <a href="../dashboard/">Claude Code</a> to watch them come in.</p>`);
    } catch (e) {
      $('do-link').disabled = false;
      const err = $('link-err');
      err.textContent = e.code === 'permission-denied' ? 'That code has expired. Open Limit on your computer again for a new one.' : problem(e);
      err.hidden = false;
    }
  });
  $('not-mine').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    approveBox('<h2>Not linked</h2><p class="desc">Nothing was changed. The code expires by itself.</p>');
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
