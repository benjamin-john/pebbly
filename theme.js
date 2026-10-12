// Light/dark choice from the switch at the bottom of the homepage. "light" or "dark" overrides the
// phone's setting; nothing saved means follow the phone. Load first in <head> so there's no flash.
// Pages style the override with :root[data-theme=dark] (see CLAUDE.md → Design conventions).
(function () {
  function apply() {
    var t = null;
    try { t = localStorage.getItem('pebbly_theme'); } catch (e) {}
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  apply();
  addEventListener('pageshow', apply);   // coming back with the Back button
  addEventListener('storage', function (e) { if (e.key === 'pebbly_theme') apply(); });
  window.pebblyTheme = {
    get: function () { try { return localStorage.getItem('pebbly_theme') || 'auto'; } catch (e) { return 'auto'; } },
    set: function (t) { try { if (t === 'light' || t === 'dark') localStorage.setItem('pebbly_theme', t); else localStorage.removeItem('pebbly_theme'); } catch (e) {} apply(); }
  };
})();
