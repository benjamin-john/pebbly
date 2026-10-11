// Keeps the screen from going to sleep while a game is on screen.
// Call keepAwake(true) when the game screen shows and keepAwake(false) when it closes.
// The browser drops the lock whenever the app is in the background, so it's asked for
// again each time the page becomes visible. Browsers without the Screen Wake Lock API
// just ignore it.
(function () {
  var want = false, lock = null, asking = false;

  function acquire() {
    if (!want || lock || asking || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    asking = true;
    navigator.wakeLock.request('screen').then(function (l) {
      asking = false; lock = l;
      l.addEventListener('release', function () { lock = null; });
      if (!want) release();
    }, function () { asking = false; });
  }
  function release() { if (lock) { lock.release().catch(function () {}); lock = null; } }

  document.addEventListener('visibilitychange', acquire);
  // Some browsers only grant the lock after the person has tapped something.
  document.addEventListener('pointerdown', acquire, { passive: true });

  window.keepAwake = function (on) { want = !!on; if (want) acquire(); else release(); };
})();
