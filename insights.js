/* What opens when you click a figure on the dashboard: a summary, a breakdown, and what you can do
   about it. Pure functions over the snapshot, so the same code runs in the browser (window.Insights)
   and in the tests. The page turns the result into HTML. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./prompt-coach.js'));
  else root.Insights = factory(root.PromptCoach);
})(typeof self !== 'undefined' ? self : this, function (Coach) {
  'use strict';

  const TYPES = ['cacheRead', 'cacheWrite', 'input', 'output'];
  const TYPE_LABEL = { cacheRead: 'Re-reading the chat (cache reads)', cacheWrite: 'Adding to the chat (cache writes)', input: 'New input', output: "Claude's output and thinking" };
  const COST = { cacheRead: 'costCacheRead', cacheWrite: 'costCacheWrite', input: 'costInput', output: 'costOutput' };
  const PRICE = { cacheRead: 'cacheRead', cacheWrite: 'cacheWrite5m', input: 'input', output: 'output' };
  const SESSION_FIELD = { fiveHour: 'fiveHour', today: 'today', week: 'week', all: 'tokens' };
  const BIG = /opus|fable|mythos/i;

  const usd = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
  function compact(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return `${+(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${+(v / 1e3).toFixed(1)}K`;
    return String(Math.round(v));
  }
  const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString('en-US')} ${n === 1 ? one : many}`;

  /** "claude-opus-5-5" → "Opus 5.5". */
  function prettyModel(id) {
    const s = String(id || '');
    const fam = (s.match(/opus|sonnet|haiku|fable|mythos/i) || [])[0];
    if (!fam) return s.replace(/^claude-/, '');
    const nums = s.replace(/^claude-/, '').split('-').filter((p) => /^\d{1,2}$/.test(p)).slice(0, 2);
    return `${fam.charAt(0).toUpperCase()}${fam.slice(1).toLowerCase()}${nums.length ? ` ${nums.join('.')}` : ''}`;
  }

  // ---------- rows ----------
  function moneyRows(t) {
    return TYPES.map((k) => ({ label: TYPE_LABEL[k], value: t[COST[k]] || 0, fmt: 'usd', share: t.cost ? (t[COST[k]] || 0) / t.cost : 0, note: `${compact(t[k])} tokens` }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);
  }
  function chatRows(snap, field, filter = () => true) {
    const cost = (s) => (s[field] && s[field].cost) || 0;
    const list = snap.sessions.filter((s) => filter(s) && cost(s) > 0).sort((a, b) => cost(b) - cost(a)).slice(0, 8);
    const top = list.length ? cost(list[0]) : 1;
    return list.map((s) => ({ label: s.title, value: cost(s), fmt: 'usd', share: cost(s) / top, note: `${s.project} · ${prettyModel(s.model)}`, ref: { type: 'chat', id: s.id } }));
  }
  function modelRows(models) {
    const whole = models.reduce((n, m) => n + m.cost, 0);
    return models.filter((m) => m.cost > 0).sort((a, b) => b.cost - a.cost)
      .map((m) => ({ label: prettyModel(m.model), value: m.cost, fmt: 'usd', share: whole ? m.cost / whole : 0, note: plural(m.requests, 'reply', 'replies'), ref: { type: 'model', id: m.model } }));
  }
  const baseStats = (t) => [
    { label: 'Spent', value: t.cost, fmt: 'usd' },
    { label: 'Replies', value: t.requests, fmt: 'int' },
    { label: 'Per reply', value: t.requests ? t.cost / t.requests : 0, fmt: 'usd2' },
    { label: 'Tokens', value: t.total, fmt: 'compact' },
  ];

  // ---------- advice ----------
  /** What the same tokens would have cost on Sonnet, for the big models in `models`. */
  function sonnetPrice(models, pricing) {
    const P = pricing && pricing.models ? pricing.models : [];
    const sonnet = P.filter((m) => /sonnet/i.test(m.model)).sort((a, b) => b.model.localeCompare(a.model))[0];
    if (!sonnet) return null;
    const big = models.filter((m) => BIG.test(m.model) && m.cost > 0);
    if (!big.length) return null;
    const cost = big.reduce((n, m) => n + m.cost, 0);
    const alt = big.reduce((n, m) => n + TYPES.reduce((x, k) => x + ((m[k] || 0) * (sonnet[PRICE[k]] || 0)) / 1e6, 0), 0);
    return { cost, alt, saving: cost - alt, sonnet: prettyModel(sonnet.model), big: [...new Set(big.map((m) => prettyModel(m.model)))].join(' and ') };
  }

  function tipsFor(t, models, pricing, { forceModel = false } = {}) {
    const tips = [];
    if (!t || !(t.cost > 0)) return tips;
    const share = (k) => (t[COST[k]] || 0) / t.cost;
    if (share('cacheRead') > 0.5) {
      tips.push({ title: 'Long chats re-read themselves', saving: t.costCacheRead / 2, detail: `${pct(t.costCacheRead, t.cost)}% of this (${usd(t.costCacheRead)}) is Claude re-reading the conversation before each reply. Start a new chat with /clear when you switch tasks, and use /compact when a long one has to keep going. Halving it would save about ${usd(t.costCacheRead / 2)}.` });
    }
    if (share('cacheWrite') > 0.3) {
      tips.push({ title: 'A lot is being added to the chats', detail: `${pct(t.costCacheWrite, t.cost)}% goes on cache writes: new text entering the context, such as big files and long command output, and chats picked up again after sitting idle long enough for the cache to expire. Keep large output out of the chat and finish a task in one sitting.` });
    }
    if (share('output') > 0.35) {
      tips.push({ title: 'Claude is writing a lot', detail: `${pct(t.costOutput, t.cost)}% is output, including thinking. Ask for targeted edits instead of whole files, ask for short answers when that's all you need, and lower /effort for routine work.` });
    }
    const s = models && sonnetPrice(models, pricing);
    if (s && s.saving > 0.01 && (forceModel || s.cost / t.cost > 0.5)) {
      tips.push({ title: `Try ${s.sonnet} for routine work`, saving: s.saving, detail: `The same tokens on ${s.sonnet} would have cost ${usd(s.alt)} instead of ${usd(s.cost)} on ${s.big}: ${usd(s.saving)} less. Anthropic suggests Sonnet for most coding. Switch with /model and keep the bigger model for hard problems.` });
    }
    return tips.sort((a, b) => (b.saving || 0) - (a.saving || 0));
  }
  const orNothing = (tips) => (tips.length ? tips : [{ title: 'Nothing stands out', detail: 'Spending is spread evenly across reading, writing and output. Keep doing what you are doing.' }]);

  const WORK_TIPS = {
    shell: 'Test runs, builds and logs land in the chat and are re-read with every reply. Ask for only the failing tests or the last lines of a log, or have Claude filter output with grep or tail.',
    edit: 'Edits are usually money well spent. Targeted changes cost far less than rewriting whole files: ask for a change to one function rather than "rewrite this file".',
    read: 'This is Claude searching and opening files. Name the file and function in your prompt so it opens one file instead of searching the project, and keep a short map of where things live in CLAUDE.md.',
    browser: 'Screenshots and full page reads are large. Ask Claude to read page text rather than take screenshots, and to check one page at a time.',
    plan: 'Task lists, plans and notes. Worth it for big jobs. For small changes, ask for the change directly instead of a plan.',
    talk: 'Replies and extended thinking. Lower /effort for routine questions, and ask for a short answer when a short answer is enough.',
    agents: 'Each subagent starts its own context, and its tokens count too. Use them for genuinely separate work, and give simple ones a small model such as Haiku.',
    web: 'Fetched pages can be long. Point Claude at the exact page or document you mean instead of a broad search.',
    connectors: 'Every connected MCP server adds its tool list to every request. Disconnect the ones you are not using with /mcp.',
  };

  // ---------- details ----------
  function windowDetail(snap, id) {
    const w = snap.windows.find((x) => x.key === id);
    if (!w) return null;
    const t = w.totals;
    const field = SESSION_FIELD[id];
    const sections = [
      { title: 'Where the money went', kind: 'bars', rows: moneyRows(t) },
      { title: 'By model', kind: 'bars', rows: modelRows(w.models || []) },
    ];
    if (field) sections.push({ title: 'Chats that cost the most', kind: 'bars', rows: chatRows(snap, field) });
    const prompt = t.input + t.cacheWrite + t.cacheRead;
    return {
      title: w.label, subtitle: 'At Anthropic API prices',
      stats: [...baseStats(t), { label: 'From cache', value: prompt ? t.cacheRead / prompt : 0, fmt: 'share' }],
      sections: sections.filter((s) => s.rows.length),
      tips: orNothing(tipsFor(t, w.models, snap.pricing)),
    };
  }

  function projectionDetail(snap) {
    const S = snap.spend;
    const days = (snap.series.daily || []).slice(-14);
    const top = Math.max(1e-9, ...days.map((d) => d.cost));
    const week = snap.windows.find((w) => w.key === 'week');
    return {
      title: 'Next 30 days at this pace', subtitle: 'From your average over the last 7 days',
      stats: [
        { label: 'Projected', value: S.projected30Days, fmt: 'usd' },
        { label: 'Per day', value: S.dailyAverage, fmt: 'usd' },
        { label: 'This month so far', value: S.month || 0, fmt: 'usd' },
      ],
      sections: [{ title: 'Last 14 days', kind: 'bars', rows: days.slice().reverse().map((d) => ({ label: new Date(d.t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }), value: d.cost, fmt: 'usd', share: d.cost / top, note: plural(d.requests || 0, 'reply', 'replies') })) }],
      tips: orNothing(week ? tipsFor(week.totals, week.models, snap.pricing) : []),
    };
  }

  function lastHourDetail(snap) {
    const hours = (snap.series.hourly || []).slice(-12);
    const top = Math.max(1e-9, ...hours.map((h) => h.cost));
    const five = snap.windows.find((w) => w.key === 'fiveHour');
    const active = snap.sessions.filter((s) => s.active);
    return {
      title: 'Last hour', subtitle: 'What is running right now',
      stats: [
        { label: 'Spent', value: snap.spend.lastHour, fmt: 'usd' },
        { label: 'Chats active', value: active.length, fmt: 'int' },
        { label: 'Tokens a minute', value: (snap.burn && snap.burn.tokensPerMinute) || 0, fmt: 'compact' },
      ],
      sections: [
        { title: 'Chats active now', kind: 'bars', rows: chatRows(snap, 'fiveHour', (s) => s.active) },
        { title: 'Last 12 hours', kind: 'bars', rows: hours.slice().reverse().map((h) => ({ label: new Date(h.t).toLocaleTimeString('en-US', { hour: 'numeric' }), value: h.cost, fmt: 'usd', share: h.cost / top })) },
      ].filter((s) => s.rows.length),
      tips: orNothing(five ? tipsFor(five.totals, five.models, snap.pricing) : []),
    };
  }

  function limitDetail(snap, id) {
    const L = (snap.limits && snap.limits.windows) || [];
    const w = L.find((x) => x.kind === id);
    if (!w) return null;
    const key = id === 'five_hour' ? 'fiveHour' : 'week';
    const win = snap.windows.find((x) => x.key === key);
    const time = (ms) => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const p = w.projection;
    const tips = [];
    if (p && p.runsOutBeforeReset) {
      tips.push({ title: 'At this pace it runs out before it resets', detail: `You're using about ${p.percentPerHour}% an hour, so it runs out around ${time(p.etaAt)}, before the reset${w.resetsAt ? ` at ${time(Date.parse(w.resetsAt))}` : ''}. Move routine work to Sonnet, /clear between tasks, and hold heavy subagent or browser work until it resets.` });
    }
    tips.push(...tipsFor(win ? win.totals : null, win ? win.models : [], snap.pricing));
    tips.push({ title: 'Shared with the rest of Claude', detail: 'Chats on claude.ai and in the Claude apps use the same limits as Claude Code. A long chat in the browser leaves less for coding.' });
    return {
      title: w.label, subtitle: 'Plan usage, as /usage shows it',
      stats: [
        { label: 'Used', value: w.percentUsed, fmt: 'percent' },
        { label: 'Resets', value: w.resetsAt ? time(Date.parse(w.resetsAt)) : '—', fmt: 'text' },
        { label: 'Pace', value: p ? `+${p.percentPerHour}% an hour` : 'Not enough readings yet', fmt: 'text' },
      ],
      sections: [
        win && { title: 'Where it went (at API prices)', kind: 'bars', rows: moneyRows(win.totals) },
        { title: 'Chats using it', kind: 'bars', rows: chatRows(snap, key) },
      ].filter((s) => s && s.rows.length),
      tips,
    };
  }

  /** "169 requests from you · 269 files changed · mostly running commands (42%), …" */
  function soFarText(s) {
    const m = (s && s.summary) || {};
    return [
      m.prompts ? `${plural(m.prompts, 'request')} from you` : '',
      m.files ? `${plural(m.files, 'file')} changed` : '',
      m.work && m.work.length ? `mostly ${m.work.map((w) => `${w.label.toLowerCase()} (${Math.round(w.share * 100)}%)`).join(', ')}` : '',
      s && s.subagent && s.subagent.total ? `subagents ${usd(s.subagent.cost)}` : '',
    ].filter(Boolean).join(' · ');
  }

  function chatDetail(snap, id) {
    const s = snap.sessions.find((x) => x.id === id);
    if (!s) return null;
    const t = s.tokens;
    const m = s.summary || {};
    const tips = [];
    if (s.contextPercent >= 60) {
      tips.push({ title: 'Compact or clear: the context is filling up', detail: `This chat's context is ${s.contextPercent}% full (${compact(s.contextTokens)} tokens), and every reply re-reads all of it. Use /compact to summarise it, or /clear and start fresh if the next task is different.` });
    }
    if (m.prompts && t.requests / m.prompts > 40) {
      tips.push({ title: 'Many replies per request', detail: `About ${Math.round(t.requests / m.prompts)} replies for each of your requests (${plural(t.requests, 'reply', 'replies')} for ${plural(m.prompts, 'request')}). Each reply re-reads the chat, so this is where the cost comes from. Naming the files and saying what done looks like lets Claude finish in fewer steps.` });
    }
    if (s.subagent && s.subagent.cost > 0.3 * t.cost) {
      tips.push({ title: 'Subagents did much of the work', detail: `${usd(s.subagent.cost)} (${pct(s.subagent.cost, t.cost)}%) went to subagents. That's fine for separate work, but each one builds its own context. For simple lookups, ask the main chat instead.` });
    }
    tips.push(...tipsFor(t, [{ model: s.model, ...t }], snap.pricing));
    const items = [m.goal && { id: `${s.id}:goal`, label: 'First request', text: m.goal }, m.latest && { id: `${s.id}:latest`, label: 'Latest request', text: m.latest }].filter(Boolean);
    const soFar = soFarText(s);
    return {
      title: s.title, subtitle: `${s.project} · ${prettyModel(s.model)}${s.active ? ' · active now' : ''}`,
      stats: [
        { label: 'Cost', value: t.cost, fmt: 'usd' },
        { label: 'Today', value: (s.today && s.today.cost) || 0, fmt: 'usd' },
        { label: 'Replies', value: t.requests, fmt: 'int' },
        { label: 'Per reply', value: t.requests ? t.cost / t.requests : 0, fmt: 'usd2' },
        s.contextTokens ? { label: 'Context', value: `${compact(s.contextTokens)}${s.contextPercent != null ? ` · ${s.contextPercent}%` : ''}`, fmt: 'text' } : null,
      ].filter(Boolean),
      sections: [
        items.length && { title: 'Your requests', kind: 'prompts', items },
        m.now && { title: s.active ? 'Happening now' : 'Where it stopped', kind: 'text', text: m.now },
        soFar && { title: 'So far', kind: 'text', text: soFar },
        { title: 'Where the money went', kind: 'bars', rows: moneyRows(t) },
      ].filter(Boolean),
      tips: orNothing(tips),
    };
  }

  function workDetail(snap, id) {
    const all = (snap.work.all || []).find((w) => w.key === id);
    if (!all) return null;
    const week = (snap.work.week || []).find((w) => w.key === id);
    const whole = (snap.work.all || []).reduce((n, w) => n + w.cost, 0);
    return {
      title: all.label, subtitle: 'Replies grouped by what they did',
      stats: [
        { label: 'All time', value: all.cost, fmt: 'usd' },
        { label: 'Share of spend', value: whole ? all.cost / whole : 0, fmt: 'share' },
        { label: 'Replies', value: all.requests, fmt: 'int' },
        { label: 'Per reply', value: all.requests ? all.cost / all.requests : 0, fmt: 'usd2' },
        { label: 'This week', value: week ? week.cost : 0, fmt: 'usd' },
      ],
      sections: [{ title: 'Where the money went', kind: 'bars', rows: moneyRows(all) }].filter((s) => s.rows.length),
      tips: [{ title: 'What helps', detail: WORK_TIPS[id] || 'Specific prompts and short chats keep this down.' }, ...tipsFor(all, null, snap.pricing)],
    };
  }

  function modelDetail(snap, id) {
    const all = snap.windows.find((w) => w.key === 'all');
    const m = all && (all.models || []).find((x) => x.model === id);
    if (!m) return null;
    return {
      title: prettyModel(id), subtitle: id,
      stats: [
        { label: 'Spent', value: m.cost, fmt: 'usd' },
        { label: 'Share of spend', value: all.totals.cost ? m.cost / all.totals.cost : 0, fmt: 'share' },
        { label: 'Replies', value: m.requests, fmt: 'int' },
        { label: 'Per reply', value: m.requests ? m.cost / m.requests : 0, fmt: 'usd2' },
      ],
      sections: [
        { title: 'Where the money went', kind: 'bars', rows: moneyRows(m) },
        { title: 'Chats on this model', kind: 'bars', rows: chatRows(snap, 'tokens', (s) => s.model === id) },
      ].filter((s) => s.rows.length),
      tips: orNothing(tipsFor(m, [m], snap.pricing, { forceModel: true })),
    };
  }

  function projectDetail(snap, id) {
    const p = (snap.projects || []).find((x) => x.project === id);
    if (!p) return null;
    return {
      title: p.project, subtitle: 'Project folder',
      stats: [
        { label: 'All time', value: p.all.cost, fmt: 'usd' },
        { label: 'This week', value: p.week ? p.week.cost : 0, fmt: 'usd' },
        { label: 'Chats', value: p.sessions, fmt: 'int' },
        { label: 'Tokens', value: p.all.total, fmt: 'compact' },
      ],
      sections: [
        { title: 'Chats in this folder', kind: 'bars', rows: chatRows(snap, 'tokens', (s) => s.project === id) },
        { title: 'Where the money went', kind: 'bars', rows: moneyRows(p.all) },
      ].filter((s) => s.rows.length),
      tips: orNothing(tipsFor(p.all, null, snap.pricing)),
    };
  }

  /** Every request the dashboard knows about (the first and latest of each chat). */
  function promptItems(snap) {
    return snap.sessions.flatMap((s) => {
      const m = s.summary || {};
      return [
        m.goal && { id: `${s.id}:goal`, label: 'First request', text: m.goal, chat: s.id, title: s.title },
        m.latest && { id: `${s.id}:latest`, label: 'Latest request', text: m.latest, chat: s.id, title: s.title },
      ].filter(Boolean);
    });
  }

  function promptsDetail(snap) {
    if (!Coach) return null;
    const sum = Coach.summarizePrompts(promptItems(snap));
    const n = sum.count;
    const tips = [];
    const verb = (count, one, many) => (count === 1 ? one : many);
    if (sum.missingLocation) tips.push({ title: 'Say where to look', detail: `${sum.missingLocation} of your ${plural(n, 'request')} ${verb(sum.missingLocation, 'asks', 'ask')} for a change without naming a file, function or page. Naming it saves Claude a search, often the most expensive part of a chat.` });
    if (sum.missingDone) tips.push({ title: 'Say what done looks like', detail: `${plural(sum.missingDone, 'change request')} ${verb(sum.missingDone, "doesn't", "don't")} say how you'll know it worked. "So that…", "it should…" or "the tests should pass" lets Claude check its own work.` });
    if (sum.vague) tips.push({ title: 'Swap vague words for specifics', detail: `${plural(sum.vague, 'request')} ${verb(sum.vague, 'uses', 'use')} words like "fix it", "stuff" or "make it better". Say which part and what it should do instead.` });
    if (sum.multiTask) tips.push({ title: 'One thing at a time', detail: `${plural(sum.multiTask, 'request')} ${verb(sum.multiTask, 'asks', 'ask')} for three or more things at once. Separate prompts keep each change small and easy to check.` });
    if (sum.wastedWords) tips.push({ title: 'Cut the filler', detail: `${pct(sum.wastedWords, sum.words)}% of your words are filler or padding${sum.topWasted.length ? `, mostly ${sum.topWasted.slice(0, 3).map((w) => `"${w.text}"`).join(', ')}` : ''}. They cost little, but shorter prompts are quicker to write and read.` });
    const topW = sum.topWasted.length ? sum.topWasted[0].count : 1;
    return {
      title: 'Your prompts', subtitle: `The first and latest request of each chat${sum.replies ? `, not counting ${plural(sum.replies, 'quick reply', 'quick replies')}` : ''}`,
      stats: [
        { label: 'Average score', value: sum.avgScore == null ? '—' : `${sum.avgScore}/100`, fmt: 'text' },
        { label: 'Requests', value: n, fmt: 'int' },
        { label: 'Filler words', value: sum.wastedShare, fmt: 'share' },
        { label: 'Clear', value: (sum.grades.find((g) => g.grade === 'Clear') || {}).count || 0, fmt: 'int' },
      ],
      sections: [
        { title: 'Weakest first', kind: 'bars', rows: sum.worst.slice(0, 10).map((it) => ({ label: it.text, value: `${it.analysis.score}/100`, fmt: 'text', share: it.analysis.score / 100, note: `${it.label} · ${it.title}`, ref: { type: 'prompt', id: it.id } })) },
        { title: 'Most common filler', kind: 'bars', rows: sum.topWasted.map((w) => ({ label: `"${w.text}"`, value: w.count, fmt: 'int', share: w.count / topW })) },
      ].filter((s) => s.rows.length),
      tips: orNothing(tips),
    };
  }

  function promptDetail(snap, id) {
    const it = promptItems(snap).find((p) => p.id === id);
    if (!it) return null;
    return {
      title: it.label, subtitle: it.title,
      stats: [],
      sections: [{ title: 'Breakdown', kind: 'prompts', items: [it] }, { title: 'In this chat', kind: 'bars', rows: [{ label: it.title, value: 'Open', fmt: 'text', share: 0, ref: { type: 'chat', id: it.chat } }] }],
      tips: [],
    };
  }

  // ---------- All your AIs (the page's own reports: OpenAI, OpenRouter, Claude API, the CLIs) ----------
  const when = (ms) => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  function agoText(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  }
  const dayLabel = (date) => new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  /** "openai-api|gpt-5" → ["openai-api", "gpt-5"] (model names may contain ":" or "/"). */
  const split = (id) => { const s = String(id || ''); const i = s.indexOf('|'); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; };
  const aiValue = (r, x) => (r.hasCost && x.cost != null ? x.cost : x.tokens || 0);
  const aiFmt = (r) => (r.hasCost ? 'usd' : 'compact');
  /** Claude model ids read better as "Opus 5.5"; other providers' names stay as they are. */
  const nice = (id) => (/^claude-/.test(String(id)) ? prettyModel(id) : String(id));
  const AI_STATUS = { 'needs-key': 'Not added yet', 'not-found': 'Not found on your computer', empty: 'No usage yet', error: 'Problem reading it', waiting: 'Checking', 'needs-pc': 'Needs your computer' };
  const AI_EXTRA = {
    openrouter: ['One key per tool, with a cap', 'Give each tool or project its own OpenRouter key with a credit limit. You then see what each one costs, and a runaway script stops at its limit instead of draining your balance.'],
    'openai-api': ['Batch what can wait', "Requests that don't need an answer straight away can go through OpenAI's Batch API, which costs less."],
    'anthropic-api': ['Batch what can wait', "Requests that don't need an answer straight away can go through Anthropic's Message Batches API, which costs less."],
    'claude-code': ['See it chat by chat', 'The Claude Code page breaks this down by chat, model and kind of work, with tips for each.'],
    'codex-cli': ['Start fresh for new tasks', 'Long sessions send their whole history with every turn. Start a new session when you move on to something unrelated.'],
    'gemini-cli': ['Start fresh for new tasks', 'Long sessions send their whole history with every turn. Start a new session when you move on to something unrelated.'],
  };

  function aiTips(r) {
    const tips = [];
    const t = r.tokens || {};
    if (t.input > 1e5 && ['openai-api', 'openrouter', 'anthropic-api'].includes(r.id) && (t.cached || 0) / t.input < 0.2) {
      tips.push({ title: 'Let more of each prompt be cached', detail: `Only ${pct(t.cached || 0, t.input)}% of the ${compact(t.input)} input tokens came from the cache, and cached input costs much less. Put the fixed part of each request (instructions, examples, long documents) first and the changing part last, so repeated beginnings can be reused${r.id === 'anthropic-api' ? ', and mark them for caching with cache_control' : ''}.` });
    }
    if (t.output > 0 && (t.reasoning || 0) / t.output > 0.3) {
      tips.push({ title: 'Reasoning is a big part of the output', detail: `${pct(t.reasoning, t.output)}% of the output tokens are the model thinking before it answers. For simple requests, ask for less reasoning (a lower reasoning effort, where the API offers one) or use a model that doesn't reason.` });
    } else if (t.total > 0 && t.output / t.total > 0.35) {
      tips.push({ title: 'The answers are long', detail: `${pct(t.output, t.total)}% of the tokens are output, which costs more per token than input. Ask for shorter answers or set a maximum output length.` });
    }
    const models = (r.models || []).filter((m) => aiValue(r, m) > 0);
    const whole = models.reduce((n, m) => n + aiValue(r, m), 0);
    if (r.kind === 'account' && models.length && whole && aiValue(r, models[0]) / whole > 0.7) {
      tips.push({ title: 'Most of it is one model', detail: `${nice(models[0].model)} is ${pct(aiValue(r, models[0]), whole)}% of this. Try a smaller, cheaper model for routine requests such as summaries, tagging and simple questions, and keep this one for the hard ones.` });
    }
    const days = (r.daily || []).map((d) => (r.hasCost ? d.cost || 0 : d.tokens || 0));
    if (days.length >= 14) {
      const last = days.slice(-7).reduce((a, b) => a + b, 0);
      const prev = days.slice(-14, -7).reduce((a, b) => a + b, 0);
      if (prev > 0 && last > prev * 1.5) {
        const show = (v) => (r.hasCost ? usd(v) : `${compact(v)} tokens`);
        tips.push({ title: `Up ${Math.round((last / prev - 1) * 100)}% on the week before`, detail: `The last 7 days came to ${show(last)}, against ${show(prev)} the 7 days before. The days and models below show what changed.` });
      }
    }
    if (AI_EXTRA[r.id]) tips.push({ title: AI_EXTRA[r.id][0], detail: AI_EXTRA[r.id][1] });
    return tips;
  }

  function aiAll(reports) {
    const ok = reports.filter((r) => r.status === 'ok');
    const costly = ok.filter((r) => r.hasCost && r.spend && r.spend.month != null);
    const spend = costly.reduce((n, r) => n + r.spend.month, 0);
    const rows = costly.filter((r) => r.spend.month > 0).sort((a, b) => b.spend.month - a.spend.month)
      .map((r) => ({ label: r.name, value: r.spend.month, fmt: 'usd', share: spend ? r.spend.month / spend : 0, note: `${compact((r.tokens || {}).total || 0)} tokens · ${plural(r.requests || 0, 'request')}`, ref: { type: 'ai', id: r.id } }));
    const tokenOnly = ok.filter((r) => !r.hasCost).map((r) => ({ label: r.name, value: (r.tokens || {}).total || 0, fmt: 'compact', share: 0, note: 'tokens (no prices in its logs)', ref: { type: 'ai', id: r.id } }));
    const missing = reports.filter((r) => r.status === 'needs-key');
    const tips = [];
    if (rows.length > 1 && rows[0].share > 0.5) tips.push({ title: `${rows[0].label} is most of it`, detail: `${Math.round(rows[0].share * 100)}% of your AI spend in the last 30 days. Open it for what you can change there.` });
    if (missing.length) tips.push({ title: 'Add the rest', detail: `${missing.map((r) => r.name).join(', ')} ${missing.length === 1 ? "isn't" : "aren't"} added yet. Add ${missing.length === 1 ? 'it' : 'them'} on this page so the total covers everything.` });
    return {
      title: 'Every AI, last 30 days', subtitle: "At each provider's prices",
      stats: [
        { label: 'Spent', value: spend, fmt: 'usd' },
        { label: 'Tokens', value: ok.reduce((n, r) => n + ((r.tokens || {}).total || 0), 0), fmt: 'compact' },
        { label: 'Connected', value: ok.length, fmt: 'int' },
      ],
      sections: [{ title: 'By AI', kind: 'bars', rows }, { title: 'Tokens only', kind: 'bars', rows: tokenOnly }].filter((s) => s.rows.length),
      tips: orNothing(tips),
    };
  }

  function aiOne(reports, id) {
    const r = reports.find((x) => x.id === id);
    if (!r) return null;
    if (r.status !== 'ok') {
      return { title: r.name, subtitle: AI_STATUS[r.status] || '', stats: [], tips: [], sections: [{ title: 'Status', kind: 'text', text: r.message || `Add ${r.name} on this page to see it here.` }] };
    }
    const L = r.spendLabels || { today: 'Today', week: 'Last 7 days', month: 'Last 30 days', allTime: 'All time' };
    const days = r.daily || [];
    const sumDays = (k) => days.slice(-k).reduce((n, d) => n + (d.tokens || 0), 0);
    const t = r.tokens || {};
    const stats = r.hasCost
      ? [
        { label: L.today, value: r.spend.today, fmt: 'usd' },
        { label: L.week, value: r.spend.week, fmt: 'usd' },
        { label: L.month, value: r.spend.month, fmt: 'usd' },
        r.spend.allTime != null && { label: L.allTime, value: r.spend.allTime, fmt: 'usd' },
        { label: 'Per request', value: r.requests ? r.spend.month / r.requests : 0, fmt: 'usd2' },
      ]
      : [
        { label: 'Today', value: sumDays(1), fmt: 'compact' },
        { label: 'Last 7 days', value: sumDays(7), fmt: 'compact' },
        { label: 'Last 30 days', value: t.total || 0, fmt: 'compact' },
        r.allTimeTokens != null && { label: 'All time', value: r.allTimeTokens, fmt: 'compact' },
      ];
    const tokRows = [['Input', t.input], ['From the cache (part of input)', t.cached], ['Output', t.output], ['Reasoning', t.reasoning]]
      .filter(([, v]) => v > 0).map(([label, v]) => ({ label, value: v, fmt: 'compact', share: t.total ? Math.min(1, v / t.total) : 0 }));
    const models = (r.models || []).filter((m) => aiValue(r, m) > 0);
    const top = Math.max(1e-9, ...models.map((m) => aiValue(r, m)));
    const recent = days.slice(-14).reverse();
    const topDay = Math.max(1e-9, ...recent.map((d) => aiValue(r, d)));
    const sessions = (r.sessions || []).slice(0, 10);
    const topS = Math.max(1e-9, ...sessions.map((s) => aiValue(r, s)));
    return {
      title: r.name, subtitle: r.kind === 'account' ? 'Last 30 days, from its usage API' : 'From its logs on your computer',
      stats: stats.filter(Boolean),
      sections: [
        { title: 'Tokens', kind: 'bars', rows: tokRows },
        { title: 'By model', kind: 'bars', rows: models.map((m) => ({ label: nice(m.model), value: aiValue(r, m), fmt: aiFmt(r), share: aiValue(r, m) / top, note: `${compact(m.tokens)} tokens · ${plural(m.requests || 0, 'request')}`, ref: { type: 'aiModel', id: `${r.id}|${m.model}` } })) },
        { title: 'Last 14 days', kind: 'bars', rows: recent.map((d) => ({ label: dayLabel(d.date), value: aiValue(r, d), fmt: aiFmt(r), share: aiValue(r, d) / topDay, note: plural(d.requests || 0, 'request'), ref: { type: 'aiDay', id: `${r.id}|${d.date}` } })) },
        { title: r.id === 'claude-code' ? 'Most expensive chats' : 'Recent sessions', kind: 'bars', rows: sessions.map((s, i) => ({ label: s.title || s.model || 'Session', value: aiValue(r, s), fmt: aiFmt(r), share: aiValue(r, s) / topS, note: `${s.model ? `${s.model} · ` : ''}${compact(s.tokens || 0)} tokens${s.lastTs ? ` · ${agoText(s.lastTs)}` : ''}`, ref: { type: 'aiSession', id: `${r.id}|${i}` } })) },
      ].filter((s) => s.rows.length),
      tips: orNothing(aiTips(r)),
    };
  }

  function aiModel(reports, id) {
    const [aid, model] = split(id);
    const r = reports.find((x) => x.id === aid);
    const m = r && (r.models || []).find((x) => x.model === model);
    if (!m) return null;
    const whole = (r.models || []).reduce((n, x) => n + aiValue(r, x), 0);
    const share = whole ? aiValue(r, m) / whole : 0;
    const tips = [];
    if (r.kind === 'account' && share > 0.5 && (r.models || []).length) tips.push({ title: 'Try a smaller model for routine requests', detail: `This model is ${Math.round(share * 100)}% of ${r.name}. Summaries, tagging and simple questions rarely need it: a smaller model from the same family usually costs a fraction as much.` });
    if (r.kind === 'account' && m.requests && m.tokens / m.requests > 20000) tips.push({ title: 'Big requests', detail: `About ${compact(m.tokens / m.requests)} tokens a request. Send only the context the model needs (the relevant part of a document, not all of it), and reuse a fixed beginning so it can be cached.` });
    if (/:free\b/i.test(m.model)) tips.push({ title: 'Free, with a daily limit', detail: 'Free models cost nothing but have a daily allowance of requests. If a tool starts failing, that limit is the first thing to check.' });
    return {
      title: nice(m.model), subtitle: `${r.name} · ${m.model} · last 30 days`,
      stats: [
        r.hasCost && m.cost != null && { label: 'Spent', value: m.cost, fmt: 'usd' },
        { label: 'Tokens', value: m.tokens, fmt: 'compact' },
        { label: 'Requests', value: m.requests || 0, fmt: 'int' },
        r.hasCost && m.cost != null && { label: 'Per request', value: m.requests ? m.cost / m.requests : 0, fmt: 'usd2' },
        { label: `Share of ${r.name}`, value: share, fmt: 'share' },
      ].filter(Boolean),
      sections: [],
      tips: orNothing(tips),
    };
  }

  function aiDay(reports, id) {
    const [aid, date] = split(id);
    const r = reports.find((x) => x.id === aid);
    const days = (r && r.daily) || [];
    const d = days.find((x) => x.date === date);
    if (!d) return null;
    const avg = days.reduce((n, x) => n + aiValue(r, x), 0) / (days.length || 1);
    const v = aiValue(r, d);
    const tips = [];
    if (avg > 0 && v > 2 * avg) tips.push({ title: 'A busy day', detail: `About ${Math.round((v / avg) * 10) / 10} times your daily average. If that wasn't planned, check which tool or script ran that day, and give it its own key with a cap.` });
    return {
      title: dayLabel(date), subtitle: r.name,
      stats: [
        r.hasCost ? { label: 'Spent', value: d.cost || 0, fmt: 'usd' } : { label: 'Tokens', value: d.tokens || 0, fmt: 'compact' },
        { label: 'Requests', value: d.requests || 0, fmt: 'int' },
        { label: '30-day average', value: avg, fmt: aiFmt(r) },
        { label: 'Against average', value: avg ? `${v >= avg ? '+' : '−'}${Math.abs(Math.round((v / avg - 1) * 100))}%` : '—', fmt: 'text' },
      ],
      sections: [],
      tips: orNothing(tips),
    };
  }

  function aiSession(reports, id) {
    const [aid, idx] = split(id);
    const r = reports.find((x) => x.id === aid);
    const s = r && (r.sessions || [])[Number(idx)];
    if (!s) return null;
    const tips = [];
    if ((s.tokens || 0) > 2e6) tips.push({ title: 'A long session', detail: `${compact(s.tokens)} tokens. Long sessions resend their history with every turn, so later turns cost more than early ones. Start a new session when the task changes.` });
    if (AI_EXTRA[r.id]) tips.push({ title: AI_EXTRA[r.id][0], detail: AI_EXTRA[r.id][1] });
    return {
      title: s.title || s.model || 'Session', subtitle: r.name,
      stats: [
        r.hasCost && s.cost != null && { label: 'Cost', value: s.cost, fmt: 'usd' },
        { label: 'Tokens', value: s.tokens || 0, fmt: 'compact' },
        s.model && { label: 'Model', value: s.model, fmt: 'text' },
        s.lastTs && { label: 'Last active', value: agoText(s.lastTs), fmt: 'text' },
      ].filter(Boolean),
      sections: [],
      tips: orNothing(tips),
    };
  }

  const AI_KINDS = { aiAll: (reports) => aiAll(reports), ai: aiOne, aiModel, aiDay, aiSession };
  /** What opens when you click a figure on All your AIs. */
  function aiDetail(reports, ref) {
    const fn = ref && AI_KINDS[ref.type];
    return fn && Array.isArray(reports) ? fn(reports, ref.id) : null;
  }

  // ---------- Friends (their shared cards: totals and limits only) ----------
  function cardFigures(card) {
    const pcs = Object.values((card && card.pcs) || {}).filter((p) => p && p.claude).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { pcs, c: pcs[0] ? pcs[0].claude : null, at: pcs[0] ? pcs[0].updatedAt : 0 };
  }

  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  /** Your own card, from the dashboard's snapshot: the same figures friends receive (lib/share.js cardOf). */
  function cardFromSnapshot(snap, name) {
    if (!snap || !snap.spend) return null;
    const work = snap.work && snap.work.all && snap.work.all[0];
    const today = snap.windows && snap.windows.find((w) => w.key === 'today');
    const S = snap.spend;
    return {
      name, photo: null, ai: {},
      pcs: {
        here: {
          name: 'This computer', updatedAt: Date.now(),
          claude: {
            spend: { today: round2(S.today), week: round2(S.week), lastHour: round2(S.lastHour), allTime: round2(S.allTime), projected30Days: round2(S.projected30Days), month: round2(S.month) },
            limits: snap.limits && !snap.limits.stale ? snap.limits.windows.map((w) => ({ label: w.label, percent: w.percentUsed, resetsAt: w.resetsAt })) : [],
            activeChats: snap.activeSessions || 0,
            repliesToday: today ? today.totals.requests : 0,
            topWork: work && S.allTime ? { label: work.label, share: round2(work.cost / S.allTime) } : null,
          },
        },
      },
    };
  }

  /** The desktop app's friends (added by friend code) in the shape the strip and breakdown use. */
  function friendsFromCodes(list) {
    return (list || []).filter((f) => !(f.card && f.card.stopped)).map((f) => ({
      uid: `code:${f.code}`,
      name: f.card ? f.card.name : f.code,
      card: f.card ? { name: f.card.name, photo: null, ai: {}, pcs: { here: { name: 'Their computer', updatedAt: Date.parse(f.card.updatedAt) || 0, claude: f.card } } } : null,
    }));
  }

  /** The dashboard's friends strip: one small card each, whoever is active first, then the biggest spender today. */
  function friendStrip(ctx) {
    return ((ctx && ctx.friends) || []).map((f) => {
      const { c, at } = cardFigures(f.card);
      const sp = (c && c.spend) || {};
      const five = ((c && c.limits) || []).find((l) => /5-hour/i.test(l.label)) || ((c && c.limits) || [])[0];
      return {
        uid: f.uid, name: (f.card && f.card.name) || f.name || 'Friend', photo: (f.card && f.card.photo) || f.photo || null,
        loading: !f.card, at, active: at ? Date.now() - at < 6 * 60e3 : false,
        today: sp.today != null ? sp.today : null, month: sp.month != null ? sp.month : sp.projected30Days != null ? sp.projected30Days : null,
        limit: five ? Math.round(Number(five.percent) || 0) : null, limitLabel: five ? five.label : '',
      };
    }).sort((a, b) => (b.active - a.active) || ((b.today || 0) - (a.today || 0)) || a.name.localeCompare(b.name));
  }

  /** ctx: { me: { uid, name, card }, friends: [{ uid, name, card }] }. */
  function friendDetail(ctx, ref) {
    if (!ctx || !ref || ref.type !== 'friend') return null;
    const self = Boolean(ctx.me && ref.id === ctx.me.uid);
    const f = self ? ctx.me : (ctx.friends || []).find((x) => x.uid === ref.id);
    if (!f || !f.card) return null;
    const name = f.card.name || f.name || 'Friend';
    const { pcs, c, at } = cardFigures(f.card);
    const sp = (c && c.spend) || {};
    const month = sp.month != null ? sp.month : sp.projected30Days;
    const perReply = c && c.repliesToday ? sp.today / c.repliesToday : null;
    const mine = !self && ctx.me && ctx.me.card ? cardFigures(ctx.me.card).c : null;
    const mySp = (mine && mine.spend) || {};
    const myPerReply = mine && mine.repliesToday ? mySp.today / mine.repliesToday : null;
    const whose = self ? 'your' : `${name}'s`;
    const tips = [];
    if (!self && perReply != null && myPerReply != null) {
      if (myPerReply > perReply * 1.3) tips.push({ title: 'You pay more per reply', detail: `About ${usd(myPerReply)} a reply for you against ${usd(perReply)} for ${name} today. Long chats and the biggest models are the usual reasons. Your Claude Code page shows which.` });
      else if (perReply > myPerReply * 1.3) tips.push({ title: `${name} pays more per reply`, detail: `${usd(perReply)} a reply against your ${usd(myPerReply)} today. If they ask: clearing chats between tasks and using Sonnet for routine work are the usual fixes.` });
    }
    for (const l of ((c && c.limits) || []).filter((x) => Number(x.percent) >= 80)) {
      tips.push({ title: `${self ? 'You are' : `${name} is`} close to a limit`, detail: `${l.label} is at ${Math.round(l.percent)}%${l.resetsAt ? `, and resets ${when(Date.parse(l.resetsAt))}` : ''}.` });
    }
    if (c && c.topWork) tips.push({ title: 'Where most of it goes', detail: `${c.topWork.label} is ${Math.round(c.topWork.share * 100)}% of ${whose} Claude Code spend.` });
    if (at && Date.now() - at > 864e5) tips.push({ title: 'Not updated lately', detail: `${self ? 'Your' : `${name}'s`} computer last sent figures ${agoText(at)}.` });
    const vs = (label, a, b) => ({ label, value: `${a == null ? '—' : usd(a)} vs ${b == null ? '—' : usd(b)}`, fmt: 'text', share: 0 });
    return {
      title: self ? `${name} (you)` : name,
      subtitle: at ? `Claude Code at API prices · updated ${agoText(at)}` : 'No computer linked yet',
      stats: [
        { label: 'Today', value: sp.today, fmt: 'usd' },
        { label: '7 days', value: sp.week, fmt: 'usd' },
        { label: '30 days', value: month, fmt: 'usd' },
        sp.allTime != null && { label: 'All time', value: sp.allTime, fmt: 'usd' },
        c && { label: 'Replies today', value: c.repliesToday || 0, fmt: 'int' },
        perReply != null && { label: 'Per reply today', value: perReply, fmt: 'usd2' },
      ].filter((s) => s && s.value != null),
      sections: [
        { title: 'Plan limits', kind: 'bars', rows: ((c && c.limits) || []).map((l) => ({ label: l.label, value: `${Math.round(l.percent)}%`, fmt: 'text', share: Math.max(0.01, Math.min(1, l.percent / 100)), note: l.resetsAt ? `Resets ${when(Date.parse(l.resetsAt))}` : '' })) },
        !self && mine && { title: 'Compared with you', kind: 'bars', rows: [vs('Today, them vs you', sp.today, mySp.today), vs('7 days', sp.week, mySp.week), vs('Per reply today', perReply, myPerReply)] },
        { title: 'Computers', kind: 'bars', rows: pcs.map((p) => ({ label: p.name || 'Computer', value: p.claude.spend.today, fmt: 'usd', share: 0, note: `Today · updated ${agoText(p.updatedAt)}` })) },
        { title: 'Other AIs, last 30 days', kind: 'bars', rows: Object.values(f.card.ai || {}).filter((a) => a && a.month != null).map((a) => ({ label: a.name, value: a.month, fmt: 'usd', share: 0 })) },
      ].filter((s) => s && s.rows.length),
      tips: orNothing(tips),
    };
  }

  const KINDS = {
    window: windowDetail, projection: projectionDetail, lastHour: lastHourDetail, limit: limitDetail, chat: chatDetail,
    work: workDetail, model: modelDetail, project: projectDetail, prompts: promptsDetail, prompt: promptDetail,
  };
  function detail(snap, ref) {
    const fn = ref && KINDS[ref.type];
    return fn && snap ? fn(snap, ref.id) : null;
  }

  return { detail, aiDetail, friendDetail, friendStrip, friendsFromCodes, cardFromSnapshot, soFarText, prettyModel, promptItems, tipsFor };
});
