// Optional passwords for the Plan apps (RSVP, Poll, Which Day Works?). See
// supabase/migrations/20261012000000_plan_passwords.sql for the database side.
//
// Apps: 'rsvp', 'poll', 'wdw', 'doc' (Split the Bill, Sign-up Sheet, Shared List; doc.js) and 'santa'.
// A guest trades the password for a key once (lock_open); this phone keeps the key in localStorage
// and PebblyLock.call adds it to every guest call (gated_<name>). The host's phone gets the key with
// its host link (lock_owner), so hosts never type the password.
//
// Page hooks (app is 'rsvp', 'poll' or 'wdw'; raw(fn, args) is the page's plain Supabase call):
//   rpc:      return PebblyLock.call(app, fn, args, raw)
//   on load:  if (PebblyLock.handle(err, { app, code, owner, raw, el, what, retry })) return;
//   create:   PebblyLock.fieldHtml(what) in the form; after creating: PebblyLock.afterCreate(app, code, owner, pw, raw)
//   host:     PebblyLock.openHost({ app, code, owner, raw, what })
(function () {
  var GATED = {
    rsvp: ['rsvp_get', 'rsvp_respond', 'rsvp_post', 'rsvp_delete_post', 'rsvp_item_add', 'rsvp_item_edit', 'rsvp_item_remove', 'rsvp_item_claim'],
    poll: ['poll_get', 'poll_vote', 'poll_add_option', 'poll_edit_option', 'poll_remove_option'],
    wdw: ['wdw_get', 'get_event', 'save_response', 'delete_response'],
    doc: ['doc_get', 'doc_push'],
    santa: ['santa_get', 'santa_claim', 'santa_unclaim', 'santa_join', 'santa_set_wish']
  };
  var KEYS = 'pebbly_lock_keys', PWS = 'pebbly_lock_pw', noGate = false;
  var MSG = {
    password_required: 'This now needs a password. Reload the page to enter it.',
    wrong_password: 'That password isn’t right. Check with the person who shared the link.',
    too_many_attempts: 'Too many wrong tries. Wait 15 minutes and try again.',
    password_too_long: 'Keep the password to 100 characters or fewer.',
    not_owner: 'Only the host can change the password.',
    lock_unavailable: 'Passwords aren’t available yet. Try again in a few minutes.',
    network: 'Couldn’t reach the server. Check your connection and try again.'
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function load(name) { try { return JSON.parse(localStorage.getItem(name)) || {}; } catch (e) { return {}; } }
  function save(name, v) { try { localStorage.setItem(name, JSON.stringify(v)); } catch (e) {} }
  function id(app, code) { return app + ':' + String(code || '').trim().toLowerCase(); }
  function key(app, code) { return load(KEYS)[id(app, code)] || null; }
  function setKey(app, code, k) { var all = load(KEYS); if (k) all[id(app, code)] = k; else delete all[id(app, code)]; save(KEYS, all); }
  // The host's own copy of the password, so they can see what to tell guests. Only on the host's phone.
  function hostPw(app, code) { return load(PWS)[id(app, code)] || ''; }
  function setHostPw(app, code, pw) { var all = load(PWS); if (pw) all[id(app, code)] = pw; else delete all[id(app, code)]; save(PWS, all); }
  function missingFn(e) { return !!e && (e.status === 404 || /could not find the function|function .* does not exist/i.test(e.message || '')); }
  function msg(e) { var m = (e && e.message) || e || ''; return MSG[m] || ''; }

  function call(app, fn, args, raw) {
    if (noGate || (GATED[app] || []).indexOf(fn) < 0) return raw(fn, args);
    var a = {}; for (var k in args) a[k] = args[k];
    a.p_key = key(app, args.p_code);
    return raw('gated_' + fn, a).catch(function (e) {
      if (!missingFn(e)) throw e;
      noGate = true;                                   // database not updated yet: use the plain functions
      return raw(fn, args);
    });
  }

  // Calls a lock_* function; resolves with its JSON, rejects with an Error whose message is a code.
  function lockCall(raw, fn, args) {
    return raw(fn, args).then(function (d) {
      if (d && d.error) throw new Error(d.error);
      return d || {};
    }, function (e) { throw new Error(missingFn(e) ? 'lock_unavailable' : (e && e.message) || 'network'); });
  }

  // what: the noun shown to people ('event', 'poll', 'list', 'sheet', 'bill', 'group', …).
  function words(what) { what = what || 'event'; return { a: what, who: what === 'event' ? 'the host' : 'the person who shared it' }; }

  function gate(o) {
    var w = words(o.what);
    o.el.innerHTML = '<div class="pl-gate"><div class="pl-emoji" aria-hidden="true">🔒</div><h1>Password needed</h1>' +
      '<p class="lede">This ' + w.a + ' is password protected. Ask ' + w.who + ' for the password. You’ll only need to enter it once on this phone.</p>' +
      '<form class="pl-form" novalidate><label class="fld"><span>Password</span>' +
      '<input type="text" name="pw" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="100" required></label>' +
      '<p class="err" role="alert"></p><button type="submit" class="btn primary">Open</button></form></div>';
    var form = o.el.querySelector('form'), input = form.elements.pw, err = form.querySelector('.err'), btn = form.querySelector('button');
    input.focus();
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var pw = input.value.trim();
      if (!pw) { err.textContent = 'Enter the password.'; return; }
      btn.disabled = true; err.textContent = '';
      lockCall(o.raw, 'lock_open', { p_app: o.app, p_code: o.code, p_password: pw }).then(function (d) {
        setKey(o.app, o.code, d.key);
        o.retry();
      }, function (e) { btn.disabled = false; err.textContent = msg(e) || MSG.network; input.select(); });
    });
  }

  // Call from a failed load. Returns true if the failure was "needs a password" (and takes it from there).
  function handle(e, o) {
    if (!e || e.message !== 'password_required') return false;
    setKey(o.app, o.code, null);
    if (!o.owner) { gate(o); return true; }
    lockCall(o.raw, 'lock_owner', { p_app: o.app, p_code: o.code, p_owner_token: o.owner }).then(function (d) {
      if (d.key) { setKey(o.app, o.code, d.key); o.retry(); } else gate(o);
    }, function () { gate(o); });
    return true;
  }

  // Host phone: get the key with the host's own key (no typing). Resolves true if this phone now has it.
  function ownerKey(app, code, owner, raw) {
    if (!owner) return Promise.resolve(false);
    return lockCall(raw, 'lock_owner', { p_app: app, p_code: code, p_owner_token: owner }).then(function (d) {
      setKey(app, code, d.key); return !!d.key;
    }, function () { return false; });
  }

  function fieldHtml(what) {
    var w = words(what), verb = /^(bill|list|sheet)$/.test(w.a) ? 'see or change' : 'see or reply to';
    return '<label class="fld"><span>🔒 Password <span class="pl-opt">(optional)</span></span>' +
      '<input type="text" name="lockpw" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="100">' +
      '<small>Leave blank so anyone with the link can open it. With a password, people need it to ' + verb + ' the ' + w.a +
      '. Tell them the password separately. You can change it later.</small></label>';
  }

  function setPw(o, pw) {
    return lockCall(o.raw, 'lock_set', { p_app: o.app, p_code: o.code, p_owner_token: o.owner, p_password: pw || null }).then(function (d) {
      setKey(o.app, o.code, d.key); setHostPw(o.app, o.code, d.locked ? pw : '');
      return d;
    });
  }

  // After creating: set the password typed into fieldHtml's box (if any). Resolves to an error message or ''.
  function afterCreate(app, code, owner, pw, raw) {
    pw = String(pw || '').trim();
    if (!pw) return Promise.resolve('');
    return setPw({ app: app, code: code, owner: owner, raw: raw }, pw).then(function () { return ''; }, function (e) {
      return 'Created, but the password wasn’t set: ' + (msg(e) || MSG.network) + ' Use 🔒 Password in your tools to try again.';
    });
  }

  var css = false;
  function addCss() {
    if (css) return; css = true;
    var s = document.createElement('style');
    s.textContent = '.pl-gate{max-width:440px;margin:24px auto 0;text-align:center}.pl-gate .lede{margin:8px 0 18px}' +
      '.pl-emoji{font-size:48px;line-height:1}.pl-form{text-align:left}.pl-form .btn{width:100%}.pl-opt{font-weight:400;color:var(--muted)}' +
      '.pl-dlg{border:1px solid var(--line);border-radius:16px;padding:20px 18px;width:min(440px,calc(100vw - 32px));background:var(--surface);color:var(--ink)}' +
      '.pl-dlg::backdrop{background:rgba(0,0,0,.4)}.pl-dlg h2{margin:0 0 6px;font-size:22px}' +
      '.pl-cur{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:10px 0;font-size:15px;overflow-wrap:anywhere}' +
      '.pl-btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}.pl-btns .btn{flex:1 1 auto}';
    document.head.appendChild(s);
  }

  // Host: dialog to add, change or remove the password. o.done(locked) is called after a change.
  function openHost(o) {
    addCss();
    var w = words(o.what), d = document.createElement('dialog');
    d.className = 'pl-dlg';
    d.innerHTML = '<h2>🔒 Password</h2><p class="hint pl-state">Checking…</p><div class="pl-cur" hidden></div>' +
      '<form method="dialog" novalidate><label class="fld"><span class="pl-label">Password</span>' +
      '<input type="text" name="pw" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="100"></label>' +
      '<p class="err" role="alert"></p><div class="pl-btns"><button type="submit" class="btn primary" disabled>Save password</button>' +
      '<button type="button" class="btn danger pl-rm" hidden>Remove password</button><button type="button" class="btn pl-close">Close</button></div></form>';
    document.body.appendChild(d);
    var form = d.querySelector('form'), input = form.elements.pw, err = d.querySelector('.err'), state = d.querySelector('.pl-state'),
      cur = d.querySelector('.pl-cur'), saveBtn = form.querySelector('[type=submit]'), rm = d.querySelector('.pl-rm');
    function show(locked) {
      var known = locked && hostPw(o.app, o.code);
      state.textContent = locked
        ? 'People need the password to open this ' + w.a + '. They only enter it once per phone. If you change it, everyone needs the new one.'
        : 'Anyone with the link can open this ' + w.a + '. Add a password so people need it to get in.';
      cur.hidden = !known; cur.innerHTML = known ? 'Current password: <b>' + esc(known) + '</b>' : '';
      d.querySelector('.pl-label').textContent = locked ? 'New password' : 'Password';
      rm.hidden = !locked; saveBtn.disabled = false; saveBtn.textContent = locked ? 'Change password' : 'Save password';
    }
    function fail(e) { err.textContent = msg(e) || MSG.network; saveBtn.disabled = false; rm.disabled = false; }
    function close() { try { d.close(); } catch (e) {} d.remove(); }
    d.addEventListener('close', function () { if (d.parentNode) d.remove(); });
    d.querySelector('.pl-close').addEventListener('click', close);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var pw = input.value.trim();
      if (!pw) { err.textContent = 'Type a password first.'; return; }
      saveBtn.disabled = true; err.textContent = '';
      setPw(o, pw).then(function () { close(); if (o.toast) o.toast('Password saved. Share it with your guests separately.'); if (o.done) o.done(true); }, fail);
    });
    rm.addEventListener('click', function () {
      rm.disabled = true; err.textContent = '';
      setPw(o, '').then(function () { close(); if (o.toast) o.toast('Password removed. Anyone with the link can open it.'); if (o.done) o.done(false); }, fail);
    });
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    lockCall(o.raw, 'lock_owner', { p_app: o.app, p_code: o.code, p_owner_token: o.owner }).then(function (r) {
      if (r.key) setKey(o.app, o.code, r.key);
      show(!!r.locked);
    }, function (e) { state.textContent = msg(e) || MSG.network; });
  }

  addCss();
  window.PebblyLock = { call: call, handle: handle, ownerKey: ownerKey, fieldHtml: fieldHtml, afterCreate: afterCreate, openHost: openHost,
    message: msg, key: key };
})();
