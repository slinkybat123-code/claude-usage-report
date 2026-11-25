/* The friends strip at the top of the dashboard: one small card per friend, arrows on a computer and
   swipe on a phone; a card opens that friend's breakdown in the shared panel (public/sheet.js).
   The website (Google friends) and the desktop app (friend codes) both draw it with this.

     const strip = FriendStrip.mount({ onAdd: () => openAddFriend() });
     strip.render(Insights.friendStrip(ctx), 'One line under the title'); */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const usd = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  function ago(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  }
  const tone = (p) => (p >= 90 ? 'var(--critical)' : p >= 70 ? 'var(--warning)' : 'var(--series-1)');
  const avatar = (name, photo) => (photo
    ? `<img class="avatar" src="${esc(photo)}" alt="" referrerpolicy="no-referrer" loading="lazy">`
    : `<span class="avatar" aria-hidden="true">${esc(String(name || '?').trim().charAt(0).toUpperCase() || '?')}</span>`);

  function cardHtml(f) {
    const status = f.loading ? 'Waiting for their first update' : f.active ? 'Using Claude Code now' : f.at ? `Updated ${ago(f.at)}` : 'No computer linked yet';
    const attrs = window.Sheet ? window.Sheet.attrs(`friend:${f.uid}`) : '';
    return `<article class="fs-card"${attrs} aria-label="${esc(f.name)}: ${f.today == null ? 'no figures yet' : `${usd(f.today)} today`}">
      <div class="fs-top">${avatar(f.name, f.photo)}<div class="fs-who"><b>${esc(f.name)}</b><span>${esc(status)}</span></div><span class="dot${f.active ? ' on' : ''}" aria-hidden="true"></span></div>
      <div class="fs-nums"><div><span>Today</span><b>${f.today == null ? '—' : usd(f.today)}</b></div><div><span>30 days</span><b>${f.month == null ? '—' : usd(f.month)}</b></div></div>
      ${f.limit == null ? '' : `<div class="fs-limit"><div><span>${esc(f.limitLabel)}</span><b>${f.limit}%</b></div><div class="fmeter"><span style="width:${Math.min(100, f.limit)}%;background:${tone(f.limit)}"></span></div></div>`}
    </article>`;
  }
  const ADD_CARD = '<button type="button" class="fs-card fs-add" data-strip="add"><span class="fs-plus" aria-hidden="true">+</span><b>Add a friend</b><span>Invite them to share</span></button>';

  function mount({ root = document.getElementById('friend-strip'), onAdd = () => {} } = {}) {
    if (!root) return { render() {} };
    const track = root.querySelector('.fs-track');
    const arrows = root.querySelector('.fs-arrows');
    const prev = root.querySelector('[data-strip="prev"]');
    const next = root.querySelector('[data-strip="next"]');
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let last = null;

    function updateArrows() {
      const max = track.scrollWidth - track.clientWidth - 2;
      arrows.hidden = max <= 0;
      prev.disabled = track.scrollLeft <= 2;
      next.disabled = track.scrollLeft >= max;
    }
    root.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-strip]');
      if (!b) return;
      const what = b.getAttribute('data-strip');
      if (what === 'add') return onAdd();
      const card = track.querySelector('.fs-card');
      const step = card ? card.getBoundingClientRect().width + 12 : 260;
      const page = Math.max(1, Math.floor(track.clientWidth / step)) * step;
      track.scrollBy({ left: what === 'next' ? page : -page, behavior: calm ? 'auto' : 'smooth' });
    });
    track.addEventListener('scroll', () => requestAnimationFrame(updateArrows), { passive: true });
    window.addEventListener('resize', () => requestAnimationFrame(updateArrows));

    function render(items, desc) {
      last = { items, desc };
      const x = track.scrollLeft;
      root.hidden = false;
      root.querySelector('.fs-desc').textContent = desc != null ? desc
        : items.length ? `${items.length} friend${items.length === 1 ? '' : 's'} · click one for their breakdown` : "See each other's usage, once you both agree";
      track.innerHTML = items.map(cardHtml).join('') + ADD_CARD;
      track.scrollLeft = x;
      updateArrows();
    }
    // "Updated 5 min ago" moves on by itself.
    setInterval(() => { if (last && !document.hidden) render(last.items, last.desc); }, 60000);
    return { render };
  }

  window.FriendStrip = { mount };
})();
