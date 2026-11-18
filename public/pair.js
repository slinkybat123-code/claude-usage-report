'use strict';
/* The page a phone opens from the dashboard's QR code: download the app, then hand it the address and pairing code. */
(async () => {
  const q = new URLSearchParams(location.search);
  const raw = (q.get('code') || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const code = /^[2-9A-HJKMNP-Z]{10}$/.test(raw) ? raw : null;
  let info = {};
  try {
    info = await (await fetch('/api/whoami')).json();
  } catch {
    /* links still work */
  }
  const params = new URLSearchParams({ url: location.origin });
  if (code || info.code) params.set('code', code || info.code);
  if (info.finder) params.set('finder', info.finder);
  document.getElementById('connect').href = `claudeusage://connect?${params}`;
  if (info.apkBytes) document.getElementById('download').textContent = `Download the app (${Math.round(info.apkBytes / 1048576)} MB)`;
  const shown = code || info.code;
  if (shown) {
    const box = document.getElementById('code');
    box.textContent = `${shown.slice(0, 5)}-${shown.slice(5)}`;
    box.hidden = false;
  }
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
  if (ios && info.webApp) {
    document.getElementById('ios-steps').hidden = false;
    document.getElementById('android-steps').hidden = true;
    document.getElementById('ios-open').href = `${info.webApp}#code=${shown || ''}`;
  } else if (!/Android/i.test(navigator.userAgent)) {
    document.getElementById('desktop-note').hidden = false;
  }
})();
