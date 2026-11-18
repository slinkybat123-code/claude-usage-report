'use strict';
/**
 * Turns scanner records + limit readings into one snapshot: totals per time
 * window, per session / model / project breakdowns, time series and the
 * diagnostic findings. Pure: everything it needs is passed in.
 */
const path = require('node:path');
const { costOf, priceFor, PRICES_AS_OF } = require('./pricing');

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ACTIVE_MS = 5 * MIN;

function emptyTotals() {
  return { requests: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, webSearches: 0, cost: 0, costInput: 0, costOutput: 0, costCacheWrite: 0, costCacheRead: 0 };
}

/**
 * What kind of work a response was, judged by the tools it called. Checked in
 * this order, so a reply that edits a file and also reads one counts as editing.
 */
const WORK = [
  ['edit', 'Writing and editing files', /^(Edit|Write|MultiEdit|NotebookEdit)$/],
  ['shell', 'Running commands', /^(Bash|PowerShell|BashOutput|KillShell|Monitor|mcp__terminal__.*)$/],
  ['browser', 'Browser and screen control', /^mcp__(Claude_Browser|claude-in-chrome|computer-use)__/],
  ['web', 'Web research', /^(WebSearch|WebFetch)$/],
  ['agents', 'Running subagents', /^(Agent|Task|SendMessage|SubagentHandback)$/],
  ['connectors', 'Connected apps (MCP)', /^mcp__(?!ccd_|hub__)/],
  ['read', 'Reading and searching files', /^(Read|Grep|Glob|LS)$/],
  ['plan', 'Planning and housekeeping', /./],
];
const TALK = ['talk', 'Thinking and replying'];
/** The newest thing said in a chat's main thread: by you or by Claude. */
function lastMessage(meta) {
  const you = meta.lastPrompt ? { who: 'you', text: meta.lastPrompt, ts: meta.lastPromptTs || 0 } : null;
  const claude = meta.lastSay ? { who: meta.lastSayKind || 'claude', text: meta.lastSay, ts: meta.lastSayTs || 0 } : null;
  if (!you || !claude) return you || claude;
  return claude.ts >= you.ts ? claude : you;
}

function workOf(tools) {
  if (!tools || !tools.length) return TALK;
  return WORK.find(([, , re]) => tools.some((t) => re.test(t)));
}

function addTo(t, r) {
  t.requests++;
  t.input += r.input;
  t.output += r.output;
  t.cacheWrite += r.cacheWrite;
  t.cacheRead += r.cacheRead;
  t.webSearches += r.webSearches;
  t.total += r.input + r.output + r.cacheWrite + r.cacheRead;
  const c = r.cost;
  t.cost += c.total;
  t.costInput += c.input;
  t.costOutput += c.output;
  t.costCacheWrite += c.cacheWrite;
  t.costCacheRead += c.cacheRead;
}

function startOfLocalDay(ms, daysBack = 0) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).getTime();
}

function defineWindows(now, limitsView) {
  const reset = (kind, length) => {
    const w = limitsView.windows.find((x) => x.kind === kind);
    const at = w && w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    return Number.isFinite(at) ? { start: at - length, anchored: true } : { start: now - length, anchored: false };
  };
  const five = reset('five_hour', 5 * HOUR);
  const week = reset('seven_day', 7 * DAY);
  return [
    { key: 'fiveHour', label: five.anchored ? 'Current 5-hour window' : 'Last 5 hours', start: five.start, anchored: five.anchored },
    { key: 'today', label: 'Today', start: startOfLocalDay(now) },
    { key: 'week', label: week.anchored ? 'Current weekly window' : 'Last 7 days', start: week.start, anchored: week.anchored },
    { key: 'month', label: 'Last 30 days', start: now - 30 * DAY },
    { key: 'all', label: 'All time', start: 0 },
  ];
}

function projectLabel(cwd) {
  if (!cwd) return 'Unknown folder';
  if (/scratch-workspaces/i.test(cwd)) return 'No folder (app scratch)';
  return path.win32.basename(cwd) || cwd;
}

