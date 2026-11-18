/* Runs before the page draws. ?app=1 is the Android app's Full view: the whole
   dashboard in a dense phone layout (html.app in style.css). */
(function () {
  'use strict';
  try {
    if (new URLSearchParams(location.search).get('app') === '1') document.documentElement.classList.add('app');
  } catch (e) {
    /* old browser: the normal layout is fine */
  }
})();
