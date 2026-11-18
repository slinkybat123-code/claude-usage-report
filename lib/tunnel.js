'use strict';
/**
 * Runs a tunnel that gives the remote listener an https address reachable from
 * other devices, and reports its state. The tunnel lives and dies with the
 * monitor: nothing is left configured after it stops.
 *
 *   tailscale         `tailscale serve`   your own devices only (they run Tailscale too)
 *   tailscale-funnel  `tailscale funnel`  public https address, stable
 *   cloudflare        `cloudflared tunnel --url`  public, no account, new address each start
 */
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const KINDS = {
  tailscale: {
    label: 'Tailscale',
    exe: 'tailscale',
    reach: 'Your devices that run Tailscale',
    args: (port) => ['serve', String(port)],
  },
  'tailscale-funnel': {
    label: 'Tailscale Funnel',
    exe: 'tailscale',
    reach: 'Any browser (public address)',
    args: (port) => ['funnel', String(port)],
  },
  cloudflare: {
    label: 'Cloudflare quick tunnel',
    exe: 'cloudflared',
    reach: 'Any browser (public address, changes each start)',
    args: (port) => ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
  },
};

const INSTALL_HINT = {
  tailscale: 'Tailscale is not installed. Get it from tailscale.com/download, sign in, and the monitor picks it up.',
  cloudflared: process.platform === 'win32'
    ? 'cloudflared is not installed. Put cloudflared.exe in the monitor\'s tools folder, or run: winget install --id Cloudflare.cloudflared'
    : 'cloudflared is not installed. Run the installer again, or: brew install cloudflared',
};

function knownLocations(exe) {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  // A copy dropped into the app's own tools/ folder needs no install (and no admin prompt).
  const bundled = path.join(__dirname, '..', 'tools', exe + (process.platform === 'win32' ? '.exe' : ''));
  if (process.platform === 'win32') {
    return exe === 'tailscale'
      ? [bundled, path.join(pf, 'Tailscale', 'tailscale.exe')]
      : [bundled, path.join(pf86, 'cloudflared', 'cloudflared.exe'), path.join(pf, 'cloudflared', 'cloudflared.exe'), local && path.join(local, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe')];
  }
  if (process.platform === 'darwin' && exe === 'tailscale') return [bundled, '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  return [bundled];
}

function findExe(exe) {
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  const onPath = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((dir) => exts.map((e) => path.join(dir, exe + e)));
  return [...knownLocations(exe), ...onPath].find((p) => p && fs.existsSync(p)) || null;
}

const TRY_CLOUDFLARE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
const TS_NET = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/i;
const TS_APPROVAL = /https:\/\/login\.tailscale\.com\/\S+/i;

/** Pulls what matters out of one line of tunnel output. */
function parseTunnelLine(kind, line) {
  const out = {};
  if (kind === 'cloudflare') {
    const url = (line.match(TRY_CLOUDFLARE) || []).find((u) => !/^https:\/\/api\./i.test(u));
    if (url) out.url = url.toLowerCase();
    const err = /\bERR\b\s*(.*)$/.exec(line);
    if (err) out.error = err[1].trim();
  } else {
    const approval = TS_APPROVAL.exec(line);
    if (approval) out.approvalUrl = approval[0];
    else {
      const url = TS_NET.exec(line);
      if (url) out.url = url[0].toLowerCase();
    }
    if (/\b(error|failed|not allowed|access denied)\b/i.test(line) && !out.url) out.error = line.trim();
  }
  return out;
}

function tailscaleStatus(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['status', '--json'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      let s = null;
      try {
        s = JSON.parse(stdout);
      } catch {
        // not JSON: the daemon is not running, or an old CLI
      }
      if (!s) return resolve({ error: String(stderr || (err && err.message) || 'Tailscale did not answer').trim().split('\n')[0] });
      if (s.BackendState === 'NeedsLogin') return resolve({ error: 'Tailscale is installed but not signed in. Open Tailscale and sign in.' });
      if (s.BackendState === 'Stopped') return resolve({ error: 'Tailscale is turned off. Turn it on from its tray icon.' });
      if (s.BackendState !== 'Running') return resolve({ error: `Tailscale is ${s.BackendState || 'not running'}.` });
      const dns = s.Self && s.Self.DNSName ? s.Self.DNSName.replace(/\.$/, '') : null;
      return resolve({ url: dns ? `https://${dns}` : null });
    });
  });
}

class Tunnel extends EventEmitter {
  /**
   * @param {string} kind  one of KINDS
   * @param {number} port  the remote listener's port
   * @param {object} [opts]  exe / find / prefixArgs / precheck / retryMs: overridable for tests
   */
  constructor(kind, port, opts = {}) {
    super();
    if (!KINDS[kind]) throw new Error(`unknown tunnel "${kind}"`);
    this.kind = kind;
    this.port = port;
    this.spec = KINDS[kind];
    this.opts = { prefixArgs: [], precheck: kind.startsWith('tailscale'), retryMs: 15000, ...opts };
    this.child = null;
    this.timer = null;
    this.stopped = false;
    this.state = { kind, label: this.spec.label, reach: this.spec.reach, state: 'off', url: null, approvalUrl: null, message: null };
  }

  status() {
    return { ...this.state };
  }

  set(patch) {
    const before = JSON.stringify(this.state);
    Object.assign(this.state, patch);
    if (JSON.stringify(this.state) !== before) this.emit('change', this.status());
  }

  retry(ms = this.opts.retryMs) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), ms);
  }

  async start() {
    if (this.stopped || this.child) return;
    const exe = this.opts.exe || (this.opts.find || findExe)(this.spec.exe);
    if (!exe) {
      this.set({ state: 'missing', url: null, approvalUrl: null, message: INSTALL_HINT[this.spec.exe] });
      return this.retry(this.opts.retryMs * 2);
    }
    if (this.opts.precheck) {
      const st = await tailscaleStatus(exe);
      if (this.stopped) return;
      if (st.error) {
        this.set({ state: 'error', url: null, approvalUrl: null, message: st.error });
        return this.retry();
      }
    }

    this.set({ state: 'starting', url: null, approvalUrl: null, message: null });
    let lastError = null;
    const child = spawn(exe, [...this.opts.prefixArgs, ...this.spec.args(this.port)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;

    const onLine = (line) => {
      const p = parseTunnelLine(this.kind, line);
      if (p.error) lastError = p.error;
      if (p.approvalUrl) this.set({ state: 'approval', approvalUrl: p.approvalUrl, message: null });
      if (p.url) this.set({ state: 'up', url: p.url, approvalUrl: null, message: null });
    };
    for (const stream of [child.stdout, child.stderr]) {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        lines.forEach(onLine);
      });
    }
    child.on('error', (err) => {
      lastError = err.message;
    });
    child.on('close', (code) => {
      this.child = null;
      if (this.stopped) return;
      this.set({ state: 'error', url: null, approvalUrl: null, message: lastError || `${path.basename(exe)} stopped (exit code ${code}). Trying again shortly.` });
      this.retry();
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.child) this.child.kill();
    this.child = null;
    this.set({ state: 'off', url: null, approvalUrl: null });
  }
}

module.exports = { KINDS, Tunnel, parseTunnelLine, findExe };
