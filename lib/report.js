'use strict';
/**
 * The diagnostic report: one self-contained HTML file (inline CSS, server-drawn
 * SVG, no scripts) built from a snapshot. Opens anywhere; prints to PDF cleanly.
 */
const fs = require('node:fs');
const path = require('node:path');
const C = require('../public/charts.js');

const { esc, compact, full, usd, usd2, pct, duration, dateTime, shortDate, hourLabel, clock } = C;
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const KEYS = ['cacheRead', 'cacheWrite', 'input', 'output'];
const label = (k) => C.SERIES.find((s) => s.key === k).label;

function totalsTable(windows) {
  const head = '<tr><th>Window</th><th class="num">Requests</th><th class="num">Input</th><th class="num">Cache write</th><th class="num">Cache read</th><th class="num">Output</th><th class="num">Total</th><th class="num">From cache</th></tr>';
  const rows = windows.map((w) => {
    const t = w.totals;
    const prompt = t.input + t.cacheWrite + t.cacheRead;
    return `<tr><td>${esc(w.label)}<div class="s-meta">since ${w.start ? dateTime(w.start) : 'first record'}</div></td><td class="num">${full(t.requests)}</td><td class="num">${full(t.input)}</td><td class="num">${full(t.cacheWrite)}</td><td class="num">${full(t.cacheRead)}</td><td class="num">${full(t.output)}</td><td class="num"><b>${full(t.total)}</b></td><td class="num">${pct(t.cacheRead, prompt)}%</td></tr>`;
  });
  return `<table><thead>${head}</thead><tbody>${rows.join('')}</tbody></table>`;
}

function limitsSection(L, now) {
  if (!L.connected) {
    return '<div class="callout"><p><b>Plan limits not connected.</b> /usage percentages are not stored in Claude Code\'s transcripts. Install the plan-usage-reporter from the dashboard to include them.</p></div>';
  }
  const rows = L.windows.map((w) => {
    const p = w.projection;
    const pace = p ? `+${p.percentPerHour}%/h · ${p.runsOutBeforeReset ? `runs out ~${clock(p.etaAt)} (before reset)` : 'lasts until reset'}` : 'not enough readings';
    return `<tr><td>${esc(w.label)}</td><td class="num"><b>${w.percentUsed}%</b></td><td style="min-width:160px">${C.meter(w.percentUsed)}</td><td>${w.resetsAt ? `${dateTime(Date.parse(w.resetsAt))} (in ${duration(Date.parse(w.resetsAt) - now)})` : '—'}</td><td>${esc(pace)}</td></tr>`;
  });
  return `<table><thead><tr><th>Window</th><th class="num">Used</th><th></th><th>Resets</th><th>Pace</th></tr></thead><tbody>${rows.join('')}</tbody></table>
    <p class="note">Reading taken ${dateTime(L.readAt)} (${duration(L.ageMs)} before this report) from ${L.sessionsReporting} reporting session${L.sessionsReporting === 1 ? '' : 's'}${L.stale ? '; <b>stale</b>' : ''}.</p>`;
}

function spendSection(snap) {
  const S = snap.spend;
  const type = [['cacheRead', 'Re-reading the conversation (cache reads)'], ['cacheWrite', 'Saving context (cache writes)'], ['output', 'Writing replies (output)'], ['input', 'New input']];
  return `<table><thead><tr><th>Period</th><th class="num">Cost</th></tr></thead><tbody>
    <tr><td>All time</td><td class="num"><b>${usd2(S.allTime)}</b></td></tr>
    <tr><td>Last 30 days</td><td class="num">${usd2(S.month)}</td></tr>
    <tr><td>Current weekly window</td><td class="num">${usd2(S.week)}</td></tr>
    <tr><td>Today</td><td class="num">${usd2(S.today)}</td></tr>
    <tr><td>Average per day (last 7 days)</td><td class="num">${usd2(S.dailyAverage)}</td></tr>
    <tr><td>Next 30 days at that pace</td><td class="num">${usd2(S.projected30Days)}</td></tr>
    <tr><td>Average per reply</td><td class="num">${usd2(S.perRequest)}</td></tr>
    </tbody></table>
    <table style="margin-top:16px"><thead><tr><th>Where it goes</th><th class="num">Cost</th><th class="num">Share</th></tr></thead><tbody>${type
      .map(([k, name]) => `<tr><td>${name}</td><td class="num">${usd2(S.byType[k])}</td><td class="num">${pct(S.byType[k], S.allTime)}%</td></tr>`)
      .join('')}</tbody></table>`;
}

function chart(title, rows, opts) {
  return `<div class="card" style="margin-top:16px"><div class="chart-head"><h2>${esc(title)}</h2><span class="spacer"></span>${C.legend(KEYS)}</div>${C.stackedColumns(rows, { keys: KEYS, title, ...opts })}</div>`;
}

