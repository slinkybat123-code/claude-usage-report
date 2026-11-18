'use strict';
/**
 * Friends you follow from this PC's dashboard: the same friend codes the
 * Android and iPhone apps use. A friend's figures arrive only because they
 * turned on Share with friends on their own computer; this reads their card
 * from ntfy.sh and keeps the list in data/friends.json. The list and cards are
 * shown on this PC's dashboard only, never to remote viewers, since your
 * friends agreed to share with you, not with whoever has your address.
 */
const fs = require('node:fs');
const path = require('node:path');
const { normalizeCode, prettyCode } = require('./finder');

const NTFY = 'https://ntfy.sh';
const topicOf = (c) => `claude-usage-f-${c.toLowerCase()}`;

/** The newest message body in ntfy's newline-separated JSON answer, or null. */
function latestMessage(ndjson) {
  const lines = String(ndjson || '').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev.event === 'message' && ev.message) return ev.message;
    } catch {
      /* skip */
    }
  }
  return null;
}

/** A friend card, trimmed to the fields we show; null when it isn't one. */
function cleanCard(body) {
  let c;
  try {
    c = JSON.parse(body);
  } catch {
    return null;
  }
  if (!c || typeof c !== 'object' || typeof c.name !== 'string') return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const s = c.spend || {};
  return {
    name: c.name.replace(/[\u0000-\u001f<>]/g, '').slice(0, 32) || 'Friend',
    stopped: c.stopped === true,
    updatedAt: Date.parse(c.updatedAt) || 0,
    spend: { today: n(s.today), week: n(s.week), lastHour: n(s.lastHour), allTime: n(s.allTime), projected30Days: n(s.projected30Days) },
    limits: Array.isArray(c.limits) ? c.limits.slice(0, 4).map((l) => ({ label: String(l.label || '').slice(0, 40), percent: Math.max(0, Math.min(100, Math.round(n(l.percent)))), resetsAt: l.resetsAt || null })) : [],
    activeChats: Math.max(0, Math.round(n(c.activeChats))),
    repliesToday: Math.max(0, Math.round(n(c.repliesToday))),
    topWork: c.topWork && typeof c.topWork.label === 'string' ? { label: c.topWork.label.slice(0, 40), share: n(c.topWork.share) } : null,
  };
}

class Friends {
  constructor(dataDir, fetchFn = (...a) => fetch(...a)) {
    this.file = path.join(dataDir, 'friends.json');
    this.fetch = fetchFn;
    this.codes = [];
    this.cards = new Map(); // code -> card
    this.checkedAt = 0;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.codes = (saved.codes || []).map(normalizeCode).filter(Boolean);
      for (const [code, card] of Object.entries(saved.cards || {})) if (this.codes.includes(code) && card) this.cards.set(code, card);
    } catch {
      /* no friends yet */
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ codes: this.codes, cards: Object.fromEntries(this.cards) }, null, 2));
  }

  async read(code) {
    const r = await this.fetch(`${NTFY}/${topicOf(code)}/json?poll=1&since=all`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`ntfy.sh answered ${r.status}`);
    const body = latestMessage(await r.text());
    return body ? cleanCard(body) : null;
  }

  /** Adds a friend by code once their card is found. */
  async add(text) {
    const code = normalizeCode(text);
    if (!code) throw new Error('A friend code has 10 letters and numbers, like K7P2Q-X9M4R.');
    if (this.codes.includes(code)) throw new Error('Already added.');
    const card = await this.read(code);
    if (!card) throw new Error('No one is sharing with that code. Check it with your friend.');
    if (card.stopped) throw new Error(`${card.name} has stopped sharing.`);
    this.codes.push(code);
    this.cards.set(code, card);
    this.save();
    return card;
  }

  remove(text) {
    const code = normalizeCode(text);
    this.codes = this.codes.filter((c) => c !== code);
    this.cards.delete(code);
    this.save();
  }

  /** Fetches every friend's newest card; keeps the last one when a read fails. */
  async refresh() {
    this.checkedAt = Date.now();
    let changed = false;
    await Promise.all(this.codes.map(async (code) => {
      try {
        const card = await this.read(code);
        if (card) {
          this.cards.set(code, card);
          changed = true;
        }
      } catch {
        /* keep the cached card */
      }
    }));
    if (changed) this.save();
  }

  view() {
    return this.codes.map((code) => ({ code: prettyCode(code), card: this.cards.get(code) || null }));
  }
}

module.exports = { Friends, cleanCard, latestMessage };
