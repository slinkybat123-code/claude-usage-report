#!/usr/bin/env node
'use strict';
/**
 * Claude Usage Monitor: a live dashboard of Claude Code token usage and plan
 * limits, with an exportable diagnostic report. No dependencies.
 *
 *   node server.js [--port 4747] [--open]
 *                  [--tunnel tailscale|tailscale-funnel|cloudflare] [--remote] [--remote-port 4748]
 *                  [--data-dir ./data]
 *
 * Two listeners, both on 127.0.0.1:
 *   - the local dashboard (PORT): no sign-in, reachable from this PC only;
 *   - the remote dashboard (REMOTE_PORT, with --remote or --tunnel): read-only,
 *     and every request needs the access key. A tunnel publishes it to your
 *     phone; it is never reachable otherwise.
 *
 * Reads ~/.claude/projects (transcripts) and ~/.claude/usage-monitor (written by
 * the bundled reporter mod).
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const { TranscriptScanner } = require('./lib/scanner');
const { LimitsTracker } = require('./lib/limits');
const { buildSnapshot } = require('./lib/aggregate');
const { renderReport } = require('./lib/report');
const remote = require('./lib/remote');
const { KINDS: TUNNELS, Tunnel } = require('./lib/tunnel');

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const PORT = Number(argValue('--port') || process.env.PORT || 4747);
const HOST = '127.0.0.1';
const TUNNEL = argValue('--tunnel') || process.env.USAGE_MONITOR_TUNNEL || null;
const REMOTE = args.includes('--remote') || !!TUNNEL;
// No access key: whoever has the tunnel address can view (read-only). The random address is the only guard.
const NO_SIGN_IN = args.includes('--no-sign-in') || process.env.USAGE_MONITOR_NO_SIGN_IN === '1';
const REMOTE_PORT = Number(argValue('--remote-port') || process.env.REMOTE_PORT || PORT + 1);
const APP_DIR = __dirname;
const DATA_DIR = path.resolve(argValue('--data-dir') || process.env.USAGE_MONITOR_DATA_DIR || path.join(APP_DIR, 'data'));
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const REPORTER_DATA_DIR = path.join(CLAUDE_DIR, 'usage-monitor');
const MOD_NAME = 'plan-usage-reporter';
const MOD_SRC = path.join(APP_DIR, 'reporter-mod');
const MOD_DEST = path.join(CLAUDE_DIR, 'skills', MOD_NAME);
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const REPORTS_DIR = process.env.USAGE_MONITOR_REPORTS_DIR || path.join(APP_DIR, 'reports');

if (TUNNEL && !TUNNELS[TUNNEL]) {
  console.error(`Unknown --tunnel "${TUNNEL}". Use one of: ${Object.keys(TUNNELS).join(', ')}`);
  process.exit(2);
}

const scanner = new TranscriptScanner(PROJECTS_DIR);
const limits = new LimitsTracker({
  reporterDataDir: REPORTER_DATA_DIR,
  historyFile: path.join(DATA_DIR, 'limits-history.jsonl'),
});
const { Finder, prettyCode } = require('./lib/finder');
const { Share } = require('./lib/share');
const { qrSvg } = require('./lib/qr');
const finder = new Finder(DATA_DIR);
const share = new Share(DATA_DIR);
const friends = new (require('./lib/friends').Friends)(DATA_DIR);
const cloud = new (require('./lib/cloud').Cloud)(finder);
const ai = new (require('./lib/ai').AI)(DATA_DIR, { snapshot: () => snapshot });
/** This PC's home folder, in every spelling it takes inside JSON; replaced by "~" in anything that leaves the PC. */
const HOME_RE = (() => {
  const home = os.homedir();
  const forms = [JSON.stringify(home).slice(1, -1), home.replace(/\\/g, '/')];
  return new RegExp(forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
})();
let remoteJson = '';
/** The published Claude Usage Report page (data/site.json), allowed to show the remote dashboard in a frame. */
const SITE = (() => {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'site.json'), 'utf8'));
    return /^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(s.origin) ? s : null;
  } catch {
    return null;
  }
})();
/** How this copy was installed: 'win-exe' (Windows installer), 'mac-app' (the Mac app), or null (zip or source). */
const PACKAGED = process.env.CLAUDE_USAGE_PACKAGED || (fs.existsSync(path.join(APP_DIR, 'node', 'node.exe')) ? 'win-exe' : null);
/** Where the phone web app lives (for iPhone): your published site, or the one the package came from. */
const WEB_APP = (() => {
  if (SITE && SITE.url) return new URL('app/', SITE.url).href;
  try {
    const l = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'links.json'), 'utf8'));
    return /^https:\/\/[a-z0-9.-]+\/[\w./-]*$/i.test(l.webApp || '') ? l.webApp : null;
  } catch {
    return null;
  }
})();
const access = REMOTE && !NO_SIGN_IN ? new remote.AccessStore(path.join(DATA_DIR, 'remote.json')).load() : null;
const limiter = new remote.LoginLimiter();
const tunnel = TUNNEL ? new Tunnel(TUNNEL, REMOTE_PORT) : null;