function sessionsTable(sessions) {
  const sorted = [...sessions].sort((a, b) => b.tokens.cost - a.tokens.cost);
  return `<table><thead><tr><th>Session</th><th>Model</th><th>First → last activity</th><th class="num">Requests</th><th class="num">5-hour window</th><th class="num">Output</th><th class="num">Total</th><th class="num">Subagents</th><th class="num">Context</th><th class="num">Cost</th><th class="num">Per reply</th></tr></thead><tbody>${sorted
    .map(
      (s) => `<tr><td><span class="s-title">${esc(s.title)}</span><div class="s-meta">${esc(s.project)} · ${esc(s.id.slice(0, 8))}${s.entrypoint ? ` · ${esc(s.entrypoint)}` : ''}</div>${s.summary && s.summary.goal ? `<div class="s-meta" style="max-width:60ch;white-space:normal"><b>Goal:</b> ${esc(s.summary.goal)}</div>` : ''}${s.summary && s.summary.now ? `<div class="s-meta" style="max-width:60ch;white-space:normal"><b>${s.active ? 'Now' : 'Stopped at'}:</b> ${esc(s.summary.now)}</div>` : ''}</td>
      <td>${esc((s.model || '').replace(/^claude-/, ''))}</td>
      <td class="s-meta">${s.firstTs ? dateTime(s.firstTs) : '—'} → ${s.lastTs ? dateTime(s.lastTs) : '—'}</td>
      <td class="num">${full(s.tokens.requests)}</td><td class="num">${s.fiveHour.total ? compact(s.fiveHour.total) : '—'}</td>
      <td class="num">${compact(s.tokens.output)}</td><td class="num"><b>${compact(s.tokens.total)}</b></td>
      <td class="num">${s.subagent.total ? compact(s.subagent.total) : '—'}</td>
      <td class="num">${s.contextTokens ? compact(s.contextTokens) : '—'}${s.contextPercent != null ? ` (${s.contextPercent}%)` : ''}</td>
      <td class="num"><b>${usd(s.tokens.cost)}</b></td><td class="num">${usd2(s.tokens.cost / Math.max(1, s.tokens.requests))}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function modelTable(models, wholeCost) {
  return `<table><thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Input</th><th class="num">Cache write</th><th class="num">Cache read</th><th class="num">Output</th><th class="num">Total</th><th class="num">Cost</th><th class="num">Share of cost</th></tr></thead><tbody>${models
    .map((m) => `<tr><td>${esc(m.model)}</td><td class="num">${full(m.requests)}</td><td class="num">${full(m.input)}</td><td class="num">${full(m.cacheWrite)}</td><td class="num">${full(m.cacheRead)}</td><td class="num">${full(m.output)}</td><td class="num">${full(m.total)}</td><td class="num"><b>${usd(m.cost)}</b></td><td class="num">${pct(m.cost, wholeCost)}%</td></tr>`)
    .join('')}</tbody></table>`;
}

function renderReport(snap) {
  const now = snap.generatedAt;
  const all = snap.windows.find((w) => w.key === 'all');
  const week = snap.windows.find((w) => w.key === 'week');
  const counts = snap.diagnostics.reduce((o, d) => ((o[d.severity] = (o[d.severity] || 0) + 1), o), {});
  const headline = counts.critical ? `${counts.critical} critical finding${counts.critical > 1 ? 's' : ''}` : counts.warning ? `${counts.warning} warning${counts.warning > 1 ? 's' : ''}` : 'No problems found';
  const d = snap.data;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code Usage Report · ${esc(dateTime(now))}</title>
<style>${CSS}
.report h1 { font-size: 24px; margin: 0 0 4px; }
.report .section-title { margin-top: 32px; }
.report .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
@media (max-width: 760px) { .report .kpis { grid-template-columns: 1fr 1fr; } }
</style></head>
<body><div class="wrap report">
<header class="top"><div><h1>Claude Code usage report</h1>
<div class="sub">Generated ${esc(dateTime(now))} · ${snap.sessions.length} sessions · ${esc(headline)}</div></div></header>

<div class="section-title"><h2>Summary</h2></div>
<div class="kpis">${['fiveHour', 'today', 'week', 'all']
    .map((k) => {
      const w = snap.windows.find((x) => x.key === k);
      return `<div class="card"><div class="stat-label">${esc(w.label)}</div><div class="stat-value">${usd(w.totals.cost)}</div><div class="stat-sub"><b>${compact(w.totals.total)}</b> tokens · <b>${full(w.totals.requests)}</b> replies</div></div>`;
    })
    .join('')}</div>

<div class="section-title"><h2>Findings</h2></div>
<div class="card"><ul class="diag">${snap.diagnostics
    .map((x) => `<li class="${x.severity}"><span aria-hidden="true">${C.SEVERITY[x.severity].icon}</span><div><div class="d-title">${esc(x.title)}<span class="d-tag">${C.SEVERITY[x.severity].label}</span></div><div class="d-detail">${esc(x.detail)}</div></div></li>`)
    .join('')}</ul></div>

<div class="section-title"><h2>Spend</h2><span class="desc">API value at list prices; on a subscription you pay your plan price, not this</span></div>
<div class="card table-wrap">${spendSection(snap)}</div>

<div class="section-title"><h2>Most expensive chats</h2><span class="desc">All time</span></div>
<div class="card table-wrap"><table><thead><tr><th class="num">#</th><th>Chat</th><th>Model</th><th class="num">Replies</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Share</th></tr></thead><tbody>${snap.leaderboard
    .map((r) => `<tr><td class="num">${r.rank}</td><td><span class="s-title">${esc(r.title)}</span><div class="s-meta">${esc(r.project)}</div></td><td>${esc((r.model || '').replace(/^claude-/, ''))}</td><td class="num">${full(r.requests)}</td><td class="num">${compact(r.tokens)}</td><td class="num"><b>${usd(r.cost)}</b></td><td class="num">${Math.round(r.share * 100)}%</td></tr>`)
    .join('')}</tbody></table></div>

<div class="section-title"><h2>What the work costs</h2><span class="desc">Each reply, by the tools it called. All time</span></div>
<div class="card table-wrap"><table><thead><tr><th>Kind of work</th><th class="num">Replies</th><th class="num">Tokens</th><th class="num">Per reply</th><th class="num">Cost</th><th class="num">Share</th></tr></thead><tbody>${snap.work.all
    .map((w) => `<tr><td>${esc(w.label)}</td><td class="num">${full(w.requests)}</td><td class="num">${compact(w.total)}</td><td class="num">${usd2(w.cost / Math.max(1, w.requests))}</td><td class="num"><b>${usd(w.cost)}</b></td><td class="num">${pct(w.cost, snap.spend.allTime)}%</td></tr>`)
    .join('')}</tbody></table></div>

<div class="section-title"><h2>Plan limits</h2><span class="desc">What /usage shows</span></div>
<div class="card">${limitsSection(snap.limits, now)}</div>

<div class="section-title"><h2>Token totals</h2><span class="desc">Each API response counted once</span></div>
<div class="card table-wrap">${totalsTable(snap.windows)}</div>

<div class="section-title"><h2>Activity</h2></div>
${chart('Last 48 hours, tokens per hour', snap.series.hourly, { height: 220, labelEvery: 6, xLabel: hourLabel })}
${chart('Last 30 days, tokens per day', snap.series.daily, { height: 190, labelEvery: 5, labelOffset: 4, xLabel: shortDate })}

<div class="section-title"><h2>By model</h2><span class="desc">${esc(week.label)}</span></div>
<div class="card table-wrap">${modelTable(week.models, week.totals.cost)}</div>
${all.totals.total !== week.totals.total ? `<div class="section-title"><h2>By model</h2><span class="desc">All time</span></div><div class="card table-wrap">${modelTable(all.models, all.totals.cost)}</div>` : ''}

<div class="section-title"><h2>Sessions</h2><span class="desc">Sorted by total tokens</span></div>
<div class="card table-wrap">${sessionsTable(snap.sessions)}</div>

<div class="section-title"><h2>Project folders</h2></div>
<div class="card table-wrap"><table><thead><tr><th>Folder</th><th class="num">Sessions</th><th class="num">${esc(week.label)}</th><th class="num">All time</th><th>Last activity</th></tr></thead><tbody>${snap.projects
    .map((p) => `<tr><td>${esc(p.project)}</td><td class="num">${p.sessions}</td><td class="num">${compact(p.week.total)}</td><td class="num"><b>${compact(p.all.total)}</b></td><td>${p.lastTs ? dateTime(p.lastTs) : '—'}</td></tr>`)
    .join('')}</tbody></table></div>

<div class="section-title"><h2>Data and method</h2></div>
<div class="card stat-sub" style="font-size:13px;line-height:1.6">
<p>Read ${full(d.files)} transcript files under <code>${esc(snap.paths.projectsDir)}</code>: ${full(d.linesRead)} lines, ${full(d.responses)} API responses, ${full(d.duplicateLines)} duplicate lines skipped, ${full(d.unreadableLines)} unreadable.</p>
<p>Claude Code writes one transcript line per content block, each repeating the response's usage, so every response is counted once by message id and request id. Subagent transcripts count toward their parent session. "Total" adds input, cache write, cache read and output tokens. Cache reads are billed and rate-limited far below fresh input, so a large total that is mostly cache reads costs much less than the number suggests.</p>
<p>Plan-limit percentages come from the plan-usage-reporter mod, which records what each API response reported; the per-model weekly windows that /usage can also show are not reported to mods. Dollar figures price every response at Anthropic's API list rates as of ${esc(snap.pricing.asOf)} (${snap.pricing.models.map((m) => `${esc(m.model.replace(/^claude-/, ''))} $${m.input}/$${m.output} in/out, $${m.cacheRead} cache read`).join('; ')}; cache writes at 1.25x input for 5 minutes and 2x for 1 hour). They are an estimate of API value, not a bill. Usage from claude.ai chats is not in these transcripts, though it counts toward the same plan limits.</p>
</div>
<footer class="foot"><span>Claude Usage Monitor · local report, nothing was sent anywhere</span></footer>
</div></body></html>`;
}

module.exports = { renderReport };
