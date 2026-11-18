'use strict';
/**
 * All your AIs: one report shape for every AI, so the AI window can show them
 * side by side. Claude Code comes from this dashboard; Codex CLI and Gemini CLI
 * from their files on this computer; Claude API, OpenAI API and OpenRouter from
 * a key you paste on this PC (kept in data/ai.json, sent only to that provider).
 *
 * Report: { id, name, kind, status, message, hasCost, spend{today,week,month,allTime},
 *   spendLabels, tokens{input,cached,output,reasoning,total}, requests,
 *   daily[{date,cost,tokens,requests}] (30 days), models[{model,cost,tokens,requests}],
 *   sessions[{title,lastTs,tokens,model}], notes[], updatedAt }
 */
const fs = require('node:fs');
const path = require('node:path');
const { LocalTool } = require('./ai-local');
const { ACCOUNTS } = require('./ai-accounts');

const DAY = 86400e3;
const LOCAL_TTL = 60e3;
const ACCOUNT_TTL = 15 * 60e3;
const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const PROVIDERS = [
  { id: 'claude-code', name: 'Claude Code', kind: 'local', where: 'This dashboard' },
  { id: 'codex', name: 'Codex CLI', kind: 'local', where: 'OpenAI Codex CLI on this computer (~/.codex)' },
  { id: 'gemini-cli', name: 'Gemini CLI', kind: 'local', where: 'Google Gemini CLI on this computer (~/.gemini)' },
  ...Object.entries(ACCOUNTS).map(([id, a]) => ({ id, name: a.name, kind: 'account', keyName: a.keyName, keyHelp: a.keyHelp })),
];

