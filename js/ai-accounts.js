// Built from lib/ai-accounts.js: the same provider code the PC uses.
const built = (() => {
const module = { exports: {} };
'use strict';
/**
 * Usage and spend from AI accounts, with a key you paste on this PC. Each
 * request below is as documented by the provider (checked against their API
 * reference or OpenAPI spec):
 *
 * Claude API (Claude Console): GET /v1/organizations/analytics/usage and /cost,
 *   admin key (sk-ant-admin...), headers anthropic-version and
 *   anthropic-beta: analytics-usage-cost-2026-08-24. Rows: starting_at, group.model,
 *   usage {uncached_input_tokens, cache_creation{...}, cache_read_input_tokens,
 *   output_tokens, total_tokens, requests}; cost {amount (cents, decimal string)}.
 *   Ranges up to 31 days; data lands 4 to 24 hours late.
 * OpenAI API: GET /v1/organization/usage/completions and /v1/organization/costs,
 *   admin key, start_time (Unix seconds), bucket_width=1d. Buckets data[].results[]:
 *   input_tokens, input_cached_tokens, output_tokens, num_model_requests, model;
 *   amount {value, currency}, line_item.
 * OpenRouter: GET /api/v1/key (any key): data.usage, usage_daily, usage_weekly,
 *   usage_monthly (USD). GET /api/v1/activity (management keys only): rows of
 *   date, model, usage (USD), requests, prompt_tokens, completion_tokens,
 *   reasoning_tokens, cached_tokens, for the last 30 completed UTC days.
 */
const DAY = 86400e3;
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const midnightUtc = (ms) => Math.floor(ms / DAY) * DAY;

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** The provider's own words from an error response, if it sent any. */
async function saidBy(r) {
  try {
    const b = await r.json();
    const m = (b.error && (b.error.message || (typeof b.error === 'string' && b.error))) || b.message;
    return typeof m === 'string' ? m.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
  } catch {
    return '';
  }
}

async function getJson(fetchFn, url, headers, label, hint = 'Check it is the right kind of key.') {
  let r;
  try {
    r = await fetchFn(url, { headers, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new ApiError(`Could not reach ${label} (${e.name === 'TimeoutError' ? 'timed out' : 'network error'}).`);
  }
  if (r.status === 401 || r.status === 403) {
    const said = await saidBy(r);
    throw new ApiError(`${label} refused this key (HTTP ${r.status})${said ? `: "${said}"` : '.'} ${hint}`, r.status);
  }
  if (!r.ok) {
    const said = await saidBy(r);
    throw new ApiError(`${label} answered HTTP ${r.status}${said ? `: "${said}"` : '.'}`, r.status);
  }
  return r.json();
}

/** Catches the usual mix-up (a normal API key where usage needs an admin key) before asking the provider. */
function checkKey(id, key) {
  const a = ACCOUNTS[id];
  const k = String(key || '').trim();
  if (!a) return 'Unknown AI account.';
  if (!k || k.length > 300 || /\s/.test(k)) return `That doesn't look like a ${a.keyName.replace(/^Admin/, 'admin')}.`;
  if (a.keyPattern.test(k)) return null;
  return (a.wrongKey && a.wrongKey(k)) || `That doesn't look like a ${a.keyName.replace(/^Admin/, 'admin')}. ${a.keyHelp}`;
}

/** Turns per-day rows into the shared report shape. rows: [{ date, model, cost|null, input, cached, output, reasoning, total, requests }] */
function fromDailyRows(rows, { now, hasCost }) {
  const today = utcDay(now);
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(utcDay(midnightUtc(now) - i * DAY));
  const byDay = new Map(days.map((d) => [d, { date: d, cost: hasCost ? 0 : null, tokens: 0, requests: 0 }]));
  const byModel = new Map();
  const tokens = { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
  let requests = 0;
  const spend = { today: hasCost ? 0 : null, week: hasCost ? 0 : null, month: hasCost ? 0 : null, allTime: null };
  const weekStart = utcDay(midnightUtc(now) - 6 * DAY);
  for (const r of rows) {
    const day = byDay.get(r.date);
    if (!day) continue;
    const total = n(r.total) || n(r.input) + n(r.output);
    day.tokens += total;
    day.requests += n(r.requests);
    if (hasCost) day.cost += n(r.cost);
    tokens.input += n(r.input);
    tokens.cached += n(r.cached);
    tokens.output += n(r.output);
    tokens.reasoning += n(r.reasoning);
    tokens.total += total;
    requests += n(r.requests);
    if (hasCost) {
      spend.month += n(r.cost);
      if (r.date >= weekStart) spend.week += n(r.cost);
      if (r.date === today) spend.today += n(r.cost);
    }
    const key = r.model || 'other';
    const m = byModel.get(key) || { model: key, cost: hasCost ? 0 : null, tokens: 0, requests: 0 };
    m.tokens += total;
    m.requests += n(r.requests);
    if (hasCost) m.cost += n(r.cost);
    byModel.set(key, m);
  }
  const models = [...byModel.values()].sort((a, b) => (hasCost ? b.cost - a.cost : 0) || b.tokens - a.tokens);
  return { spend, tokens, requests, daily: [...byDay.values()], models };
}

const ACCOUNTS = {
  'anthropic-api': {
    name: 'Claude API',
    keyName: 'Admin key',
    keyPattern: /^sk-ant-admin[\w-]{10,}$/,
    keyHelp: 'Claude Console → Settings → Admin keys (organization admins only). Starts with sk-ant-admin.',
    wrongKey: (k) => (/^sk-ant-/.test(k) ? 'That is a normal Claude API key. Anthropic only shows usage to an admin key: Claude Console → Settings → Admin keys (organization admins only). It starts with sk-ant-admin.' : null),
    async fetch(key, fetchFn, now) {
      const headers = { 'x-api-key': key, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'analytics-usage-cost-2026-08-24' };
      const hint = 'Usage needs an admin key (sk-ant-admin...) from Claude Console → Settings → Admin keys.';
      const start = Math.max(midnightUtc(now) - 29 * DAY, Date.parse('2026-01-01T00:00:00Z'));
      const params = (extra = {}) => {
        const p = new URLSearchParams({ starting_at: new Date(start).toISOString(), ending_at: new Date(midnightUtc(now) + DAY).toISOString(), time_bucket_width: '1d', order_by: 'time', order: 'asc', limit: '1000', ...extra });
        p.append('group_by[]', 'model');
        return p;
      };
      const pages = async (endpoint) => {
        const rows = [];
        let page = null;
        let refreshed = null;
        for (let i = 0; i < 20; i++) {
          const q = params(page ? { page } : {});
          const body = await getJson(fetchFn, `https://api.anthropic.com/v1/organizations/analytics/${endpoint}?${q}`, headers, 'Anthropic', hint);
          rows.push(...(body.data || []));
          refreshed = body.data_refreshed_at || refreshed;
          if (!body.has_more || !body.next_page) break;
          page = body.next_page;
        }
        return { rows, refreshed };
      };
      const [usage, cost] = await Promise.all([pages('usage'), pages('cost')]);
      const merged = new Map();
      const keyOf = (r) => `${String(r.starting_at).slice(0, 10)}|${(r.group && r.group.model) || 'other'}`;
      for (const r of usage.rows) {
        const u = r.usage || {};
        const cw = u.cache_creation || {};
        const cacheWrite = n(cw.ephemeral_1h_input_tokens) + n(cw.ephemeral_5m_input_tokens);
        merged.set(keyOf(r), {
          date: String(r.starting_at).slice(0, 10),
          model: (r.group && r.group.model) || 'other',
          input: n(u.uncached_input_tokens) + cacheWrite + n(u.cache_read_input_tokens),
          cached: n(u.cache_read_input_tokens),
          output: n(u.output_tokens),
          reasoning: 0,
          total: n(u.total_tokens),
          requests: n(u.requests),
          cost: 0,
        });
      }
      for (const r of cost.rows) {
        const k = keyOf(r);
        const row = merged.get(k) || { date: String(r.starting_at).slice(0, 10), model: (r.group && r.group.model) || 'other', input: 0, cached: 0, output: 0, reasoning: 0, total: 0, requests: 0, cost: 0 };
        row.cost += n(r.cost && r.cost.amount) / 100; // cents -> dollars
        merged.set(k, row);
      }
      const report = fromDailyRows([...merged.values()], { now, hasCost: true });
      report.notes = [`Claude Console figures arrive 4 to 24 hours late${usage.refreshed ? `; complete up to ${new Date(usage.refreshed).toLocaleString()}` : ''}. Cost is after discounts, before credits.`];
      report.spendLabels = { today: 'Today (UTC)', week: 'Last 7 days', month: 'Last 30 days', allTime: 'All time' };
      return report;
    },
  },

  'openai-api': {
    name: 'OpenAI API',
    keyName: 'Admin key',
    keyPattern: /^sk-admin-[\w-]{20,}$/,
    keyHelp: 'platform.openai.com → Settings → Organization → Admin keys → Create new admin key (organization owners only). It starts with sk-admin-. A normal project key cannot read usage.',
    wrongKey: (k) => (/^sk-/.test(k) ? `That is a ${/^sk-proj-/.test(k) ? 'project' : /^sk-svcacct-/.test(k) ? 'service account' : 'normal'} API key, and OpenAI only shows usage to an admin key. Make one at platform.openai.com → Settings → Organization → Admin keys → Create new admin key (organization owners only). It starts with sk-admin-.` : null),
    async fetch(key, fetchFn, now) {
      const headers = { Authorization: `Bearer ${key}` };
      const hint = 'Usage needs an admin key (sk-admin-...) with read access to Usage, made by an organization owner.';
      const start = Math.floor((midnightUtc(now) - 29 * DAY) / 1000);
      const pages = async (pathAndQuery) => {
        const buckets = [];
        let page = null;
        for (let i = 0; i < 20; i++) {
          const url = `https://api.openai.com/v1/organization/${pathAndQuery}${page ? `&page=${encodeURIComponent(page)}` : ''}`;
          const body = await getJson(fetchFn, url, headers, 'OpenAI', hint);
          buckets.push(...(body.data || []));
          if (!body.has_more || !body.next_page) break;
          page = body.next_page;
        }
        return buckets;
      };
      const [usage, costs] = await Promise.all([
        pages(`usage/completions?start_time=${start}&bucket_width=1d&limit=31&group_by=model`),
        pages(`costs?start_time=${start}&bucket_width=1d&limit=31&group_by=line_item`),
      ]);
      const rows = [];
      for (const b of usage) {
        const date = utcDay(n(b.start_time) * 1000);
        for (const r of b.results || []) {
          rows.push({ date, model: r.model || 'other', input: n(r.input_tokens), cached: n(r.input_cached_tokens), output: n(r.output_tokens), reasoning: 0, total: n(r.input_tokens) + n(r.output_tokens), requests: n(r.num_model_requests), cost: 0 });
        }
      }
      for (const b of costs) {
        const date = utcDay(n(b.start_time) * 1000);
        for (const r of b.results || []) {
          // Line items read like "gpt-5, input": file the cost under the model part.
          const model = String(r.line_item || 'other').split(',')[0].trim() || 'other';
          rows.push({ date, model, input: 0, cached: 0, output: 0, reasoning: 0, total: 0, requests: 0, cost: n(r.amount && r.amount.value) });
        }
      }
      const report = fromDailyRows(rows, { now, hasCost: true });
      report.notes = ['Tokens count chat and responses requests (the completions usage report); spend covers everything billed to the organization.'];
      report.spendLabels = { today: 'Today (UTC)', week: 'Last 7 days', month: 'Last 30 days', allTime: 'All time' };
      return report;
    },
  },

  openrouter: {
    name: 'OpenRouter',
    keyName: 'API key',
    keyPattern: /^sk-or-[\w-]{10,}$/,
    keyHelp: 'openrouter.ai → Settings → Keys. Any key shows your spend; a management key also shows models and tokens.',
    wrongKey: () => 'OpenRouter keys start with sk-or-. Find yours at openrouter.ai → Settings → Keys.',
    async fetch(key, fetchFn, now) {
      const headers = { Authorization: `Bearer ${key}` };
      const info = (await getJson(fetchFn, 'https://openrouter.ai/api/v1/key', headers, 'OpenRouter')).data || {};
      let report;
      const notes = [];
      try {
        const act = await getJson(fetchFn, 'https://openrouter.ai/api/v1/activity', headers, 'OpenRouter');
        const rows = (act.data || []).map((r) => ({
          date: r.date,
          model: r.model,
          input: n(r.prompt_tokens),
          cached: n(r.cached_tokens),
          output: n(r.completion_tokens),
          reasoning: n(r.reasoning_tokens),
          total: n(r.prompt_tokens) + n(r.completion_tokens) + n(r.reasoning_tokens),
          requests: n(r.requests),
          cost: n(r.usage),
        }));
        report = fromDailyRows(rows, { now, hasCost: true });
        notes.push('Models and tokens cover the last 30 completed UTC days.');
      } catch (e) {
        if (e.status !== 401 && e.status !== 403) throw e;
        report = fromDailyRows([], { now, hasCost: true });
        report.daily = [];
        notes.push('Paste a management key to see models, tokens and a daily chart; this key shows spend only.');
      }
      report.spend = { today: n(info.usage_daily), week: n(info.usage_weekly), month: n(info.usage_monthly), allTime: n(info.usage) };
      report.spendLabels = { today: 'Today (UTC)', week: 'This week', month: 'This month', allTime: 'All time' };
      if (info.limit != null) notes.push(`Key limit $${n(info.limit).toFixed(2)}, $${n(info.limit_remaining).toFixed(2)} left.`);
      report.notes = notes;
      return report;
    },
  },
};

module.exports = { ACCOUNTS, fromDailyRows, ApiError, utcDay, checkKey };

return module.exports;
})();
export const { ACCOUNTS, checkKey, fromDailyRows } = built;
