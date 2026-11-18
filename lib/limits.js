'use strict';
/**
 * Plan limits (what /usage shows) are not in the transcripts: Claude Code learns
 * them from each API response. The bundled `plan-usage-reporter` mod writes
 * them, per session, to <dataDir>/sessions/<sessionId>.json after every turn:
 *
 *   { v: 1, sessionId, cwd, model, updatedAt, rateLimits: [{ kind, percentUsed, resetsAt }],
 *     context: { tokens, window, percent }, costUsd }
 *
 * This module reads those files, keeps a history of readings, and projects
 * when a window will run out at the current pace.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');

const LABELS = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly · all models',
  spend_limit: 'Spend limit',
};
const WINDOW_MS = { five_hour: 5 * 3600e3, seven_day: 7 * 24 * 3600e3 };
const HISTORY_KEEP_MS = 8 * 24 * 3600e3;
const STALE_MS = 30 * 60e3;

class LimitsTracker {
  constructor({ reporterDataDir, historyFile }) {
    this.sessionsDir = path.join(reporterDataDir, 'sessions');
    this.historyFile = historyFile;
    this.history = []; // { t, kind, percentUsed, resetsAt }
    this.latest = null; // { readAt, sessionId, windows }
    this.sessions = new Map(); // sessionId -> { updatedAt, context, costUsd, model }
    this.signature = '';
  }

  async loadHistory() {
    try {
      const text = await fsp.readFile(this.historyFile, 'utf8');
      const cutoff = Date.now() - HISTORY_KEEP_MS;
      this.history = text
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((h) => h && h.t >= cutoff);
    } catch {
      this.history = [];
    }
  }

  /** Re-reads the reporter files. Resolves true when anything changed. */
  async refresh() {
    let names = [];
    try {
      names = (await fsp.readdir(this.sessionsDir)).filter((n) => n.endsWith('.json'));
    } catch {
      // Reporter not installed yet, or no session has reported.
    }
    const sessions = new Map();
    let latest = null;
    for (const name of names) {
      let data;
      try {
        data = JSON.parse(await fsp.readFile(path.join(this.sessionsDir, name), 'utf8'));
      } catch {
        continue; // half-written or foreign file
      }
      if (!data || !data.sessionId || !Number.isFinite(data.updatedAt)) continue;
      sessions.set(data.sessionId, {
        updatedAt: data.updatedAt,
        context: data.context || null,
        costUsd: Number.isFinite(data.costUsd) ? data.costUsd : null,
        model: data.model || null,
        cwd: data.cwd || null,
      });
      const windows = Array.isArray(data.rateLimits) ? data.rateLimits.filter((w) => w && w.kind && Number.isFinite(w.percentUsed)) : [];
      if (windows.length && (!latest || data.updatedAt > latest.readAt)) {
        latest = { readAt: data.updatedAt, sessionId: data.sessionId, windows };
      }
    }
    this.sessions = sessions;
    this.latest = latest;
    if (latest) await this.recordHistory(latest);
    const signature = JSON.stringify([latest, [...sessions.entries()]]);
    const changed = signature !== this.signature;
    this.signature = signature;
    return changed;
  }

  async recordHistory(latest) {
    const fresh = [];
    for (const w of latest.windows) {
      const last = [...this.history].reverse().find((h) => h.kind === w.kind);
      if (last && last.percentUsed === w.percentUsed && last.resetsAt === w.resetsAt) continue;
      fresh.push({ t: latest.readAt, kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt || null });
    }
    if (!fresh.length) return;
    this.history.push(...fresh);
    try {
      await fsp.mkdir(path.dirname(this.historyFile), { recursive: true });
      await fsp.appendFile(this.historyFile, fresh.map((h) => JSON.stringify(h)).join('\n') + '\n');
    } catch {
      // History is a nicety; projections just get less data.
    }
  }

  /**
   * Linear projection over the last 90 minutes of readings in the current window.
   * Null when there is too little movement to say anything.
   */
  project(kind, now = Date.now()) {
    const current = this.latest && this.latest.windows.find((w) => w.kind === kind);
    if (!current) return null;
    const points = this.history.filter((h) => h.kind === kind && h.resetsAt === (current.resetsAt || null) && h.t >= now - 90 * 60e3);
    if (points.length < 2) return null;
    const first = points[0];
    const last = points[points.length - 1];
    const span = last.t - first.t;
    if (span < 10 * 60e3 || last.percentUsed <= first.percentUsed) return null;
    const perMs = (last.percentUsed - first.percentUsed) / span;
    const etaAt = last.t + (100 - last.percentUsed) / perMs;
    const resetsAt = current.resetsAt ? Date.parse(current.resetsAt) : null;
    return {
      percentPerHour: Math.round(perMs * 3600e3 * 10) / 10,
      etaAt,
      runsOutBeforeReset: resetsAt ? etaAt < resetsAt : null,
    };
  }

  /**
   * The windows as the dashboard shows them. A window whose reset time has
   * passed since the last reading says nothing about the new one, so it moves
   * to `expired` instead of showing an old percentage.
   */
  view(now = Date.now()) {
    if (!this.latest) return { connected: false, windows: [], expired: [], sessionsReporting: this.sessions.size };
    const label = (kind) => LABELS[kind] || kind.replace(/_/g, ' ');
    const isExpired = (w) => !!w.resetsAt && Date.parse(w.resetsAt) <= now;
    return {
      connected: true,
      readAt: this.latest.readAt,
      ageMs: now - this.latest.readAt,
      stale: now - this.latest.readAt > STALE_MS,
      sessionsReporting: this.sessions.size,
      windows: this.latest.windows
        .filter((w) => !isExpired(w))
        .map((w) => ({
          kind: w.kind,
          label: label(w.kind),
          percentUsed: w.percentUsed,
          resetsAt: w.resetsAt || null,
          windowMs: WINDOW_MS[w.kind] || null,
          projection: this.project(w.kind, now),
        })),
      expired: this.latest.windows.filter(isExpired).map((w) => ({ kind: w.kind, label: label(w.kind), resetsAt: w.resetsAt })),
    };
  }
}

module.exports = { LimitsTracker, LABELS, WINDOW_MS, STALE_MS };
