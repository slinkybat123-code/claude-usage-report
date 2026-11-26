/* Opening screen: the Limit mark on plain white or black (whichever theme you use), then the
   page fades in and its numbers and charts start from zero. The logo shows once per visit (per
   tab); pages you open after that only fade in. Load it in <head>, before the page draws.
   Pages that wait for data (the dashboards) set data-wait-ready on <html> and fire
   "limit-ready" once drawn; everyone can listen for "limit-splash-done". */
(function () {
  'use strict';
  var html = document.documentElement;
  if (html.classList.contains('shell') || window.LimitSplash) return; // the phone app has its own
  var calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var seen = false;
  try {
    var t = localStorage.getItem('theme');
    if ((t === 'light' || t === 'dark') && !html.getAttribute('data-theme')) html.setAttribute('data-theme', t);
    seen = sessionStorage.getItem('limit-splash') === '1';
    sessionStorage.setItem('limit-splash', '1');
  } catch (e) { /* private window: show it every time */ }
  var full = !seen && !calm;
  var api = (window.LimitSplash = { done: false });

  var css = document.createElement('style');
  css.textContent =
    'html.splashing body{opacity:0}' +
    'html.splash-out body{animation:ls-page .7s cubic-bezier(.2,.8,.2,1) both}' +
    '@keyframes ls-page{from{opacity:0;transform:translateY(10px) scale(.995)}}' +
    '.limit-splash{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#fff;color:#0b0b0b;transition:opacity .55s ease,visibility 0s .55s}' +
    '@media (prefers-color-scheme:dark){html:not([data-theme="light"]) .limit-splash{background:#000;color:#f0efec}}' +
    'html[data-theme="dark"] .limit-splash{background:#000;color:#f0efec}' +
    '.limit-splash.out{opacity:0;visibility:hidden}' +
    '.limit-splash .ls-in{display:flex;align-items:flex-end;gap:16px;transition:transform .55s cubic-bezier(.4,0,.2,1)}' +
    '.limit-splash.out .ls-in{transform:scale(1.08)}' +
    '.ls-mark{display:inline-flex;gap:8px;align-items:flex-end;height:56px}' +
    '.ls-mark i{width:14px;border-radius:4px;background:#2a78d6;transform-origin:bottom;animation:ls-bar .6s cubic-bezier(.2,.9,.25,1.2) both}' +
    '.ls-mark i:nth-child(1){height:26px;animation-delay:.05s}' +
    '.ls-mark i:nth-child(2){height:40px;animation-delay:.17s}' +
    '.ls-mark i:nth-child(3){height:56px;background:#eb6834;animation-delay:.29s}' +
    '.ls-word{font:700 44px/1 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:-.02em;margin-bottom:-4px;animation:ls-word .6s .42s cubic-bezier(.2,.8,.2,1) both}' +
    '@keyframes ls-bar{from{transform:scaleY(0)}}' +
    '@keyframes ls-word{from{opacity:0;transform:translateX(-10px);filter:blur(6px)}}' +
    '@media (prefers-reduced-motion:reduce){html.splash-out body{animation:none}}';
  (document.head || html).appendChild(css);
  html.classList.add('splashing');

  var el = null;
  if (full) {
    el = document.createElement('div');
    el.className = 'limit-splash';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="ls-in"><span class="ls-mark"><i></i><i></i><i></i></span><span class="ls-word">Limit</span></div>';
    html.appendChild(el);
  }

  var t0 = Date.now();
  var MIN = full ? 1150 : 0; // long enough to see the mark draw
  var MAX = full ? 2800 : 1200; // never hold the page longer than this
  var wait = full && html.hasAttribute('data-wait-ready');
  var parsed = false;
  var ready = false;

  function finish() {
    if (api.done) return;
    api.done = true;
    html.classList.remove('splashing');
    if (!calm) html.classList.add('splash-out');
    if (el) el.classList.add('out');
    window.dispatchEvent(new Event('limit-splash-done'));
    setTimeout(function () {
      html.classList.remove('splash-out');
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }, 800);
  }
  function check() {
    if (parsed && (ready || !wait)) setTimeout(finish, Math.max(0, MIN - (Date.now() - t0)));
  }
  window.addEventListener('limit-ready', function () { ready = true; check(); });
  if (document.readyState !== 'loading') parsed = true;
  else document.addEventListener('DOMContentLoaded', function () { parsed = true; check(); });
  check();
  setTimeout(finish, MAX);
})();
