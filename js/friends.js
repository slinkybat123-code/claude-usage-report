// Friends: invites by Google email, both sides must agree, and either can stop.
// You see a friend's card (totals and limits) because they shared it with you (shares/{them}_{you}).
import {
  requireUser, db, doc, getDoc, updateDoc, deleteDoc, onSnapshot, collection, query, where, writeBatch,
  serverTimestamp, esc, ago, usd, compact, millis, avatar, emailOf, nameOf, problem,
} from './cloud.js';
import { sendInvite, watchFriends } from './friends-data.js';

const user = await requireUser('friends');
const me = { uid: user.uid, email: emailOf(user), name: nameOf(user), photo: user.photoURL || null };
const $ = (id) => document.getElementById(id);
const CALM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const opens = (ref) => (window.Sheet ? window.Sheet.attrs(ref) : '');
const AI_COLORS = { 'anthropic-api': 'var(--ai-claude-api, #c96442)', 'openai-api': 'var(--ai-openai, #10a37f)', openrouter: 'var(--ai-openrouter, #6467f2)' };

let inbox = [];
let outbox = [];
let following = []; // shares where you are the viewer
let viewers = []; // shares where you are the owner
let cards = new Map(); // uid -> card data
const seen = new Set(); // cards already on screen don't replay their entrance
let myCard = null;

// ---------- what a card says ----------
/** The freshest computer's Claude Code figures on a card, plus the AI accounts. */
function summary(card) {
  const pcs = Object.values((card && card.pcs) || {}).filter((p) => p && p.claude).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const pc = pcs[0] || null;
  const c = pc ? pc.claude : null;
  return {
    at: pc ? pc.updatedAt : 0,
    active: pc ? Date.now() - pc.updatedAt < 6 * 60e3 : false,
    today: c ? c.spend.today : null,
    week: c ? c.spend.week : null,
    month: c ? (c.spend.month ?? c.spend.projected30Days) : null,
    limits: c ? c.limits || [] : [],
    chats: c ? c.activeChats || 0 : 0,
    ais: Object.entries((card && card.ai) || {}).filter(([, a]) => a && a.month != null),
  };
}

function friendCard(uid, i) {
  const card = cards.get(uid);
  const share = following.find((s) => s.owner === uid);
  const name = (card && card.name) || (share && share.ownerName) || 'Friend';
  const photo = (card && card.photo) || (share && share.ownerPhoto);
  if (!card) {
    return `<article class="card friend" style="--i:${i}"><div class="friend-top">${avatar(name, photo, 'lg')}<div class="who"><b>${esc(name)}</b><span>Loading…</span></div></div></article>`;
  }
  const s = summary(card);
  const limits = s.limits.slice(0, 2).map((l) => {
    const p = Math.max(0, Math.min(100, Number(l.percent) || 0));
    const tone = p >= 90 ? 'var(--critical)' : p >= 70 ? 'var(--warning)' : 'var(--series-1)';
    return `<div class="limit"><div><span>${esc(l.label)}</span><b>${Math.round(p)}%</b></div><div class="fmeter"><span style="width:${p}%;background:${tone}"></span></div></div>`;
  }).join('');
  const status = s.at ? (s.active ? `Using Claude Code now${s.chats ? ` · ${s.chats} chat${s.chats === 1 ? '' : 's'}` : ''}` : `Updated ${ago(s.at)}`) : 'No computer linked yet';
  const enter = seen.has(uid) ? '' : ' enter';
  seen.add(uid);
  return `<article class="card friend${enter}" style="--i:${i}"${opens(`friend:${uid}`)}>
    <div class="friend-top">${avatar(name, photo, 'lg')}<div class="who"><b>${esc(name)}</b><span>${esc(status)}</span></div><span class="dot${s.active ? ' on' : ''}" title="${s.active ? 'Active' : 'Not active'}"></span></div>
    <dl><div><dt>Today</dt><dd>${usd(s.today)}</dd></div><div><dt>7 days</dt><dd>${usd(s.week)}</dd></div><div><dt>30 days</dt><dd>${usd(s.month)}</dd></div></dl>
    ${limits ? `<div class="limits">${limits}</div>` : ''}
    ${s.ais.length ? `<div class="ais">${s.ais.map(([id, a]) => `<span><i style="background:${AI_COLORS[id] || 'var(--axis)'}"></i>${esc(a.name)} ${usd(a.month)}</span>`).join('')}</div>` : ''}
    <div class="foot"><span>Claude Code at API prices</span><button type="button" data-unfriend="${esc(uid)}">Remove</button></div>
  </article>`;
}

