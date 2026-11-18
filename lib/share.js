'use strict';
/**
 * Share with friends: an opt-in, made on this PC only. While it is on, the
 * monitor posts a small card of figures (spend, plan limits, how busy) to a
 * private ntfy.sh topic named after a friend code. Friends add that code in
 * the Android app's Friends tab. The card never holds chat titles, messages,
 * folder names or the dashboard's address. Stopping posts a "stopped" card
 * so friends see it at once, and throws the code away; sharing again makes a
 * new code.
 */
const fs = require('node:fs');
const path = require('node:path');
const { newCode, prettyCode } = require('./finder');

const NTFY = 'https://ntfy.sh';
const MIN_GAP_MS = 10 * 60e3; // ntfy.sh allows a few hundred posts a day; this stays far below
const REPOST_MS = 4 * 3600e3; // ntfy.sh keeps a post for 12 hours
const topicOf = (c) => `claude-usage-f-${c.toLowerCase()}`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The figures a friend sees. Nothing that names a chat, a folder or a message. */
function cardOf(snap, name) {
  const work = snap.work && snap.work.all && snap.work.all[0];
  const today = snap.windows && snap.windows.find((w) => w.key === 'today');
  return {
    v: 1,
    name,
    updatedAt: new Date().toISOString(),
    spend: {
      today: round2(snap.spend.today),
      week: round2(snap.spend.week),
      lastHour: round2(snap.spend.lastHour),
      allTime: round2(snap.spend.allTime),
      projected30Days: round2(snap.spend.projected30Days),
    },
    limits: snap.limits.stale ? [] : snap.limits.windows.map((w) => ({ label: w.label, percent: w.percentUsed, resetsAt: w.resetsAt })),
    activeChats: snap.activeSessions || 0,
    repliesToday: today ? today.totals.requests : 0,
    topWork: work && snap.spend.allTime ? { label: work.label, share: round2(work.cost / snap.spend.allTime) } : null,
  };
}

class Share {
  constructor(dataDir, fetchFn = (...a) => fetch(...a)) {
    this.file = path.join(dataDir, 'share.json');
    this.fetch = fetchFn;
    this.state = null; // { code, name, since }
    this.lastBody = null;
    this.lastPostAt = 0;
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (/^[2-9A-HJKMNP-Z]{10}$/.test(s.code) && typeof s.name === 'string') this.state = s;
    } catch {
      /* not sharing */
    }
  }

  get on() {
    return Boolean(this.state);
  }

  status() {
    return this.state ? { on: true, code: prettyCode(this.state.code), name: this.state.name, since: this.state.since } : { on: false };
  }

  start(name) {
    const clean = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 32);
    if (!clean) throw new Error('Give a name your friends will see');
    this.state = { code: this.state ? this.state.code : newCode(), name: clean, since: this.state ? this.state.since : new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    this.lastBody = null;
    this.lastPostAt = 0;
    return this.status();
  }

  async stop() {
    if (!this.state) return this.status();
    const { code, name } = this.state;
    this.state = null;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* already gone */
    }
    await this.post(code, JSON.stringify({ v: 1, name, stopped: true, updatedAt: new Date().toISOString() })).catch(() => {});
    return this.status();
  }

  post(code, body) {
    return this.fetch(`${NTFY}/${topicOf(code)}`, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, signal: AbortSignal.timeout(15000) }).then((r) => {
      if (!r.ok) throw new Error(`ntfy.sh answered ${r.status}`);
    });
  }

  /** Posts the card when the figures changed (at most every 10 minutes), or every 4 hours anyway. */
  async publish(snap, { force = false } = {}) {
    if (!this.state || !snap) return false;
    const card = cardOf(snap, this.state.name);
    const figures = JSON.stringify({ ...card, updatedAt: null });
    const now = Date.now();
    const due = force || (figures !== this.lastBody && now - this.lastPostAt >= MIN_GAP_MS) || now - this.lastPostAt >= REPOST_MS;
    if (!due) return false;
    this.lastPostAt = now; // set first so a slow post is not sent twice
    await this.post(this.state.code, JSON.stringify(card));
    this.lastBody = figures;
    return true;
  }
}

module.exports = { Share, cardOf, topicOf };