let snapshot = null;
let snapshotJson = '';
const clients = new Set();

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function reporterStatus() {
  const shipped = await readJson(path.join(MOD_SRC, '.claude-plugin', 'plugin.json'));
  const installed = await readJson(path.join(MOD_DEST, '.claude-plugin', 'plugin.json'));
  return {
    installed: !!(installed && installed.name === MOD_NAME),
    installedVersion: installed ? installed.version : null,
    shippedVersion: shipped ? shipped.version : null,
    updateAvailable: !!(installed && shipped && installed.version !== shipped.version),
    path: MOD_DEST,
  };
}

/** What every viewer may know about remote access. The key itself never goes in a snapshot. */
function remoteStatus() {
  return { enabled: REMOTE, signIn: !!access, port: REMOTE ? REMOTE_PORT : null, tunnel: tunnel ? tunnel.status() : null };
}

async function rebuild(force = false) {
  const [scanned, limitsChanged] = await Promise.all([scanner.scan(), limits.refresh()]);
  if (!force && !scanned && !limitsChanged && snapshot) return;
  snapshot = buildSnapshot({ scanner, limits });
  snapshot.reporter = await reporterStatus();
  snapshot.remote = remoteStatus();
  snapshot.paths = { claudeDir: CLAUDE_DIR, projectsDir: PROJECTS_DIR, reporterDataDir: REPORTER_DATA_DIR };
  snapshot.site = SITE ? { url: SITE.url } : null;
  snapshotJson = JSON.stringify(snapshot);
  remoteJson = snapshotJson.replace(HOME_RE, '~');
  for (const c of clients) push(c);
  if (cloud.enabled) {
    cloud
      .publish({ summaryJson: JSON.stringify(summaryOf(snapshot)), snapshotJson: remoteJson })
      .then((sent) => sent && console.log('Cloud copy: saved to your gist.'), (e) => console.log(`Cloud copy: could not save (${e.message}).`));
  }
  if (share.on) share.publish(snapshot).catch((e) => console.log(`Share with friends: could not post (${e.message}).`));
}

/** The address the phone app pairs with, and a QR code that opens the pair page on a phone. */
function pairInfo() {
  const t = tunnel ? tunnel.status() : null;
  const url = t && t.state === 'up' ? t.url : null;
  if (!finder.code) return { code: null, url };
  const pairUrl = url ? `${url}/pair?code=${finder.code}` : null;
  return { code: prettyCode(finder.code), url, pairUrl, qr: pairUrl ? qrSvg(pairUrl) : null };
}

// One rebuild at a time; requests that arrive meanwhile fold into one more.
let running = null;
let queued = false;
function schedule(force = false) {
  if (running) {
    queued = true;
    return running;
  }
  running = rebuild(force)
    .catch((err) => console.error('rebuild failed:', err))
    .finally(() => {
      running = null;
      if (queued) {
        queued = false;
        schedule();
      }
    });
  return running;
}

function watch() {
  try {
    let timer = null;
    fs.watch(PROJECTS_DIR, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => schedule(), 250);
    });
  } catch {
    // fs.watch can be unavailable (network drives); the poll below still runs.
  }
  setInterval(() => schedule(), 2000); // catches anything the watcher missed, plus reporter files
  setInterval(() => schedule(true), 60000); // rolling windows move even when nothing is written
}

// ---------- responses ----------