/** Token events from a local tool -> the shared report shape (local days, tokens only). */
function localReport(sessions, now) {
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(localDay(now - i * DAY));
  const byDay = new Map(days.map((d) => [d, { date: d, cost: null, tokens: 0, requests: 0 }]));
  const byModel = new Map();
  const tokens = { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
  let requests = 0;
  let allTokens = 0;
  const list = [];
  for (const s of sessions) {
    let sTokens = 0;
    let last = 0;
    let model = null;
    for (const e of s.events) {
      allTokens += e.total;
      sTokens += e.total;
      if (e.ts > last) {
        last = e.ts;
        model = e.model;
      }
      const day = byDay.get(localDay(e.ts));
      if (!day) continue;
      day.tokens += e.total;
      day.requests += 1;
      tokens.input += e.input;
      tokens.cached += e.cached;
      tokens.output += e.output;
      tokens.reasoning += e.reasoning;
      tokens.total += e.total;
      requests += 1;
      const m = byModel.get(e.model) || { model: e.model, cost: null, tokens: 0, requests: 0 };
      m.tokens += e.total;
      m.requests += 1;
      byModel.set(e.model, m);
    }
    if (sTokens) list.push({ title: s.session.title, lastTs: last, tokens: sTokens, model });
  }
  return {
    hasCost: false,
    spend: { today: null, week: null, month: null, allTime: null },
    tokens,
    allTimeTokens: allTokens,
    requests,
    daily: [...byDay.values()],
    models: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
    sessions: list.sort((a, b) => b.lastTs - a.lastTs).slice(0, 12),
  };
}

/** Claude Code, from this dashboard's own snapshot. */
function claudeCodeReport(snap) {
  const month = snap.windows.find((w) => w.key === 'month');
  const all = snap.windows.find((w) => w.key === 'all');
  const t = month ? month.totals : { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0, requests: 0 };
  return {
    status: 'ok',
    hasCost: true,
    spend: { today: snap.spend.today, week: snap.spend.week, month: snap.spend.month, allTime: snap.spend.allTime },
    spendLabels: { today: 'Today', week: 'This week (plan window)', month: 'Last 30 days', allTime: 'All time' },
    tokens: { input: t.input + t.cacheWrite + t.cacheRead, cached: t.cacheRead, output: t.output, reasoning: 0, total: t.total },
    allTimeTokens: all ? all.totals.total : t.total,
    requests: t.requests,
    daily: (snap.series.daily || []).slice(-30).map((d) => ({ date: localDay(d.t), cost: d.cost, tokens: d.total, requests: d.requests })),
    models: ((month || all).models || []).map((m) => ({ model: m.model, cost: m.cost, tokens: m.total, requests: m.requests })).sort((a, b) => b.cost - a.cost),
    sessions: (snap.leaderboard || []).slice(0, 12).map((r) => ({ title: r.title, lastTs: r.lastTs, tokens: r.tokens, model: r.model, cost: r.cost })),
    notes: ['Priced at API list rates, the way /cost does it. On a subscription you pay your plan price.'],
  };
}

class AI {
  constructor(dataDir, { fetchFn = (...a) => fetch(...a), snapshot = () => null, codexRoot, geminiRoot } = {}) {
    this.file = path.join(dataDir, 'ai.json');
    this.fetch = fetchFn;
    this.snapshot = snapshot;
    this.local = { codex: new LocalTool('codex', codexRoot), 'gemini-cli': new LocalTool('gemini', geminiRoot) };
    this.cache = new Map(); // id -> { at, report }
    this.keys = {};
    try {
      this.keys = JSON.parse(fs.readFileSync(this.file, 'utf8')).keys || {};
    } catch {
      /* none yet */
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ keys: this.keys }, null, 2));
  }

  async build(p, now) {
    const base = { id: p.id, name: p.name, kind: p.kind, where: p.where || null, keyName: p.keyName || null, keyHelp: p.keyHelp || null, updatedAt: now };
    if (p.id === 'claude-code') {
      const snap = this.snapshot();
      return snap ? { ...base, ...claudeCodeReport(snap) } : { ...base, status: 'empty', message: 'Reading your sessions…' };
    }
    if (p.kind === 'local') {
      const tool = this.local[p.id];
      if (!tool.found) return { ...base, status: 'not-found', message: `Not on this computer. Use ${p.name} here and it shows up by itself.` };
      const r = localReport(tool.scan(), now);
      return {
        ...base,
        ...r,
        status: r.allTimeTokens ? 'ok' : 'empty',
        message: r.allTimeTokens ? null : `Found ${p.name}, but no usage recorded yet.`,
        notes: [`${p.name} saves token counts, not prices, so there are no dollar figures. On a subscription you are not billed per token.`],
      };
    }
    const saved = this.keys[p.id];
    if (!saved) return { ...base, status: 'needs-key', message: `Paste your ${p.name} ${p.keyName.replace(/^Admin/, "admin")} to add it.` };
    try {
      const r = await ACCOUNTS[p.id].fetch(saved.key, this.fetch, now);
      return { ...base, ...r, status: 'ok', connectedAt: saved.addedAt };
    } catch (e) {
      return { ...base, status: 'error', message: e.message, connectedAt: saved.addedAt };
    }
  }

  /** Every AI's report, from cache when fresh. */
  async all({ force = false } = {}) {
    const now = Date.now();
    const out = await Promise.all(PROVIDERS.map(async (p) => {
      const hit = this.cache.get(p.id);
      const ttl = p.kind === 'account' ? ACCOUNT_TTL : LOCAL_TTL;
      if (!force && hit && now - hit.at < ttl && p.id !== 'claude-code') return hit.report;
      const report = await this.build(p, now);
      this.cache.set(p.id, { at: now, report });
      return report;
    }));
    return out;
  }

  /** Checks the key with the provider, and keeps it only if it works. */
  async connect(id, key) {
    const p = PROVIDERS.find((x) => x.id === id && x.kind === 'account');
    if (!p) throw new Error('Unknown AI account.');
    const clean = String(key || '').trim();
    if (!clean || clean.length > 300 || /\s/.test(clean)) throw new Error(`That doesn't look like a ${p.keyName.replace(/^Admin/, "admin")}.`);
    const report = await ACCOUNTS[id].fetch(clean, this.fetch, Date.now()); // throws with a readable message
    this.keys[id] = { key: clean, addedAt: new Date().toISOString() };
    this.save();
    this.cache.delete(id);
    return report;
  }

  disconnect(id) {
    delete this.keys[id];
    this.cache.delete(id);
    this.save();
  }
}

module.exports = { AI, PROVIDERS, localReport, claudeCodeReport };
