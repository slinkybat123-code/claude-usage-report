/**
 * Chart + formatting helpers shared by the live dashboard (browser) and the
 * exported report (Node). Every chart is returned as an SVG/HTML string whose
 * colors are CSS custom properties, so both pages theme them the same way.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Charts = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Token types in fixed categorical order: stack order = slot order (validated adjacent pairs).
  const SERIES = [
    { key: 'cacheRead', label: 'Cache read', color: 'var(--series-1)' },
    { key: 'cacheWrite', label: 'Cache write', color: 'var(--series-2)' },
    { key: 'input', label: 'Input', color: 'var(--series-3)' },
    { key: 'output', label: 'Output', color: 'var(--series-4)' },
  ];

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function compact(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e9) return `${+(n / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
    if (a >= 1e6) return `${+(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
    if (a >= 1e4) return `${Math.round(n / 1e3)}K`;
    return Math.round(n).toLocaleString('en-US');
  }
  const full = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
  /** Dollars: cents below $1,000, whole dollars above. */
  function usd(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n > 0 && n < 0.005) return '<$0.01';
    const big = Math.abs(n) >= 1000;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: big ? 0 : 2, maximumFractionDigits: big ? 0 : 2 });
  }
  const usd2 = (n) => '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

  function duration(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    const m = Math.max(0, Math.round(ms / 60000));
    if (m >= 48 * 60) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
    if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
    return `${m}m`;
  }
  function ago(ts, now) {
    if (!ts) return '—';
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dateTime = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const shortDate = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const hourLabel = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric' });

  // Axis scale with clean ticks: a step of 1, 2 or 5 × 10^n, about four ticks.
  function niceScale(v) {
    if (v <= 0) return { max: 4, step: 1 };
    const raw = v / 4;
    const exp = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * exp).find((s) => s >= raw);
    return { max: Math.ceil(v / step) * step, step };
  }

  // A column segment: 4px rounded data-end on top, square at the baseline.
  function topRounded(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  /**
   * Stacked columns. rows: [{ t, ...tokenTotals }]. keys: series keys to stack.
   * Each column carries data-i for the hover layer; a full-height hit rect
   * makes the target bigger than the mark.
   */
  function stackedColumns(rows, opts) {
    const keys = opts.keys;
    const get = opts.get || ((r, k) => r[k] || 0); // e.g. the cost of each token type instead of its count
    const tick = opts.tick || compact;
    const W = opts.width || 960;
    const H = opts.height || 240;
    const m = { top: 12, right: 8, bottom: 26, left: 52 };
    const iw = W - m.left - m.right;
    const ih = H - m.top - m.bottom;
    const totals = rows.map((r) => keys.reduce((s, k) => s + get(r, k), 0));
    const { max, step } = niceScale(Math.max(0, ...totals));
    const slot = iw / Math.max(1, rows.length);
    const bw = Math.max(2, Math.min(24, slot * 0.66));
    const y = (v) => m.top + ih - (v / max) * ih;
    const parts = [];

    for (let i = 0; i <= Math.round(max / step); i++) {
      const v = step * i;
      const yy = Math.round(y(v)) + 0.5;
      parts.push(`<line x1="${m.left}" x2="${W - m.right}" y1="${yy}" y2="${yy}" stroke="${i === 0 ? 'var(--axis)' : 'var(--grid)'}" stroke-width="1"/>`);
      parts.push(`<text x="${m.left - 8}" y="${yy + 4}" text-anchor="end" class="tick">${esc(tick(v))}</text>`);
    }

    rows.forEach((r, i) => {
      const x = m.left + i * slot + (slot - bw) / 2;
      let base = m.top + ih;
      const visible = keys.filter((k) => get(r, k) > 0);
      const segs = [];
      visible.forEach((k, j) => {
        const h = (get(r, k) / max) * ih;
        const isTop = j === visible.length - 1;
        const gap = isTop ? 0 : 2; // 2px surface gap between stacked segments
        const sh = h - gap;
        const color = SERIES.find((s) => s.key === k).color;
        if (sh >= 0.5) {
          segs.push(isTop
            ? `<path d="${topRounded(x, base - h, bw, sh, 4)}" fill="${color}"/>`
            : `<rect x="${x}" y="${base - h + gap}" width="${bw}" height="${sh}" fill="${color}"/>`);
        }
        base -= h;
      });
      parts.push(`<g class="col" data-i="${i}"><rect class="hit" x="${m.left + i * slot}" y="${m.top}" width="${slot}" height="${ih}" fill="transparent"/>${segs.join('')}</g>`);
      if (opts.labelEvery && i % opts.labelEvery === (opts.labelOffset || 0)) {
        parts.push(`<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" class="tick">${esc(opts.xLabel(r.t))}</text>`);
      }
    });

    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(opts.title || 'Token usage chart')}" class="chart">${parts.join('')}</svg>`;
  }

  /**
   * One series over time as a filled line: 2px line, soft area, and a ringed
   * dot on the latest point. values: numbers, oldest first.
   */
  function sparkArea(values, opts = {}) {
    const W = opts.width || 960;
    const H = opts.height || 96;
    const pad = 6;
    const max = Math.max(1e-9, ...values);
    const x = (i) => pad + (i / Math.max(1, values.length - 1)) * (W - pad * 2);
    const y = (v) => H - pad - (v / max) * (H - pad * 2 - 4);
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const last = values.length - 1;
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="${esc(opts.title || 'Trend')}" class="spark">` +
      `<path class="spark-area" d="M${x(0)},${H - pad}L${pts.join('L')}L${x(last)},${H - pad}Z"/>` +
      `<path class="spark-line" pathLength="1" d="M${pts.join('L')}" vector-effect="non-scaling-stroke"/>` +
      `<line class="spark-base" x1="${pad}" x2="${W - pad}" y1="${H - pad + 0.5}" y2="${H - pad + 0.5}" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function legend(keys) {
    return `<div class="legend">${SERIES.filter((s) => keys.includes(s.key))
      .map((s) => `<span class="key"><i style="background:${s.color}"></i>${esc(s.label)}</span>`)
      .join('')}</div>`;
  }

  /** One-series horizontal bars as an HTML list: label · bar · value. */
  function barList(items, opts = {}) {
    const max = Math.max(1, ...items.map((d) => d.value));
    return `<ol class="barlist">${items
      .map(
        (d) => `<li><span class="bl-label" title="${esc(d.title || d.label)}">${esc(d.label)}</span>` +
          `<span class="bl-track"><span class="bl-bar" style="width:${Math.max(0.5, (d.value / max) * 100)}%"></span></span>` +
          `<span class="bl-value">${esc(opts.format ? opts.format(d.value) : compact(d.value))}${d.note ? ` <small>${esc(d.note)}</small>` : ''}</span></li>`,
      )
      .join('')}</ol>`;
  }

  /** Meter: fill carries severity; the track is a lighter step of the same ramp. */
  function meter(percent) {
    const p = Math.max(0, Math.min(100, percent));
    const level = percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'ok';
    return `<div class="meter meter-${level}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${p}%"></span></div>`;
  }

  const SEVERITY = {
    critical: { icon: '⛔', label: 'Critical' },
    warning: { icon: '⚠️', label: 'Warning' },
    info: { icon: 'ℹ️', label: 'Note' },
    ok: { icon: '✅', label: 'OK' },
  };

  return { SERIES, esc, compact, full, usd, usd2, sparkArea, pct, duration, ago, clock, dateTime, shortDate, hourLabel, stackedColumns, legend, barList, meter, SEVERITY };
});
