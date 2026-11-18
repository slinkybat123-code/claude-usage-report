'use strict';
/**
 * Cloud copy: so you don't need the PC running to see your figures. When the
 * address-finder gist exists, the monitor also keeps your latest dashboard in
 * it (claude-usage-snapshot.json, with this PC's home folder replaced by "~")
 * and the phone summary (claude-usage-summary.json). The report page, the
 * phone apps and the offline dashboard read them while the PC is off or asleep.
 * Written at most every 10 minutes while something changed, and on quit.
 */
const { execFile } = require('node:child_process');

const MIN_GAP_MS = 10 * 60e3;

function gh(args, body, run = execFile) {
  return new Promise((resolve, reject) => {
    const child = run('gh', args, { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n')[0]));
      else resolve(stdout);
    });
    if (body != null && child && child.stdin) child.stdin.end(body);
  });
}

class Cloud {
  constructor(finder, run = execFile) {
    this.finder = finder;
    this.run = run;
    this.base = null; // https://gist.githubusercontent.com/<login>/<id>/raw/
    this.lastSent = '';
    this.lastAt = 0;
  }

  get enabled() {
    return Boolean(this.finder.id);
  }

  /** Where phones and the report page read the copy from. */
  async rawBase() {
    if (!this.enabled) return null;
    if (!this.base) {
      const login = JSON.parse(await gh(['api', 'user'], null, this.run)).login;
      if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new Error('unexpected GitHub login');
      this.base = `https://gist.githubusercontent.com/${login}/${this.finder.id}/raw/`;
    }
    return this.base;
  }

  /** Sends the copy when it changed and 10 minutes have passed (or force). Returns true if sent. */
  async publish({ summaryJson, snapshotJson }, { force = false } = {}) {
    if (!this.enabled || !snapshotJson) return false;
    const fingerprint = summaryJson; // the phone figures change whenever anything worth showing does
    if (!force && (fingerprint === this.lastSent || Date.now() - this.lastAt < MIN_GAP_MS)) return false;
    this.lastAt = Date.now();
    const body = JSON.stringify({
      files: {
        'claude-usage-summary.json': { content: summaryJson },
        'claude-usage-snapshot.json': { content: snapshotJson },
      },
    });
    await gh(['api', `gists/${this.finder.id}`, '--method', 'PATCH', '--input', '-'], body, this.run);
    this.lastSent = fingerprint;
    return true;
  }
}

module.exports = { Cloud, MIN_GAP_MS };