function buildSnapshot({ scanner, limits, now = Date.now() }) {
  const limitsView = limits.view(now);
  const windows = defineWindows(now, limitsView);
  const totals = {};
  const byModel = {};
  for (const w of windows) {
    totals[w.key] = emptyTotals();
    byModel[w.key] = new Map();
  }

  const sessionAgg = new Map();
  const projectAgg = new Map();
  const hourly = new Map();
  const daily = new Map();
  const hourStart = Math.floor(now / HOUR) * HOUR - 47 * HOUR;
  const dayStart = startOfLocalDay(now, 29);
  const last15 = emptyTotals();
  const subagentWeek = emptyTotals();
  const lastHour = emptyTotals();
  const workAll = new Map();
  const workWeek = new Map();
  const modelsSeen = new Set();
  const bump = (map, [key, label], r) => {
    let t = map.get(key);
    if (!t) map.set(key, (t = { key, label, ...emptyTotals() }));
    addTo(t, r);
  };

  for (const r of scanner.records) {
    r.cost = costOf(r); // recomputed each time: later transcript lines can still raise a response's output count
    modelsSeen.add(r.model);
    const work = workOf(r.tools);
    bump(workAll, work, r);
    if (r.ts >= windows[2].start) bump(workWeek, work, r);
    if (r.ts >= now - HOUR) addTo(lastHour, r);
    for (const w of windows) {
      if (r.ts < w.start) continue;
      addTo(totals[w.key], r);
      let m = byModel[w.key].get(r.model);
      if (!m) byModel[w.key].set(r.model, (m = emptyTotals()));
      addTo(m, r);
    }
    let s = sessionAgg.get(r.sessionId);
    if (!s) sessionAgg.set(r.sessionId, (s = { all: emptyTotals(), fiveHour: emptyTotals(), today: emptyTotals(), week: emptyTotals(), subagent: emptyTotals(), models: new Set(), work: new Map() }));
    s.work.set(work[1], (s.work.get(work[1]) || 0) + r.cost.total);
    addTo(s.all, r);
    if (r.ts >= windows[0].start) addTo(s.fiveHour, r);
    if (r.ts >= windows[1].start) addTo(s.today, r);
    if (r.ts >= windows[2].start) addTo(s.week, r);
    if (r.subagent) addTo(s.subagent, r);
    s.models.add(r.model);
    if (r.subagent && r.ts >= windows[2].start) addTo(subagentWeek, r);
    if (r.ts >= now - 15 * MIN) addTo(last15, r);
    if (r.ts >= hourStart) {
      const h = Math.floor(r.ts / HOUR) * HOUR;
      if (!hourly.has(h)) hourly.set(h, emptyTotals());
      addTo(hourly.get(h), r);
    }
    if (r.ts >= dayStart) {
      const d = startOfLocalDay(r.ts);
      if (!daily.has(d)) daily.set(d, emptyTotals());
      addTo(daily.get(d), r);
    }
  }

  const sessions = [];
  for (const [id, agg] of sessionAgg) {
    const meta = scanner.sessions.get(id) || {};
    const reported = limits.sessions.get(id);
    const ctxWindow = reported && reported.context && reported.context.window;
    const ctxTokens = reported && reported.context && Number.isFinite(reported.context.tokens) && reported.updatedAt >= (meta.contextTs || 0)
      ? reported.context.tokens
      : meta.contextTokens || 0;
    sessions.push({
      id,
      title: meta.title || projectLabel(meta.cwd),
      project: projectLabel(meta.cwd),
      cwd: meta.cwd || null,
      entrypoint: meta.entrypoint || null,
      version: meta.version || null,
      gitBranch: meta.gitBranch || null,
      model: (reported && reported.model) || meta.model || [...agg.models][0] || null,
      models: [...agg.models],
      firstTs: meta.firstTs || null,
      lastTs: meta.lastTs || null,
      active: !!meta.lastTs && now - meta.lastTs < ACTIVE_MS,
      tokens: agg.all,
      fiveHour: agg.fiveHour,
      today: agg.today,
      week: agg.week,
      subagent: agg.subagent,
      contextTokens: ctxTokens,
      contextWindow: ctxWindow || null,
      contextPercent: ctxWindow ? Math.round((ctxTokens / ctxWindow) * 100) : null,
      costUsd: reported ? reported.costUsd : null,
      reporting: !!reported,
      summary: {
        goal: meta.firstPrompt || null,
        latest: meta.lastPrompt && meta.lastPrompt !== meta.firstPrompt ? meta.lastPrompt : null,
        now: meta.lastSay || null,
        last: lastMessage(meta),
        prompts: meta.prompts || 0,
        files: meta.files ? meta.files.size : 0,
        work: [...agg.work].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([label, cost]) => ({ label, share: agg.all.cost ? cost / agg.all.cost : 0 })),
      },
    });
    const pKey = projectLabel(meta.cwd);
    let p = projectAgg.get(pKey);
    if (!p) projectAgg.set(pKey, (p = { project: pKey, sessions: 0, all: emptyTotals(), week: emptyTotals(), lastTs: 0 }));
    p.sessions++;
    for (const k of Object.keys(p.all)) {
      p.all[k] += agg.all[k];
      p.week[k] += agg.week[k];
    }
    p.lastTs = Math.max(p.lastTs, meta.lastTs || 0);
  }
  sessions.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));

  const hourlySeries = [];
  for (let i = 0; i < 48; i++) {
    const t = hourStart + i * HOUR;
    hourlySeries.push({ t, ...(hourly.get(t) || emptyTotals()) });
  }
  const dailySeries = [];
  for (let i = 29; i >= 0; i--) {
    const t = startOfLocalDay(now, i);
    dailySeries.push({ t, ...(daily.get(t) || emptyTotals()) });
  }

  const modelRows = (key) =>
    [...byModel[key].entries()].map(([model, t]) => ({ model, ...t })).sort((a, b) => b.total - a.total);
  const costs = sessions.filter((s) => s.costUsd != null);
  const all = totals.all;
  const last7 = dailySeries.slice(-7).reduce((sum, d) => sum + d.cost, 0);
  const firstTs = scanner.records.reduce((m, r) => Math.min(m, r.ts), now);
  const daysOfData = Math.max(1, Math.min(7, Math.ceil((now - firstTs) / DAY)));
  const topDay = dailySeries.reduce((best, d) => (d.cost > best.cost ? d : best), dailySeries[0]);
  const workRows = (map) => [...map.values()].sort((a, b) => b.cost - a.cost);
  const leaderboard = sessions
    .slice()
    .sort((a, b) => b.tokens.cost - a.tokens.cost)
    .slice(0, 10)
    .map((s, i) => ({
      rank: i + 1, id: s.id, title: s.title, project: s.project, model: s.model, active: s.active, lastTs: s.lastTs,
      cost: s.tokens.cost, costToday: s.today.cost, requests: s.tokens.requests, tokens: s.tokens.total,
      share: all.cost ? s.tokens.cost / all.cost : 0,
      last: s.summary.last,
    }));

  const snapshot = {
    generatedAt: now,
    windows: windows.map((w) => ({ ...w, totals: totals[w.key], models: modelRows(w.key) })),
    limits: limitsView,
    burn: {
      tokensPerMinute: Math.round(last15.total / 15),
      outputPerMinute: Math.round(last15.output / 15),
      requestsLast15: last15.requests,
    },
    activeSessions: sessions.filter((s) => s.active).length,
    sessions,
    projects: [...projectAgg.values()].sort((a, b) => b.all.total - a.all.total),
    series: { hourly: hourlySeries, daily: dailySeries },
    cost: costs.length ? { usd: costs.reduce((sum, s) => sum + s.costUsd, 0), sessions: costs.length } : null,
    // API-equivalent value of the usage at list prices; see lib/pricing.js.
    spend: {
      allTime: all.cost,
      today: totals.today.cost,
      week: totals.week.cost,
      month: totals.month.cost,
      fiveHour: totals.fiveHour.cost,
      lastHour: lastHour.cost,
      dailyAverage: last7 / daysOfData,
      projected30Days: (last7 / daysOfData) * 30,
      topDay: topDay && topDay.cost > 0 ? { t: topDay.t, cost: topDay.cost } : null,
      perRequest: all.requests ? all.cost / all.requests : 0,
      byType: { cacheRead: all.costCacheRead, cacheWrite: all.costCacheWrite, input: all.costInput, output: all.costOutput },
    },
    work: { all: workRows(workAll), week: workRows(workWeek) },
    leaderboard,
    pricing: {
      asOf: PRICES_AS_OF,
      models: [...modelsSeen].map((m) => priceFor(m)).map((p) => ({ model: p.model, label: p.label, input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite5m: p.cacheWrite5m, cacheWrite1h: p.cacheWrite1h, known: p.known })),
    },
    subagentWeek,
    data: { ...scanner.stats, sessionsSeen: scanner.sessions.size },
  };
  snapshot.diagnostics = diagnose(snapshot, now);
  return snapshot;
}

