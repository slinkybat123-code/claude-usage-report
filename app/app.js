'use strict';
/*
 * Claude Usage web app: for iPhone (Safari, Add to Home Screen) and any browser.
 * Pairs with a PC's monitor by its pairing code, reads the PC's figures from
 * its own address, and follows friends by friend code. Everything is read from
 * ntfy.sh (the relay the monitors post to) and the PC; nothing is stored
 * anywhere but this browser.
 */
(function () {
  var NTFY = 'https://ntfy.sh/';
  var CODE = /^[2-9A-HJKMNP-Z]{10}$/;
  var view = document.getElementById('view');
  var tabs = document.getElementById('tabs');
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('cu.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('cu.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  var state = { tab: store.get('tab', 'me'), code: store.get('code', null), url: store.get('url', null), follow: store.get('follow', false), summary: null, live: false, fetchedAt: 0, friends: store.get('friends', []), cards: store.get('cards', {}), cloud: store.get('cloud', null), offlinePage: store.get('offlinePage', null), copy: false };

  // ---------- helpers ----------
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) el.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function normalize(t) { var c = String(t || '').toUpperCase().replace(/[^0-9A-Z]/g, ''); return CODE.test(c) ? c : null; }
  function pretty(c) { return c.slice(0, 5) + '-' + c.slice(5); }
  function money(v) { v = Number(v) || 0; return v >= 100 ? '$' + Math.round(v).toLocaleString('en-US') : '$' + v.toFixed(2); }
  function ago(t) { var s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; }
  function timed(ms) { var c = new AbortController(); setTimeout(function () { c.abort(); }, ms); return c.signal; }

  function latest(nd) {
    var lines = String(nd || '').split('\n');
    for (var i = lines.length - 1; i >= 0; i--) {
      try { var ev = JSON.parse(lines[i]); if (ev.event === 'message' && ev.message) return ev.message; } catch (e) { /* skip */ }
    }
    return null;
  }
  function relay(topic) {
    return fetch(NTFY + encodeURIComponent(topic) + '/json?poll=1&since=all', { cache: 'no-store', signal: timed(10000) })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(latest)
      .catch(function () { return null; });
  }
  var GIST_RAW = /^https:\/\/gist\.githubusercontent\.com\/[A-Za-z0-9-]+\/[0-9a-f]{20,40}\/raw\/$/;
  /** The PC's address, plus where its cloud copy and offline dashboard are when it has them. */
  function addressFor(code) {
    return relay('claude-usage-' + code.toLowerCase()).then(function (body) {
      try {
        var rec = JSON.parse(body);
        if (GIST_RAW.test(rec.cloud || '')) { state.cloud = rec.cloud; store.set('cloud', rec.cloud); }
        if (/^https:\/\/[a-z0-9.-]+\/[\w./-]*$/i.test(rec.offline || '')) { state.offlinePage = rec.offline; store.set('offlinePage', rec.offline); }
        var u = new URL(rec.url);
        return u.protocol === 'https:' ? u.origin : null;
      } catch (e) { return null; }
    });
  }
  function readCloudSummary() {
    return fetch(state.cloud + 'claude-usage-summary.json?t=' + Math.floor(Date.now() / 120000), { cache: 'no-store', signal: timed(10000) }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function readSummary(url) {
    return fetch(url + '/api/summary', { cache: 'no-store', signal: timed(8000) }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function friendCard(code) {
    return relay('claude-usage-f-' + code.toLowerCase()).then(function (body) {
      try { var c = JSON.parse(body); return c && typeof c.name === 'string' ? c : null; } catch (e) { return null; }
    });
  }

  // ---------- refresh ----------
  function refresh() {
    if (!state.code && !state.url) return Promise.resolve();
    var tryUrl = state.url ? readSummary(state.url) : Promise.reject(new Error('no address'));
    return tryUrl.catch(function () {
      // The PC moved (the monitor restarted): look up its new address by the pairing code.
      if (!state.code) throw new Error('no code');
      return addressFor(state.code).then(function (url) {
        if (!url) throw new Error('not found');
        return readSummary(url).then(function (s) { state.url = url; store.set('url', url); return s; });
      });
    }).then(function (s) {
      state.summary = s; state.live = true; state.copy = false; state.fetchedAt = Date.now();
      store.set('summary', s); store.set('fetchedAt', state.fetchedAt);
    }, function () {
      state.live = false;
      // The PC is off or asleep: show the last copy it saved to the cloud, if it keeps one.
      if (!state.cloud) return;
      return readCloudSummary().then(function (s) {
        if (!state.summary || Date.parse(s.generatedAt) >= Date.parse(state.summary.generatedAt || 0)) state.summary = s;
        state.copy = true;
        store.set('summary', state.summary);
      }, function () { /* keep what we have */ });
    }).then(render);
  }
  function refreshFriends() {
    return Promise.all(state.friends.map(function (code) {
      return friendCard(code).then(function (c) { if (c) state.cards[code] = c; });
    })).then(function () {
      // Kept on this phone, so a friend whose computer is off still shows their last figures.
      store.set('cards', state.cards);
      render();
    });
  }

  // ---------- views ----------
  var shownMoney = {};
  function countUp(el, key, value) {
    var from = shownMoney[key] == null ? 0 : shownMoney[key];
    shownMoney[key] = value;
    if (from === value || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = money(value); return; }
    // The element is put on the page after this returns, so the count starts on the next frame.
    el.textContent = money(from);
    var t0 = null;
    requestAnimationFrame(function step(now) {
      if (t0 == null) t0 = now;
      var p = Math.min(1, (now - t0) / 800), v = from + (value - from) * (1 - Math.pow(1 - p, 4));
      el.textContent = money(p === 1 ? value : v);
      if (p < 1 && el.isConnected) requestAnimationFrame(step);
    });
  }

  var seen = {}; // chat title -> last message we drew
  function whoName(w) { return w === 'you' ? 'You' : w === 'notice' ? 'Notice' : 'Claude'; }
  function lastLine(key, m) {
    var box = h('div', { class: 'lm', title: m ? whoName(m.who) + ': ' + m.text : null });
    if (!m || !m.text) return null;
    var prev = seen[key];
    seen[key] = m;
    var fresh = prev && (prev.ts !== m.ts || prev.text !== m.text);
    if (fresh) {
      box.appendChild(h('div', { class: 'out', 'aria-hidden': 'true' }, [h('span', { class: 'who ' + prev.who, text: whoName(prev.who) }), prev.text]));
      var words = m.text.split(' ');
      var line = h('div', { class: 'in' }, [h('span', { class: 'who ' + m.who, text: whoName(m.who) })]);
      words.forEach(function (w, i) {
        var s = h('span', { class: 'w', text: w });
        s.style.setProperty('--w', String(Math.min(i, 28)));
        line.appendChild(s);
        if (i < words.length - 1) line.appendChild(document.createTextNode(' '));
      });
      box.appendChild(line);
    } else {
      box.appendChild(h('div', {}, [h('span', { class: 'who ' + m.who, text: whoName(m.who) }), m.text]));
    }
    var hours = (Date.now() - (m.ts || Date.now())) / 3600e3;
    box.style.opacity = String(Math.max(0.5, 1 - hours / 8));
    return box;
  }

  function meter(p) {
    var bar = h('span', { class: p >= 90 ? 'bad' : p >= 75 ? 'warn' : '' });
    bar.style.width = Math.max(0, Math.min(100, p)) + '%';
    return h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(p) }, [bar]);
  }

  function pairView() {
    var input = h('input', { id: 'code', placeholder: 'K7P2Q-X9M4R', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '16', 'aria-label': 'Pairing code' });
    var err = h('p', { class: 'err', role: 'alert', hidden: true });
    var go = h('button', { class: 'btn wide', type: 'submit', text: 'Connect' });
    var form = h('form', { onsubmit: function (ev) {
      ev.preventDefault();
      var code = normalize(input.value);
      if (!code) { err.textContent = 'The code has 10 letters and numbers, like K7P2Q-X9M4R.'; err.hidden = false; return; }
      go.disabled = true; go.textContent = 'Connecting…'; err.hidden = true;
      addressFor(code).then(function (url) {
        if (!url) throw new Error('No computer is using that code right now. Check the code, and that the computer is on with the monitor running.');
        return readSummary(url).then(function (s) {
          state.code = code; state.url = url; state.summary = s; state.live = true; state.fetchedAt = Date.now(); state.follow = false;
          store.set('code', code); store.set('url', url); store.set('follow', false);
          render();
        }, function () { throw new Error('Found the computer, but it did not answer. Is the monitor up to date and running?'); });
      }).catch(function (e) { err.textContent = e.message; err.hidden = false; go.disabled = false; go.textContent = 'Connect'; });
    } }, [h('label', { for: 'code', class: 'label', text: 'Pairing code' }), input, err, h('div', { style: 'height:12px' }), go]);
    return [
      h('div', { class: 'card' }, [
        h('h2', { text: 'Connect to your computer' }),
        h('p', { class: 'fine', text: 'On the computer, open the Claude Usage dashboard. Under Apps, Pair a phone, it shows a code. Type it here. No Claude password is ever needed; your usage stays on your computer.' }),
        h('div', { style: 'height:14px' }), form,
      ]),
      h('button', { class: 'link', type: 'button', text: 'I only want to follow friends', onclick: function () { state.follow = true; store.set('follow', true); state.tab = 'friends'; render(); } }),
      h('p', { class: 'fine' }, ['Don’t have the monitor yet? ', h('a', { href: '../get/', text: 'Get it for Windows or Mac' }), '.']),
    ];
  }

  function s0() { return state.summary; }
  function meView() {
    var s = state.summary;
    var out = [];
    var copyAt = state.copy && s0() && Date.parse(s0().generatedAt);
    var status = h('span', { class: 'live' + (state.live ? ' on' : '') }, [h('i'), state.live ? 'Live' : copyAt ? 'Computer off · figures from ' + ago(copyAt) : state.fetchedAt ? 'Last update ' + ago(state.fetchedAt) : 'Connecting…']);
    out.push(h('div', { class: 'row', style: 'margin:0 0 10px' }, [status]));
    if (!s) { out.push(h('div', { class: 'card' }, [h('p', { class: 'fine', text: state.live ? 'Loading…' : 'Can’t reach your computer. Is it on, with the monitor running?' })])); return out; }
    var today = h('div', { class: 'big' });
    countUp(today, 'today', s.spend.today);
    var stat = function (label, key, v) { var b = h('b'); countUp(b, key, v); return h('div', { class: 'stat' }, [h('span', { class: 'label', text: label }), b]); };
    out.push(h('div', { class: 'card' }, [
      h('span', { class: 'label', text: 'Spent today' }), today,
      h('p', { class: 'fine', text: 'API value at list prices, not a bill' }),
      h('div', { class: 'stats' }, [stat('Last hour', 'hour', s.spend.lastHour), stat('This week', 'week', s.spend.week), stat('All time', 'all', s.spend.allTime), stat('Next 30 days', 'proj', s.spend.projected30Days)]),
    ]));
    if (s.limits && s.limits.length) {
      out.push(h('div', { class: 'card' }, [h('h2', { text: 'Plan limits' })].concat(s.limits.map(function (l) {
        var left = l.resetsAt ? Date.parse(l.resetsAt) - Date.now() : 0;
        var hrs = Math.floor(left / 3600e3), mins = Math.round((left % 3600e3) / 60e3);
        var reset = left > 0 ? 'Resets in ' + (hrs >= 24 ? Math.floor(hrs / 24) + ' d ' + (hrs % 24) + ' h' : hrs ? hrs + ' h ' + mins + ' min' : mins + ' min') : '';
        return h('div', { class: 'limit' }, [h('div', { class: 'limit-top' }, [h('span', { text: l.label }), h('b', { text: l.percent + '% used' })]), meter(l.percent), reset ? h('span', { class: 'fine', text: reset }) : null]);
      })).concat(s.limitsStale ? [h('p', { class: 'fine', text: 'This reading is old; it refreshes on the next Claude Code reply.' })] : [])));
    }
    if (s.chats && s.chats.length) {
      out.push(h('div', { class: 'card' }, [h('h2', { text: 'Most expensive chats' })].concat(s.chats.map(function (c, i) {
        var sub = [c.active ? 'Active now' : '', c.costToday > 0.005 ? money(c.costToday) + ' today' : ''].filter(Boolean).join(' · ');
        return h('div', { class: 'chat' }, [
          h('span', { class: 'n', text: String(i + 1) }), h('span', { class: 't', text: c.title }), h('span', { class: 'c', text: money(c.cost) }),
          sub ? h('span', { class: 'sub' + (c.active ? ' active' : ''), text: sub }) : null,
          lastLine(c.title, c.last),
        ]);
      }))));
    }
    if (!state.live && state.cloud && state.offlinePage) {
      out.push(h('a', { class: 'btn wide', href: state.offlinePage + '#cloud=' + encodeURIComponent(state.cloud), target: '_blank', rel: 'noopener', text: 'Open the last full dashboard' }));
    } else if (state.url) {
      out.push(h('a', { class: 'btn wide', href: state.url + '/', target: '_blank', rel: 'noopener', text: 'Open the full dashboard' }));
    }
    out.push(h('p', { class: 'fine', style: 'margin-top:14px' }, [state.code ? 'Paired with code ' + pretty(state.code) + '. ' : '', h('button', { class: 'link', type: 'button', text: 'Unpair', onclick: function () {
      if (!confirm('Unpair this phone from the computer?')) return;
      state.code = null; state.url = null; state.summary = null; store.set('code', null); store.set('url', null); render();
    } })]));
    return out;
  }

  function friendsView() {
    var out = [];
    var rows = [];
    if (state.summary) rows.push({ name: 'You', today: state.summary.spend.today, me: true });
    state.friends.forEach(function (code) { var c = state.cards[code]; if (c && !c.stopped && c.spend) rows.push({ name: c.name, today: c.spend.today }); });
    rows.sort(function (a, b) { return b.today - a.today; });
    if (rows.length > 1) {
      var top = Math.max(0.01, rows[0].today);
      out.push(h('div', { class: 'card' }, [h('h2', { text: 'Today' })].concat(rows.map(function (r, i) {
        var bar = h('span', { class: r.me ? 'me' : '' }); bar.style.width = Math.max(2, (r.today / top) * 100) + '%';
        return h('div', { class: 'chat' }, [h('span', { class: 'n', text: String(i + 1) }), h('span', { class: 't', text: r.name }), h('span', { class: 'c', text: money(r.today) }), h('div', { class: 'bar', style: 'grid-column:2/-1' }, [bar])]);
      }))));
    }
    state.friends.forEach(function (code) {
      var c = state.cards[code];
      var remove = h('button', { class: 'link', type: 'button', text: 'Remove', onclick: function () {
        state.friends = state.friends.filter(function (x) { return x !== code; }); delete state.cards[code]; store.set('friends', state.friends); store.set('cards', state.cards); render();
      } });
      var head = h('div', { class: 'row' }, [h('h2', { style: 'flex:1;margin:0', text: c ? c.name : pretty(code) }), remove]);
      if (!c) { out.push(h('div', { class: 'card' }, [head, h('p', { class: 'fine', text: 'Waiting for their first update…' })])); return; }
      if (c.stopped) { out.push(h('div', { class: 'card' }, [head, h('p', { class: 'fine', text: 'Stopped sharing ' + ago(Date.parse(c.updatedAt)) + '.' })])); return; }
      var bits = [c.activeChats ? c.activeChats + ' chat' + (c.activeChats === 1 ? '' : 's') + ' active' : 'Idle', (c.repliesToday || 0) + ' replies today', c.topWork ? 'mostly ' + c.topWork.label.toLowerCase() : '', 'updated ' + ago(Date.parse(c.updatedAt))].filter(Boolean).join(' · ');
      out.push(h('div', { class: 'card' }, [head,
        h('span', { class: 'label', text: 'Spent today' }), h('div', { class: 'big', style: 'font-size:40px', text: money(c.spend.today) }),
        h('div', { class: 'stats' }, [h('div', { class: 'stat' }, [h('span', { class: 'label', text: 'This week' }), h('b', { text: money(c.spend.week) })]), h('div', { class: 'stat' }, [h('span', { class: 'label', text: 'All time' }), h('b', { text: money(c.spend.allTime) })])]),
      ].concat((c.limits || []).map(function (l) { return h('div', { class: 'limit' }, [h('div', { class: 'limit-top' }, [h('span', { text: l.label }), h('b', { text: l.percent + '% used' })]), meter(l.percent)]); }))
        .concat([h('p', { class: 'fine', style: 'margin-top:10px', text: bits })])));
    });
    var input = h('input', { id: 'fcode', placeholder: 'K7P2Q-X9M4R', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '16', 'aria-label': 'Friend code' });
    var err = h('p', { class: 'err', role: 'alert', hidden: true });
    var add = h('button', { class: 'btn', type: 'submit', text: 'Add friend' });
    out.push(h('div', { class: 'card' }, [
      h('h2', { text: 'Add a friend' }),
      h('p', { class: 'fine', text: 'Friends share from their own computer (Windows or Mac): on their dashboard, Friends, Share yours. They choose to, can stop at any time, and you only see their totals and limits.' }),
      h('form', { style: 'margin-top:12px', onsubmit: function (ev) {
        ev.preventDefault();
        var code = normalize(input.value);
        if (!code) { err.textContent = 'A friend code has 10 letters and numbers.'; err.hidden = false; return; }
        if (state.friends.indexOf(code) >= 0) { err.textContent = 'Already added.'; err.hidden = false; return; }
        add.disabled = true;
        friendCard(code).then(function (c) {
          add.disabled = false;
          if (!c) { err.textContent = 'No one is sharing with that code. Check it with your friend.'; err.hidden = false; return; }
          if (c.stopped) { err.textContent = c.name + ' has stopped sharing.'; err.hidden = false; return; }
          state.cards[code] = c; state.friends = state.friends.concat(code); store.set('friends', state.friends); render();
        });
      } }, [input, err, h('div', { style: 'height:12px' }), add]),
    ]));
    if (!state.code) out.push(h('button', { class: 'link', type: 'button', text: 'Connect my own computer', onclick: function () { state.follow = false; store.set('follow', false); state.tab = 'me'; render(); } }));
    return out;
  }

  function render() {
    var paired = Boolean(state.code || state.url);
    tabs.hidden = !(paired || state.follow);
    Array.prototype.forEach.call(tabs.querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.tab === state.tab)); });
    var parts = !paired && (!state.follow || state.tab === 'me') ? pairView() : state.tab === 'friends' ? friendsView() : meView();
    var focused = document.activeElement && document.activeElement.id;
    var typed = focused && document.getElementById(focused) ? document.getElementById(focused).value : null;
    view.replaceChildren.apply(view, parts.filter(Boolean));
    if (focused && document.getElementById(focused)) { var f = document.getElementById(focused); if (typed != null) f.value = typed; f.focus(); }
  }

  tabs.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab; store.set('tab', state.tab); render();
    if (state.tab === 'friends') refreshFriends();
  });

  // A link like app/#code=K7P2QX9M4R (from the pair page) pairs straight away.
  var m = /code=([0-9A-Za-z-]+)/.exec(location.hash);
  if (m && normalize(m[1])) {
    state.code = normalize(m[1]); state.url = null; store.set('code', state.code); store.set('url', null);
    history.replaceState(null, '', location.pathname);
  }
  state.summary = store.get('summary', null);
  state.fetchedAt = store.get('fetchedAt', 0);

  var ios = /iP(hone|ad|od)/.test(navigator.userAgent);
  var standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (ios && !standalone && !store.get('hintClosed', false)) document.getElementById('hint').hidden = false;
  document.getElementById('hint-close').addEventListener('click', function () { document.getElementById('hint').hidden = true; store.set('hintClosed', true); });

  render();
  refresh();
  refreshFriends();
  setInterval(function () { if (!document.hidden && (state.tab === 'me' || state.tab === 'friends')) refresh(); }, 10000);
  setInterval(function () { if (!document.hidden) refreshFriends(); }, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { refresh(); refreshFriends(); } });
})();
