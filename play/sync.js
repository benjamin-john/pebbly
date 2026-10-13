// Pebbly: play together.
// Shares one game between phones through Supabase (see play.sql). Each game is a JSON document
// with a version number. A phone pushes its whole game after every change; if someone else got
// there first, it works out what it changed (a diff against the last copy it had), applies that
// on top of the latest copy and tries again. Other phones pick changes up every ~1.5 seconds.
//
// The app supplies: getState(), applyRemote(state, info), and optionally onMembers/onGone.
// Everything is exposed as window.PebblySync.
(function () {
  'use strict';
  var URL_ = 'https://xujtuijpbwujduuzlwat.supabase.co', KEY_ = 'sb_publishable_bpV96pme2gEyfeelqqDYXA_CpAoj9OZ';
  if (window.PEBBLY_SYNC_CONFIG) { URL_ = window.PEBBLY_SYNC_CONFIG.url; KEY_ = window.PEBBLY_SYNC_CONFIG.key; }
  var KINDS = { qwixx: 'Kwiks', farkle: 'Farkle', score: 'Score Keeper', darts: 'Darts', namegame: 'Name Game', trivia: 'Trivia', bracket: 'Bracket',
               dots: 'Dots and Boxes', gomoku: 'Gomoku', mancala: 'Mancala' };
  // Web folder for each kind (internal names stay the same so saved and shared games keep working).
  var PATHS = { qwixx: 'kwiks' };
  function pathOf(kind) { return PATHS[kind] || kind; }
  var POLL_MS = 1500;

  function rpc(fn, args) {
    var headers = { 'Content-Type': 'application/json', apikey: KEY_ };
    if (/^eyJ/.test(KEY_)) headers.Authorization = 'Bearer ' + KEY_;
    return fetch(URL_.replace(/\/+$/, '') + '/rest/v1/rpc/' + fn, { method: 'POST', headers: headers, body: JSON.stringify(args) })
      .then(function (res) {
        return res.text().then(function (t) {
          var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) {}
          if (!res.ok) { var err = new Error((d && (d.message || d.error_description)) || ('http_' + res.status)); err.status = res.status; throw err; }
          return d;
        });
      }, function () { throw new Error('network'); });
  }
  function friendly(e) {
    var m = (e && e.message) || '';
    if (m === 'network') return 'Couldn’t reach the server. Check your connection.';
    if (m === 'game_not_found') return 'No game with that code. Check it and try again.';
    if (m === 'game_full') return 'That game is full.';
    if (m === 'invalid_kind') return 'Playing this game together isn’t ready yet. Try again in a few minutes.';
    if (/find the function|schema cache|does not exist/i.test(m)) return 'Playing together isn’t set up yet: run play/play.sql in Supabase.';
    return 'Something went wrong (' + m + ').';
  }

  // ---------------------------------------------------------------- JSON helpers
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  // Deep equality that ignores key order (the database stores object keys in its own order).
  function same(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) { if (a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false; return true; }
    var ka = Object.keys(a), kb = Object.keys(b); if (ka.length !== kb.length) return false;
    for (var j = 0; j < ka.length; j++) { if (!Object.prototype.hasOwnProperty.call(b, ka[j]) || !same(a[ka[j]], b[ka[j]])) return false; }
    return true;
  }
  // List of changes that turn a into b: {p:path, v:value} | {p:path, d:true} | {p:path, len:n}
  function diff(a, b, path, ops) {
    path = path || []; ops = ops || [];
    if (same(a, b)) return ops;
    if (isObj(a) && isObj(b)) {
      Object.keys(b).forEach(function (k) { diff(a[k], b[k], path.concat(k), ops); });
      Object.keys(a).forEach(function (k) { if (!(k in b)) ops.push({ p: path.concat(k), d: true }); });
    } else if (Array.isArray(a) && Array.isArray(b)) {
      var n = Math.min(a.length, b.length);
      for (var i = 0; i < n; i++) diff(a[i], b[i], path.concat(i), ops);
      for (var j = n; j < b.length; j++) ops.push({ p: path.concat(j), v: b[j], add: true });
      if (b.length < a.length) ops.push({ p: path, len: b.length });
    } else ops.push({ p: path, v: b });
    return ops;
  }
  function mergeInto(t, v) { Object.keys(v).forEach(function (k) { if (isObj(t[k]) && isObj(v[k])) mergeInto(t[k], v[k]); else t[k] = clone(v[k]); }); }
  function apply(target, ops) {
    ops.forEach(function (op) {
      if (!op.p.length) { if (op.v !== undefined) target = clone(op.v); return; }
      var node = target;
      for (var i = 0; i < op.p.length - 1; i++) {
        var k = op.p[i];
        if (node[k] === null || typeof node[k] !== 'object') node[k] = typeof op.p[i + 1] === 'number' ? [] : {};
        node = node[k];
      }
      var last = op.p[op.p.length - 1];
      if (op.d) { if (Array.isArray(node)) node.splice(last, 1); else delete node[last]; }
      else if (op.len != null) { if (Array.isArray(node[last]) && node[last].length > op.len) node[last].length = op.len; }
      else if (isObj(node[last]) && isObj(op.v)) mergeInto(node[last], op.v);   // both sides added to the same spot
      else if (op.add && Array.isArray(node) && node[last] !== undefined && !same(node[last], op.v)) node.push(clone(op.v));  // both appended: keep both
      else node[last] = clone(op.v);
    });
    return target;
  }

  // ---------------------------------------------------------------- session
  function skey(kind) { return 'pebbly_play_' + kind; }
  function getSession(kind) { try { return JSON.parse(localStorage.getItem(skey(kind))); } catch (e) { return null; } }
  function setSession(kind, s) { try { if (s) localStorage.setItem(skey(kind), JSON.stringify(s)); else localStorage.removeItem(skey(kind)); } catch (e) {} }
  function newId() { return 'm' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

  var S = null;   // the live connection: { kind, code, me, token, host, name, h, base, ver, members, inflight, again, own, status, timer }

  function create(kind, me, name, state) {
    return rpc('play_create', { p_kind: kind, p_member: me, p_name: name, p_state: state }).then(function (r) {
      var sess = { code: r.code, me: me, token: r.token, host: true, name: name };
      setSession(kind, sess);
      return { session: sess, version: r.version };
    });
  }
  function peek(code) { return rpc('play_get', { p_code: code, p_since: 0 }); }
  function join(kind, code, me, name) {
    return rpc('play_join', { p_code: code, p_member: me, p_name: name }).then(function (r) {
      var sess = { code: code.toUpperCase(), me: me, token: r.token, host: false, name: name };
      setSession(kind, sess);
      return { session: sess, state: r.state, version: r.version, members: r.members };
    });
  }

  // Start syncing. base/version: the copy we already have from the server (after create/join).
  function attach(kind, handlers, base, version) {
    stop();
    var sess = getSession(kind); if (!sess) return null;
    S = { kind: kind, code: sess.code, me: sess.me, token: sess.token, host: sess.host, name: sess.name, h: handlers,
          base: base != null ? clone(base) : null, ver: version || 0, members: [{ id: sess.me, name: sess.name }], inflight: false, again: false, own: {}, status: 'live', tries: 0 };
    if (S.base == null) poll(true); else { poll(); }
    S.timer = setInterval(function () { if (document.visibilityState === 'visible') poll(); }, POLL_MS);
    document.addEventListener('visibilitychange', onVis);
    renderBadge();
    return S;
  }
  function onVis() { if (S && document.visibilityState === 'visible') poll(); }
  function stop() { if (S && S.timer) clearInterval(S.timer); document.removeEventListener('visibilitychange', onVis); S = null; renderBadge(); }
  function setStatus(st) { if (S && S.status !== st) { S.status = st; renderBadge(); } }

  function poll(first) {
    if (!S || S.inflight) return;
    var s = S;
    rpc('play_get', { p_code: s.code, p_since: first ? 0 : s.ver }).then(function (r) {
      if (S !== s) return;
      if (!r) { gone(); return; }
      setStatus('live');
      if (!same(r.members, s.members)) { s.members = r.members || []; if (s.h.onMembers) s.h.onMembers(s.members); renderBadge(); }
      if (r.state && r.version > s.ver) {
        var mine = s.base != null ? diff(s.base, s.h.getState()) : [];
        var merged = apply(clone(r.state), mine);
        var foreign = !s.own[r.version];
        s.base = clone(r.state); s.ver = r.version;
        s.h.applyRemote(merged, { foreign: foreign });
        if (mine.length) push();
      }
    }, function (e) { if (S === s) setStatus('offline'); });
  }
  function push() {
    if (!S) return;
    if (S.inflight) { S.again = true; return; }
    S.inflight = true; send(S);
  }
  function send(s) {
    var state = clone(s.h.getState());
    if (s.base != null && same(state, s.base)) { s.inflight = false; return; }
    rpc('play_push', { p_code: s.code, p_member: s.me, p_token: s.token, p_expected: s.ver, p_state: state }).then(function (r) {
      if (S !== s) return;
      setStatus('live');
      if (r.conflict) {
        if (++s.tries > 8) { s.tries = 0; s.inflight = false; return; }
        var mine = diff(s.base, state), merged = apply(clone(r.state), mine);
        s.base = clone(r.state); s.ver = r.version;
        s.h.applyRemote(merged, { foreign: true, merged: true });
        return send(s);
      }
      s.tries = 0; s.base = state; s.ver = r.version; s.own[r.version] = true;
      if (s.again) { s.again = false; return send(s); }
      if (!same(s.h.getState(), s.base)) return send(s);
      s.inflight = false;
    }, function (e) {
      if (S !== s) return;
      s.inflight = false;
      if (e.message === 'game_not_found' || e.message === 'not_member') { gone(e.message); return; }
      setStatus('offline');
      setTimeout(function () { if (S === s) push(); }, 3000);
    });
  }
  function gone(why) {
    var s = S; if (!s) return;
    setSession(s.kind, null); stop();
    if (s.h.onGone) s.h.onGone(why || 'game_not_found');
  }
  function leave() {
    var s = S; if (!s) return Promise.resolve();
    setSession(s.kind, null); stop();
    return rpc('play_leave', { p_code: s.code, p_member: s.me, p_token: s.token }).catch(function () {});
  }

  // Can this phone act for player pid? Players without a phone of their own can be played by anyone.
  function canAct(pid) {
    if (!S) return true;
    return pid === S.me || !S.members.some(function (m) { return m.id === pid; });
  }
  function hasPhone(pid) { return !!S && S.members.some(function (m) { return m.id === pid; }); }

  // ---------------------------------------------------------------- UI (styles use each app's CSS variables)
  var css = document.createElement('style');
  css.textContent =
    '.ps-card{margin-bottom:12px}' +
    '.ps-modes{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
    '.ps-mode{display:flex;flex-direction:column;align-items:center;gap:4px;padding:12px 8px;border:1px solid var(--line);border-radius:14px;cursor:pointer;text-align:center;background:var(--surface);color:var(--ink);font:inherit}' +
    '.ps-mode b{font-size:16px}.ps-mode small{color:var(--muted);font-size:13px;line-height:1.3}' +
    '.ps-mode[aria-pressed="true"]{border:2px solid var(--brand);background:var(--brand-t,var(--surface))}' +
    '.ps-me{margin-top:12px}.ps-me label{display:block;font-weight:600;margin-bottom:6px}' +
    '.ps-me select,.ps-in{width:100%;min-height:48px;padding:10px 12px;border:1px solid var(--field,var(--line));border-radius:10px;background:var(--surface);color:var(--ink);font:500 17px/1.2 var(--body,inherit)}' +
    '.ps-hint{color:var(--muted);font-size:14px;margin:8px 0 0}' +
    '.ps-join{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:48px;margin:0 0 12px;border:1.5px dashed var(--brand);border-radius:12px;background:transparent;color:var(--brand);font:600 16px/1 var(--body,inherit);cursor:pointer}' +
    '.ps-badge{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:0 12px;margin:0 0 10px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--ink);font:600 14px/1 var(--body,inherit);cursor:pointer}' +
    '.ps-badge i{width:9px;height:9px;border-radius:50%;background:#2E9B5A;flex:none}.ps-badge i.off{background:#CC423D}' +
    '.ps-badge code{font:800 15px/1 var(--head,inherit);letter-spacing:.08em}' +
    '.ps-dlg{width:min(480px,calc(100% - 24px));padding:0;border:0;border-radius:18px;background:var(--bg);color:var(--ink);box-shadow:0 20px 60px rgba(0,0,0,.35)}' +
    '.ps-dlg::backdrop{background:rgba(10,20,16,.55)}' +
    '.ps-body{padding:16px}.ps-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}.ps-head h3{flex:1;margin:0;font:800 22px/1.2 var(--head,inherit)}' +
    '.ps-x{width:44px;height:44px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--ink);font-size:18px;cursor:pointer}' +
    '.ps-code{font:800 44px/1 var(--head,inherit);letter-spacing:.14em;text-align:center;margin:8px 0 4px}' +
    '.ps-btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:50px;margin-top:10px;border:0;border-radius:12px;background:var(--brand);color:var(--brand-ink);font:600 16px/1.2 var(--body,inherit);cursor:pointer}' +
    '.ps-btn.ghost{background:transparent;color:var(--brand);border:1.5px solid var(--brand)}.ps-btn.plain{background:var(--surface);color:var(--ink);border:1px solid var(--line)}' +
    '.ps-btn.danger{background:transparent;color:#CC423D;border:1.5px solid #CC423D}.ps-btn:disabled{opacity:.45}' +
    '.ps-list{list-style:none;margin:10px 0 0;padding:0}.ps-list li{padding:8px 2px;border-bottom:1px solid var(--line)}' +
    '.ps-err{color:#CC423D;min-height:1.3em;margin:8px 0 0;font-size:15px}' +
    '.ps-codein{text-transform:uppercase;letter-spacing:.2em;text-align:center;font:800 28px/1 var(--head,inherit) !important}' +
    '.ps-wait{padding:12px;border-radius:12px;background:var(--lead-t,var(--surface));font-weight:600;text-align:center}' +
    '.ps-wait button{margin-top:8px;border:0;background:none;color:var(--brand);font:600 15px/1 var(--body,inherit);cursor:pointer;padding:6px}';
  document.head.appendChild(css);

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function dialog(html) {
    var d = document.createElement('dialog'); d.className = 'ps-dlg'; d.innerHTML = '<div class="ps-body">' + html + '</div>';
    document.body.appendChild(d);
    d.addEventListener('close', function () { d.remove(); });
    d.addEventListener('click', function (e) { if (e.target === d || e.target.closest('[data-ps-close]')) d.close(); });
    d.showModal(); return d;
  }
  function closeBtn() { return '<button type="button" class="ps-x" data-ps-close aria-label="Close">✕</button>'; }

  // "Play on: this phone / everyone's phones" box for setup screens.
  // opts.names(): current player names (to pick "which one are you"), or null if not needed.
  function setupBox(el, kind, opts) {
    opts = opts || {};
    var st = { shared: false, me: 0 };
    function draw() {
      var names = opts.names ? opts.names() : null;
      if (st.me >= (names || []).length) st.me = 0;
      el.innerHTML = '<section class="card ps-card"><h2>Play on</h2><div class="ps-modes">' +
        '<button type="button" class="ps-mode" data-m="0" aria-pressed="' + !st.shared + '"><b>📱 This phone</b><small>Pass it around, or one person keeps score</small></button>' +
        '<button type="button" class="ps-mode" data-m="1" aria-pressed="' + st.shared + '"><b>👥 Everyone’s phones</b><small>Get a code; others join and play along on their own phones</small></button></div>' +
        (st.shared && names ? (names.length
          ? '<div class="ps-me"><label for="psMe">Which player are you?</label><select id="psMe">' +
              names.map(function (n, i) { return '<option value="' + i + '"' + (i === st.me ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') + '</select></div>' +
            '<p class="ps-hint">Players with their own phone join with the code after you start. Anyone you list here without a phone can be played from any phone.</p>'
          : '<p class="ps-hint">Add yourself as a player. Others join with the code after you start.</p>') : '') +
        (st.shared && !names ? '<p class="ps-hint">You’re the host. Others join with the code after you start.</p>' : '') +
        '</section>';
    }
    el.addEventListener('click', function (e) {
      var b = e.target.closest('.ps-mode'); if (!b) return;
      st.shared = b.dataset.m === '1'; draw(); if (opts.onChange) opts.onChange();
    });
    el.addEventListener('change', function (e) { if (e.target.id === 'psMe') st.me = +e.target.value; });
    draw();
    return { redraw: draw, shared: function () { return st.shared; }, meIndex: function () { return st.me; },
             set: function (shared) { st.shared = !!shared; draw(); } };
  }

  // "Join a game" button + dialog. opts.players(state) → [{id,name}] (or omit for apps without players).
  // opts.onJoined({state, version, me, name, isNew}) is called after joining.
  function joinButton(el, kind, opts) {
    el.innerHTML = '<button type="button" class="ps-join">👥 Join a game with a code</button>';
    el.firstChild.addEventListener('click', function () { openJoin(kind, opts); });
  }
  function openJoin(kind, opts, code) {
    var d = dialog('<div class="ps-head"><h3>Join a game</h3>' + closeBtn() + '</div>' +
      '<p class="ps-hint" style="margin:0 0 10px">Ask the host for the 5-letter code on their screen.</p>' +
      '<input class="ps-in ps-codein" id="psCode" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CODE" value="' + esc(code || '') + '">' +
      '<p class="ps-err" id="psErr"></p><button type="button" class="ps-btn" id="psNext">Next</button>');
    var inp = d.querySelector('#psCode');
    inp.addEventListener('input', function () { inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    function next() {
      var c = inp.value.trim().toUpperCase(), err = d.querySelector('#psErr');
      if (c.length !== 5) { err.textContent = 'Codes are 5 characters.'; return; }
      err.textContent = 'Looking…';
      peek(c).then(function (r) {
        if (!r) { err.textContent = friendly({ message: 'game_not_found' }); return; }
        if (r.kind !== kind) {
          err.innerHTML = 'That code is for a ' + esc(KINDS[r.kind] || r.kind) + ' game. <a href="/' + esc(pathOf(r.kind)) + '/?join=' + esc(c) + '">Open it there</a>.'; return;
        }
        d.close(); pickWho(kind, opts, c, r);
      }, function (e) { err.textContent = friendly(e); });
    }
    d.querySelector('#psNext').addEventListener('click', next);
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') next(); });
    setTimeout(function () { inp.focus(); if (code) next(); }, 50);
  }
  function pickWho(kind, opts, code, r) {
    var players = opts.players ? opts.players(r.state) : [];
    var onPhone = {}; (r.members || []).forEach(function (m) { onPhone[m.id] = true; });
    var mem = []; try { mem = (JSON.parse(localStorage.getItem('pebbly_score_memory')) || {}).players || []; } catch (e) {}
    var d = dialog('<div class="ps-head"><h3>Who are you?</h3>' + closeBtn() + '</div>' +
      (players.length ? '<p class="ps-hint" style="margin:0">Already in the game:</p><div>' + players.map(function (p) {
        return '<button type="button" class="ps-btn ' + (onPhone[p.id] ? 'plain' : 'ghost') + '" data-claim="' + esc(p.id) + '" data-name="' + esc(p.name) + '">' +
          'I’m ' + esc(p.name) + (onPhone[p.id] ? ' (move to this phone)' : '') + '</button>';
      }).join('') + '</div><p class="ps-hint" style="margin-top:14px">Or join as someone new:</p>' : '') +
      '<input class="ps-in" id="psName" maxlength="16" placeholder="Your name" list="psNames" autocomplete="off">' +
      '<datalist id="psNames">' + mem.slice(0, 20).map(function (n) { return '<option value="' + esc(n) + '">'; }).join('') + '</datalist>' +
      '<p class="ps-err" id="psErr2"></p><button type="button" class="ps-btn" id="psJoinGo">Join</button>');
    function go(me, name, isNew) {
      var err = d.querySelector('#psErr2'); err.textContent = 'Joining…';
      join(kind, code, me, name).then(function (res) {
        d.close();
        try { var m = JSON.parse(localStorage.getItem('pebbly_score_memory')) || { players: [], games: [] };
          m.players = [name].concat((m.players || []).filter(function (x) { return x.toLowerCase() !== name.toLowerCase(); })).slice(0, 40);
          localStorage.setItem('pebbly_score_memory', JSON.stringify(m)); } catch (e) {}
        opts.onJoined({ state: res.state, version: res.version, me: me, name: name, isNew: isNew, members: res.members });
      }, function (e) { err.textContent = friendly(e); });
    }
    d.addEventListener('click', function (e) {
      var c = e.target.closest('[data-claim]'); if (c) go(c.dataset.claim, c.dataset.name, false);
    });
    d.querySelector("#psJoinGo").addEventListener('click', function () {
      var n = d.querySelector('#psName').value.trim().replace(/\s+/g, ' ');
      if (!n) { d.querySelector('#psErr2').textContent = 'Type your name.'; return; }
      var taken = players.filter(function (p) { return p.name.toLowerCase() === n.toLowerCase(); })[0];
      if (taken) go(taken.id, taken.name, false); else go(newId(), n, true);
    });
  }

  // Code chip for the play screen. Tapping it shows the code, join link, who's connected, and Leave.
  var badgeEl = null, badgeOpts = null;
  function badge(el, opts) { badgeEl = el; badgeOpts = opts || {}; renderBadge(); }
  function renderBadge() {
    if (!badgeEl) return;
    if (!S) { badgeEl.innerHTML = ''; badgeEl.hidden = true; return; }
    badgeEl.hidden = false;
    var n = S.members.length || 1;
    badgeEl.innerHTML = '<button type="button" class="ps-badge" aria-label="Shared game ' + esc(S.code) + ', ' + n + ' phones. Show code"><i class="' +
      (S.status === 'live' ? '' : 'off') + '"></i>👥 <code>' + esc(S.code) + '</code> · ' + n + (n === 1 ? ' phone' : ' phones') + (S.status === 'live' ? '' : ' · reconnecting') + '</button>';
    badgeEl.firstChild.onclick = showCode;
  }
  function joinUrl() { return location.origin + '/' + pathOf(S.kind) + '/?join=' + S.code; }
  function showCode() {
    if (!S) return;
    var d = dialog('<div class="ps-head"><h3>Playing together</h3>' + closeBtn() + '</div>' +
      '<p class="ps-hint" style="margin:0;text-align:center">Others open ' + esc(KINDS[S.kind]) + ' in Pebbly, tap “Join a game”, and enter:</p>' +
      '<div class="ps-code">' + esc(S.code) + '</div>' +
      '<button type="button" class="ps-btn ghost" id="psShare">' + (navigator.share ? 'Share join link' : 'Copy join link') + '</button>' +
      '<p class="ps-hint" style="margin-top:14px">On their own phones:</p><ul class="ps-list">' +
      S.members.map(function (m) { return '<li>' + esc(m.name) + (m.id === S.me ? ' (this phone)' : '') + '</li>'; }).join('') + '</ul>' +
      '<button type="button" class="ps-btn danger" id="psLeave">Leave shared game</button>');
    d.querySelector('#psShare').addEventListener('click', function () {
      var url = joinUrl();
      if (navigator.share) navigator.share({ title: 'Join my ' + KINDS[S.kind] + ' game', text: 'Join my ' + KINDS[S.kind] + ' game in Pebbly: code ' + S.code, url: url }).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { d.querySelector('#psShare').textContent = 'Link copied'; });
    });
    d.querySelector('#psLeave').addEventListener('click', function () {
      if (!confirm('Leave this shared game on this phone? The others can keep playing.')) return;
      d.close(); leave().then(function () { if (badgeOpts && badgeOpts.onLeave) badgeOpts.onLeave(); });
    });
  }

  // ?join=CODE in the address (from a shared link): returns the code once and tidies the address.
  function pendingJoin() {
    var m = /[?&]join=([A-Za-z0-9]{5})/.exec(location.search); if (!m) return null;
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    return m[1].toUpperCase();
  }

  // One-call setup for a game page.
  // cfg: { setupEl, joinEl, badgeEl, names(): draft names for "which player are you" (or omit),
  //        getGame(), setGame(g) (store it locally), render(), clearUndo(), showPlay(),
  //        players(g) → [{id,name}] (omit if the game has no player list), addPlayer(g, id, name),
  //        onRemote(prev, next) (optional, after a change from another phone), onLeave() }
  function wire(kind, cfg) {
    var handlers = {
      getState: cfg.getGame,
      applyRemote: function (next, info) {
        var prev = cfg.getGame(); cfg.setGame(next);
        if (info.foreign && cfg.clearUndo) cfg.clearUndo();
        cfg.render(); if (cfg.onRemote) cfg.onRemote(prev, next);
      },
      onMembers: function () { cfg.render(); },
      onGone: function () { alert('This shared game has ended or expired. You can keep playing on this phone.'); cfg.render(); }
    };
    var box = cfg.setupEl ? setupBox(cfg.setupEl, kind, { names: cfg.names }) : null;
    if (cfg.joinEl) joinButton(cfg.joinEl, kind, { players: cfg.players, onJoined: joined });
    if (cfg.badgeEl) badge(cfg.badgeEl, { onLeave: function () { cfg.render(); if (cfg.onLeave) cfg.onLeave(); } });
    function joined(r) {
      var g = clone(r.state);
      if (r.isNew && cfg.addPlayer) cfg.addPlayer(g, r.me, r.name);
      cfg.setGame(g); if (cfg.clearUndo) cfg.clearUndo();
      attach(kind, handlers, r.state, r.version);
      cfg.showPlay(); push();
    }
    // Reconnect after a reload, and open join links.
    if (getSession(kind) && cfg.getGame()) attach(kind, handlers);
    var code = pendingJoin(); if (code) setTimeout(function () { openJoin(kind, { players: cfg.players, onJoined: joined }, code); }, 50);
    return {
      box: box,
      shared: function () { return !!box && box.shared(); },
      // Call right after a new game was set up locally. me: this phone's player {id,name} (or null).
      started: function (me) {
        var wantShared = box && box.shared();
        var old = getSession(kind);
        var go = function () {
          if (!wantShared) { cfg.render(); return; }
          var id = me && me.id || newId(), name = me && me.name || 'Host';
          create(kind, id, name, cfg.getGame()).then(function (r) {
            attach(kind, handlers, cfg.getGame(), r.version); cfg.render(); showCode();
          }, function (e) { alert(friendly(e) + ' Playing on this phone only.'); });
        };
        if (S) leave().then(go); else { if (old) setSession(kind, null); go(); }
      },
      push: function () { if (S) push(); }
    };
  }

  window.PebblySync = {
    wire: wire,
    create: create, join: join, attach: attach, push: push, stop: stop, leave: leave,
    session: getSession, active: function () { return !!S; }, me: function () { return S ? S.me : null; },
    isHost: function () { return !!S && S.host; }, code: function () { return S ? S.code : null; },
    members: function () { return S ? S.members : []; }, canAct: canAct, hasPhone: hasPhone,
    setupBox: setupBox, joinButton: joinButton, openJoin: openJoin, badge: badge, showCode: showCode, pendingJoin: pendingJoin,
    newId: newId, friendly: friendly, _diff: diff, _apply: apply
  };
})();