const JSON_TYPE = 'application/json; charset=utf-8';
const TYPES = {
  '.apk': 'application/vnd.android.package-archive',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, { type = JSON_TYPE, headers = {}, gzip = false } = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const h = { ...BASE_HEADERS, 'Content-Type': type, ...headers };
  if (res.siteOrigin) {
    // Remote listener only: the Claude Usage Report page may show the dashboard in a frame.
    delete h['X-Frame-Options'];
    h['Content-Security-Policy'] = h['Content-Security-Policy'].replace("frame-ancestors 'none'", `frame-ancestors ${res.siteOrigin}`);
  }
  if (gzip && buf.length > 1024 && !type.startsWith('image/png')) {
    buf = zlib.gzipSync(buf);
    h['Content-Encoding'] = 'gzip';
    h.Vary = 'Accept-Encoding';
  }
  h['Content-Length'] = buf.length;
  res.writeHead(status, h);
  res.end(buf);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Remote viewers get at most one snapshot every 3 s; the latest one always arrives. */
function push(c) {
  const wait = c.minGapMs - (Date.now() - c.lastSent);
  if (wait > 0) {
    c.timer ??= setTimeout(() => {
      c.timer = null;
      push(c);
    }, wait);
    return;
  }
  c.lastSent = Date.now();
  c.out.write(`event: snapshot\ndata: ${c.remote ? remoteJson : snapshotJson}\n\n`);
}

function openEvents(req, res, ctx) {
  const headers = { ...BASE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' };
  let out = res;
  if (ctx.gzip) {
    // About 54 kB of JSON per update shrinks to about 8 kB: worth it on a phone.
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
    out = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH });
    out.pipe(res);
  }
  res.writeHead(200, headers);
  const client = { out, lastSent: 0, timer: null, minGapMs: ctx.remote ? 3000 : 0, remote: ctx.remote };
  clients.add(client);
  push(client);
  const ping = setInterval(() => out.write(': ping\n\n'), 20000); // keeps proxies from timing the stream out
  req.on('close', () => {
    clearInterval(ping);
    clearTimeout(client.timer);
    clients.delete(client);
    if (out !== res) out.end();
  });
}

async function serveStatic(res, pathname, ctx) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  const type = TYPES[path.extname(file)];
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !type) return send(res, 404, '{"error":"not found"}');
  let body;
  try {
    body = await fsp.readFile(file);
  } catch {
    return send(res, 404, '{"error":"not found"}');
  }
  if (ctx.remote && (rel === 'index.html' || rel === 'ai.html')) body = Buffer.from(String(body).replace('<body>', '<body data-mode="remote">'));
  return send(res, 200, body, { type, gzip: ctx.gzip });
}

// ---------- routes ----------

/** The few figures a phone widget or tile needs: about 1 kB instead of the full snapshot. */
function summaryOf(s) {
  const top = s.work.all[0];
  return {
    v: 1,
    generatedAt: s.generatedAt,
    spend: {
      allTime: s.spend.allTime,
      today: s.spend.today,
      week: s.spend.week,
      lastHour: s.spend.lastHour,
      dailyAverage: s.spend.dailyAverage,
      projected30Days: s.spend.projected30Days,
    },
    limits: s.limits.windows.map((w) => ({ kind: w.kind, label: w.label, percent: w.percentUsed, resetsAt: w.resetsAt })),
    limitsStale: Boolean(s.limits.stale),
    activeChats: s.activeSessions,
    chats: s.leaderboard.slice(0, 5).map((r) => ({
      title: r.title,
      cost: r.cost,
      costToday: r.costToday,
      active: r.active,
      last: r.last ? { who: r.last.who, text: r.last.text.slice(0, 220), ts: r.last.ts } : null,
    })),
    topWork: top ? { label: top.label, cost: top.cost, share: s.spend.allTime ? top.cost / s.spend.allTime : 0 } : null,
  };
}

