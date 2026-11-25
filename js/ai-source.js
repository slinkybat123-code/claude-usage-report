// All your AIs on the website. Where each report comes from:
//   Claude Code, Codex CLI, Gemini CLI   your linked computer (it reads their files and uploads)
//   OpenAI API, OpenRouter               this browser, with the key saved in your account
//   Claude API                           your linked computer, with the key saved in your account
//                                        (Anthropic's usage API does not answer browsers)
import {
  requireUser, db, doc, setDoc, updateDoc, deleteDoc, collection, onSnapshot, serverTimestamp, deleteField, millis, ago,
} from './cloud.js';
import { ACCOUNTS, checkKey } from './ai-accounts.js';

const user = await requireUser('ai');

const LOCAL = [
  { id: 'claude-code', name: 'Claude Code', where: 'From your linked computer' },
  { id: 'codex', name: 'Codex CLI', where: 'OpenAI Codex CLI on your computer (~/.codex)' },
  { id: 'gemini-cli', name: 'Gemini CLI', where: 'Google Gemini CLI on your computer (~/.gemini)' },
];
const ACCOUNT_IDS = ['anthropic-api', 'openai-api', 'openrouter'];
const IN_BROWSER = new Set(['openai-api', 'openrouter']);
const FRESH = 15 * 60e3;

let keys = {}; // id -> { key, addedAt }
let docs = {}; // report documents by id
let gotKeys = false;
let gotDocs = false;
const live = {}; // id -> { at, report | error } fetched by this browser
const fetching = {};

const latestPc = () => Object.entries(docs)
  .filter(([, d]) => d.kind === 'pc')
  .map(([id, d]) => ({ id, ...d, at: millis(d.updatedAt) }))
  .sort((a, b) => b.at - a.at)[0];

function base(id) {
  const local = LOCAL.find((p) => p.id === id);
  if (local) return { id, name: local.name, kind: 'local', where: local.where, keyName: null, keyHelp: null };
  const a = ACCOUNTS[id];
  return { id, name: a.name, kind: 'account', where: null, keyName: a.keyName, keyHelp: a.keyHelp };
}

/** Totals for the card friends see. */
async function saveCard(id, report) {
  const entry = report ? { name: ACCOUNTS[id].name, today: report.spend.today ?? null, month: report.spend.month ?? null, tokens: (report.tokens && report.tokens.total) || 0, at: Date.now() } : deleteField();
  await updateDoc(doc(db, 'cards', user.uid), { [`ai.${id}`]: entry }).catch(() => {});
}

/** OpenAI and OpenRouter: read in this browser, at most every 15 minutes; the result is kept in your account. */
async function refresh(id) {
  if (fetching[id]) return fetching[id];
  fetching[id] = (async () => {
    try {
      const report = await ACCOUNTS[id].fetch(keys[id].key, (...a) => fetch(...a), Date.now());
      live[id] = { at: Date.now(), report };
      await setDoc(doc(db, 'users', user.uid, 'reports', id), { kind: 'account', provider: id, report: JSON.stringify(report), error: null, updatedAt: serverTimestamp() });
      await saveCard(id, report);
    } catch (e) {
      live[id] = { at: Date.now(), error: e.message };
    } finally {
      delete fetching[id];
    }
  })();
  return fetching[id];
}

function accountReport(id) {
  const b = base(id);
  const k = keys[id];
  if (!k) return { ...b, status: 'needs-key', message: `Paste your ${ACCOUNTS[id].name} ${ACCOUNTS[id].keyName.replace(/^Admin/, 'admin')} to add it.` };
  const connectedAt = k.addedAt;
  if (IN_BROWSER.has(id)) {
    const l = live[id];
    if (l && l.error) return { ...b, status: 'error', message: l.error, connectedAt };
    if (l && l.report) return { ...b, ...l.report, status: 'ok', connectedAt, updatedAt: l.at };
    const saved = docs[id];
    if (saved && saved.report) return { ...b, ...JSON.parse(saved.report), status: 'ok', connectedAt, updatedAt: millis(saved.updatedAt) };
    return { ...b, status: 'waiting', message: 'Reading your usage…', connectedAt };
  }
  // Claude API: your computer fetches it.
  const saved = docs[id];
  if (saved && saved.error) return { ...b, status: 'error', message: `${saved.error} (checked by ${saved.checkedBy || 'your computer'} ${ago(millis(saved.updatedAt))})`, connectedAt };
  if (saved && saved.report) {
    const r = JSON.parse(saved.report);
    return { ...b, ...r, status: 'ok', connectedAt, notes: [...(r.notes || []), `Fetched by ${saved.checkedBy || 'your computer'} ${ago(millis(saved.updatedAt))}.`] };
  }
  if (!latestPc()) return { ...b, status: 'needs-pc', message: 'Anthropic doesn\'t let websites read usage, so your linked computer fetches it. Link a computer under Computers, and this fills in within 15 minutes of it being on.', connectedAt };
  return { ...b, status: 'waiting', message: 'Saved. Your computer checks this key and fetches your usage within 15 minutes of being on (Anthropic doesn\'t let websites read usage directly).', connectedAt };
}