// ---------- breakdowns: click a friend (or a row on the board) for their figures and how they compare ----------
if (window.Sheet && window.Insights) {
  window.Sheet.use((ref) => window.Insights.friendDetail({
    me: { uid: me.uid, name: me.name, card: myCard },
    friends: following.map((s) => ({ uid: s.owner, name: s.ownerName, card: cards.get(s.owner) })),
  }, window.Sheet.parse(ref)));
}

// ---------- drawing ----------
function renderInbox() {
  $('inbox').hidden = !inbox.length;
  $('inbox-list').innerHTML = inbox.map((inv) => `<li>${avatar(inv.fromName, inv.fromPhoto)}<div class="who"><b>${esc(inv.fromName || inv.fromEmail)}</b><span>${esc(inv.fromEmail)} wants to see each other's usage</span></div>
    <div class="row-actions"><button class="primary" type="button" data-accept="${esc(inv.id)}">Accept</button><button type="button" data-decline="${esc(inv.id)}">Decline</button></div></li>`).join('');
}

function renderOutbox() {
  const open = outbox.filter((o) => o.status !== 'accepted');
  $('outbox').innerHTML = open.map((o) => `<li><div class="who"><b>${esc(o.toEmail)}</b><span>${o.status === 'declined' ? 'Declined' : `Invited ${ago(millis(o.createdAt))}, waiting for them to sign in and accept`}</span></div>
    <div class="row-actions"><button type="button" data-cancel="${esc(o.id)}">${o.status === 'declined' ? 'Clear' : 'Cancel'}</button></div></li>`).join('');
}

function renderFriends() {
  const el = $('friends');
  if (!following.length) {
    el.innerHTML = '<p class="empty">No friends yet. Invite someone below; once they accept, their card shows up here.</p>';
  } else {
    el.innerHTML = following.map((s, i) => friendCard(s.owner, CALM ? 0 : i)).join('');
  }
  renderBoard();
}

function renderBoard() {
  const rows = [{ uid: me.uid, name: `${me.name} (you)`, photo: me.photo, today: summary(myCard).today }, ...following.map((s) => {
    const card = cards.get(s.owner);
    return { uid: s.owner, name: (card && card.name) || s.ownerName || 'Friend', photo: (card && card.photo) || s.ownerPhoto, today: card ? summary(card).today : null };
  })].filter((r) => r.today != null);
  $('board-section').hidden = !following.length || !rows.length;
  rows.sort((a, b) => b.today - a.today);
  const top = Math.max(0.01, ...rows.map((r) => r.today));
  $('today-board').innerHTML = rows.map((r, i) => `<li class="${r.uid === me.uid ? 'me' : ''}"${opens(`friend:${r.uid}`)}><span class="rank">${i + 1}</span>${avatar(r.name, r.photo)}<span>${esc(r.name)}</span><b>${usd(r.today)}</b><span class="bar"><span data-w="${(r.today / top) * 100}"></span></span></li>`).join('');
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelectorAll('#today-board [data-w]').forEach((b) => (b.style.width = `${b.dataset.w}%`))));
  if (window.Sheet) window.Sheet.refresh();
}

function renderViewers() {
  $('viewers').innerHTML = viewers.length
    ? viewers.map((v) => `<li>${avatar(v.viewerName, v.viewerPhoto)}<div class="who"><b>${esc(v.viewerName || 'A friend')}</b><span>Sees your totals and limits since ${ago(millis(v.createdAt))}</span></div>
      <div class="row-actions"><button type="button" data-stop="${esc(v.viewer)}">Stop sharing</button></div></li>`).join('')
    : '<li><p class="empty">Nobody. Your figures are private until you accept an invite or a friend accepts yours.</p></li>';
}

