'use strict';
/**
 * Sign-in for the remote listener: one access key per install, exchanged for a
 * signed session cookie. Nothing is stored per device, so changing the key
 * (which also changes the signing secret) signs every device out at once.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE = 'cum_session';
const SESSION_MS = 30 * 24 * 3600e3;
const REFRESH_MS = 24 * 3600e3; // re-issue the cookie once a day, so 30 days counts from last use
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I

/** 25 symbols x 5 bits = 125 random bits, shown as XXXXX-XXXXX-XXXXX-XXXXX-XXXXX. */
function newAccessKey() {
  let s = '';
  for (const b of crypto.randomBytes(25)) s += ALPHABET[b & 31]; // 256 is a multiple of 32, so no bias
  return s.match(/.{5}/g).join('-');
}

/** Case, spaces and dashes do not matter when typing the key. */
const normalizeKey = (k) => (typeof k === 'string' ? k.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');

class AccessStore {
  constructor(file) {
    this.file = file;
    this.state = null;
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (s && typeof s.key === 'string' && typeof s.secret === 'string' && s.secret.length >= 32) this.state = s;
    } catch {
      // first run, or an unreadable file: start over with a new key
    }
    if (!this.state) this.rotate();
    return this;
  }

  rotate() {
    this.state = { v: 1, key: newAccessKey(), secret: crypto.randomBytes(32).toString('hex'), createdAt: Date.now() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    return this.state.key;
  }

  get key() {
    return this.state.key;
  }

  hmac(data) {
    return crypto.createHmac('sha256', this.state.secret).update(data).digest();
  }

  /** Constant-time: both sides are hashed to the same length first. */
  checkKey(input) {
    const given = normalizeKey(input);
    return given.length > 0 && crypto.timingSafeEqual(this.hmac(given), this.hmac(normalizeKey(this.state.key)));
  }

  issue(now = Date.now()) {
    const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + SESSION_MS })).toString('base64url');
    return `${payload}.${this.hmac(payload).toString('base64url')}`;
  }

  /** Returns the claims of a valid, unexpired token, else null. */
  verify(token, now = Date.now()) {
    if (typeof token !== 'string' || token.length > 512) return null;
    const [payload, sig, extra] = token.split('.');
    if (!payload || !sig || extra !== undefined) return null;
    const want = this.hmac(payload);
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!(claims.exp > now) || !(claims.iat <= now + 60e3)) return null;
      return claims;
    } catch {
      return null;
    }
  }
}

/** Failed sign-ins: per client and in total, over a sliding window. */
class LoginLimiter {
  constructor({ perClient = 10, total = 50, windowMs = 15 * 60e3 } = {}) {
    Object.assign(this, { perClient, total, windowMs });
    this.byClient = new Map();
    this.all = [];
  }

  prune(now) {
    const cutoff = now - this.windowMs;
    this.all = this.all.filter((t) => t > cutoff);
    for (const [k, list] of this.byClient) {
      const kept = list.filter((t) => t > cutoff);
      if (kept.length) this.byClient.set(k, kept);
      else this.byClient.delete(k);
    }
  }

  /** Milliseconds until this client may try again; 0 when it may try now. */
  retryAfter(client, now = Date.now()) {
    this.prune(now);
    const mine = this.byClient.get(client) || [];
    const waits = [];
    if (mine.length >= this.perClient) waits.push(mine[mine.length - this.perClient] + this.windowMs - now);
    if (this.all.length >= this.total) waits.push(this.all[this.all.length - this.total] + this.windowMs - now);
    return waits.length ? Math.max(1, ...waits) : 0;
  }

  fail(client, now = Date.now()) {
    const list = this.byClient.get(client) || [];
    list.push(now);
    this.byClient.set(client, list);
    this.all.push(now);
  }

  /** A sign-in worked: forget this client's attempts, in its own count and the total. */
  succeed(client) {
    for (const t of this.byClient.get(client) || []) {
      const i = this.all.indexOf(t);
      if (i >= 0) this.all.splice(i, 1);
    }
    this.byClient.delete(client);
  }
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function sessionCookie(token, secure) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function clearedCookie(secure) {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * The remote listener only ever sees the tunnel connecting from 127.0.0.1, so
 * the client is whoever the nearest proxy says it is: Cloudflare's own header,
 * else the last X-Forwarded-For entry (the one the proxy appended, not one the
 * client sent).
 */
function clientId(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (xff.length) return xff[xff.length - 1];
  return req.socket.remoteAddress || 'unknown';
}

function isHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || String(req.headers['cf-visitor'] || '').includes('https');
}

/** POSTs must come from a page on the same host the request was sent to. */
function sameOrigin(req) {
  try {
    return !!req.headers.host && new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = {
  COOKIE,
  SESSION_MS,
  REFRESH_MS,
  newAccessKey,
  normalizeKey,
  AccessStore,
  LoginLimiter,
  readCookie,
  sessionCookie,
  clearedCookie,
  clientId,
  isHttps,
  sameOrigin,
  readBody,
};
