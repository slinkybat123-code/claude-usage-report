'use strict';
/* All your AIs: one tab per AI, the same report for each (spend, tokens, a
   30-day chart, models, sessions). Connect accounts by pasting a key here on
   the PC; remote viewers see the reports read-only. */
(() => {
  const C = window.Charts;
  const { esc, compact, full, usd, usd2, ago } = C;
  const $ = (id) => document.getElementById(id);
  const REMOTE = document.body.dataset.mode === 'remote';
  // The website: window.AI_SOURCE (set by the page's module) reads your account instead of this PC's server.
  const HOSTED = document.documentElement.hasAttribute('data-hosted');
  const src = () => window.AI_SOURCE;
  const APP = document.documentElement.classList.contains('app');
  const CALM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COLORS = { 'claude-code': 'var(--ai-claude)', 'anthropic-api': 'var(--ai-claude-api)', codex: 'var(--ai-codex)', 'openai-api': 'var(--ai-openai)', 'gemini-cli': 'var(--ai-gemini)', openrouter: 'var(--ai-openrouter)' };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
  };
  if (APP && $('back')) $('back').href = '/?app=1';

  let reports = [];
  let selected = store.get('aiTab');
  let problem = {}; // id -> message from a failed connect
  const shown = new Map();

  // ---------- numbers that count up ----------
  function countUp(el) {
    const key = el.dataset.k;
    const to = Number(el.dataset.n);
    const fmt = el.dataset.f === 'usd' ? usd2 : el.dataset.f === 'usd0' ? usd : compact;
    const from = shown.has(key) ? shown.get(key) : 0;
    shown.set(key, to);
    if (CALM || from === to) return void (el.textContent = fmt(to));
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 800);
      el.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - p, 4)));
      if (p < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const num = (key, v, f) => (v == null ? '<span class="ai-na">—</span>' : `<span class="num" data-k="${esc(key)}" data-n="${v}" data-f="${f}">${f === 'tok' ? compact(0) : usd2(0)}</span>`);
  const opens = (ref) => (window.Sheet ? window.Sheet.attrs(ref) : '');
  const animate = () => document.querySelectorAll('#ai-overview [data-n], #ai-panel [data-n]').forEach(countUp);

  if (window.Sheet && window.Insights) window.Sheet.use((ref) => window.Insights.aiDetail(reports, window.Sheet.parse(ref)));

  // ---------- overview ----------
  function renderOverview() {
    const ok = reports.filter((r) => r.status === 'ok');
    const costly = ok.filter((r) => r.hasCost && r.spend && r.spend.month != null);
    const spend = costly.reduce((s, r) => s + r.spend.month, 0);
    const tokens = ok.reduce((s, r) => s + ((r.tokens && r.tokens.total) || 0), 0);
    const share = costly.filter((r) => r.spend.month > 0).sort((a, b) => b.spend.month - a.spend.month);
    $('ai-overview').innerHTML = `
      <div class="ai-ov-main"${opens('aiAll')}>
        <div class="eyebrow">Last 30 days, every AI</div>
        <div class="ai-ov-total">${num('ov.spend', spend, 'usd')}</div>
        <div class="ai-ov-sub">${num('ov.tokens', tokens, 'tok')} tokens across ${ok.length} AI${ok.length === 1 ? '' : 's'} · ${reports.filter((r) => r.status === 'needs-key').length} more you can add</div>
      </div>
      <div class="ai-ov-share">
        <div class="ai-share" role="img" aria-label="Share of spend by AI">${share.map((r) => `<span style="flex-grow:${r.spend.month};background:${COLORS[r.id]}" title="${esc(r.name)} ${usd2(r.spend.month)}"></span>`).join('') || '<span class="ai-share-empty"></span>'}</div>
        <ul class="ai-share-key">${share.map((r) => `<li${opens(`ai:${r.id}`)}><i style="background:${COLORS[r.id]}"></i>${esc(r.name)} <b>${usd(r.spend.month)}</b> <span>${Math.round((r.spend.month / (spend || 1)) * 100)}%</span></li>`).join('')}</ul>
      </div>`;
  }

  // ---------- tabs ----------
  function statusWord(r) {
    return { ok: 'Connected', empty: 'No usage yet', 'not-found': HOSTED ? 'Not on your computer' : 'Not on this computer', 'needs-key': 'Not added', error: 'Problem', waiting: 'Checking', 'needs-pc': 'Needs your computer' }[r.status] || '';
  }
  function renderTabs() {
    const tabs = $('ai-tabs');
    const ink = $('ai-ink');
    tabs.innerHTML = '';
    tabs.appendChild(ink);
    reports.forEach((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.role = 'tab';
      b.id = `tab-${r.id}`;
      b.dataset.id = r.id;
      b.setAttribute('aria-selected', String(r.id === selected));
      b.tabIndex = r.id === selected ? 0 : -1;
      b.className = `ai-tab ${r.status}`;
      b.innerHTML = `<i style="background:${r.status === 'ok' ? COLORS[r.id] : 'var(--axis)'}"></i><span>${esc(r.name)}</span><small>${esc(statusWord(r))}</small>`;
      tabs.appendChild(b);
    });
    moveInk(false);
    if (!renderTabs.placed) {
      // First draw: bring the remembered tab into view without animating.
      renderTabs.placed = true;
      const tab = document.querySelector(`.ai-tab[data-id="${CSS.escape(selected)}"]`);
      if (tab) tab.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }
  function moveInk(smooth = true) {
    const tab = document.querySelector(`.ai-tab[data-id="${CSS.escape(selected)}"]`);
    const ink = $('ai-ink');
    if (!tab) return;
    ink.style.transition = smooth && !CALM ? '' : 'none';
    ink.style.width = `${tab.offsetWidth}px`;
    ink.style.transform = `translateX(${tab.offsetLeft}px)`;
    ink.style.background = COLORS[selected];
    if (smooth) tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: CALM ? 'auto' : 'smooth' });
  }

  // ---------- one AI ----------
  function chart(r) {
    const days = r.daily || [];
    if (!days.length) return '';
    const useCost = r.hasCost && days.some((d) => d.cost != null);
    const val = (d) => (useCost ? d.cost || 0 : d.tokens || 0);
    const max = Math.max(1e-9, ...days.map(val));
    const W = 960;
    const H = 200;
    const slot = W / days.length;
    const bw = Math.max(4, slot - 6);
    const bars = days.map((d, i) => {
      const h = Math.max(val(d) > 0 ? 3 : 0, (val(d) / max) * (H - 30));
      const x = i * slot + (slot - bw) / 2;
      const label = i % 5 === days.length % 5 ? `<text x="${x + bw / 2}" y="${H - 4}" text-anchor="middle" class="tick">${esc(d.date.slice(5).replace('-', '/'))}</text>` : '';
      return `<g class="ai-bar" data-i="${i}" data-detail="aiDay:${esc(r.id)}|${esc(d.date)}" style="--c:${i}"><rect class="hit" x="${i * slot}" y="0" width="${slot}" height="${H - 18}" fill="transparent"/><path d="M${x},${H - 18} v${-Math.max(0, h - 3)} q0,-3 3,-3 h${bw - 6} q3,0 3,3 v${Math.max(0, h - 3)} z" fill="${COLORS[r.id]}"/></g>${label}`;
    }).join('');
    return `<div class="card ai-chart"><div class="chart-head"><h2>${useCost ? 'Spend' : 'Tokens'} per day</h2><p class="desc" style="margin:0">Last 30 days</p></div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" class="chart" role="img" aria-label="${esc(r.name)} ${useCost ? 'spend' : 'tokens'} per day" data-ai-chart="${esc(r.id)}">${bars}</svg></div>`;
  }

  function list(title, rows, r, valueOf, metaOf, keyPrefix, refOf) {
    if (!rows.length) return '';
    const top = Math.max(1e-9, ...rows.map(valueOf));
    return `<div class="card"><h2>${title}</h2><ol class="board work ai-list">${rows.slice(0, 10).map((row, i) => `
      <li${refOf ? opens(refOf(row, i)) : ''}><div class="b-main"><div class="b-title" title="${esc(row.title || row.model)}">${esc(row.title || row.model)}</div><div class="b-meta">${esc(metaOf(row))}</div></div>
      <div class="b-cost">${r.hasCost && row.cost != null ? num(`${keyPrefix}.${r.id}.${i}`, row.cost, 'usd') : num(`${keyPrefix}.${r.id}.${i}`, row.tokens, 'tok')}</div>
      <div class="track"><span class="fill ai-fill" style="--w:${Math.max(1, (valueOf(row) / top) * 100)}%;background:${COLORS[r.id]}"></span></div></li>`).join('')}</ol></div>`;
  }

  function connectCard(r) {
    if (REMOTE) return `<div class="card ai-empty"><h2>${esc(r.name)} isn't added yet</h2><p>Add it from the dashboard on your computer: All your AIs, ${esc(r.name)}.</p></div>`;
    const err = problem[r.id];
    return `<div class="card ai-connect"><h2>Add ${esc(r.name)}</h2>
      <p class="desc">${HOSTED ? esc(src().keyNote(r)) : `Paste your ${esc(r.keyName.replace(/^Admin/, "admin"))}. It stays on this computer (in the monitor's data folder) and is only ever sent to ${esc(r.name.replace(' API', ''))} itself, to read your usage.`}</p>
      <p class="ai-help">${esc(r.keyHelp)}</p>
      <form data-connect="${esc(r.id)}" autocomplete="off">
        <label for="key-${esc(r.id)}">${esc(r.keyName)}</label>
        <div class="apps-actions"><input id="key-${esc(r.id)}" name="key" type="password" spellcheck="false" autocomplete="off" required placeholder="Paste it here">
        <button type="submit" class="primary">Connect</button></div>
        <p class="err" role="alert"${err ? '' : ' hidden'}>${esc(err || '')}</p>
      </form></div>`;
  }

  function panel(r) {
    if (r.status === 'needs-key') return connectCard(r);
    if (r.status === 'waiting' || r.status === 'needs-pc') {
      return `<div class="card ai-empty"><h2>${esc(r.name)}</h2><p>${esc(r.message || '')}</p>
        <div class="apps-actions"><button type="button" data-disconnect="${esc(r.id)}">Remove key</button></div></div>`;
    }
    if (r.status === 'not-found' || r.status === 'empty') {
      return `<div class="card ai-empty"><h2>${esc(r.name)}</h2><p>${esc(r.message || '')}</p>${r.where ? `<p class="desc">${esc(r.where)}</p>` : ''}</div>`;
    }
    if (r.status === 'error') {
      return `<div class="card ai-empty"><h2>Couldn't read ${esc(r.name)}</h2><p>${esc(r.message || '')}</p>
        ${REMOTE ? '' : `<div class="apps-actions"><button type="button" data-retry>Try again</button><button type="button" data-disconnect="${esc(r.id)}">Remove key</button></div>`}</div>`;
    }
    const L = r.spendLabels || { today: 'Today', week: 'Last 7 days', month: 'Last 30 days', allTime: 'All time' };
    const days = r.daily || [];
    const tokSum = (k) => days.slice(-k).reduce((s, d) => s + (d.tokens || 0), 0);
    const kpis = r.hasCost
      ? [[L.today, r.spend.today, 'usd'], [L.week, r.spend.week, 'usd'], [L.month, r.spend.month, 'usd'], [L.allTime, r.spend.allTime, 'usd0']]
      : [['Tokens today', tokSum(1), 'tok'], ['Last 7 days', tokSum(7), 'tok'], ['Last 30 days', tokSum(30), 'tok'], ['All time', r.allTimeTokens, 'tok']];
    const t = r.tokens || {};
    const mix = [['Input', t.input, 'var(--series-1)'], ['Cached', t.cached, 'var(--series-3)'], ['Output', t.output, 'var(--series-2)'], ['Reasoning', t.reasoning, 'var(--series-4)']].filter(([, v]) => v > 0);
    const mixTotal = mix.reduce((s, [, v]) => s + v, 0) || 1;
    return `
      <div class="card ai-head"${opens(`ai:${r.id}`)}>
        <div class="ai-head-row"><span class="ai-dot" style="background:${COLORS[r.id]}"></span><h2>${esc(r.name)}</h2>
          <span class="desc">${esc(r.kind === 'account' ? `Connected${r.connectedAt ? ` ${ago(Date.parse(r.connectedAt), Date.now())}` : ''}` : r.where || '')}</span>
          <span class="spacer"></span>${r.kind === 'account' && !REMOTE ? `<button type="button" class="ai-remove" data-disconnect="${esc(r.id)}">Remove</button>` : ''}</div>
        <dl class="ai-kpis">${kpis.map(([label, v, f], i) => `<div><dt>${esc(label)}</dt><dd>${num(`k.${r.id}.${i}`, v, f)}</dd></div>`).join('')}</dl>
        ${mix.length ? `<div class="mix ai-mix">${mix.map(([, v, c]) => `<span style="flex-grow:${v};background:${c}"></span>`).join('')}</div>
        <ul class="mix-legend">${mix.map(([label, v, c]) => `<li><i style="background:${c}"></i>${label} <b>${compact(v)}</b> · ${Math.round((v / mixTotal) * 100)}%</li>`).join('')}</ul>
        <p class="desc ai-tokline">${compact(t.total || 0)} tokens and ${full(r.requests || 0)} ${r.kind === 'local' && r.id !== 'claude-code' ? 'turns' : 'requests'} in the last 30 days</p>` : ''}
      </div>
      ${chart(r)}
      <div class="grid cols-2 ai-lists">
        ${list('Models', r.models || [], r, (m) => (r.hasCost && m.cost != null ? m.cost : m.tokens), (m) => `${compact(m.tokens)} tokens · ${full(m.requests)} ${m.requests === 1 ? 'request' : 'requests'}`, 'm', (m) => `aiModel:${r.id}|${m.model}`)}
        ${list(r.id === 'claude-code' ? 'Most expensive chats' : 'Recent sessions', r.sessions || [], r, (s) => (r.hasCost && s.cost != null ? s.cost : s.tokens), (s) => `${s.model ? `${s.model} · ` : ''}${compact(s.tokens)} tokens · ${ago(s.lastTs, Date.now())}`, 's', (s, i) => `aiSession:${r.id}|${i}`)}
      </div>
      ${(r.notes || []).map((n) => `<p class="note">${esc(n)}</p>`).join('')}`;
  }

  function renderPanel(withEntry) {
    const r = reports.find((x) => x.id === selected) || reports[0];
    if (!r) return;
    const el = $('ai-panel');
    el.setAttribute('aria-labelledby', `tab-${r.id}`);
    // Keep a half-typed key when the panel redraws for a refresh.
    const typing = document.activeElement && document.activeElement.name === 'key' ? document.activeElement.value : null;
    el.innerHTML = panel(r);
    if (typing != null) {
      const input = el.querySelector('input[name="key"]');
      if (input) { input.value = typing; input.focus(); }
    }
    if (withEntry && !CALM) {
      el.classList.remove('ai-enter');
      void el.offsetWidth;
      el.classList.add('ai-enter');
    }
    requestAnimationFrame(() => requestAnimationFrame(() => el.querySelectorAll('.ai-fill').forEach((f) => f.classList.add('on'))));
  }

  function render(withEntry) {
    if (!reports.some((r) => r.id === selected)) selected = (reports.find((r) => r.status === 'ok') || reports[0] || {}).id;
    renderOverview();
    renderTabs();
    renderPanel(withEntry);
    animate();
    if (window.Sheet) window.Sheet.refresh();
    const live = $('live');
    live.classList.add('on');
    live.lastElementChild.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }

  async function load(first) {
    try {
      if (HOSTED) reports = await src().load();
      else {
        const r = await fetch('/api/ai', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        reports = (await r.json()).ais;
      }
      render(first);
    } catch (e) {
      const live = $('live');
      live.classList.remove('on');
      live.lastElementChild.textContent = 'Not reachable, retrying';
    }
  }

  function select(id) {
    if (id === selected) return;
    selected = id;
    store.set('aiTab', id);
    document.querySelectorAll('.ai-tab').forEach((b) => {
      const on = b.dataset.id === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    moveInk(true);
    renderPanel(true);
    animate();
  }

  $('ai-tabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('.ai-tab');
    if (b) select(b.dataset.id);
  });
  $('ai-tabs').addEventListener('keydown', (ev) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
    const ids = reports.map((r) => r.id);
    let i = ids.indexOf(selected);
    i = ev.key === 'Home' ? 0 : ev.key === 'End' ? ids.length - 1 : (i + (ev.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
    select(ids[i]);
    document.getElementById(`tab-${ids[i]}`).focus();
    ev.preventDefault();
  });

  $('ai-panel').addEventListener('submit', async (ev) => {
    const form = ev.target.closest('form[data-connect]');
    if (!form) return;
    ev.preventDefault();
    const id = form.dataset.connect;
    const btn = form.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      if (HOSTED) reports = await src().connect(id, form.key.value);
      else {
        const r = await fetch('/api/ai/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, key: form.key.value }) });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        reports = body.ais;
      }
      delete problem[id];
      render(true);
    } catch (e) {
      problem[id] = e.message;
      renderPanel(false);
    }
  });
  $('ai-panel').addEventListener('click', async (ev) => {
    const d = ev.target.closest('[data-disconnect]');
    if (d) {
      if (!window.confirm(`Remove this key from ${HOSTED ? 'your account' : 'this computer'}? The usage report for it disappears until you add it again.`)) return;
      if (HOSTED) {
        reports = await src().disconnect(d.dataset.disconnect);
        render(true);
        return;
      }
      const r = await fetch('/api/ai/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: d.dataset.disconnect }) });
      if (r.ok) {
        reports = (await r.json()).ais;
        render(true);
      }
      return;
    }
    if (ev.target.closest('[data-retry]')) load(false);
  });

  // Hover details for the daily chart.
  const tip = $('tooltip');
  document.addEventListener('mousemove', (ev) => {
    const bar = ev.target.closest && ev.target.closest('.ai-bar');
    const svg = bar && bar.closest('[data-ai-chart]');
    if (!svg) return void (tip.hidden = true);
    const r = reports.find((x) => x.id === svg.dataset.aiChart);
    const d = r && r.daily[Number(bar.dataset.i)];
    if (!d) return;
    tip.innerHTML = `<div class="tt-title">${esc(new Date(`${d.date}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}</div>
      ${d.cost != null ? `<div class="tt-row"><b>Spend</b><span><b>${usd2(d.cost)}</b></span></div>` : ''}
      <div class="tt-row">Tokens<span>${compact(d.tokens)}</span></div>${d.requests ? `<div class="tt-row">${r.kind === 'local' && r.id !== 'claude-code' ? 'Turns' : 'Requests'}<span>${full(d.requests)}</span></div>` : ''}`;
    const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    tip.hidden = false;
    const rect = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(ev.clientX + 14, innerWidth - rect.width - 8)) / z}px`;
    tip.style.top = `${(ev.clientY + rect.height + 20 > innerHeight ? ev.clientY - rect.height - 12 : ev.clientY + 14) / z}px`;
  });
  window.addEventListener('resize', () => moveInk(false));

  function start() {
    load(true);
    setInterval(() => document.hidden || load(false), 60000);
    document.addEventListener('visibilitychange', () => document.hidden || load(false));
  }
  // The website's source can also push fresh reports (when your computer uploads).
  window.AIPage = { update(next) { reports = next; render(false); } };
  if (!HOSTED) start();
  else if (src()) start();
  else window.addEventListener('ai-source', start, { once: true });
})();
