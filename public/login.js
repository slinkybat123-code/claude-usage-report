/* Sign-in for the remote dashboard. A pairing link (/login#key=...) signs in
   on open; the fragment never leaves this browser. */
(function () {
  'use strict';
  const form = document.getElementById('login');
  const input = document.getElementById('key');
  const err = document.getElementById('err');
  const button = form.querySelector('button[type="submit"]');

  try {
    const theme = localStorage.getItem('theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  } catch {
    /* storage blocked: follow the system theme */
  }

  const next = (() => {
    const n = new URLSearchParams(location.search).get('next') || '/';
    return /^\/(?![/\\])/.test(n) ? n : '/'; // same-site paths only
  })();

  function show(message) {
    err.textContent = message;
    err.hidden = false;
  }

  async function submit(key) {
    if (!key.trim()) return show('Enter the access key.');
    button.disabled = true;
    button.textContent = 'Signing in…';
    err.hidden = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
        credentials: 'same-origin',
      });
      if (res.ok) return location.replace(next);
      const body = await res.json().catch(() => ({}));
      show(body.error || `Sign-in failed (HTTP ${res.status}).`);
    } catch {
      show("Can't reach your PC. Check that the monitor is running and the PC is awake.");
    }
    button.disabled = false;
    button.textContent = 'Sign in';
  }

  document.getElementById('reveal').addEventListener('change', (ev) => {
    input.type = ev.target.checked ? 'text' : 'password';
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submit(input.value);
  });

  const m = /(?:^#|&)key=([^&]+)/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname + location.search);
    input.value = decodeURIComponent(m[1]);
    submit(input.value);
  } else {
    input.focus();
  }
})();
