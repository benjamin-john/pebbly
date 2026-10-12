// Pebbly: shared documents for the Plan apps that many people edit (Split the Bill, Sign-up Sheet,
// Shared List). See supabase/migrations/20261013000000_new_apps.sql (doc_*).
//
// A document is one JSON object with a version number. Anyone with the link can change it; a change
// is pushed as the whole object along with the version it started from. If someone else saved first,
// this works out what it changed (a diff against the last copy it had), applies that to the latest
// copy and tries again. Other phones pick changes up every few seconds while the page is open.
//
// Keep lists as objects keyed by id (e.g. items: { "i3k9": {..., order: 2} }), not arrays: two
// people adding or removing at once then merge cleanly. Arrays are fine for small values set as a whole.
//
// Needs /lock.js first (optional passwords). Exposed as window.PebblyDoc:
//   PebblyDoc.create(kind, state)            → Promise<{ code, owner_token }> (host key is remembered)
//   PebblyDoc.open(code, opts)               → Promise<doc | null>  (null: no such document)
//     opts: { kind, el, what, onState(state, info), onStatus(status), onGone(why) }
//     el/what: where and how to show the password screen if it has one (then the promise waits).
//   doc.state()                              → a copy of the current state
//   doc.change(function (s) { ...mutate s... })  → applies locally, calls onState, saves
//   doc.isOwner, doc.code, doc.status ('live' | 'saving' | 'offline'), doc.close(), doc.remove()
//   PebblyDoc.owner(code) / PebblyDoc.setOwner(code, token)   host keys on this phone
//   PebblyDoc.ownerLink(code) / PebblyDoc.takeOwnerFromUrl(code)   "?o=" host links
//   PebblyDoc.id()                           → a short random id for new list entries
//   PebblyDoc.raw                            → plain Supabase call (for PebblyLock.openHost)
(function () {
  'use strict';
  var URL_ = 'https://xujtuijpbwujduuzlwat.supabase.co', KEY_ = 'sb_publishable_bpV96pme2gEyfeelqqDYXA_CpAoj9OZ';
  var POLL_MS = 3000, OWNERS = 'pebbly_doc_owners';

  function raw(fn, args) {
    var headers = { 'Content-Type': 'application/json', apikey: KEY_ };
    if (/^eyJ/.test(KEY_)) headers.Authorization = 'Bearer ' + KEY_;
    return fetch(URL_ + '/rest/v1/rpc/' + fn, { method: 'POST', headers: headers, body: JSON.stringify(args) })
      .then(function (res) {
        return res.text().then(function (t) {
          var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) {}
          if (!res.ok) { var err = new Error((d && (d.message || d.error_description)) || ('http_' + res.status)); err.status = res.status; throw err; }
          return d;
        });
      }, function () { throw new Error('network'); });
  }
  function rpc(fn, args) { return window.PebblyLock ? PebblyLock.call('doc', fn, args, raw) : raw(fn, args); }

  // ------------------------------------------------------------ merge helpers (same as play/sync.js)
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function same(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) { if (a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false; return true; }
    var ka = Object.keys(a), kb = Object.keys(b); if (ka.length !== kb.length) return false;
    for (var j = 0; j < ka.length; j++) { if (!Object.prototype.hasOwnProperty.call(b, ka[j]) || !same(a[ka[j]], b[ka[j]])) return false; }
    return true;
  }
  function diff(a, b, path, ops) {
    path = path || []; ops = ops || [];
    if (same(a, b)) return ops;
    if (isObj(a) && isObj(b)) {
      Object.keys(b).forEach(function (k) { diff(a[k], b[k], path.concat(k), ops); });
      Object.keys(a).forEach(function (k) { if (!(k in b)) ops.push({ p: path.concat(k), d: true }); });
    } else ops.push({ p: path, v: b });                    // arrays and values are replaced whole
    return ops;
  }
  function apply(target, ops) {
    ops.forEach(function (op) {
      if (!op.p.length) { if (op.v !== undefined) target = clone(op.v); return; }
      var node = target;
      for (var i = 0; i < op.p.length - 1; i++) {
        var k = op.p[i];
        if (!isObj(node[k])) { if (op.d) return; node[k] = {}; }   // deleting inside something already gone
        node = node[k];
      }
      var last = op.p[op.p.length - 1];
      if (op.d) delete node[last]; else node[last] = clone(op.v);
    });
    return target;
  }

  // ------------------------------------------------------------ host keys
  function owners() { try { return JSON.parse(localStorage.getItem(OWNERS)) || {}; } catch (e) { return {}; } }
  function owner(code) { return owners()[String(code || '').toLowerCase()] || null; }
  function setOwner(code, tok) {
    var o = owners(); code = String(code || '').toLowerCase();
    if (tok) o[code] = tok; else delete o[code];
    try { localStorage.setItem(OWNERS, JSON.stringify(o)); } catch (e) {}
  }
  function ownerLink(code) {
    var u = new URL(location.href); u.search = '?d=' + code + '&o=' + encodeURIComponent(owner(code) || ''); u.hash = '';
    return u.toString();
  }
  function takeOwnerFromUrl(code) {
    var q = new URLSearchParams(location.search), tok = q.get('o');
    if (!tok) return;
    setOwner(code, tok.trim());
    q.delete('o');
    try { history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : '') + location.hash); } catch (e) {}
  }
  function id() { return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }

  function create(kind, state) {
    return raw('doc_create', { p_kind: kind, p_state: state }).then(function (r) { setOwner(r.code, r.owner_token); return r; });
  }

  // ------------------------------------------------------------ an open document
  function open(code, opts) {
    code = String(code || '').trim().toLowerCase();
    var tok = owner(code);
    return new Promise(function (resolve, reject) {
      var triedOwner = false;
      function first() {
        rpc('doc_get', { p_code: code, p_owner_token: tok, p_since: 0 }).then(function (r) {
          if (!r) { resolve(null); return; }
          if (opts.kind && r.kind !== opts.kind) { resolve(null); return; }
          resolve(start(code, tok, r, opts));
        }, function (e) {
          if (e.message === 'password_required' && tok && window.PebblyLock && !triedOwner) {
            triedOwner = true;                                     // the host's phone fetches the key itself
            PebblyLock.ownerKey('doc', code, tok, raw).then(function (ok) { if (ok) first(); else fail(e); });
            return;
          }
          fail(e);
        });
      }
      function fail(e) {
        if (window.PebblyLock && opts.el && PebblyLock.handle(e, { app: 'doc', code: code, owner: null, raw: raw, el: opts.el,
          what: opts.what || 'list', retry: first })) return;
        reject(e);
      }
      first();
    });
  }

  function start(code, tok, r, opts) {
    var D = { code: code, isOwner: !!r.is_owner, status: 'live', closed: false };
    var base = clone(r.state), ver = r.version, local = clone(r.state), inflight = false, again = false, tries = 0, timer;
    function status(st) { if (D.status !== st) { D.status = st; if (opts.onStatus) opts.onStatus(st); } }
    function show(info) { if (opts.onState) opts.onState(clone(local), info || {}); }
    function gone(why) { D.close(); if (opts.onGone) opts.onGone(why); }

    function poll() {
      if (D.closed || inflight) return;
      rpc('doc_get', { p_code: code, p_owner_token: tok, p_since: ver }).then(function (g) {
        if (D.closed || inflight) return;
        if (!g) { gone('doc_not_found'); return; }
        status('live');
        if (g.state && g.version > ver) {
          var mine = diff(base, local);
          base = clone(g.state); ver = g.version;
          local = apply(clone(g.state), mine);
          show({ remote: true });
          if (mine.length) push();
        }
      }, function (e) {
        if (D.closed) return;
        if (e.message === 'password_required') { relock(); return; }
        status('offline');
      });
    }
    function push() {
      if (D.closed) return;
      if (inflight) { again = true; return; }
      inflight = true; status('saving'); send();
    }
    function send() {
      var state = clone(local);
      if (same(state, base)) { inflight = false; status('live'); return; }
      rpc('doc_push', { p_code: code, p_expected: ver, p_state: state }).then(function (res) {
        if (D.closed) return;
        if (!res.ok) {
          if (++tries > 8) { tries = 0; inflight = false; status('offline'); return; }
          var mine = diff(base, local);                      // everything this phone changed, sent or not
          base = clone(res.state); ver = res.version;
          local = apply(clone(res.state), mine);
          show({ remote: true, merged: true });
          return send();
        }
        tries = 0; base = state; ver = res.version;
        if (again || !same(local, base)) { again = false; return send(); }
        inflight = false; status('live');
      }, function (e) {
        if (D.closed) return;
        inflight = false;
        if (e.message === 'password_required') { relock(); return; }
        if (e.message === 'doc_not_found') { gone(e.message); return; }
        status('offline');
        setTimeout(function () { if (!D.closed) push(); }, 3000);
      });
    }
    // A password was added while this was open: the host's phone fetches the new key and carries on;
    // anyone else is told (onGone('password_required')) and enters it after reloading.
    var relocking = false;
    function relock() {
      if (relocking) return;
      relocking = true;
      var ok = window.PebblyLock && tok ? PebblyLock.ownerKey('doc', code, tok, raw) : Promise.resolve(false);
      ok.then(function (has) { relocking = false; if (!has) { gone('password_required'); return; } if (D.closed) return; push(); poll(); });
    }
    function onVis() { if (document.visibilityState === 'visible') poll(); }

    D.state = function () { return clone(local); };
    D.change = function (fn) { var s = clone(local); var out = fn(s); local = out === undefined ? s : out; show({ local: true }); push(); };
    D.close = function () { D.closed = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
    D.remove = function () { return raw('doc_delete', { p_code: code, p_owner_token: tok }).then(function () { setOwner(code, null); D.close(); }); };
    timer = setInterval(function () { if (document.visibilityState === 'visible') poll(); }, POLL_MS);
    document.addEventListener('visibilitychange', onVis);
    setTimeout(function () { show({ first: true }); }, 0);
    return D;
  }

  var MSG = {
    doc_not_found: 'This link doesn’t work anymore. It may have been deleted.',
    invalid_state: 'That’s too much to save in one list. Try removing some entries.',
    not_owner: 'Only the person who made this can do that.',
    network: 'Couldn’t reach the server. Check your connection and try again.'
  };
  function message(e) {
    var m = (e && e.message) || e || '';
    return (window.PebblyLock && PebblyLock.message(m)) || MSG[m] || 'Something went wrong. Please try again.';
  }

  window.PebblyDoc = { create: create, open: open, owner: owner, setOwner: setOwner, ownerLink: ownerLink,
    takeOwnerFromUrl: takeOwnerFromUrl, id: id, raw: raw, message: message, clone: clone, same: same };
})();