async function route(req, res, url, ctx) {
  if (!snapshot) await schedule(true);

  switch (`${req.method} ${url.pathname}`) {
    case 'GET /api/snapshot': {
      const download = url.searchParams.has('download');
      const body = ctx.remote ? remoteJson : snapshotJson;
      return send(res, 200, download ? JSON.stringify(JSON.parse(body), null, 2) : body, {
        gzip: ctx.gzip,
        headers: download ? { 'Content-Disposition': `attachment; filename="claude-usage-${stamp()}.json"` } : {},
      });
    }
    case 'GET /api/summary': {
      const headers = { 'Cache-Control': 'no-store' };
      // The web app (iPhone and any browser) reads these figures from its own address.
      // Anyone who has this address can already read them, so any page may; nothing else is opened up.
      if (ctx.remote) headers['Access-Control-Allow-Origin'] = '*';
      return send(res, 200, JSON.stringify(summaryOf(snapshot)), { gzip: ctx.gzip, headers });
    }
    case 'GET /api/events':
      return openEvents(req, res, ctx);
    case 'GET /pair':
      return serveStatic(res, '/pair.html', ctx);
    case 'GET /ai':
      return serveStatic(res, '/ai.html', ctx);
    case 'GET /api/ai': {
      // Usage reports only: keys never leave this PC, and remote viewers get "~" for the home folder.
      const json = JSON.stringify({ ais: await ai.all() });
      return send(res, 200, ctx.remote ? json.replace(HOME_RE, '~') : json, { gzip: ctx.gzip });
    }
    case 'GET /api/whoami':
      return send(res, 200, JSON.stringify({ remote: ctx.remote, platform: process.platform, packaged: PACKAGED, webApp: WEB_APP, finder: finder.id, code: finder.code, site: SITE ? SITE.url : null, apkBytes: await fsp.stat(path.join(PUBLIC_DIR, 'claude-usage.apk')).then((st) => st.size, () => 0) }));
    case 'GET /report': {
      const html = renderReport(ctx.remote ? JSON.parse(remoteJson) : snapshot);
      if (!url.searchParams.has('download')) return send(res, 200, html, { type: TYPES['.html'], gzip: ctx.gzip });
      const name = `claude-usage-report-${stamp()}.html`;
      if (!ctx.remote) {
        // A copy stays on this PC; downloads from other devices do not write here.
        await fsp.mkdir(REPORTS_DIR, { recursive: true });
        await fsp.writeFile(path.join(REPORTS_DIR, name), html);
      }
      return send(res, 200, html, { type: TYPES['.html'], gzip: ctx.gzip, headers: { 'Content-Disposition': `attachment; filename="${name}"` } });
    }
    default:
      break;
  }

  // Changes to this PC only from this PC: none of these exist on the remote listener.
  if (!ctx.remote) {
    switch (`${req.method} ${url.pathname}`) {
      case 'POST /api/reporter/install': {
        await fsp.cp(MOD_SRC, MOD_DEST, { recursive: true, force: true, filter: (src) => !src.includes(`${path.sep}tests`) });
        await schedule(true);
        return send(res, 200, JSON.stringify(await reporterStatus()));
      }
      case 'POST /api/reporter/uninstall': {
        const status = await reporterStatus();
        if (status.installed) await fsp.rm(MOD_DEST, { recursive: true, force: true }); // only ever our own plugin folder
        await schedule(true);
        return send(res, 200, JSON.stringify(await reporterStatus()));
      }
      case 'POST /api/quit':
        // Save the cloud copy before going, so phones show the latest figures while the PC is off.
        if (cloud.enabled) await cloud.publish({ summaryJson: JSON.stringify(summaryOf(snapshot)), snapshotJson: remoteJson }, { force: true }).catch(() => {});
        send(res, 200, '{"ok":true}');
        console.log('Stopped from the dashboard.');
        setTimeout(() => {
          if (tunnel) tunnel.stop();
          process.exit(0);
        }, 150);
        return undefined;
      case 'GET /api/pair':
        return send(res, 200, JSON.stringify(pairInfo()));
      case 'POST /api/pair': {
        finder.ensureCode();
        const t = tunnel ? tunnel.status() : null;
        if (t && t.state === 'up') await finder.publish(t.url, { force: true }).catch((e) => console.log(`Address finder: ${e.message}`));
        return send(res, 200, JSON.stringify(pairInfo()));
      }
      case 'GET /api/friends':
        if (Date.now() - friends.checkedAt > 60e3) await friends.refresh();
        return send(res, 200, JSON.stringify({ friends: friends.view(), you: { today: snapshot.spend.today, week: snapshot.spend.week } }));
      case 'POST /api/friends': {
        let code;
        try {
          code = JSON.parse(await remote.readBody(req, 1024)).code;
        } catch {
          return send(res, 400, '{"error":"bad request"}');
        }
        try {
          await friends.add(code);
        } catch (e) {
          return send(res, 400, JSON.stringify({ error: e.message }));
        }
        return send(res, 200, JSON.stringify({ friends: friends.view() }));
      }
      case 'POST /api/friends/remove': {
        try {
          friends.remove(JSON.parse(await remote.readBody(req, 1024)).code);
        } catch {
          return send(res, 400, '{"error":"bad request"}');
        }
        return send(res, 200, JSON.stringify({ friends: friends.view() }));
      }
      case 'POST /api/ai/connect': {
        let body;
        try {
          body = JSON.parse(await remote.readBody(req, 2048));
        } catch {
          return send(res, 400, '{"error":"bad request"}');
        }
        try {
          await ai.connect(body.id, body.key);
        } catch (e) {
          return send(res, 400, JSON.stringify({ error: e.message }));
        }
        console.log(`All your AIs: ${body.id} added.`);
        return send(res, 200, JSON.stringify({ ais: await ai.all() }));
      }
      case 'POST /api/ai/disconnect': {
        try {
          ai.disconnect(JSON.parse(await remote.readBody(req, 1024)).id);
        } catch {
          return send(res, 400, '{"error":"bad request"}');
        }
        return send(res, 200, JSON.stringify({ ais: await ai.all() }));
      }
      case 'GET /api/share':
        return send(res, 200, JSON.stringify(share.status()));
      case 'POST /api/share': {
        let name;
        try {
          name = JSON.parse(await remote.readBody(req, 1024)).name;
        } catch {
          return send(res, 400, '{"error":"bad request"}');
        }
        let status;
        try {
          status = share.start(name);
        } catch (e) {
          return send(res, 400, JSON.stringify({ error: e.message }));
        }
        await share.publish(snapshot, { force: true }).catch((e) => console.log(`Share with friends: could not post (${e.message}).`));
        console.log('Share with friends: on.');
        return send(res, 200, JSON.stringify(status));
      }
      case 'POST /api/share/stop':
        await share.stop();
        console.log('Share with friends: off.');
        return send(res, 200, JSON.stringify(share.status()));
      case 'GET /api/remote/key':
        if (!access) return send(res, 404, '{"error":"remote access is off"}');
        return send(res, 200, JSON.stringify({ key: access.key, url: tunnel ? tunnel.status().url : null }));
      case 'POST /api/remote/rotate':
        if (!access) return send(res, 404, '{"error":"remote access is off"}');
        access.rotate();
        console.log('New remote access key made; every device was signed out.');
        return send(res, 200, JSON.stringify({ key: access.key }));
      default:
        break;
    }
  }

  if (req.method !== 'GET') return send(res, 405, '{"error":"method not allowed"}');
  return serveStatic(res, url.pathname, ctx);
}

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

