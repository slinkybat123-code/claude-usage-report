/* Live dashboard: renders each snapshot the server pushes over SSE, and
   animates from what was on screen to the new values. */
(function () {
  'use strict';
  const C = window.Charts;
  const { esc, compact, full, usd, usd2, pct, duration, ago, clock, dateTime, shortDate, hourLabel } = C;
  const $ = (id) => document.getElementById(id);
  // The server marks the copy it serves to other devices; that copy is read-only.
  // The offline dashboard (cloud copy) behaves like a remote viewer: read-only.
  const OFFLINE = window.CLOUD_COPY || null;
  // The website (Limit): the page's own script hands in what your computer uploaded.
  const HOSTED = document.documentElement.hasAttribute('data-hosted');
  const REMOTE = document.body.dataset.mode === 'remote' || Boolean(OFFLINE) || HOSTED;
  let feedMeta = null; // website: { name, updatedAt } of the computer the figures came from
  const CALM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Limit app 3: the calm layout. The big chart, plan limits and a few figures; the rest behind Show all details.
  const PHONE = document.documentElement.classList.contains('phone');
  if (PHONE) document.body.classList.add('folded');

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
  };

  let snap = null;
  let receivedAt = 0;
  let booted = false;
  let metric = ['cost', 'tokens', 'nocache'].includes(store.get('metric')) ? store.get('metric') : 'cost';
  let workRange = store.get('workRange') === 'week' ? 'week' : 'all';
  let heroRange = store.get('heroRange') || 'month'; // the big chart's period: day week month quarter year all
  let hero = null; // what the big chart is showing: Insights.range() plus where each point sits
  const openTables = new Set(); // data tables the viewer opened survive re-renders
  document.addEventListener('toggle', (ev) => {
    const id = ev.target.getAttribute && ev.target.getAttribute('data-table');
    if (id) ev.target.open ? openTables.add(id) : openTables.delete(id);
  }, true);
  const ALL_KEYS = ['cacheRead', 'cacheWrite', 'input', 'output'];
  const COST_FIELD = { cacheRead: 'costCacheRead', cacheWrite: 'costCacheWrite', input: 'costInput', output: 'costOutput' };
  const keys = () => (metric === 'nocache' ? ALL_KEYS.slice(1) : ALL_KEYS);
  const valueOf = (row, k) => (metric === 'cost' ? row[COST_FIELD[k]] : row[k]) || 0;
  const show = (v) => (metric === 'cost' ? usd(v) : full(v));
  const axisUsd = (v) => (v >= 1000 ? `$${+(v / 1000).toFixed(1)}K` : `$${+v.toFixed(2)}`);

  // ---------- motion: numbers count, bars glide, rows trade places ----------
  const shown = new Map(); // key -> number currently on screen
  const widths = new Map(); // key -> bar size currently on screen
  const tweens = new Map();
  const targets = new Map(); // key -> last value the data asked for
  const FMT = {
    hero: (n) => { const [d, c] = usd2(n).split('.'); return `${d}<span class="cents">.${c}</span>`; },
    usd, usd2, compact, int: full,
    pct: (n) => `${Math.round(n)}%`,
    dec1: (n) => n.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: n < 100 ? 1 : 0 }),
    dur: (min) => spanOf(min),
  };
  /** Minutes as calendar time: "45 min", "30 hours", "30 days", "7 months", "2.1 years". */
  function spanOf(min) {
    const one = (n, unit) => `${n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 1 : 0 })} ${unit}${n === 1 ? '' : 's'}`;
    if (min < 90) return `${Math.round(min)} min`;
    if (min < 48 * 60) return one(Math.round(min / 60), 'hour');
    if (min < 61 * 1440) return one(Math.round(min / 1440), 'day');
    if (min < 24 * 30.44 * 1440) return one(Math.round(min / (30.44 * 1440)), 'month');
    return one(Math.round((min / (365.25 * 1440)) * 10) / 10, 'year');
  }
  const start = (k, v) => (shown.has(k) ? shown.get(k) : booted ? v : 0);
  /** A number that counts from its last shown value to `v`. */
  const num = (k, v, f = 'usd', cls = '') => `<span class="num ${cls}" data-k="${esc(k)}" data-n="${v}" data-f="${f}">${FMT[f](start(k, v))}</span>`;
  /** A bar that glides from its last size to `p` percent (or flex share). */
  const fill = (k, p, prop = 'width', style = '') => {
    const from = widths.has(k) ? widths.get(k) : 0;
    return `<span class="fill-anim${prop === 'width' ? ' fill' : ''}" data-k="${esc(k)}" data-w="${p}" data-p="${prop}" style="${prop === 'width' ? `width:${from}%` : `flex-grow:${from}`};${style}"></span>`;
  };

  function animate() {
    document.querySelectorAll('[data-n]').forEach((el) => {
      const k = el.dataset.k;
      const f = FMT[el.dataset.f];
      const to = Number(el.dataset.n);
      const from = start(k, to);
      const rose = targets.has(k) && to > targets.get(k); // the figure itself went up, not just a count-up catching up
      targets.set(k, to);
      cancelAnimationFrame(tweens.get(k));
      if (CALM || from === to) {
        shown.set(k, to);
        el.innerHTML = f(to);
        return;
      }
      if (rose) el.classList.add('up');
      const t0 = performance.now();
      const dur = booted ? 700 : 1500; // on open, everything counts up from zero
      const step = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        const v = from + (to - from) * (1 - Math.pow(1 - p, 4));
        shown.set(k, p === 1 ? to : v);
        if (el.isConnected) el.innerHTML = f(p === 1 ? to : v);
        if (p < 1) tweens.set(k, requestAnimationFrame(step));
      };
      tweens.set(k, requestAnimationFrame(step));
    });
    // Two frames so the starting size is painted before the transition begins.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.querySelectorAll('[data-w]').forEach((el) => {
        const w = Number(el.dataset.w);
        widths.set(el.dataset.k, w);
        if (el.dataset.p === 'width') el.style.width = `${w}%`;
        else el.style.flexGrow = w;
      });
    }));
  }

  /** The page zoom that fits the dashboard to a desktop window (1 elsewhere). */
  const zoomOf = () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;

  /** FLIP: rows that changed rank slide to their new place. */
  function reorder(list, html) {
    const before = new Map([...list.children].map((el) => [el.dataset.id, el.getBoundingClientRect().top]));
    list.innerHTML = html;
    if (CALM || !before.size) return;
    [...list.children].forEach((el) => {
      const old = before.get(el.dataset.id);
      if (old == null) return el.classList.add('new');
      const dy = (old - el.getBoundingClientRect().top) / zoomOf();
      if (!dy) return;
      el.style.transform = `translateY(${dy}px)`;
      el.style.transition = 'none';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        el.style.transition = 'transform 0.6s cubic-bezier(0.2, 0.8, 0.2, 1)';
        el.style.transform = '';
      }));
    });
  }

  // ---------- theme ----------
  const THEMES = ['system', 'light', 'dark'];
  // Inside the phone app (html.shell) the app's Settings choose the theme; mode.js has already applied it.
  const SHELL_THEME = document.documentElement.classList.contains('shell') ? document.documentElement.getAttribute('data-theme') || 'system' : null;
  let theme = SHELL_THEME || (THEMES.includes(store.get('theme')) ? store.get('theme') : 'system');
  function applyTheme() {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    $('theme').textContent = `Theme: ${theme}`;
  }
  $('theme').addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    store.set('theme', theme);
    applyTheme();
  });
  applyTheme();

  // ---------- live connection ----------
  function setLive(on, text) {
    $('live').classList.toggle('on', on);
    $('live').lastElementChild.textContent = text;
  }
  /** Offline dashboard: draws the last copy your PC saved, and checks for a newer one every 2 minutes. */
  async function loadCloudCopy() {
    try {
      const r = await fetch(`${OFFLINE}claude-usage-snapshot.json?t=${Math.floor(Date.now() / 120000)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      snap = await r.json();
      receivedAt = Date.now();
      render();
      const at = new Date(snap.generatedAt);
      setLive(false, `Last copy · ${at.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`);
      const note = $('offline-note');
      if (note) note.textContent = `Your computer is off or asleep, so this is the last copy it saved, from ${at.toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. It updates by itself when the computer is back.`;
    } catch (e) {
      setLive(false, 'No copy yet');
    }
    setTimeout(loadCloudCopy, 120000);
  }

  /** Website: live while the computer uploaded in the last few minutes, otherwise the last upload. */
  function feedStatus() {
    if (!feedMeta) return;
    const at = feedMeta.updatedAt || 0;
    const fresh = Date.now() - at < 6 * 60e3;
    setLive(fresh, fresh ? `Live · ${feedMeta.name}` : `${feedMeta.name} · ${ago(at, Date.now())}`);
    const note = $('offline-note');
    if (note) {
      note.hidden = fresh;
      note.textContent = fresh ? '' : `${feedMeta.name} is off or asleep, so these are the figures it last sent, from ${new Date(at).toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. They update by themselves when it's back.`;
    }
  }

  // Other scripts on the page (the friends strip) read the figures on screen from here.
  window.Dashboard = { snapshot: () => snap };

  function connect() {
    if (HOSTED) {
      Object.assign(window.Dashboard, {
        feed(s, meta) {
          snap = s;
          feedMeta = meta;
          receivedAt = Date.now();
          render();
          feedStatus();
        },
      });
      window.dispatchEvent(new Event('dashboard-ready'));
      return;
    }
    if (OFFLINE) return loadCloudCopy();
    const es = new EventSource('/api/events');
    es.addEventListener('snapshot', (ev) => {
      snap = JSON.parse(ev.data);
      receivedAt = Date.now();
      render();
    });
    es.onopen = () => setLive(true, 'Live');
    es.onerror = () => {
      // Network drops: EventSource retries on its own. An HTTP error (tunnel up but
      // PC asleep, or signed out) closes it for good, so find out which and retry.
      if (es.readyState !== EventSource.CLOSED) return setLive(false, 'Reconnecting…');
      setLive(false, REMOTE ? 'PC not reachable, retrying' : 'Server not reachable, retrying');
      fetch('/api/whoami', { cache: 'no-store' })
        .then((r) => (r.status === 401 ? location.replace('/login') : setTimeout(connect, 5000)))
        .catch(() => setTimeout(connect, 5000));
    };
  }

  // ---------- sections ----------
  const win = (key) => snap.windows.find((w) => w.key === key);
  const modelName = (m) => (window.Insights ? window.Insights.prettyModel(m) : (m || '').replace(/^claude-/, ''));
  const replies = (n) => `${full(n)} ${n === 1 ? 'reply' : 'replies'}`;
  /** Makes an element open its breakdown when clicked (see the detail sheet below). */
  const opens = (ref) => (window.Sheet ? window.Sheet.attrs(ref) : '');

  function renderSpend() {
    const S = snap.spend;
    const all = win('all').totals;
    const mix = ALL_KEYS.map((k) => ({ k, s: C.SERIES.find((x) => x.key === k), v: S.byType[k] }));
    $('spend').innerHTML = `${heroHtml()}<div class="spend-head"${opens('window:all')}>
        <div class="eyebrow">All chats combined · API value <span class="chev" aria-hidden="true">›</span></div>
        <div class="spend-total">${num('spend.all', S.allTime, 'hero')}</div>
        <div class="stat-sub"><b>${num('spend.req', all.requests, 'int')}</b> replies across <b>${snap.sessions.length}</b> chats · <b>${num('spend.per', S.perRequest, 'usd2')}</b> per reply</div>
        <p class="fine">Priced at Anthropic's API list rates, the way /cost does it. On a subscription plan you pay your plan price, not this.</p>
      </div>
      <dl class="kpis">
        <div${opens('window:today')}><dt>Today</dt><dd>${num('spend.today', S.today)}<small>${replies(win('today').totals.requests)}</small></dd></div>
        <div${opens('window:week')}><dt>${esc(win('week').label)}</dt><dd>${num('spend.week', S.week)}<small>${replies(win('week').totals.requests)}</small></dd></div>
        <div${opens('lastHour')}><dt>Last hour</dt><dd>${num('spend.hour', S.lastHour)}<small>${snap.activeSessions} chat${snap.activeSessions === 1 ? '' : 's'} active now</small></dd></div>
        <div${opens('projection')}><dt>Next 30 days at this pace</dt><dd>${num('spend.proj', S.projected30Days)}<small>${usd(S.dailyAverage)} a day, 7-day average</small></dd></div>
      </dl>
      ${highlightsHtml()}
      <div class="spend-mix">
        <div class="mix" role="img" aria-label="Spend by token type">${mix.filter((m) => m.v > 0).map((m) => fill(`mix.${m.k}`, m.v, 'flexGrow', `background:${m.s.color}`)).join('')}</div>
        <div class="mix-legend">${mix.map((m) => `<span><i style="background:${m.s.color}"></i>${esc(m.s.label)} <b>${usd(m.v)}</b> · ${pct(m.v, S.allTime)}%</span>`).join('')}</div>
      </div>`;
  }

  // ---------- the big chart: what you spent over 1D 1W 1M 3M 1Y or All, against the period before ----------
  const HW = 1000;
  const HH = 300;
  /** A smooth line through the points that never overshoots (monotone cubic), so a flat stretch stays flat. */
  function smoothPath(pts) {
    const n = pts.length;
    if (!n) return '';
    if (n === 1) return `M${pts[0][0] - 1},${pts[0][1]}L${pts[0][0] + 1},${pts[0][1]}`;
    const d = [];
    for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0] || 1));
    const m = [d[0]];
    for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
    m.push(d[n - 2]);
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const q = a * a + b * b;
      if (q > 9) { const t = 3 / Math.sqrt(q); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    const f = (v) => v.toFixed(1);
    let path = `M${f(pts[0][0])},${f(pts[0][1])}`;
    for (let i = 0; i < n - 1; i++) {
      const dx = (pts[i + 1][0] - pts[i][0]) / 3;
      path += `C${f(pts[i][0] + dx)},${f(pts[i][1] + m[i] * dx)} ${f(pts[i + 1][0] - dx)},${f(pts[i + 1][1] - m[i + 1] * dx)} ${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
    }
    return path;
  }
  const heroWhen = (t, unit) => (unit === 'hour'
    ? new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric' })
    : new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: heroRange === 'year' || heroRange === 'all' ? 'numeric' : undefined }));
  function heroDelta(r) {
    if (r.change == null || !r.prev) {
      const avg = r.points.length ? r.total / r.points.length : 0;
      const since = r.key === 'all' && r.points.length ? `since ${new Date(r.points[0].t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}` : '';
      return `<span class="hd-chip">${usd(avg)} a ${r.unit}</span><span class="hd-quiet">on average${since ? ` · ${esc(since)}` : ''}</span>`;
    }
    const diff = r.total - r.prev;
    const cls = diff > 0.005 ? 'more' : diff < -0.005 ? 'less' : '';
    const arrow = diff > 0.005 ? '▲' : diff < -0.005 ? '▼' : '=';
    return `<span class="hd-chip ${cls}">${arrow} ${usd(Math.abs(diff))} (${Math.round(Math.abs(r.change) * 100)}%)</span><span class="hd-quiet">vs ${esc(r.prevLabel)}</span>`;
  }
  function heroHtml() {
    const I = window.Insights;
    if (!I || !I.range) return '';
    const list = I.ranges(snap);
    if (!list.some((x) => x.key === heroRange)) heroRange = 'month';
    const r = I.range(snap, heroRange);
    if (!r || !r.points.length) return '';
    const n = r.points.length;
    const before = r.prev != null && r.prevPoints && r.prevPoints.length ? r.prevPoints : null;
    const top = Math.max(1e-9, r.total, before ? r.prev : 0) * 1.08;
    const x = (i, count) => (count === 1 ? HW / 2 : 2 + (i / (count - 1)) * (HW - 26)); // room for the end dot
    const y = (v) => HH - 6 - (v / top) * (HH - 22);
    const pts = r.points.map((p, i) => [x(i, n), y(p.total)]);
    hero = { r, pts };
    const line = smoothPath(pts);
    const area = `${line}L${HW},${HH}L0,${HH}Z`;
    const ghost = before ? smoothPath(before.map((p, i) => [x(i, before.length), y(p.total)])) : '';
    const end = pts[n - 1];
    const pctX = (v) => (v / HW) * 100;
    const pctY = (v) => (v / HH) * 100;
    return `<div class="trend" data-hero>
        <div class="hero-head">
          <div class="eyebrow" id="hero-when">Spent · ${esc(r.label)}</div>
          <div class="hero-total" id="hero-total">${num('hero.total', r.total, 'hero')}</div>
          <div class="hero-delta" id="hero-delta">${heroDelta(r)}</div>
        </div>
        <div class="hero-plot" data-hero-plot role="img" aria-label="${esc(`Spend, ${r.label}: ${usd(r.total)}`)}">
          <svg class="hero-svg" viewBox="0 0 ${HW} ${HH}" preserveAspectRatio="none" aria-hidden="true">
            <defs><linearGradient id="hero-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--series-1);stop-opacity:.22"/><stop offset="1" style="stop-color:var(--series-1);stop-opacity:0"/></linearGradient></defs>
            ${ghost ? `<path class="hero-ghost" d="${ghost}"/>` : ''}
            <path class="hero-area" d="${area}" fill="url(#hero-fill)"/>
            <path class="hero-line" d="${line}"/>
          </svg>
          <span class="hero-dot" style="left:${pctX(end[0])}%;top:${pctY(end[1])}%"></span>
          <span class="hero-cursor" hidden></span><span class="hero-knob" hidden></span>
        </div>
        <div class="hero-axis"><span>${esc(heroWhen(r.points[0].t, r.unit))}</span>${before ? '<span class="hero-key"><i></i>the period before</span>' : ''}<span>Now</span></div>
        <div class="hero-ranges" role="tablist" aria-label="Period">${list.map((x) => `<button type="button" role="tab" data-range="${x.key}" aria-selected="${x.key === heroRange}" title="${esc(x.label)}">${esc(x.short)}</button>`).join('')}</div>
        <dl class="hero-foot">
          <div${opens('window:today')}><dt>Today</dt><dd>${num('hf.today', snap.spend.today)}</dd></div>
          <div${opens('window:all')}><dt>All time</dt><dd>${num('hf.all', snap.spend.allTime)}</dd></div>
          <div${opens('projection')}><dt>Next 30 days</dt><dd>${num('hf.proj', snap.spend.projected30Days)}</dd></div>
        </dl>
      </div>`;
  }
  /** Re-draws just the big chart for another period; the total counts from the old figure to the new one. */
  function setHeroRange(key) {
    heroRange = key;
    store.set('heroRange', key);
    const old = document.querySelector('[data-hero]');
    if (!old) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = heroHtml();
    const next = wrap.firstElementChild;
    if (!next) return;
    if (!CALM) next.classList.add('re');
    old.replaceWith(next);
    animate();
    setTimeout(() => next.classList.remove('re'), 1200);
  }
  /** A finger or pointer on the chart: the big figure shows that moment instead, like a stock chart. */
  function heroScrub(ev) {
    const plot = ev.target.closest && ev.target.closest('[data-hero-plot]');
    if (!plot || !hero) return null;
    const box = plot.getBoundingClientRect();
    const n = hero.r.points.length;
    const i = Math.max(0, Math.min(n - 1, Math.round(((ev.clientX - box.left) / box.width) * (n - 1))));
    const p = hero.r.points[i];
    const [px, py] = hero.pts[i];
    const cur = plot.querySelector('.hero-cursor');
    const knob = plot.querySelector('.hero-knob');
    cur.hidden = knob.hidden = false;
    cur.style.left = knob.style.left = `${(px / HW) * 100}%`;
    knob.style.top = `${(py / HH) * 100}%`;
    plot.closest('[data-hero]').classList.add('scrubbing');
    cancelAnimationFrame(tweens.get('hero.total'));
    $('hero-total').innerHTML = FMT.hero(p.total);
    $('hero-when').textContent = heroWhen(p.t, hero.r.unit);
    $('hero-delta').innerHTML = `<span class="hd-quiet">${usd(p.value)} spent that ${hero.r.unit}</span>`;
    return p;
  }
  function heroRest() {
    const h = document.querySelector('[data-hero]');
    if (!h || !hero || !h.classList.contains('scrubbing')) return;
    h.classList.remove('scrubbing');
    h.querySelectorAll('.hero-cursor, .hero-knob').forEach((el) => (el.hidden = true));
    shown.set('hero.total', hero.r.total);
    $('hero-total').innerHTML = FMT.hero(hero.r.total);
    $('hero-when').textContent = `Spent · ${hero.r.label}`;
    $('hero-delta').innerHTML = heroDelta(hero.r);
  }
  let scrubDown = null;
  document.addEventListener('pointerdown', (ev) => {
    if (!snap || !ev.target.closest || !ev.target.closest('[data-hero-plot]')) return;
    scrubDown = { x: ev.clientX, y: ev.clientY, p: heroScrub(ev) };
  });
  document.addEventListener('pointermove', (ev) => {
    if (!snap || !ev.target.closest) return;
    if (ev.pointerType === 'mouse' || scrubDown) {
      if (!heroScrub(ev) && ev.pointerType === 'mouse') heroRest();
    }
  }, { passive: true });
  const scrubEnd = (ev) => {
    if (!scrubDown) return;
    const tap = ev.type === 'pointerup' && Math.abs(ev.clientX - scrubDown.x) < 8 && Math.abs(ev.clientY - scrubDown.y) < 8;
    const p = scrubDown.p;
    scrubDown = null;
    if (ev.pointerType !== 'mouse') setTimeout(heroRest, tap ? 1200 : 300);
    if (tap && p && hero && hero.r.unit === 'day' && window.Sheet && snap.series.daily.some((d) => d.t === p.t && d.requests > 0)) window.Sheet.open(`day:${p.t}`);
  };
  document.addEventListener('pointerup', scrubEnd);
  document.addEventListener('pointercancel', scrubEnd);
  document.addEventListener('mouseout', (ev) => {
    const from = ev.target.closest && ev.target.closest('[data-hero-plot]');
    const to = ev.relatedTarget && ev.relatedTarget.closest && ev.relatedTarget.closest('[data-hero-plot]');
    if (from && !to) heroRest();
  });
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-range]');
    if (b && snap) setHeroRange(b.getAttribute('data-range'));
  });

  /** A row of quick figures: this week against the last, streak, busiest weekday and hour, yesterday. */
  function highlightsHtml() {
    if (!window.Insights || !window.Insights.highlights) return '';
    const h = window.Insights.highlights(snap);
    const ch = h.week.change;
    const trend = ch == null ? '' : `<span class="delta ${ch > 0 ? 'more' : ch < 0 ? 'less' : ''}" title="Against the 7 days before (${usd(h.week.prev)})">${ch > 0 ? '▲' : ch < 0 ? '▼' : '='} ${num('hl.change', Math.abs(ch), 'pct')}</span>`;
    const hour = h.peakHour == null ? null : new Date(2000, 0, 1, h.peakHour).toLocaleTimeString([], { hour: 'numeric' });
    const chips = [
      `<div class="hl"><span class="hl-k">Last 7 days</span><span class="hl-v">${num('hl.week', h.week.cost)} ${trend}</span></div>`,
      `<div class="hl"><span class="hl-k">Yesterday</span><span class="hl-v">${num('hl.yesterday', h.yesterday)}</span></div>`,
      `<div class="hl"><span class="hl-k">Streak</span><span class="hl-v">${num('hl.streak', h.streak, 'int')} <small>day${h.streak === 1 ? '' : 's'} in a row</small></span></div>`,
      h.busiestWeekday ? `<div class="hl"><span class="hl-k">Busiest day</span><span class="hl-v">${esc(h.busiestWeekday)}s</span></div>` : '',
      hour ? `<div class="hl"><span class="hl-k">Busiest hour</span><span class="hl-v">Around ${esc(hour)}</span></div>` : '',
    ];
    return `<div class="highlights">${chips.join('')}</div>`;
  }

  function renderLimits() {
    const L = snap.limits;
    const R = snap.reporter;
    const five = L.windows.find((w) => w.kind === 'five_hour');
    const others = L.windows.filter((w) => w.kind !== 'five_hour');
    const cards = [];

    if (five) {
      cards.push(`<div class="card"${opens('limit:five_hour')}><h2>${esc(five.label)}</h2><p class="desc">Plan usage, as /usage shows it</p>
        <div class="hero">${num('lim.five', five.percentUsed, 'int')}<small>%</small></div>${C.meter(five.percentUsed)}
        <div class="limit-row"><span>Resets in <b data-until="${esc(five.resetsAt)}">${resetIn(five.resetsAt)}</b></span><span>${five.resetsAt ? `at ${clock(Date.parse(five.resetsAt))}` : ''}</span></div>
        ${projectionLine(five)}</div>`);
    } else {
      const t = win('fiveHour').totals;
      const gone = (L.expired || []).find((w) => w.kind === 'five_hour');
      cards.push(`<div class="card"${opens('window:fiveHour')}><h2>Last 5 hours</h2><p class="desc">All chats</p>
        <div class="hero">${num('five.cost', t.cost)}</div>
        <div class="stat-sub"><b>${num('five.tok', t.total, 'compact')}</b> tokens · <b>${full(t.requests)}</b> replies</div>
        ${gone ? `<div class="note">The 5-hour limit reset at ${clock(Date.parse(gone.resetsAt))}. Its new % shows after your next reply.</div>` : ''}</div>`);
    }

    for (const w of others) {
      cards.push(`<div class="card"${opens(`limit:${w.kind}`)}><h2>${esc(w.label)}</h2><p class="desc">Plan usage</p>
        <div class="limit-pct">${num(`lim.${w.kind}`, w.percentUsed, 'pct')}</div>${C.meter(w.percentUsed)}
        <div class="limit-row"><span>Resets in <b data-until="${esc(w.resetsAt)}">${resetIn(w.resetsAt)}</b></span><span>${w.resetsAt ? dateTime(Date.parse(w.resetsAt)) : ''}</span></div>
        ${projectionLine(w)}</div>`);
    }

    // Status card: where the limit figures come from.
    let body;
    if (!R.installed) {
      body = `<div class="callout"><p>${L.connected ? 'These readings stop updating without the reporter. ' : ''}Plan limits are not in Claude Code's log files. The <b>plan-usage-reporter</b> mod writes them after each reply.</p>
        ${HOSTED ? '<p>Run the Limit installer again on your computer and keep <b>Show my plan limits</b> ticked.</p>' : REMOTE ? '<p>Install it from the dashboard on your PC.</p>' : '<button class="primary no-print" type="button" data-action="install">Install reporter</button>'}</div>`;
    } else if (!L.connected) {
      body = `<div class="callout"><p>Reporter installed. Readings appear after the next reply in a session started since then.</p><p>Sessions that were already running need a restart to load it.</p></div>`;
    } else {
      body = `<div class="stat-label">Last reading</div><div class="stat-value mid" data-ago="${L.readAt}">${ago(L.readAt, Date.now())}</div>
        <div class="stat-sub"><b>${L.sessionsReporting}</b> session${L.sessionsReporting === 1 ? '' : 's'} reporting${L.stale ? ' · <b>stale</b>' : ''}</div>
        ${R.updateAvailable && !REMOTE ? '<button class="no-print" type="button" data-action="install" style="margin-top:10px">Update reporter</button>' : ''}`;
    }
    cards.push(`<div class="card"><h2>Limit data</h2><p class="desc">${R.installed ? `plan-usage-reporter ${esc(R.installedVersion)}` : 'Reporter not installed'}</p>${body}</div>`);
    $('limits').innerHTML = cards.join('');
  }

  function resetIn(iso) {
    return iso ? duration(Date.parse(iso) - Date.now()) : '—';
  }
  function projectionLine(w) {
    const p = w.projection;
    if (!p) return '<div class="note">Pace: not enough readings yet</div>';
    const warn = p.runsOutBeforeReset;
    return `<div class="note">Pace: +${p.percentPerHour}%/h · ${warn ? `<b>runs out ~${clock(p.etaAt)}</b>, before reset` : 'lasts until reset'}</div>`;
  }

  const BOARD_ROWS = 6; // keeps this card about as tall as the one beside it
  function renderBoard() {
    const rows = snap.leaderboard.filter((r) => r.cost > 0).slice(0, BOARD_ROWS);
    const chats = new Map(snap.sessions.map((x) => [x.id, x]));
    const top = rows.length ? rows[0].cost : 1;
    $('board-desc').textContent = `Top ${rows.length} of ${snap.sessions.length}, all time, at API prices · click one for its breakdown`;
    reorder($('board'), rows.length
      ? rows.map((r) => `<li data-id="${esc(r.id)}"${opens(`chat:${r.id}`)}>
          <span class="rank">${r.rank}</span>
          <div class="b-main"><div class="b-title" title="${esc(r.title)}"><span class="dot${r.active ? ' on' : ''}" title="${r.active ? 'Active now' : 'Idle'}"></span>${esc(r.title)}</div>
            <div class="b-meta">${esc(r.project)} · ${esc(modelName(r.model))} · ${replies(r.requests)}</div>${lastLine(r.id, r.last)}${chatFold(chats.get(r.id), 'b')}</div>
          <div class="b-cost">${num(`b.${r.id}`, r.cost)}<small>${r.costToday > 0.005 ? `+${usd(r.costToday)} today` : `${Math.round(r.share * 100)}% of all`}</small></div>
          <div class="track">${fill(`bw.${r.id}`, Math.max(1, (r.cost / top) * 100))}</div></li>`).join('')
      : '<li class="empty">No usage yet.</li>');
  }

  // ---------- each chat's last message ----------
  // A new message fades in word by word while the one before it drifts up and
  // fades away; older messages fade back as they age. Renders that land while
  // a change is still animating pick up where it is (negative delay), so live
  // updates never restart it.
  const SEEN = new Map(); // key -> { ts, old, changedAt }
  const SWAP_MS = 2600;
  const HOUR_MS = 3600e3;
  const whoLabel = (w) => (w === 'you' ? 'You' : w === 'notice' ? 'Notice' : 'Claude');
  const plain = (m) => `<span class="lm-who ${m.who}">${whoLabel(m.who)}</span><span class="lm-text">${esc(m.text)}</span>`;
  function lastLine(key, m) {
    if (!m || !m.text) return '';
    const now = Date.now();
    let seen = SEEN.get(key);
    if (!seen || seen.ts !== m.ts) {
      seen = { ts: m.ts, old: seen ? seen.html : null, changedAt: seen && booted && !CALM ? now : 0, html: plain(m) };
      SEEN.set(key, seen);
    }
    const age = Math.max(0, now - (m.ts || now));
    const fade = Math.max(0.5, 1 - age / (8 * HOUR_MS)).toFixed(2); // a day-old line sits quieter than a fresh one
    const since = now - seen.changedAt;
    const label = `${whoLabel(m.who)}, ${ago(m.ts, now)}: ${m.text}`;
    if (!seen.changedAt || since > SWAP_MS) {
      return `<div class="lastmsg" style="--age:${fade}" title="${esc(label)}">${seen.html}</div>`;
    }
    const words = esc(m.text).split(' ');
    const head = words.slice(0, 28).map((w, i) => `<span class="w" style="--w:${i}">${w}</span>`).join(' ');
    const tail = words.length > 28 ? ` <span class="w" style="--w:28">${words.slice(28).join(' ')}</span>` : '';
    return `<div class="lastmsg swap" style="--age:${fade};--t:-${since}ms" title="${esc(label)}">${seen.old ? `<div class="lm-old" aria-hidden="true">${seen.old}</div>` : ''}<div class="lm-new"><span class="lm-who ${m.who}">${whoLabel(m.who)}</span><span class="lm-text">${head}${tail}</span></div></div>`;
  }

  /** Label, cost and bar rows shared by the work, model and project lists. */
  function costRows(prefix, items, whole) {
    const top = Math.max(1e-9, ...items.map((d) => d.cost));
    return items.length
      ? items.map((d) => `<li data-id="${esc(d.id)}"${d.ref ? opens(d.ref) : ''}>
          <div class="b-main"><div class="b-title" title="${esc(d.title || d.label)}">${esc(d.label)}</div><div class="b-meta">${esc(d.meta)}</div></div>
          <div class="b-cost">${num(`${prefix}.${d.id}`, d.cost)}<small>${pct(d.cost, whole)}% of spend</small></div>
          <div class="track">${fill(`${prefix}w.${d.id}`, Math.max(1, (d.cost / top) * 100))}</div></li>`).join('')
      : '<li class="empty">Nothing in this period yet.</li>';
  }

  function renderWork() {
    $('work-range').innerHTML = [['all', 'All time'], ['week', 'This week']]
      .map(([k, label]) => `<button type="button" data-action="work-${k}" aria-pressed="${workRange === k}">${label}</button>`).join('');
    const rows = snap.work[workRange].filter((w) => w.cost > 0);
    const whole = rows.reduce((s, w) => s + w.cost, 0);
    reorder($('work'), costRows(`w.${workRange}`, rows.map((w) => ({
      id: w.key, ref: `work:${w.key}`, label: w.label, cost: w.cost,
      meta: `${replies(w.requests)} · ${usd2(w.cost / Math.max(1, w.requests))} each · ${compact(w.total)} tokens`,
    })), whole));
  }

  // ---------- just for fun ----------
  // Rough, stated conversions. Harry Potter: words per book in the UK first editions, 1,084,170 in all.
  const HP_WORDS = [76944, 85141, 107253, 190637, 257045, 168923, 198227];
  const WORDS_PER_TOKEN = 0.75;
  const HP_SERIES_TOKENS = HP_WORDS.reduce((a, b) => a + b, 0) / WORDS_PER_TOKEN;
  const HP_BOOK_TOKENS = HP_SERIES_TOKENS / HP_WORDS.length;
  const TALLER_THAN = [[1.7, 'a person'], [3.05, 'a basketball hoop'], [4.4, 'a double-decker bus'], [5.5, 'a giraffe'], [10, 'a three-storey house'], [46, 'the Statue of Liberty'], [93, 'the Statue of Liberty on its pedestal'], [330, 'the Eiffel Tower'], [828, 'the Burj Khalifa']];
  function renderFun() {
    const all = (snap.windows.find((w) => w.key === 'all') || {}).totals;
    if (!all || !all.total) {
      $('fun').innerHTML = '<p class="desc">Nothing to convert yet.</p>';
      return;
    }
    const series = all.total / HP_SERIES_TOKENS;
    const books = all.total / HP_BOOK_TOKENS;
    const wrote = all.output * WORDS_PER_TOKEN; // words Claude wrote for you
    const pages = wrote / 275;
    const stack = (pages * 0.1) / 1000; // metres, one sheet a page
    const landmark = TALLER_THAN.filter(([h]) => stack >= h).pop();
    const readMin = wrote / 238;
    const typeMin = wrote / 40;
    const workYears = typeMin / 60 / 8 / 250;
    const lattes = all.cost / 5;
    const intoSeries = series - Math.floor(series);
    const lit = Math.round(intoSeries * HP_WORDS.length);
    const widest = Math.max(...HP_WORDS);
    const shelf = HP_WORDS.map((w, i) => `<i class="${i < lit ? 'lit' : ''}" style="width:${Math.round(8 + (w / widest) * 16)}px;height:${44 + (i % 3) * 6}px"></i>`).join('');
    $('fun').innerHTML = `
      <div class="card fun-hp">
        <div class="fun-shelf" aria-hidden="true">${shelf}</div>
        <div class="fun-big">${num('fun.books', books, 'int')}</div>
        <div class="fun-what">Harry Potter books</div>
        <p class="fun-line">Everything Claude read and wrote for you, ${compact(all.total)} tokens, fills the whole seven-book series <b>${num('fun.series', series, 'dec1')} times</b>. Claude itself wrote <b>${num('fun.wroteBooks', all.output / HP_BOOK_TOKENS, 'int')} books</b>' worth.</p>
      </div>
      <div class="card"><div class="fun-big">${num('fun.pages', pages, 'int')}</div><div class="fun-what">printed pages</div>
        <p class="fun-line">Everything Claude wrote for you, on paper: a stack <b>${stack.toFixed(1)} m</b> tall${landmark ? `, taller than ${landmark[1]}` : ''}.</p></div>
      <div class="card"><div class="fun-big">${num('fun.read', readMin, 'dur')}</div><div class="fun-what">of nonstop reading</div>
        <p class="fun-line">To read all of it at 238 words a minute. At 8 hours a day, <b>${spanOf(readMin * 3)}</b>.</p></div>
      <div class="card"><div class="fun-big">${num('fun.type', typeMin, 'dur')}</div><div class="fun-what">of nonstop typing</div>
        <p class="fun-line">For a person typing it at 40 words a minute: <b>${workYears.toFixed(1)} years</b> of 8-hour workdays.</p></div>
      <div class="card"><div class="fun-big">${num('fun.lattes', lattes, 'int')}</div><div class="fun-what">lattes</div>
        <p class="fun-line">What your ${usd(all.cost)} of API value would buy at $5 a cup. At your current pace, <b>${Math.round(snap.spend.dailyAverage / 5)} a day</b>.</p></div>
      <p class="fun-fine">Rough on purpose: about 0.75 words a token, 275 words a page, 0.1 mm a sheet, reading at 238 words a minute and typing at 40. "Read and wrote" counts every token, including the conversation Claude re-reads each reply. The seven Harry Potter books have 1,084,170 words, about ${compact(HP_SERIES_TOKENS)} tokens.</p>`;
  }

  function renderTiles() {
    $('tiles').innerHTML = ['fiveHour', 'today', 'week', 'all']
      .map((k) => {
        const w = win(k);
        const t = w.totals;
        const prompt = t.input + t.cacheWrite + t.cacheRead;
        return `<div class="card"${opens(`window:${k}`)}><div class="stat-label">${esc(w.label)}</div>
          <div class="stat-value">${num(`tile.${k}`, t.total, 'compact')} <span class="stat-label">tokens</span></div>
          <div class="stat-sub"><b>${usd(t.cost)}</b> · <b>${compact(t.output)}</b> output · <b>${full(t.requests)}</b> replies</div>
          <div class="stat-sub"><b>${pct(t.cacheRead, prompt)}%</b> of prompt tokens from cache</div></div>`;
      })
      .join('');
  }

  function chartCard(id, title, what, rows, opts) {
    const ks = keys();
    const desc = `${metric === 'cost' ? 'Cost' : 'Tokens'} ${what}, all chats`;
    const svg = C.stackedColumns(rows, { keys: ks, title, get: valueOf, tick: metric === 'cost' ? axisUsd : compact, ...opts })
      // Each day of the 30-day chart opens that day's breakdown.
      .replace(/<g class="col" data-i="(\d+)"/g, (_, i) => `<g class="col" data-i="${i}" style="--c:${i}"${id === 'daily-card' && rows[i] && rows[i].requests > 0 ? opens(`day:${rows[i].t}`) : ''}`);
    const seg = [['cost', 'Cost'], ['tokens', 'Tokens'], ['nocache', 'Tokens, no cache reads']]
      .map(([k, label]) => `<button type="button" data-action="metric-${k}" aria-pressed="${metric === k}">${label}</button>`).join('');
    const head = `<div class="chart-head"><div><h2>${esc(title)}</h2><p class="desc" style="margin:0">${esc(desc)}</p></div><span class="spacer"></span>${C.legend(ks)}
      <div class="seg no-print" role="group" aria-label="Measure">${seg}</div></div>`;
    const table = `<details class="data" data-table="${id}"${openTables.has(id) ? ' open' : ''}><summary>Data table</summary><div class="table-wrap"><table><thead><tr><th>${opts.unit}</th>${ks
      .map((k) => `<th class="num">${esc(C.SERIES.find((s) => s.key === k).label)}</th>`)
      .join('')}<th class="num">Total</th></tr></thead><tbody>${rows
      .filter((r) => r.requests > 0)
      .reverse()
      .map((r) => `<tr><td>${esc(opts.rowLabel(r.t))}</td>${ks.map((k) => `<td class="num">${show(valueOf(r, k))}</td>`).join('')}<td class="num">${show(ks.reduce((s, k) => s + valueOf(r, k), 0))}</td></tr>`)
      .join('')}</tbody></table></div></details>`;
    $(id).innerHTML = head + `<div data-chart="${id}">${svg}</div>` + table;
  }

  function renderCharts(replay) {
    chartCard('hourly-card', 'Last 48 hours', 'per hour', snap.series.hourly, {
      height: 240, labelEvery: 6, labelOffset: 0, xLabel: hourLabel, unit: 'Hour', rowLabel: dateTime,
    });
    chartCard('daily-card', 'Last 30 days', 'per day', snap.series.daily, {
      height: 200, labelEvery: 5, labelOffset: 4, xLabel: shortDate, unit: 'Day', rowLabel: shortDate,
    });
    if (replay && !CALM) {
      for (const id of ['hourly-card', 'daily-card']) {
        $(id).classList.remove('regrow');
        void $(id).offsetWidth; // restart the grow-in for the new measure
        $(id).classList.add('regrow');
      }
    }
  }

  function renderDiagnostics() {
    const byTitle = new Map(snap.sessions.map((s) => [s.title, s.id]));
    $('diagnostics').innerHTML = snap.diagnostics
      .map((d) => {
        const s = C.SEVERITY[d.severity];
        const named = (String(d.title).match(/"([^"]+)"/) || [])[1];
        const id = named && byTitle.get(named);
        return `<li class="${d.severity}"${id ? opens(`chat:${id}`) : ''}><span aria-hidden="true">${s.icon}</span><div><div class="d-title">${esc(d.title)}<span class="d-tag">${s.label}</span></div><div class="d-detail">${esc(d.detail)}</div></div></li>`;
      })
      .join('');
  }

  function renderSessions() {
    const now = Date.now();
    const rows = showAllChats ? snap.sessions : snap.sessions.slice(0, CHATS_SHOWN);
    $('sessions-desc').textContent = `${snap.sessions.length} chats · ${snap.activeSessions} active in the last 5 minutes · click one for its breakdown`;
    $('sessions').innerHTML = `<table><thead><tr><th>Chat</th><th>Model</th><th>Last activity</th><th class="num">Cost</th><th class="num">Today</th><th class="num">Tokens</th><th class="num">Output</th><th class="num">Context</th></tr></thead><tbody>${rows
      .map((s) => {
        const ctx = s.contextTokens ? `${compact(s.contextTokens)}${s.contextPercent != null ? ` · ${s.contextPercent}%` : ''}` : '—';
        return `<tr${opens(`chat:${s.id}`)}><td><span class="dot${s.active ? ' on' : ''}" title="${s.active ? 'Active' : 'Idle'}"></span><span class="s-title">${esc(s.title)}</span>
            <div class="s-meta">${esc(s.project)}${s.gitBranch && s.gitBranch !== 'HEAD' ? ` · ${esc(s.gitBranch)}` : ''}${s.subagent.total ? ` · subagents ${usd(s.subagent.cost)}` : ''}</div>${lastLine(`s.${s.id}`, s.summary && s.summary.last)}${chatFold(s, 's')}</td>
          <td>${esc(modelName(s.model))}</td>
          <td data-ago="${s.lastTs}">${ago(s.lastTs, now)}</td>
          <td class="num"><b>${s.active ? num(`s.${s.id}`, s.tokens.cost) : usd(s.tokens.cost)}</b><span class="sub-cost">${usd2(s.tokens.cost / Math.max(1, s.tokens.requests))} a reply</span></td>
          <td class="num">${s.today.cost ? usd(s.today.cost) : '—'}</td>
          <td class="num">${compact(s.tokens.total)}</td>
          <td class="num">${compact(s.tokens.output)}</td>
          <td class="num">${ctx}</td></tr>`;
      })
      .join('')}</tbody></table>${snap.sessions.length > CHATS_SHOWN ? `<div class="more-row"><button type="button" class="more-toggle" data-action="chats-toggle" aria-expanded="${showAllChats}">${showAllChats ? 'Show fewer chats' : `Show ${snap.sessions.length - CHATS_SHOWN} more chats`}<span class="caret" aria-hidden="true"></span></button></div>` : ''}`;
  }
  const CHATS_SHOWN = 10;
  let showAllChats = false;

  /** What a chat is for and where it stands, from its own messages: one line that folds open. */
  function chatFold(s, where) {
    const m = s && s.summary;
    if (!m || (!m.goal && !m.latest && !m.now)) return '';
    const so = window.Insights ? window.Insights.soFarText(s) : '';
    const id = `sum-${where}-${s.id}`;
    return `<details class="sum" data-table="${esc(id)}"${openTables.has(id) ? ' open' : ''}><summary><span class="sum-line">${esc(m.goal || m.latest || m.now)}</span></summary><dl>
      ${m.goal ? `<dt>Started with</dt><dd>${esc(m.goal)}</dd>` : ''}
      ${m.latest ? `<dt>Latest request</dt><dd>${esc(m.latest)}</dd>` : ''}
      ${m.now ? `<dt>${s.active ? 'Happening now' : 'Where it stopped'}</dt><dd>${esc(m.now)}</dd>` : ''}
      ${so ? `<dt>So far</dt><dd>${esc(so)}</dd>` : ''}</dl></details>`;
  }

  // ---------- your prompts ----------
  function renderPrompts() {
    const el = $('prompts-card');
    if (!el || !window.Insights || !window.PromptCoach) return;
    const sum = window.PromptCoach.summarizePrompts(window.Insights.promptItems(snap));
    el.hidden = !sum.count;
    if (!sum.count) return;
    const n = Object.fromEntries(sum.grades.map((g) => [g.grade, g.count]));
    const d = window.Insights.detail(snap, { type: 'prompts' });
    const top = d && d.tips[0];
    const seg = [['Clear', 'good'], ['Could be clearer', 'mid'], ['Vague', 'bad']];
    el.innerHTML = `<div class="pr-score"><div class="eyebrow">Your prompts</div>
        <div class="pr-big">${num('pr.avg', sum.avgScore, 'int')}<small>/100</small></div>
        <div class="stat-sub">average clarity over <b>${full(sum.count)}</b> requests</div></div>
      <div class="pr-grades"><div class="pr-bar" role="img" aria-label="${seg.map(([g]) => `${g}: ${n[g] || 0}`).join(', ')}">${seg.filter(([g]) => n[g]).map(([g, c]) => `<span class="${c}" style="flex-grow:${n[g]}"></span>`).join('')}</div>
        <div class="pr-legend">${seg.map(([g, c]) => `<span><i class="${c}"></i>${esc(g)} <b>${full(n[g] || 0)}</b></span>`).join('')}</div></div>
      <div class="pr-tip">${top ? `<div class="stat-label">Biggest win</div><b>${esc(top.title)}</b><p>${esc(top.detail)}</p>` : ''}</div>
      <span class="chev" aria-hidden="true">›</span>`;
  }

  function renderBreakdown() {
    const all = win('all');
    $('breakdown-desc').textContent = `All time · ${usd(all.totals.cost)} · ${compact(all.totals.total)} tokens`;
    $('models').innerHTML = costRows('m', all.models.slice().sort((a, b) => b.cost - a.cost).map((m) => ({
      id: m.model, ref: `model:${m.model}`, label: modelName(m.model), title: m.model, cost: m.cost,
      meta: `${replies(m.requests)} · ${compact(m.total)} tokens`,
    })), all.totals.cost);
    // As many folders as there are models (at least 5), then the rest in one row, so the two cards match.
    const folders = snap.projects.slice().sort((a, b) => b.all.cost - a.all.cost);
    const shown = Math.max(5, all.models.length);
    const rest = folders.slice(shown);
    const restCost = rest.reduce((n, p) => n + p.all.cost, 0);
    $('projects').innerHTML = costRows('p', folders.slice(0, shown).map((p) => ({
      id: p.project, ref: `project:${p.project}`, label: p.project, cost: p.all.cost,
      meta: `${p.sessions} chat${p.sessions === 1 ? '' : 's'} · ${compact(p.all.total)} tokens`,
    })).concat(rest.length ? [{
      id: '~rest', label: `${rest.length} more folder${rest.length === 1 ? '' : 's'}`, cost: restCost,
      meta: rest.slice(0, 3).map((p) => p.project).join(', ') + (rest.length > 3 ? ', …' : ''),
    }] : []), all.totals.cost);
  }

  function renderFooter() {
    const d = snap.data;
    const R = snap.reporter;
    const P = snap.pricing;
    $('footer').innerHTML = `<span>${full(d.files)} transcript files · ${full(d.responses)} API responses · ${full(d.duplicateLines)} duplicate lines skipped${d.unreadableLines ? ` · ${full(d.unreadableLines)} unreadable` : ''}</span>
      <span>Reading <code>${esc(snap.paths.projectsDir)}</code></span>
      <span class="no-print no-offline"><a href="/api/snapshot?download=1">Download JSON</a> · <a href="/report?download=1">Download report</a></span>
      ${R.installed && !REMOTE ? '<span class="no-print"><button type="button" data-action="uninstall">Remove reporter</button></span>' : ''}
      <details class="prices" data-table="prices"${openTables.has('prices') ? ' open' : ''}><summary>Prices used for the dollar figures (per million tokens, as of ${esc(P.asOf)})</summary>
        <div class="table-wrap"><table><thead><tr><th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Cache write 5 min</th><th class="num">Cache write 1 h</th></tr></thead><tbody>${P.models
          .map((m) => `<tr><td>${esc(modelName(m.model))}${m.known ? '' : ' (guess)'}</td>${[m.input, m.output, m.cacheRead, m.cacheWrite5m, m.cacheWrite1h].map((v) => `<td class="num">$${+v.toFixed(3)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div></details>`;
  }

  // ---------- remote access (local dashboard only) ----------
  let remoteKey = null; // fetched on request from this PC's own server; never part of a snapshot
  let keyShown = false;
  const TUNNEL_STATE = { up: ['on', 'Live'], starting: ['', 'Starting…'], approval: ['', 'Needs your OK'], missing: ['', 'Not installed'], error: ['', 'Not connected'], off: ['', 'Off'] };

  function renderRemote() {
    if (REMOTE) return;
    const r = snap.remote;
    if (!r || !r.enabled) {
      $('remote').innerHTML = `<p class="stat-sub" style="margin:0">Off. Start the monitor with <code>start-remote.cmd</code> to open it from your phone. The README has the steps.</p>`;
      return;
    }
    const t = r.tunnel;
    let status;
    let address;
    if (!t) {
      status = `<span class="dot on"></span>Listening on 127.0.0.1:${r.port}`;
      address = `<span class="stat-sub">No tunnel started. Point your own tunnel or reverse proxy at <span class="mono">http://127.0.0.1:${r.port}</span>.</span>`;
    } else {
      const [dot, text] = TUNNEL_STATE[t.state] || ['', t.state];
      status = `<span class="dot ${dot}"></span>${esc(t.label)} · ${text}`;
      if (t.state === 'up') address = `<a class="mono" href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.url)}</a><button type="button" data-action="copy-url">Copy</button>`;
      else if (t.state === 'approval') address = `<span>Tailscale needs you to allow this once.</span><a href="${esc(t.approvalUrl)}" target="_blank" rel="noopener">Allow it in Tailscale</a>`;
      else address = `<span class="stat-sub">${esc(t.message || 'Waiting for the tunnel…')}</span>`;
    }
    const key = keyShown && remoteKey
      ? `<span class="mono">${esc(remoteKey)}</span><button type="button" data-action="hide-key">Hide</button>`
      : '<span class="mono" aria-label="Hidden">•••••-•••••-•••••-•••••-•••••</span><button type="button" data-action="show-key">Show</button>';
    const link = t && t.state === 'up' ? '<button type="button" data-action="copy-link">Copy sign-in link</button>' : '';
    const reach = esc(t ? t.reach : 'Whoever your tunnel lets through');
    $('remote').innerHTML = `<div class="remote-head"><span>${status}</span></div>
      <dl class="remote-grid">
        <dt>Address</dt><dd>${address}</dd>
        ${r.signIn
          ? `<dt>Who can open it</dt><dd>${reach}, with the access key</dd>
             <dt>Access key</dt><dd>${key}${link}<button type="button" data-action="rotate-key">New key…</button></dd>`
          : `<dt>Who can open it</dt><dd>${reach}. No sign-in, so anyone who has the address can view it.</dd>`}
      </dl>
      <p class="note">Your PC has to stay on and awake with the monitor running. Other devices can look but can't install or remove the reporter.${
        r.signIn ? ' A sign-in link signs a device in with one tap, so anyone who has it can sign in: send it only to yourself.' : ''}</p>`;
  }

  async function loadKey() {
    const res = await fetch('/api/remote/key', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    remoteKey = (await res.json()).key;
    return remoteKey;
  }

  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => btn.isConnected && (btn.textContent = old), 1500);
    } catch {
      prompt('Copy this:', text);
    }
  }

  async function remoteAction(action, btn) {
    if (action === 'signout') {
      await fetch('/api/logout', { method: 'POST' }).catch(() => {});
      return location.replace('/login');
    }
    try {
      if (action === 'show-key') {
        await loadKey();
        keyShown = true;
      } else if (action === 'hide-key') {
        keyShown = false;
      } else if (action === 'copy-url') {
        return copy(snap.remote.tunnel.url, btn);
      } else if (action === 'copy-link') {
        const k = remoteKey || (await loadKey());
        return copy(`${snap.remote.tunnel.url}/login#key=${encodeURIComponent(k)}`, btn);
      } else if (action === 'rotate-key') {
        if (!confirm('Make a new access key? Every phone and browser signed in now is signed out and needs the new key.')) return;
        const res = await fetch('/api/remote/rotate', { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        remoteKey = (await res.json()).key;
        keyShown = true;
      }
      renderRemote();
    } catch (err) {
      alert(`That didn't work: ${err.message}`);
    }
  }

  function render() {
    if (!snap) return;
    $('subtitle').textContent = `${snap.sessions.length} chats · updated ${clock(snap.generatedAt)}`;
    renderSpend();
    renderLimits();
    renderPrompts();
    renderBoard();
    renderWork();
    renderCharts();
    renderTiles();
    renderFun();
    renderDiagnostics();
    renderSessions();
    renderBreakdown();
    renderFooter();
    renderRemote();
    if (PHONE && !document.querySelector('.fold-more') && $('limits')) {
      $('limits').insertAdjacentHTML('afterend', '<div class="fold-more"><button type="button" data-action="fold" aria-expanded="false"><span>Show all details</span><span class="caret" aria-hidden="true"></span></button></div>');
    }
    if (window.Sheet) window.Sheet.refresh();
    const signout = document.querySelector('[data-action="signout"]');
    if (signout) signout.hidden = !(snap.remote && snap.remote.signIn);
    window.dispatchEvent(new Event('limit-ready')); // the opening logo (splash.js) can go now
    if (!booted && window.LimitSplash && !window.LimitSplash.done) {
      // Still behind the logo: everything sits at zero and starts moving once the page shows.
      if (!holding) {
        holding = true;
        window.addEventListener('limit-splash-done', () => {
          holding = false;
          bootIn();
          animate();
          booted = true;
        }, { once: true });
      }
      return;
    }
    if (holding) return;
    if (!booted) bootIn();
    animate();
    booted = true;
  }
  let holding = false;

  /** First paint only: cards rise in order, columns grow from zero, the trend line rises and draws. */
  function bootIn() {
    if (CALM) return;
    document.querySelectorAll('.wrap > .card, .wrap > .grid > .card, .wrap > .section-title, .wrap > div > .section-title, .wrap > div > .card, .wrap > div > .grid > .card')
      .forEach((el, i) => el.style.setProperty('--i', Math.min(i, 14)));
    document.body.classList.add('boot');
    setTimeout(() => document.body.classList.remove('boot'), 2600);
  }

  // Countdowns and "x ago" tick locally between snapshots.
  setInterval(() => {
    if (!snap) return;
    const now = Date.now();
    document.querySelectorAll('[data-until]').forEach((el) => (el.textContent = resetIn(el.getAttribute('data-until'))));
    document.querySelectorAll('[data-ago]').forEach((el) => (el.textContent = ago(Number(el.getAttribute('data-ago')), now)));
    if (HOSTED) feedStatus();
    else if (now - receivedAt > 90000) setLive(false, 'No updates for a while');
  }, 1000);

  // ---------- actions ----------
  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    if (action === 'fold') {
      const open = document.body.classList.toggle('folded') === false;
      btn.setAttribute('aria-expanded', String(open));
      btn.firstElementChild.textContent = open ? 'Show less' : 'Show all details';
      if (open && !CALM) {
        document.body.classList.add('unfolding');
        renderCharts(true);
        animate();
        setTimeout(() => document.body.classList.remove('unfolding'), 900);
      }
      if (!open) $('spend').scrollIntoView({ block: 'start', behavior: CALM ? 'auto' : 'smooth' });
      return;
    }
    if (action === 'chats-toggle') {
      showAllChats = !showAllChats;
      renderSessions();
      animate();
      if (!showAllChats) $('sessions').scrollIntoView({ block: 'start' });
      return;
    }
    if (action.startsWith('metric-')) {
      metric = action.slice(7);
      store.set('metric', metric);
      renderCharts(true);
      return;
    }
    if (action.startsWith('work-')) {
      workRange = action.slice(5);
      store.set('workRange', workRange);
      renderWork();
      animate();
      return;
    }
    if (['show-key', 'hide-key', 'copy-url', 'copy-link', 'rotate-key', 'signout'].includes(action)) {
      remoteAction(action, btn);
      return;
    }
    if (action === 'install' || action === 'uninstall') {
      if (action === 'uninstall' && !confirm('Remove the plan-usage-reporter mod from ~/.claude/skills? Limit readings stop updating.')) return;
      btn.disabled = true;
      btn.textContent = action === 'install' ? 'Installing…' : 'Removing…';
      try {
        const res = await fetch(`/api/reporter/${action}`, { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        alert(`Could not ${action} the reporter: ${err.message}`);
        btn.disabled = false;
      }
    }
  });

  // ---------- breakdowns: every figure opens one (public/sheet.js draws them, public/insights.js works them out) ----------
  if (window.Sheet && window.Insights) window.Sheet.use((ref) => (snap ? window.Insights.detail(snap, window.Sheet.parse(ref)) : null));

  // ---------- hover layer ----------
  const tip = $('tooltip');
  function place(ev) {
    tip.hidden = false;
    // Pointer and box positions are on-screen pixels; left/top are scaled by the page zoom (desktop fit).
    const z = zoomOf();
    const r = tip.getBoundingClientRect();
    const x = Math.max(8, Math.min(ev.clientX + 14, window.innerWidth - r.width - 8));
    const y = ev.clientY + r.height + 20 > window.innerHeight ? ev.clientY - r.height - 12 : ev.clientY + 14;
    tip.style.left = `${x / z}px`;
    tip.style.top = `${y / z}px`;
  }
  document.addEventListener('mousemove', (ev) => {
    if (!snap || !ev.target.closest) return (tip.hidden = true);
    const col = ev.target.closest('.col');
    const host = col && col.closest('[data-chart]');
    if (!col || !host) return (tip.hidden = true);
    const daily = host.getAttribute('data-chart') === 'daily-card';
    const row = (daily ? snap.series.daily : snap.series.hourly)[Number(col.getAttribute('data-i'))];
    if (!row) return;
    const ks = keys();
    const title = daily ? new Date(row.t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : `${dateTime(row.t)} – ${clock(row.t + 3600e3)}`;
    tip.innerHTML = `<div class="tt-title">${esc(title)}</div>${ks
      .slice()
      .reverse()
      .map((k) => {
        const s = C.SERIES.find((x) => x.key === k);
        return `<div class="tt-row"><i style="background:${s.color}"></i>${esc(s.label)}<span>${show(valueOf(row, k))}</span></div>`;
      })
      .join('')}<div class="tt-row" style="margin-top:4px"><b>Total</b><span><b>${show(ks.reduce((a, k) => a + valueOf(row, k), 0))}</b></span></div>
      <div class="tt-row">${metric === 'cost' ? 'Tokens' : 'Cost'}<span>${metric === 'cost' ? compact(row.total) : usd(row.cost)}</span></div><div class="tt-row">Replies<span>${full(row.requests)}</span></div>`;
    place(ev);
  });

  connect();
})();
