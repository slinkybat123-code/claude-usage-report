/* Claude Usage Report: looks up the monitor's current address in the
   address-finder gist and shows the live dashboard full screen. When the
   monitor restarts with a new address, it notices and follows. */
(function () {
  'use strict';
  var GIST = (window.SITE || {}).gist;
  var FILE = 'claude-usage-address.json';
  var state = document.getElementById('state');
  var msg = document.getElementById('msg');
  var retry = document.getElementById('retry');
  var frame = document.getElementById('frame');
  var current = null;
  var misses = 0;
  var again = null;

  function say(text, stuck) {
    frame.hidden = true;
    state.hidden = false;
    state.classList.toggle('busy', !stuck);
    msg.textContent = text;
    retry.hidden = !stuck;
    clearTimeout(again);
    if (stuck) again = setTimeout(find, 90000); // keeps trying while the page is open
  }

  function within(ms) {
    var c = new AbortController();
    setTimeout(function () { c.abort(); }, ms);
    return c.signal;
  }

  function since(iso) {
    var t = Date.parse(iso);
    if (!t) return 'a while ago';
    var m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 1440) return Math.round(m / 60) + ' h ago';
    return Math.round(m / 1440) + ' days ago';
  }

  async function lookup() {
    var r = await fetch('https://api.github.com/gists/' + encodeURIComponent(GIST), {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
      signal: within(10000),
    });
    if (!r.ok) throw new Error('GitHub answered ' + r.status);
    var g = await r.json();
    var data = JSON.parse(g.files[FILE].content);
    if (!data.url) return { url: null, at: data.updatedAt };
    var u = new URL(data.url);
    if (u.protocol !== 'https:') throw new Error('not an https address');
    return { url: u.origin, at: data.updatedAt };
  }

  async function answers(url) {
    try {
      var r = await fetch(url + '/api/summary', { cache: 'no-store', signal: within(8000) });
      return r.ok;
    } catch (e) {
      return false;
    }
  }

  async function find() {
    say('Finding your dashboard…', false);
    var a;
    try {
      a = await lookup();
    } catch (e) {
      return say('Could not reach GitHub to look up the address. Check your connection.', true);
    }
    if (!a.url) return say('The monitor on your PC has not gone online yet.', true);
    if (!(await answers(a.url))) {
      // The PC is off or asleep: show the last copy it saved, and keep checking for it to come back.
      if ((window.SITE || {}).cloud) return showCopy();
      return say('Your PC is off or the monitor is not running. It last came online ' + since(a.at) + '.', true);
    }
    show(a.url);
  }

  function showCopy() {
    var src = 'offline/#cloud=' + encodeURIComponent(window.SITE.cloud);
    if (current !== src) {
      current = src;
      frame.src = src;
    }
    state.hidden = true;
    frame.hidden = false;
    clearTimeout(again);
    again = setTimeout(find, 90000); // switch back to live once the PC answers
  }

  function show(url) {
    clearTimeout(again);
    if (current !== url) {
      current = url;
      frame.src = url + '/';
    }
    misses = 0;
    state.hidden = true;
    frame.hidden = false;
  }

  // While the dashboard is showing, check once a minute that it still answers;
  // after two misses the monitor has probably restarted, so look it up again.
  setInterval(async function () {
    if (!current || frame.hidden || document.hidden || current.indexOf('offline/') === 0) return;
    if (await answers(current)) {
      misses = 0;
      return;
    }
    misses += 1;
    if (misses >= 2) {
      current = null;
      find();
    }
  }, 60000);

  retry.addEventListener('click', find);
  if (!GIST) say('This page is not set up yet.', true);
  else find();
})();