const usd = (n) => (n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`);
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const duration = (ms) => {
  const m = Math.max(0, Math.round(ms / MIN));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

/** Plain-language findings, most severe first. */
function diagnose(snap, now) {
  const out = [];
  const add = (severity, title, detail) => out.push({ severity, title, detail });
  const L = snap.limits;

  if (!L.connected) {
    add('info', 'Plan limits are not connected', 'Install the usage reporter (button on the dashboard). After the next reply in any Claude Code session, the 5-hour and weekly percentages appear here.');
  } else {
    if (L.stale) add('info', `Limit reading is ${duration(L.ageMs)} old`, 'It refreshes after the next reply in any session that has the reporter loaded. Sessions started before it was installed need a restart.');
    for (const w of L.expired || []) {
      add('info', `${w.label} reset at ${clock(Date.parse(w.resetsAt))}`, 'No reading since, so its new percentage is not known yet. It appears after the next reply in a session with the reporter loaded.');
    }
    for (const w of L.windows) {
      const resetIn = w.resetsAt ? duration(Date.parse(w.resetsAt) - now) : null;
      if (w.percentUsed >= 90) add('critical', `${w.label} at ${w.percentUsed}%`, `Requests may be throttled until it resets${resetIn ? ` in ${resetIn}` : ''}.`);
      else if (w.percentUsed >= 75) add('warning', `${w.label} at ${w.percentUsed}%`, `Resets${resetIn ? ` in ${resetIn}` : ' later'}.`);
      const p = w.projection;
      if (p && p.runsOutBeforeReset) {
        add('warning', `${w.label} runs out around ${clock(p.etaAt)} at this pace`, `Climbing ${p.percentPerHour}% per hour; that is ${duration(Date.parse(w.resetsAt) - p.etaAt)} before it resets.`);
      }
    }
  }

  const five = snap.windows.find((w) => w.key === 'fiveHour').totals;
  const busiest = snap.sessions.filter((s) => s.fiveHour.total > 0).sort((a, b) => b.fiveHour.total - a.fiveHour.total)[0];
  if (busiest && five.total > 0 && pct(busiest.fiveHour.total, five.total) >= 50) {
    add('info', `"${busiest.title}" is ${pct(busiest.fiveHour.total, five.total)}% of this 5-hour window`, `${fmt(busiest.fiveHour.total)} of ${fmt(five.total)} tokens.`);
  }

  const running = snap.sessions.filter((s) => s.lastTs && now - s.lastTs < 15 * MIN);
  if (running.length >= 3) add('info', `${running.length} sessions active in the last 15 minutes`, 'They all draw from the same 5-hour and weekly limits.');

  const recent = snap.sessions.filter((s) => s.lastTs && now - s.lastTs <= DAY);
  for (const s of recent) {
    if (s.contextPercent != null && s.contextPercent >= 70) {
      add('warning', `"${s.title}" context is ${s.contextPercent}% full`, `Every reply re-reads ${fmt(s.contextTokens)} tokens. /compact or a fresh session uses less of your limits.`);
    }
  }
  const heavy = recent
    .filter((s) => !(s.contextPercent >= 70) && s.contextTokens >= 200e3)
    .sort((a, b) => b.contextTokens - a.contextTokens);
  if (heavy.length) {
    const named = heavy.slice(0, 3).map((s) => `"${s.title}" ${fmt(s.contextTokens)}`).join(' · ');
    add('info', `${heavy.length} recent session${heavy.length > 1 ? 's carry' : ' carries'} a context over 200k tokens`, `${named}${heavy.length > 3 ? ` and ${heavy.length - 3} more` : ''}. Every reply re-reads the whole context, so /compact or a fresh session uses less of your limits.`);
  }

  // Where the money goes.
  const S = snap.spend;
  if (S && S.allTime > 0) {
    const [top, second] = snap.work.all;
    if (top) {
      add('info', `${top.label} costs the most: ${usd(top.cost)}, ${pct(top.cost, S.allTime)}% of all spend`,
        `${fmt(top.total)} tokens over ${top.requests.toLocaleString('en-US')} replies${second ? `. Next: ${second.label.toLowerCase()} at ${usd(second.cost)} (${pct(second.cost, S.allTime)}%)` : ''}.`);
    }
    const reread = pct(S.byType.cacheRead, S.allTime);
    const rewrite = pct(S.byType.cacheWrite, S.allTime);
    if (reread >= 40) add('info', `Re-reading the conversation is ${reread}% of spend (${usd(S.byType.cacheRead)})`, 'Every reply reads the whole conversation again from cache, so long chats cost more per reply. /compact, or a fresh chat for a new task, cuts this.');
    if (rewrite >= 35) add('info', `Saving context to cache is ${rewrite}% of spend (${usd(S.byType.cacheWrite)})`, 'Cache entries expire after an hour of silence, and the next reply pays to write the whole conversation again. Coming back to a long chat after a break is the expensive moment.');
    const priciest = snap.leaderboard[0];
    if (priciest && priciest.cost > 0) {
      add('info', `"${priciest.title}" is the most expensive chat: ${usd(priciest.cost)}`, `${pct(priciest.cost, S.allTime)}% of all spend, ${priciest.requests.toLocaleString('en-US')} replies at ${usd(priciest.cost / Math.max(1, priciest.requests))} each.`);
    }
    const allModels = snap.windows.find((w) => w.key === 'all');
    const lead = allModels.models.slice().sort((a, b) => b.cost - a.cost)[0];
    if (lead && allModels.models.length > 1 && pct(lead.cost, S.allTime) >= 50) {
      add('info', `${lead.model.replace(/^claude-/, '')} is ${pct(lead.cost, S.allTime)}% of spend`, `It answered ${pct(lead.requests, allModels.totals.requests)}% of replies. A cheaper model for routine steps lowers this.`);
    }
    const unknown = snap.pricing.models.filter((m) => !m.known).map((m) => m.model);
    if (unknown.length) add('info', `No list price known for ${unknown.join(', ')}`, 'Its usage is priced at the Opus 5.5 rate, so its dollar figures are a guess.');
  }

  const week = snap.windows.find((w) => w.key === 'week').totals;
  const prompt = week.input + week.cacheWrite + week.cacheRead;
  if (prompt > 1e6) {
    const hit = pct(week.cacheRead, prompt);
    if (hit < 60) add('warning', `Cache reuse is ${hit}% this week`, 'Most prompt tokens are new or freshly cached. Long idle gaps between replies let the cache expire.');
    else add('ok', `Cache reuse is ${hit}% this week`, 'Most of each prompt is served from cache.');
  }
  if (week.total > 0 && pct(snap.subagentWeek.total, week.total) >= 40) {
    add('info', `Subagents used ${pct(snap.subagentWeek.total, week.total)}% of this week's tokens`, `${fmt(snap.subagentWeek.total)} of ${fmt(week.total)}.`);
  }
  const models = snap.windows.find((w) => w.key === 'week').models;
  if (models.length > 1) {
    add('info', 'Model mix this week', models.map((m) => `${m.model} ${pct(m.total, week.total)}%`).join(' · '));
  }
  if (snap.data.unreadableLines > 0) add('info', `${snap.data.unreadableLines} transcript lines could not be read`, 'Usually lines that were mid-write. They are skipped.');

  const order = { critical: 0, warning: 1, info: 2, ok: 3 };
  out.sort((a, b) => order[a.severity] - order[b.severity]);
  if (!out.some((d) => d.severity === 'critical' || d.severity === 'warning')) {
    out.unshift({ severity: 'ok', title: 'No problems found', detail: 'Limits, context sizes and cache reuse all look healthy.' });
  }
  return out;
}

module.exports = { buildSnapshot, diagnose, emptyTotals, startOfLocalDay, projectLabel, workOf };
