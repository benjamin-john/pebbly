// Adds a slim "← Pebbly" bar to the top of an app, but only when it's running as the
// installed app. In a normal browser tab (e.g. a guest opening an RSVP link) nothing changes.
// Add ?appnav to a URL to preview the bar in a regular tab.
// It also asks the browser to keep Pebbly's saved data (names, games, host links) instead of
// clearing it on its own when space runs low. Chrome and Edge decide silently; Firefox shows a
// prompt, so there it's only asked from the installed app.
(function () {
  var installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  if (navigator.storage && navigator.storage.persist && (installed || !/Firefox\//.test(navigator.userAgent))) {
    navigator.storage.persisted().then(function (p) { if (!p) return navigator.storage.persist(); }).catch(function () {});
  }

  if (!installed && !/[?&]appnav\b/.test(location.search)) return;

  var H = 40;
  var css = document.createElement('style');
  css.textContent =
    '#pebbly-nav{position:fixed;top:0;left:0;right:0;z-index:5;display:flex;align-items:center;' +
    'height:calc(' + H + 'px + env(safe-area-inset-top));padding:env(safe-area-inset-top) 12px 0;' +
    'background:#2f7a63;font:600 15px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '#pebbly-nav a{color:#fff;text-decoration:none;display:flex;align-items:center;gap:6px;' +
    'height:100%;padding:0 6px;-webkit-tap-highlight-color:transparent}' +
    '#pebbly-nav a:active{opacity:.7}';
  document.head.appendChild(css);

  function add() {
    var bar = document.createElement('nav');
    bar.id = 'pebbly-nav';
    bar.innerHTML = '<a href="/" aria-label="Pebbly home"><span aria-hidden="true">←</span> Pebbly</a>';
    document.body.prepend(bar);
    // Push the page down by the bar's height, on top of whatever padding the app already has.
    var pad = parseFloat(getComputedStyle(document.body).paddingTop) || 0;
    document.body.style.paddingTop = 'calc(' + (pad + H) + 'px + env(safe-area-inset-top))';
  }
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})();
