/* The breakdown panel every page shares: click anything marked data-detail="<ref>" and the panel
   slides in with what the page's resolver returns for that ref (figures, what you can do, rows that
   open further). Each step deeper is a history entry, so Back and a phone's back gesture go back
   one level. Requests are broken down by PromptCoach when the page loads it.

     Sheet.use((ref) => detail or null)   the page says how to turn a ref into a breakdown
     Sheet.add('friend', fn)               ...or only the refs of one type ("friend:<uid>")
     Sheet.refresh()                       redraw what's open after new figures arrive
     Sheet.attrs(ref)                      the attributes that make an element open a ref
     Sheet.parse("chat:abc")               { type: 'chat', id: 'abc' } */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n, d) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  const usd = (n) => money(n, 2);
  const usd2 = (n) => (Math.abs(n) < 0.1 && n !== 0 ? money(n, 3) : money(n, 2)); // a few cents keeps a third digit
  const full = (n) => (Number(n) || 0).toLocaleString('en-US');
  function compact(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return `${+(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${+(v / 1e3).toFixed(1)}K`;
    return String(Math.round(v));
  }
  const fmtValue = (s) => ({ usd: () => usd(s.value), usd2: () => usd2(s.value), int: () => full(s.value), compact: () => compact(s.value), share: () => `${Math.round(s.value * 100)}%`, percent: () => `${Math.round(s.value)}%` }[s.fmt] || (() => esc(s.value)))();
  const attrs = (ref) => ` data-detail="${esc(ref)}" role="button" tabindex="0"`;
  const parse = (s) => { const t = String(s); const i = t.indexOf(':'); return i < 0 ? { type: t } : { type: t.slice(0, i), id: t.slice(i + 1) }; };
  const $ = (id) => document.getElementById(id);

  document.body.insertAdjacentHTML('beforeend', `<div class="sheet-backdrop" id="sheet-backdrop" hidden></div>
    <aside class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" hidden>
      <header class="sheet-head">
        <button type="button" class="sheet-btn" data-sheet="back" id="sheet-back" aria-label="Back" hidden>‹</button>
        <div class="sheet-titles"><h2 id="sheet-title"></h2><p id="sheet-sub"></p></div>
        <button type="button" class="sheet-btn" data-sheet="close" aria-label="Close">✕</button>
      </header>
      <div class="sheet-body" id="sheet-body"></div>
    </aside>`);

  let resolve = () => null;
  const byType = new Map(); // refs of one type a page handles itself, e.g. friend:<uid> on the dashboard
  let stack = [];
  let lastFocus = null;
  let shownHtml = '';
  const copyTexts = new Map();
  const find = (ref) => { try { return (byType.get(parse(ref).type) || resolve)(ref); } catch { return null; } };

  // ---------- drawing ----------
  function promptHtml(item) {
    const a = window.PromptCoach && window.PromptCoach.analyzePrompt(item.text);
    if (!a) return '';
    const marks = [
      ...a.wasted.map((w) => ({ ...w, cls: 'p-cut', why: w.kind === 'repeat' ? 'Repeated word' : w.kind === 'polite' ? 'Polite padding: can go' : 'Filler: can go' })),
      ...a.vague.map((v) => ({ ...v, cls: 'p-vague', why: 'Vague: say exactly what you mean' })),
    ].sort((x, y) => x.start - y.start);
    let text = '';
    let at = 0;
    for (const m of marks) {
      if (m.start < at) continue;
      text += `${esc(a.text.slice(at, m.start))}<span class="${m.cls}" title="${m.why}">${esc(a.text.slice(m.start, m.end))}</span>`;
      at = m.end;
    }
    text += esc(a.text.slice(at));
    const grade = a.reply ? 'reply' : a.grade === 'Clear' ? 'good' : a.grade === 'Vague' ? 'bad' : 'mid';
    const checks = a.reply ? [] : [
      ['Enough context', a.checks.enoughContext],
      a.asksChange && ['Says where to look', a.checks.location],
      a.asksChange && ['Says what done looks like', a.checks.doneWhen],
      ['One request at a time', a.checks.oneTask],
      ['No filler', a.wastedWords === 0],
    ].filter(Boolean);
    copyTexts.set(item.id, a.shorter);
    return `<article class="pc">
      <header class="pc-top"><span class="pc-label">${esc(item.label)}</span><span class="grade ${grade}">${esc(a.grade)}${a.score != null ? ` · ${a.score}/100` : ''}</span></header>
      <blockquote class="pc-text">${text}</blockquote>
      ${a.partial ? '<p class="pc-note">Only the first 400 or so characters of a request are kept, so the check stops there.</p>' : ''}
      ${a.reply ? '' : `<div class="pc-facts"><span>${full(a.words)} words</span><span>about ${full(a.tokens)} tokens</span><span>${a.wastedWords ? `${full(a.wastedWords)} could go` : 'no filler'}</span>${a.tasks > 1 ? `<span>${a.tasks} requests in one</span>` : ''}</div>
      <ul class="pc-checks">${checks.map(([label, ok]) => `<li class="${ok ? 'ok' : 'no'}"><span aria-hidden="true">${ok ? '✓' : '✕'}</span>${esc(label)}<span class="sr-only">${ok ? ': yes' : ': no'}</span></li>`).join('')}</ul>`}
      <ul class="pc-tips">${a.tips.map((t) => `<li><b>${esc(t.title)}.</b> ${esc(t.detail)}</li>`).join('')}</ul>
      ${a.shorter !== a.text ? `<div class="pc-short"><div class="pc-short-head"><span>Without the filler</span><button type="button" data-sheet="copy" data-id="${esc(item.id)}">Copy</button></div><p>${esc(a.shorter)}</p></div>` : ''}
    </article>`;
  }

  function sectionHtml(sec) {
    if (sec.kind === 'text') return `<section class="d-sec"><h3>${esc(sec.title)}</h3><p class="d-text">${esc(sec.text)}</p></section>`;
    if (sec.kind === 'prompts') return `<section class="d-sec"><h3>${esc(sec.title)}</h3>${sec.items.map(promptHtml).join('')}</section>`;
    return `<section class="d-sec"><h3>${esc(sec.title)}</h3><ul class="d-bars">${sec.rows.map((r) => `<li${r.ref ? attrs(`${r.ref.type}:${r.ref.id}`) : ''}>
        <div class="d-row"><span class="d-label" title="${esc(r.label)}">${esc(r.label)}</span><span class="d-val">${fmtValue(r)}</span>${r.ref ? '<span class="chev" aria-hidden="true">›</span>' : ''}</div>
        ${r.note ? `<div class="d-note">${esc(r.note)}</div>` : ''}
        ${r.share > 0 ? `<div class="d-track"><span style="width:${Math.max(1, Math.min(100, r.share * 100)).toFixed(1)}%"></span></div>` : ''}</li>`).join('')}</ul></section>`;
  }

  /** Figures first, then requests and notes, then what to do, then the breakdowns. */
  function detailHtml(d) {
    const stats = d.stats.length ? `<dl class="d-stats">${d.stats.map((s) => `<div><dt>${esc(s.label)}</dt><dd>${fmtValue(s)}</dd></div>`).join('')}</dl>` : '';
    const tips = d.tips.length ? `<section class="d-sec d-tips"><h3>What you can do</h3><ol>${d.tips.map((t) => `<li><div class="d-tip-head"><b>${esc(t.title)}</b>${t.saving > 0.005 ? `<span class="save">up to ${usd(t.saving)} less</span>` : ''}</div><p>${esc(t.detail)}</p></li>`).join('')}</ol></section>` : '';
    const first = d.sections.filter((s) => s.kind === 'prompts' || s.kind === 'text').map(sectionHtml).join('');
    const rest = d.sections.filter((s) => s.kind !== 'prompts' && s.kind !== 'text').map(sectionHtml).join('');
    return stats + first + tips + rest;
  }

  // ---------- opening and closing ----------
  function show(d, toTop) {
    const html = detailHtml(d);
    $('sheet-title').textContent = d.title;
    $('sheet-sub').textContent = d.subtitle || '';
    $('sheet-back').hidden = stack.length < 2;
    const body = $('sheet-body');
    if (html !== shownHtml || toTop) {
      const y = body.scrollTop;
      body.innerHTML = html;
      shownHtml = html;
      body.scrollTop = toTop ? 0 : y;
    }
    if ($('sheet').hidden) {
      $('sheet').hidden = false;
      $('sheet-backdrop').hidden = false;
      document.documentElement.classList.add('sheet-open');
      requestAnimationFrame(() => $('sheet').classList.add('in'));
      $('sheet').querySelector('[data-sheet="close"]').focus();
    }
  }
  function open(ref) {
    const d = find(ref);
    if (!d) return;
    if (!stack.length) lastFocus = document.activeElement;
    stack.push(ref);
    try { history.pushState({ sheet: stack.length }, ''); } catch { /* sandboxed page */ }
    show(d, true);
  }
  function close(fromHistory) {
    if ($('sheet').hidden) return;
    const depth = stack.length;
    stack = [];
    shownHtml = '';
    $('sheet').classList.remove('in');
    $('sheet').hidden = true;
    $('sheet-backdrop').hidden = true;
    document.documentElement.classList.remove('sheet-open');
    if (!fromHistory && depth) try { history.go(-depth); } catch { /* sandboxed page */ }
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
  }
  /** New figures arrived: redraw what's open (keeping the scroll), or close it if it's gone. */
  function refresh() {
    if (!stack.length) return;
    const d = find(stack[stack.length - 1]);
    if (d) show(d, false);
    else close();
  }

  window.addEventListener('popstate', () => {
    if (!stack.length) return;
    stack.pop();
    const d = stack.length && find(stack[stack.length - 1]);
    if (d) show(d, true);
    else close(true);
  });
  $('sheet-backdrop').addEventListener('click', () => close());
  document.addEventListener('click', async (ev) => {
    if (!ev.target.closest) return;
    const btn = ev.target.closest('[data-sheet]');
    if (btn) {
      const what = btn.getAttribute('data-sheet');
      if (what === 'close') return close();
      if (what === 'back') return history.back();
      if (what === 'copy') {
        try {
          await navigator.clipboard.writeText(copyTexts.get(btn.getAttribute('data-id')) || '');
          btn.textContent = 'Copied';
        } catch {
          btn.textContent = 'Select and copy it';
        }
        setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy'; }, 1600);
      }
      return;
    }
    const el = ev.target.closest('[data-detail]');
    if (!el) return;
    const inner = ev.target.closest('a, button, details, input, select, textarea, label');
    if (inner && inner !== el && el.contains(inner)) return;
    if (String(window.getSelection ? window.getSelection() : '').length > 2) return; // selecting text, not clicking
    open(el.getAttribute('data-detail'));
  });
  document.addEventListener('keydown', (ev) => {
    if (!$('sheet').hidden) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        return close();
      }
      if (ev.key === 'Tab') { // keep focus inside the open panel
        const f = [...$('sheet').querySelectorAll('button:not([hidden]), [tabindex="0"], a[href]')].filter((x) => x.offsetParent);
        if (f.length && ev.shiftKey && document.activeElement === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); }
        else if (f.length && !ev.shiftKey && document.activeElement === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
      }
    }
    const el = ev.target.closest && ev.target.closest('[data-detail]');
    if (el && el === ev.target && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      open(el.getAttribute('data-detail'));
    }
  });

  window.Sheet = { use: (fn) => { resolve = fn; }, add: (type, fn) => byType.set(type, fn), open, close, refresh, attrs, parse };
})();