// ---------- live data ----------
onSnapshot(query(collection(db, 'invites'), where('toEmail', '==', me.email), where('status', '==', 'pending')), (snap) => {
  inbox = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderInbox();
}, () => {});
onSnapshot(query(collection(db, 'invites'), where('from', '==', me.uid)), (snap) => {
  outbox = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  // Accepted invites have done their job.
  outbox.filter((o) => o.status === 'accepted').forEach((o) => deleteDoc(doc(db, 'invites', o.id)).catch(() => {}));
  renderOutbox();
}, () => {});
onSnapshot(query(collection(db, 'shares'), where('owner', '==', me.uid)), (snap) => {
  viewers = snap.docs.map((d) => d.data());
  renderViewers();
}, () => {});
watchFriends(me, (f) => {
  following = f.following;
  cards = f.cards;
  myCard = f.myCard;
  renderFriends();
}, (e) => ($('friends').innerHTML = `<p class="empty">${esc(problem(e))}</p>`));

// ---------- actions ----------
const say = (text, ok) => {
  const m = $('invite-msg');
  m.textContent = text;
  m.className = `msg ${ok ? 'ok' : 'bad'}`;
  m.hidden = false;
};

$('invite').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = ev.target.querySelector('button');
  btn.disabled = true;
  try {
    const email = await sendInvite(me, ev.target.email.value);
    ev.target.reset();
    say(`Invite sent to ${email}. Ask them to sign in at this site with that Google account.`, true);
  } catch (e) {
    say(e.code ? problem(e) : e.message);
  } finally {
    btn.disabled = false;
  }
});

async function accept(inv) {
  const mine = doc(db, 'shares', `${me.uid}_${inv.from}`);
  const theirs = doc(db, 'shares', `${inv.from}_${me.uid}`);
  const [hasMine, hasTheirs] = await Promise.all([getDoc(mine).then((d) => d.exists(), () => false), getDoc(theirs).then((d) => d.exists(), () => false)]);
  const b = writeBatch(db);
  b.update(doc(db, 'invites', inv.id), { status: 'accepted', toUid: me.uid, toName: me.name, toPhoto: me.photo, answeredAt: serverTimestamp() });
  if (!hasMine) b.set(mine, { owner: me.uid, viewer: inv.from, ownerName: me.name, ownerPhoto: me.photo, viewerName: inv.fromName || inv.fromEmail, viewerPhoto: inv.fromPhoto || null, createdAt: serverTimestamp() });
  if (!hasTheirs) b.set(theirs, { owner: inv.from, viewer: me.uid, ownerName: inv.fromName || inv.fromEmail, ownerPhoto: inv.fromPhoto || null, viewerName: me.name, viewerPhoto: me.photo, createdAt: serverTimestamp() });
  await b.commit();
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button');
  if (!t) return;
  try {
    if (t.dataset.accept) {
      t.disabled = true;
      await accept(inbox.find((i) => i.id === t.dataset.accept));
    } else if (t.dataset.decline) {
      t.disabled = true;
      await updateDoc(doc(db, 'invites', t.dataset.decline), { status: 'declined', toUid: me.uid, answeredAt: serverTimestamp() });
    } else if (t.dataset.cancel) {
      await deleteDoc(doc(db, 'invites', t.dataset.cancel));
    } else if (t.dataset.stop) {
      if (!confirm('Stop sharing your usage with them? They stop seeing your card right away.')) return;
      await deleteDoc(doc(db, 'shares', `${me.uid}_${t.dataset.stop}`));
    } else if (t.dataset.unfriend) {
      if (!confirm('Remove this friend? You stop seeing each other\'s usage.')) return;
      const them = t.dataset.unfriend;
      await Promise.all([deleteDoc(doc(db, 'shares', `${me.uid}_${them}`)).catch(() => {}), deleteDoc(doc(db, 'shares', `${them}_${me.uid}`))]);
    }
  } catch (e) {
    t.disabled = false;
    alert(problem(e));
  }
});

// Ages ("Updated 5 min ago") move on by themselves.
setInterval(() => document.hidden || renderFriends(), 60000);