function localReports() {
  const pc = latestPc();
  let list = [];
  if (pc && typeof pc.local === 'string') {
    try {
      list = JSON.parse(pc.local);
    } catch {
      list = [];
    }
  }
  return LOCAL.map((p) => {
    const r = list.find((x) => x.id === p.id);
    if (!pc) return { ...base(p.id), status: 'empty', message: 'Link the computer you use it on (Computers, at the top) and it shows up here by itself.' };
    if (!r) return { ...base(p.id), status: 'empty', message: `Waiting for ${pc.name || 'your computer'} to send it.` };
    const where = p.id === 'claude-code' ? `From ${pc.name || 'your computer'}, ${ago(pc.at)}` : `${p.name} on ${pc.name || 'your computer'}`;
    const message = r.status === 'not-found' ? `Not on ${pc.name || 'your computer'}. Use ${p.name} there and it shows up by itself.` : r.message;
    return { ...r, ...base(p.id), where, message, status: r.status };
  });
}

function build() {
  for (const id of ACCOUNT_IDS) {
    if (IN_BROWSER.has(id) && keys[id] && !fetching[id]) {
      const l = live[id];
      const saved = docs[id];
      const at = l ? l.at : saved ? millis(saved.updatedAt) : 0;
      // A failed read is retried after half a minute (Try again), a good one after 15 minutes.
      if (Date.now() - at > (l && l.error ? 30e3 : FRESH)) refresh(id).then(push);
    }
  }
  return [...localReports(), ...ACCOUNT_IDS.map(accountReport)];
}
const push = () => window.AIPage && gotKeys && gotDocs && window.AIPage.update(build());

window.AI_SOURCE = {
  async load() {
    await loaded;
    return build();
  },
  async connect(id, key) {
    const clean = String(key || '').trim();
    const wrong = checkKey(id, clean);
    if (wrong) throw new Error(wrong);
    if (IN_BROWSER.has(id)) {
      // Checked with the provider first: a key that doesn't work is never saved.
      const report = await ACCOUNTS[id].fetch(clean, (...a) => fetch(...a), Date.now());
      live[id] = { at: Date.now(), report };
      await setDoc(doc(db, 'users', user.uid, 'keys', id), { key: clean, addedAt: new Date().toISOString() });
      keys[id] = { key: clean, addedAt: new Date().toISOString() };
      await setDoc(doc(db, 'users', user.uid, 'reports', id), { kind: 'account', provider: id, report: JSON.stringify(report), error: null, updatedAt: serverTimestamp() });
      await saveCard(id, report);
    } else {
      await setDoc(doc(db, 'users', user.uid, 'keys', id), { key: clean, addedAt: new Date().toISOString() });
      keys[id] = { key: clean, addedAt: new Date().toISOString() };
      await deleteDoc(doc(db, 'users', user.uid, 'reports', id)).catch(() => {});
    }
    return build();
  },
  async disconnect(id) {
    await deleteDoc(doc(db, 'users', user.uid, 'keys', id));
    await deleteDoc(doc(db, 'users', user.uid, 'reports', id)).catch(() => {});
    await saveCard(id, null);
    delete keys[id];
    delete live[id];
    return build();
  },
  keyNote(r) {
    const key = r.keyName.replace(/^Admin/, 'admin');
    if (IN_BROWSER.has(r.id)) return `Paste your ${key}. It's saved in your account, where only you can read it, and only ever sent to ${r.name.replace(' API', '')} itself, by your browser, to read your usage.`;
    return `Paste your ${key}. It's saved in your account, where only you and your linked computer can read it. Anthropic doesn't let websites read usage, so your computer sends it to Anthropic every 15 minutes while it's on.`;
  },
};

let release;
const loaded = new Promise((resolve) => (release = resolve));
const settle = () => gotKeys && gotDocs && release();
onSnapshot(collection(db, 'users', user.uid, 'keys'), (snap) => {
  keys = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
  gotKeys = true;
  settle();
  push();
}, () => { gotKeys = true; settle(); });
onSnapshot(collection(db, 'users', user.uid, 'reports'), (snap) => {
  docs = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
  gotDocs = true;
  settle();
  push();
}, () => { gotDocs = true; settle(); });

window.dispatchEvent(new Event('ai-source'));
