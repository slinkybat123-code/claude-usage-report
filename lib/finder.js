'use strict';
/**
 * Address finder: lets the phone app find this PC's dashboard again after a
 * restart gives it a new online address. Two places can hold the address:
 *
 * - a pairing code (the usual one): the monitor posts its address to a
 *   private topic on ntfy.sh, a free message relay that needs no account.
 *   The topic name comes from a 10-character code like K7P2Q-X9M4R, which the
 *   phone app asks for. Anyone with the code can read the address, nothing
 *   else; ntfy.sh keeps a post for 12 hours, so it is posted again every 4.
 * - a secret gist in the user's GitHub account, through the GitHub CLI (`gh`),
 *   which also feeds the optional Claude Usage Report page.
 *
 * Both are off until data/finder.json says otherwise
 * (node scripts/setup-address-finder.js [--code] [--gist]).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const GIST_FILE = 'claude-usage-address.json';
const ID_RE = /^[0-9a-f]{20,40}$/;
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O, 1/I/L: easy to type from a screen
const CODE_RE = /^[2-9A-HJKMNP-Z]{10}$/;
const NTFY = 'https://ntfy.sh';
const REPOST_MS = 4 * 3600e3;

function gh(args, body, run = execFile) {
  return new Promise((resolve, reject) => {
    const child = run('gh', args, { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n')[0]));
      else resolve(stdout);
    });
    if (body != null && child && child.stdin) child.stdin.end(body);
  });
}

function record(url, extra = {}) {
  return JSON.stringify({ url, updatedAt: new Date().toISOString(), ...extra });
}

/** A new random pairing code, 10 characters (about 49 bits). */
function newCode() {
  let out = '';
  const bytes = crypto.randomBytes(20);
  for (let i = 0; out.length < 10; i++) {
    const b = bytes[i % bytes.length] ^ (i >= bytes.length ? crypto.randomBytes(1)[0] : 0);
    if (b < 248) out += ALPHABET[b % 31]; // 248 = 31 * 8: no bias
  }
  return out;
}

/** "k7p2q-x9m4r " -> "K7P2QX9M4R", or null. */
function normalizeCode(text) {
  const c = String(text || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return CODE_RE.test(c) ? c : null;
}

const prettyCode = (c) => `${c.slice(0, 5)}-${c.slice(5)}`;
const topicOf = (c) => `claude-usage-${c.toLowerCase()}`;

class Finder {
  constructor(dataDir, run = execFile, fetchFn = (...a) => fetch(...a)) {
    this.file = path.join(dataDir, 'finder.json');
    this.run = run;
    this.fetch = fetchFn;
    this.id = null;
    this.code = null;
    this.lastUrl = null;
    this.lastPostAt = 0;
    this.extra = {}; // also posted with the address: where the cloud copy and offline dashboard are
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (ID_RE.test(saved.id)) this.id = saved.id;
      if (CODE_RE.test(saved.code)) this.code = saved.code;
    } catch {
      /* not set up */
    }
  }

  get enabled() {
    return Boolean(this.id || this.code);
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ ...(this.id && { id: this.id }), ...(this.code && { code: this.code }) }, null, 2));
  }

  /** Makes the pairing code once and remembers it. */
  ensureCode() {
    if (!this.code) {
      this.code = newCode();
      this.save();
    }
    return this.code;
  }

  /** Makes the secret gist once and remembers its id. */
  async create() {
    if (this.id) return this.id;
    const body = JSON.stringify({
      description: 'Claude Usage Monitor: current dashboard address (written by the monitor)',
      public: false,
      files: { [GIST_FILE]: { content: JSON.stringify({ url: null, updatedAt: new Date().toISOString() }) } },
    });
    const out = JSON.parse(await gh(['api', 'gists', '--method', 'POST', '--input', '-'], body, this.run));
    if (!ID_RE.test(out.id)) throw new Error('GitHub did not return a gist id');
    this.id = out.id;
    this.save();
    return this.id;
  }

  /**
   * Writes the current address wherever it is kept. Returns true if anything
   * was sent. Unchanged addresses are posted again only when the relay copy
   * is about to expire (pass force to send anyway).
   */
  async publish(url, { force = false } = {}) {
    if (!this.enabled || !url) return false;
    const changed = url !== this.lastUrl;
    const stale = Date.now() - this.lastPostAt > REPOST_MS;
    if (!changed && !stale && !force) return false;
    const jobs = [];
    if (this.code) {
      jobs.push(
        this.fetch(`${NTFY}/${topicOf(this.code)}`, { method: 'POST', body: record(url, this.extra), headers: { 'Content-Type': 'text/plain' }, signal: AbortSignal.timeout(15000) }).then((r) => {
          if (!r.ok) throw new Error(`ntfy.sh answered ${r.status}`);
        }),
      );
    }
    if (this.id && (changed || force)) {
      jobs.push(gh(['api', `gists/${this.id}`, '--method', 'PATCH', '--input', '-'], JSON.stringify({ files: { [GIST_FILE]: { content: record(url, this.extra) } } }), this.run));
    }
    const results = await Promise.allSettled(jobs);
    const failed = results.find((r) => r.status === 'rejected');
    if (results.some((r) => r.status === 'fulfilled')) {
      this.lastUrl = url;
      this.lastPostAt = Date.now();
    }
    if (failed) throw failed.reason;
    return true;
  }
}

/** Reads the address posted under a pairing code (used by tests and the setup script). */
async function lookupCode(code, fetchFn = (...a) => fetch(...a)) {
  const c = normalizeCode(code);
  if (!c) return null;
  const r = await fetchFn(`${NTFY}/${topicOf(c)}/json?poll=1&since=all`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const lines = (await r.text()).split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev.event === 'message') return JSON.parse(ev.message);
    } catch {
      /* skip */
    }
  }
  return null;
}

module.exports = { Finder, GIST_FILE, ID_RE, CODE_RE, newCode, normalizeCode, prettyCode, topicOf, lookupCode, REPOST_MS };
