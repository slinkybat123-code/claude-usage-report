/* Runs before the page draws.
   ?app=1          the Android app's Full view: the whole dashboard in a dense phone layout (html.app).
   #cloud=<url>    the offline dashboard: the last copy your PC saved to your gist, for when the PC
                   is off or asleep (html[data-offline]). Only gist addresses are accepted. */
(function () {
  'use strict';
  try {
    var q = new URLSearchParams(location.search);
    if (q.get('app') === '1') {
      document.documentElement.classList.add('app');
      // Keep the phone layout when moving between the dashboard and All your AIs.
      document.addEventListener('DOMContentLoaded', function () {
        var link = document.getElementById('ai-link');
        if (link) link.href = '/ai?app=1';
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
