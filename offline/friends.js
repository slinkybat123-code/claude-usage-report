'use strict';
/* Friends on this PC's dashboard: share your own figures (opt-in), follow
   friends by their friend code, and see who spent what today. Same codes as
   the Android and iPhone apps. Shown on this PC only. */
(async () => {
  const el = document.getElementById('friends');
  if (!el || document.body.dataset.mode === 'remote') return;
  const C = window.Charts;
  const { esc, usd, usd2, ago } = C;
  const getJson = async (url, opts) => {
    const r = await fetch(url, opts);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  };
  const post = (url, body) => getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  let data = { friends: [], you: { today: 0 } };
  let shared = { on: false };
  let problem = '';

  async function load() {
    try {
      [data, shared] = await Promise.all([getJson('/api/friends'), getJson('/api/share')]);
    } catch {
      /* keep what is on screen */
    }
    render();
  }

  function board() {
    const rows = [{ name: 'You', today: data.you.today || 0, me: true }]
      .concat(data.friends.filter((f) => f.card && !f.card.stopped).map((f) => ({ name: f.card.name, today: f.card.spend.today })))
      .sort((a, b) => b.today - a.today);
    if (rows.length < 2) {
      return '<p class="desc">Add a friend to see who spent the most today.</p>';
    }
    const top = Math.max(0.01, rows[0].today);
    return `<ol class="board">${rows
      .map((r, i) => `<li><span class="rank">${i + 1}</span><div class="b-main"><div class="b-title">${r.me ? '<b>You</b>' : esc(r.name)}</div></div>
        <div class="b-cost">${usd2(r.today)}</div>
        <div class="track"><span class="fill${r.me ? '' : ' friend'}" style="width:${Math.max(2, (r.today / top) * 100)}%"></span></div></li>`)
      .join('')}</ol>`;
  }

  function friendCard(f) {
    const c = f.card;
    const head = `<div class="fr-head"><h3>${esc(c ? c.name : f.code)}</h3><button type="button" class="fr-remove" data-remove="${esc(f.code)}" aria-label="Remove ${esc(c ? c.name : f.code)}">Remove</button></div>`;
    if (!c) return `<div class="card fr">${head}<p class="desc">Waiting for their first update…</p></div>`;
    if (c.stopped) return `<div class="card fr">${head}<p class="desc">Stopped sharing ${esc(ago(c.updatedAt, Date.now()))}.</p></div>`;
    const limits = c.limits.map((l) => `<div class="limit-row"><span>${esc(l.label)}</span><span><b>${l.percent}%</b></span></div>${C.meter(l.percent)}`).join('');
    const bits = [
      c.activeChats ? `${c.activeChats} chat${c.activeChats === 1 ? '' : 's'} active` : 'Idle',
      `${c.repliesToday} replies today`,
      c.topWork ? `mostly ${c.topWork.label.toLowerCase()}` : '',
      `updated ${ago(c.updatedAt, Date.now())}`,
    ].filter(Boolean).join(' · ');
    return `<div class="card fr">${head}
      <div class="stat-label">Spent today</div><div class="stat-value">${usd2(c.spend.today)}</div>
      <div class="stat-sub"><b>${usd(c.spend.week)}</b> this week · <b>${usd(c.spend.allTime)}</b> all time · <b>${usd(c.spend.projected30Days)}</b> next 30 days</div>
      ${limits ? `<div class="fr-limits">${limits}</div>` : ''}
      <p class="note">${esc(bits)}</p></div>`;
  }

  function shareBlock() {
    if (!shared.on) {
      return `<p class="desc">Let friends see your spend, plan limits and how busy you are, on Windows, Mac, Android or iPhone. Never chat titles, messages, folders or this dashboard. Stop at any time.</p>
        <form class="share-form" data-form="share">
          <label for="share-name">Name your friends will see</label>
          <div class="apps-actions"><input id="share-name" name="name" maxlength="32" autocomplete="nickname" required placeholder="e.g. Sam">
          <button type="submit" class="primary">Start sharing</button></div>
        </form>`;
    }
    return `<p class="desc">Sharing as <b>${esc(shared.name)}</b>. Give this friend code to the people you want to see your figures:</p>
      <div class="pair-code friend">${esc(shared.code)}</div>
      <p class="desc">They see your spend today, this week, last hour and all time, the 30-day projection, plan-limit percentages, active chats, replies today and your top kind of work. Updated every 10 minutes at most.</p>
      <div class="apps-actions"><button type="button" data-action-share="stop">Stop sharing</button></div>`;
  }

  function render() {
    el.innerHTML = `<div class="grid cols-2">
        <div class="card"><h2>Today</h2><p class="desc">You and the friends you follow</p>${board()}</div>
        <div class="card"><h2>Share yours</h2>${shareBlock()}</div>
      </div>
      <div class="fr-grid">${data.friends.map(friendCard).join('')}
        <div class="card fr add">
          <h3>Add a friend</h3>
          <p class="desc">Ask them for their friend code. They make it on their own computer under Friends, Share yours.</p>
          <form class="share-form" data-form="add">
            <label for="friend-code">Friend code</label>
            <div class="apps-actions"><input id="friend-code" name="code" maxlength="16" autocomplete="off" autocapitalize="characters" spellcheck="false" required placeholder="K7P2Q-X9M4R">
            <button type="submit" class="primary">Add friend</button></div>
            <p class="err" role="alert"${problem ? '' : ' hidden'}>${esc(problem)}</p>
          </form>
        </div>
      </div>`;
  }

  el.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('form[data-form]');
    if (!form) return;
    ev.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      if (form.dataset.form === 'add') {
        data.friends = (await post('/api/friends', { code: form.code.value })).friends;
        problem = '';
        await load();
      } else {
        shared = await post('/api/share', { name: form.name.value });
        render();
      }
    } catch (e) {
      problem = e.message;
      render();
      if (form.dataset.form === 'share') alert(e.message);
    }
  });

  el.addEventListener('click', async (ev) => {
    const rm = ev.target.closest('[data-remove]');
    if (rm) {
      data.friends = (await post('/api/friends/remove', { code: rm.dataset.remove })).friends;
      return render();
    }
    const stop = ev.target.closest('[data-action-share="stop"]');
    if (stop && window.confirm('Stop sharing? Friends see that you stopped, and the friend code stops working.')) {
      shared = await post('/api/share/stop');
      render();
    }
  });

  await load();
  setInterval(load, 60000);
})();