async function handleLocal(req, res) {
  // Transcript data stays on this machine: refuse other hosts (DNS rebinding) and cross-site writes.
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, '{"error":"forbidden host"}');
  if (req.method === 'POST' && !ALLOWED_ORIGINS.has(req.headers.origin)) return send(res, 403, '{"error":"forbidden origin"}');
  return route(req, res, new URL(req.url, `http://${req.headers.host}`), { remote: false, gzip: false });
}

// Served to anyone, so the sign-in page can load and a phone can add it to its home screen.
const REMOTE_PUBLIC = new Set(['/login', '/login.js', '/style.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']);

async function handleRemote(req, res) {
  const url = new URL(req.url, 'http://remote.invalid');
  if (SITE) res.siteOrigin = SITE.origin;
  const ctx = {
    remote: true,
    gzip: /\bgzip\b/.test(req.headers['accept-encoding'] || ''),
    secure: !!tunnel || remote.isHttps(req), // every tunnel here serves https
  };
  if (req.method === 'POST' && !remote.sameOrigin(req)) return send(res, 403, '{"error":"forbidden origin"}');
  if (!access) {
    // --no-sign-in: straight to the (read-only) dashboard.
    if (url.pathname === '/login') return send(res, 302, '', { type: 'text/plain', headers: { Location: '/' } });
    return route(req, res, url, ctx);
  }
  if (req.method === 'POST' && url.pathname === '/api/login') return login(req, res, ctx);
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    return send(res, 200, '{"ok":true}', { headers: { 'Set-Cookie': remote.clearedCookie(ctx.secure) } });
  }
  if (req.method === 'GET' && REMOTE_PUBLIC.has(url.pathname)) return serveStatic(res, url.pathname === '/login' ? '/login.html' : url.pathname, ctx);

  const claims = access.verify(remote.readCookie(req.headers.cookie, remote.COOKIE));
  if (!claims) {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      return send(res, 302, '', { type: 'text/plain', headers: { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` } });
    }
    return send(res, 401, '{"error":"sign in required"}');
  }
  if (Date.now() - claims.iat > remote.REFRESH_MS) res.setHeader('Set-Cookie', remote.sessionCookie(access.issue(), ctx.secure));
  return route(req, res, url, ctx);
}

async function login(req, res, ctx) {
  const who = remote.clientId(req);
  const wait = limiter.retryAfter(who);
  if (wait) {
    const sec = Math.ceil(wait / 1000);
    return send(res, 429, JSON.stringify({ error: `Too many wrong keys. Try again in ${Math.ceil(sec / 60)} min.` }), { headers: { 'Retry-After': String(sec) } });
  }
  // Counted before anything is awaited, so guesses sent in parallel can't slip past the limit.
  limiter.fail(who);
  let key;
  try {
    key = JSON.parse(await remote.readBody(req, 2048)).key;
  } catch {
    return send(res, 400, '{"error":"bad request"}');
  }
  if (!access.checkKey(key)) {
    await new Promise((r) => setTimeout(r, 400));
    return send(res, 401, '{"error":"That key does not match. Check the Remote access card on your PC."}');
  }
  limiter.succeed(who);
  return send(res, 200, '{"ok":true}', { headers: { 'Set-Cookie': remote.sessionCookie(access.issue(), ctx.secure) } });
}

// ---------- start ----------

function listen(handler, port, label) {
  const server = http.createServer((req, res) =>
    handler(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, '{"error":"internal"}');
    }),
  );
  return new Promise((resolve) => {
    server.on('error', (err) => {
      console.error(err.code === 'EADDRINUSE' ? `${label}: port ${port} is in use. Pick another with ${label === 'Remote' ? '--remote-port' : '--port'}.` : err);
      process.exit(1);
    });
    server.listen(port, HOST, () => resolve(server));
  });
}

async function main() {
  await limits.loadHistory();
  const t0 = Date.now();
  await schedule(true);
  console.log(`Read ${scanner.stats.files} transcripts (${scanner.stats.responses} API responses) in ${Date.now() - t0} ms`);
  watch();

  await listen(handleLocal, PORT, 'Local');
  const url = `http://localhost:${PORT}`;
  console.log(`Claude Usage Monitor: ${url}  (this PC only, Ctrl+C to stop)`);

  if (REMOTE) {
    await listen(handleRemote, REMOTE_PORT, 'Remote');
    console.log(
      `Remote access listener: http://127.0.0.1:${REMOTE_PORT}  ${access ? '(sign-in required; the access key is on the local dashboard)' : '(no sign-in: anyone with the tunnel address can view it, read-only)'}`,
    );
    if (tunnel) {
      tunnel.on('change', (s) => {
        const text = { up: `live at ${s.url}`, starting: 'starting…', approval: `needs your OK once: ${s.approvalUrl}`, missing: s.message, error: s.message, off: 'off' }[s.state];
        console.log(`${s.label}: ${text}`);
        if (s.state === 'up' && finder.enabled) {
          finder.publish(s.url).then(
            (sent) => sent && console.log('Address finder: new address saved.'),
            (e) => console.log(`Address finder: could not save the address (${e.message}).`),
          );
        }
        schedule(true);
      });
      // Phones learn where the cloud copy and the offline dashboard are along with the address.
      if (cloud.enabled) {
        cloud.rawBase().then((base) => {
          finder.extra = { cloud: base, ...(SITE && SITE.url && { offline: new URL('offline/', SITE.url).href }) };
        }, (e) => console.log(`Cloud copy: off (${e.message}).`));
      }
      tunnel.start();
      // ntfy.sh keeps a post for 12 hours: post the unchanged address again now and then.
      setInterval(() => {
        const t = tunnel.status();
        if (t.state === 'up' && finder.enabled) finder.publish(t.url).catch((e) => console.log(`Address finder: ${e.message}`));
      }, 30 * 60e3).unref();
      const stop = () => {
        tunnel.stop();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      process.on('exit', () => tunnel.stop());
    } else {
      console.log('No --tunnel given: point your own tunnel or reverse proxy at the remote listener.');
    }
  }

  if (args.includes('--open')) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
  }
}

if (require.main === module) main();
