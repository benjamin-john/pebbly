// Brings over what a browser saved on benjamin-john.com (host and organizer keys, "your events",
// who you are, your name) when an old link forwards here. The old page puts it after
// #pebbly-import= in the address; this merges it into this site's storage before the app starts,
// then tidies the address. Nothing already saved here is overwritten.
(function () {
  var m = /#pebbly-import=([^&]+)/.exec(location.hash);
  if (!m) return;
  try {
    var data = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
    Object.keys(data).forEach(function (k) {
      if (!/^(rsvp|pick|meetup)\.[a-z.]+$/.test(k) || /\.local\.db$/.test(k)) return;
      var incoming = data[k], have = localStorage.getItem(k);
      if (have === null) { localStorage.setItem(k, incoming); return; }
      var a = JSON.parse(have), b = JSON.parse(incoming);
      if (/\.owners$/.test(k) && a && b && typeof a === 'object') {
        Object.keys(b).forEach(function (code) { if (!(code in a)) a[code] = b[code]; });   // keys for both sites' events
        localStorage.setItem(k, JSON.stringify(a));
      } else if (/\.recent$/.test(k) && Array.isArray(a) && Array.isArray(b)) {
        var seen = {}, all = a.concat(b).filter(function (e) { var c = e && e.code; if (!c || seen[c]) return false; seen[c] = true; return true; });
        localStorage.setItem(k, JSON.stringify(all.slice(0, 12)));
      }
      // Anything else (who you are, your name) keeps what this site already has.
    });
  } catch (e) {}
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
})();
