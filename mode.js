/* Runs before the page draws.
   ?app=1          the Android app's dense phone layout (html.app).
   ?app=2          the same inside the app's bottom tabs (1.6 and later): the app has its own
                   tabs for All your AIs and Friends, and its own Settings (theme, diagnostic
                   report), so the page hides those buttons and uses the app's fonts (html.shell).
                   &theme=light|dark sets the theme the app chose before anything is drawn.
   #cloud=<url>    the offline dashboard: the last copy your PC saved to your gist, for when the PC
                   is off or asleep (html[data-offline]). Only gist addresses are accepted. */
(function () {
  'use strict';
  try {
    var q = new URLSearchParams(location.search);
    var app = q.get('app');
    if (app === '1' || app === '2') {
      var root = document.documentElement;
      root.classList.add('app');
      if (app === '2') {
        root.classList.add('shell');
        var theme = q.get('theme');
        if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
      }
      // Keep the phone layout when moving between the dashboard and All your AIs.
      document.addEventListener('DOMContentLoaded', function () {
        var link = document.getElementById('ai-link');
        if (link) link.href = '/ai?app=' + app;
      });
    }
    var m = /(?:^#|&)cloud=([^&]+)/.exec(location.hash);
    var cloud = m ? decodeURIComponent(m[1]) : '';
    if (/^https:\/\/gist\.githubusercontent\.com\/[A-Za-z0-9-]+\/[0-9a-f]{20,40}\/raw\/$/.test(cloud)) {
      document.documentElement.setAttribute('data-offline', '');
      window.CLOUD_COPY = cloud;
    }
  } catch (e) {
    /* old browser: the normal layout is fine */
  }
})();
