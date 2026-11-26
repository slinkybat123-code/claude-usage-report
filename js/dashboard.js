// The Claude Code dashboard on the website: draws what your linked computer last uploaded,
// and redraws the moment it uploads again.
import { requireUser, db, collection, query, where, onSnapshot, getDocs, millis, esc, fillDownloads, avatar, ago, usd, emailOf, nameOf, problem } from './cloud.js';
import { sendInvite, watchFriends } from './friends-data.js';

const user = await requireUser('dashboard');
fillDownloads();
await new Promise((resolve) => (window.Dashboard ? resolve() : window.addEventListener('dashboard-ready', resolve, { once: true })));

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};
let pcs = [];
let picked = store.get('pcPick');
let drawn = ''; // id@updatedAt of what is on screen

function live(text) {
  $('live').classList.remove('on');
  $('live').lastElementChild.textContent = text;
}

async function showNoPc() {
  $('report').hidden = true;
  $('no-pc').hidden = false;
  $('pc-pick').hidden = true;
  const linked = await getDocs(query(collection(db, 'devices'), where('owner', '==', user.uid))).then((s) => s.size, () => 0);
  $('subtitle').textContent = linked ? 'Your computer is linked. Its first figures arrive a minute or two after it is on.' : 'No computer linked yet';
  live(linked ? 'Waiting for your computer' : 'No computer yet');
  window.dispatchEvent(new Event('limit-ready'));
}

function draw() {
  const pc = pcs.find((p) => p.id === picked) || pcs[0];
  const key = `${pc.id}@${pc.updatedAt}`;
  if (key === drawn) return;
  let snap;
  try {
    snap = JSON.parse(pc.snapshot);
  } catch {
    live('Could not read the last upload');
    return;
  }
  drawn = key;
  $('no-pc').hidden = true;
  $('report').hidden = false;
  window.Dashboard.feed(snap, { name: pc.name, updatedAt: pc.updatedAt });
}

function renderPicker() {
  const sel = $('pc-pick');
  sel.hidden = pcs.length < 2;
  if (sel.hidden) return;
  const current = (pcs.find((p) => p.id === picked) || pcs[0]).id;
  sel.innerHTML = pcs.map((p) => `<option value="${esc(p.id)}"${p.id === current ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
}
$('pc-pick').addEventListener('change', (ev) => {
  picked = ev.target.value;
  store.set('pcPick', picked);
  draw();
});

onSnapshot(
  collection(db, 'users', user.uid, 'reports'),
  (snap) => {
    pcs = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((d) => d.kind === 'pc' && typeof d.snapshot === 'string')
      .map((d) => ({ id: d.id, name: d.name || 'Your computer', updatedAt: millis(d.updatedAt), snapshot: d.snapshot }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (!pcs.length) return void showNoPc();
    renderPicker();
    draw();
  },
  () => { live('Could not load your figures'); window.dispatchEvent(new Event('limit-ready')); },
);

// ---------- friends at the top: a strip of cards (arrows on a computer, swipe on a phone) ----------
const me = { uid: user.uid, email: emailOf(user), name: nameOf(user), photo: user.photoURL || null };
const CALM = matchMedia('(prefers-reduced-motion: reduce)').matches;
let friends = { following: [], cards: new Map(), myCard: null };
const friendCtx = () => ({
  me: { uid: me.uid, name: me.name, card: friends.myCard },
  friends: friends.following.filter((s) => !s.pending).map((s) => ({ uid: s.owner, name: s.ownerName, photo: s.ownerPhoto, card: friends.cards.get(s.owner) })),
});
// A friend's card opens their breakdown in the same panel as everything else.
if (window.Sheet && window.Insights) window.Sheet.add('friend', (ref) => window.Insights.friendDetail(friendCtx(), window.Sheet.parse(ref)));

const strip = window.FriendStrip ? window.FriendStrip.mount({ onAdd: () => openAdd() }) : { render() {} };
const renderStrip = () => window.Insights && strip.render(window.Insights.friendStrip(friendCtx()));

watchFriends(me, (f) => {
  friends = f;
  renderStrip();
  if (window.Sheet) window.Sheet.refresh();
});

// Pending invites to you show on the Friends button.
onSnapshot(query(collection(db, 'invites'), where('toEmail', '==', me.email), where('status', '==', 'pending')), (snap) => {
  $('friends-badge').hidden = !snap.size;
  $('friends-badge').textContent = snap.size;
  $('friends-link').setAttribute('aria-label', snap.size ? `Friends, ${snap.size} new invite${snap.size === 1 ? '' : 's'}` : 'Friends');
}, () => {});

// ---------- Add a friend ----------
const dialog = $('add-friend');
const say = (text, ok) => {
  $('af-msg').textContent = text;
  $('af-msg').className = `msg ${ok ? 'ok' : 'bad'}`;
  $('af-msg').hidden = false;
};
function openAdd() {
  $('af-msg').hidden = true;
  dialog.showModal();
  $('af-email').focus();
}
document.addEventListener('click', (ev) => {
  const b = ev.target.closest && ev.target.closest('[data-fs]');
  if (!b) return;
  if (b.getAttribute('data-fs') === 'add') openAdd();
  else if (b.getAttribute('data-fs') === 'close') dialog.close();
});
dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); }); // a click on the backdrop
$('af-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = ev.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const email = await sendInvite(me, $('af-email').value);
    ev.target.reset();
    say(`Invite sent to ${email}. Once they sign in with that Google account and accept, they show up here.`, true);
    dialog.querySelector('[data-fs="close"]').textContent = 'Done';
  } catch (e) {
    say(e.code ? problem(e) : e.message);
  } finally {
    btn.disabled = false;
  }
});
dialog.addEventListener('close', () => { dialog.querySelector('[data-fs="close"]').textContent = 'Cancel'; });
