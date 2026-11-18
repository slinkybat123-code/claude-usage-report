'use strict';
/* The Apps card: pair a phone (code + QR), share with friends (opt-in, this PC
   only), get the Android app, and stop the monitor from the PC. */
(async () => {
  const el = document.getElementById('apps');
  if (!el) return;
  const esc = window.Charts.esc;
  const remote = document.body.dataset.mode === 'remote';
  const onAndroid = /Android/i.test(navigator.userAgent);
  const getJson = async (url, opts) => {
    const r = await fetch(url, opts);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  };
  let info = {};
  try {
    info = await getJson('/api/whoami');
  } catch {
    /* the card still explains what to do */
  }
  const size = info.apkBytes ? ` (${Math.round(info.apkBytes / 1048576)} MB)` : '';
  const download = info.apkBytes
    ? `<a class="btn${onAndroid ? ' primary' : ''}" href="/claude-usage.apk" download>Download the Android app${size}</a>`
    : '<span class="desc">The Android app has not been built on this PC yet (see android/ in the README).</span>';

  if (remote) return renderRemote();
  let pair = {};
  let shared = { on: false };
  try {
    [pair, shared] = await Promise.all([getJson('/api/pair'), getJson('/api/share')]);
  } catch {
    /* older server */
  }
  renderLocal();

  function renderRemote() {
    const connect = `claudeusage://connect?url=${encodeURIComponent(location.origin)}${info.code ? `&code=${info.code}` : ''}${info.finder ? `&finder=${info.finder}` : ''}`;
    el.innerHTML = `${fixedLine()}<div class="apps-grid"><div class="apps-col"><h3>Android: app, Quick Settings tile and widget</h3>
      <div class="apps-actions">${download}<a class="btn${onAndroid ? '' : ' primary'}" href="${connect}" target="_top">Connect the app</a></div>
      <ol class="apps-steps">
        <li>Download the app and open the file. Android asks once to let your browser install apps; allow it.</li>
        <li>Come back to this page and tap <b>Connect the app</b>.</li>
        <li>In the app, tap <b>Add tile</b> and <b>Add widget</b>.</li>
      </ol>
      <p class="desc">${info.code || info.finder ? 'This address changes when the monitor restarts. A connected app finds the new one by itself.' : 'This address changes when the monitor restarts. Open the new one and tap Connect the app again.'}</p></div></div>`;
  }

  function fixedLine() {
    return info.site
      ? `<p class="apps-fixed">Your fixed address, for any browser: <a href="${esc(info.site)}" target="_top" rel="noopener">${esc(info.site.replace(/^https:\/\//, '').replace(/\/$/, ''))}</a>. It always opens this dashboard, whatever today's address is.</p>`
      : '';
  }

  function pairBlock() {
    if (!pair.code) {
      return `<p class="desc">Make a pairing code, then type it into the Claude Usage app on your phone. The app finds this PC with it, even after restarts.</p>
        <div class="apps-actions"><button type="button" class="primary" data-pair="make">Make a pairing code</button></div>`;
    }
    const qr = pair.qr
      ? `<div class="pair-qr" aria-label="QR code that opens the pairing page on a phone">${pair.qr}</div>`
      : '';
    return `<div class="pair">
        ${qr}
        <div class="pair-text">
          <div class="pair-label">Pairing code</div>
          <div class="pair-code" aria-label="Pairing code ${esc(pair.code.split('').join(' '))}">${esc(pair.code)}</div>
          <ol class="apps-steps">
            <li>${pair.qr ? 'Scan the QR code with your phone camera. It offers the app download and connects it in one tap.' : 'Remote access is not online yet; the QR code appears once it is.'}</li>
            <li>Or open the Claude Usage app and type the code.</li>
          </ol>
          <p class="desc">Keep the code to yourself: it opens your full dashboard, chat titles included.</p>
        </div>
      </div>`;
  }

  function shareBlock() {
    if (!shared.on) {
      return `<p class="desc">Let friends see your spend, plan limits and how busy you are in their Claude Usage app. They never see chat titles, messages, folders or this dashboard. You can stop at any time.</p>
        <form class="share-form" data-share="start">
          <label for="share-name">Name your friends will see</label>
          <div class="apps-actions"><input id="share-name" name="name" maxlength="32" autocomplete="nickname" required placeholder="e.g. Sam">
          <button type="submit" class="primary">Start sharing</button></div>
          <p class="err" id="share-err" hidden></p>
        </form>`;
    }
    return `<p class="desc">Sharing as <b>${esc(shared.name)}</b> since ${esc(new Date(shared.since).toLocaleDateString())}. Give this friend code to the people you want to see your figures:</p>
      <div class="pair-code friend">${esc(shared.code)}</div>
      <p class="desc">They see: spend today, this week, last hour and all time, the 30-day projection, plan-limit percentages, active chats and replies today, and your top kind of work. Updated every 10 minutes at most.</p>
      <div class="apps-actions"><button type="button" data-share="stop">Stop sharing</button></div>`;
  }

  function renderLocal() {
    el.innerHTML = `${fixedLine()}<div class="apps-grid">
      <div class="apps-col"><h3>Pair a phone</h3>${pairBlock()}</div>
      <div class="apps-col"><h3>This PC</h3>
        <p class="desc">${info.packaged === 'mac-app'
          ? 'Open Claude Usage Monitor from Applications to come back to this page. The monitor starts by itself when you log in.'
          : info.packaged === 'win-exe'
            ? 'Open Claude Usage Monitor from the Start menu to come back to this page. To remove it: Settings, Apps, Installed apps.'
            : info.platform === 'darwin'
              ? 'Open <code>Claude Usage Monitor.command</code> to come back to this page. The monitor starts by itself when you log in.'
              : 'Run <code>install-desktop-app.cmd</code> once for a Desktop and Start menu shortcut. It starts the monitor quietly and opens this page in your browser.'}</p>
        <div class="apps-actions">${download}<button type="button" id="quit-monitor">Stop the monitor</button></div>
        <p class="desc" id="quit-note">Stopping also takes the online address down, so the phone app stops updating.</p></div>
      </div>`;
  }

  el.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    if (btn.id === 'quit-monitor') {
      if (!window.confirm('Stop the monitor? The dashboard and the phone app stop updating until you start it again.')) return;
      btn.disabled = true;
      try {
        await fetch('/api/quit', { method: 'POST' });
        document.getElementById('quit-note').textContent = 'Stopped. Use the desktop shortcut to start it again.';
      } catch {
        btn.disabled = false;
      }
      return;
    }
    if (btn.dataset.pair === 'make') {
      btn.disabled = true;
      try {
        pair = await getJson('/api/pair', { method: 'POST' });
        renderLocal();
      } catch (e) {
        btn.disabled = false;
        alert(`Could not make a pairing code: ${e.message}`);
      }
      return;
    }
    if (btn.dataset.share === 'stop') {
      if (!window.confirm('Stop sharing? Friends see that you stopped, and the friend code stops working.')) return;
      btn.disabled = true;
      try {
        shared = await getJson('/api/share/stop', { method: 'POST' });
      } catch {
        btn.disabled = false;
      }
      renderLocal();
    }
  });

  el.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('[data-share="start"]');
    if (!form) return;
    ev.preventDefault();
    const err = form.querySelector('#share-err');
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      shared = await getJson('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: form.name.value }) });
      renderLocal();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
})();
