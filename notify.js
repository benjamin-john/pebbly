// Pebbly notifications: the 🔔 bell. See supabase/migrations/20261028120000_notifications.sql.
//
// A phone remembers which events it's part of (localStorage pebbly_notify_feeds): as host (with the
// host key) or as a guest who responded (with its participant id). While a page with a bell is open,
// it asks notify_feed for all of them in one call every 30 seconds (and when you come back to the
// page). "Seen" is per phone: the newest id looked at, per event (pebbly_notify_seen).
// Host feeds are also picked up from the apps' saved host links, so the homepage bell knows about
// every event this phone hosts. What each kind of notification says lives in TYPES below.
//
// Pages:
//   PebblyNotify.feed(app, code, role, key, pid)   this phone hosts ('host', key = host key) or has
//                                                  responded to ('guest', key = participant id) an event
//   PebblyNotify.drop(app, code)                   forget an event (e.g. after deleting it)
//   <span data-pn-bell></span>                     a bell for all events (homepage), or with
//     data-app="rsvp" data-code="…"                just one event's. Bells can appear at any time.
//   window 'pebbly-notify-new' event { app, code, role }: something new arrived while the page is open
//   PebblyNotify.load() → Promise<feeds>, PebblyNotify.setOff(list), PebblyNotify.TYPES, …  (settings page)
//   PebblyNotify.push.support() / state() / on() / off() / test()   phone alerts (Web Push, settings page)
//
// Phone alerts: the phone subscribes with its browser's push service and sends that subscription with
// its events (notify_push_sync, again whenever they change); the notify-push Edge Function sends an
// alert for each new notification. sw.js loads this file too (importScripts) for alertView(): the
// wording is the same as the bell's.
(function () {
  'use strict';
  var URL_ = 'https://xujtuijpbwujduuzlwat.supabase.co', KEY_ = 'sb_publishable_bpV96pme2gEyfeelqqDYXA_CpAoj9OZ';
  var POLL_MS = 30000, FEEDS = 'pebbly_notify_feeds', SEEN = 'pebbly_notify_seen', OFF_ALL = 'pebbly_notify_off_all';

  // Each app: name, page, link parameter, where it keeps host keys and this phone's id, and (Sign-up
  // Sheet) its password name and the list that says which shared documents are sign-up sheets.
  var APPS = {
    rsvp: { name: 'RSVP', path: '/rsvp/', q: 'e', owners: 'rsvp.owners', pid: 'rsvp.pid' },
    wdw: { name: 'Which Day Works?', path: '/whichdayworks/', q: 'e', owners: 'meetup.owners', pid: 'meetup.pid' },
    poll: { name: 'Poll', path: '/poll/', q: 'p', owners: 'pick.owners', pid: 'pick.pid' },
    signup: { name: 'Sign-up Sheet', path: '/signup/', q: 'd', owners: 'pebbly_doc_owners', only: 'pebbly_signup_recent', pid: 'pebbly_signup_pid', lock: 'doc' },
    santa: { name: 'Secret Santa', path: '/santa/', q: 'g', owners: 'pebbly_santa_owners', pid: 'pebbly_santa_pid' },
    // a shared bracket: the page picks its game back up by itself, so the link is just the page
    bracket: { name: 'Bracket', path: '/bracket/' }
  };
  function eventUrl(app, code) { var a = APPS[app]; return !a ? '/' : a.q ? a.path + '?' + a.q + '=' + encodeURIComponent(code || '') : a.path; }
  var RSVP_STATUS = { going: 'Going', maybe: 'Maybe', no: 'Can’t go' };
  function plus(d) { return d.plus ? ' +' + d.plus : ''; }
  function answer(status, n) { return (RSVP_STATUS[status] || status) + (n ? ' +' + n : ''); }
  function day(s) { var d = String(s || '').split('-').map(Number); return new Date(d[0], d[1] - 1, d[2]).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); }
  // type → icon, text, where it is on the event page, and its label on the settings page (in order).
  var TYPES = {
    'rsvp.rsvp_new': { app: 'rsvp', role: 'host', label: 'New RSVPs', go: '#guests',
      icon: function (d) { return { going: '✅', maybe: '🤔', no: '❌' }[d.status] || '✉️'; },
      text: function (n, d) { return n + (d.status === 'going' ? ' is going' + plus(d) : d.status === 'maybe' ? ' might come' + plus(d) : ' can’t make it'); } },
    'rsvp.rsvp_changed': { app: 'rsvp', role: 'host', label: 'Changed answers', go: '#guests', icon: function () { return '🔄'; },
      text: function (n, d) { return n + ' changed to ' + answer(d.status, d.plus) + (d.from ? ' (was ' + answer(d.from, d.plus_from) + ')' : ''); } },
    'rsvp.comment': { app: 'rsvp', role: 'host', label: 'New comments', go: '#comments', icon: function () { return '💬'; },
      text: function (n, d) { return n + ': “' + (d.snippet || '') + '”'; } },
    'rsvp.bring': { app: 'rsvp', role: 'host', label: 'Someone offers to bring something', go: '#bring', icon: function () { return '🧺'; },
      text: function (n, d) { return n + ' is bringing ' + (d.item || 'something'); } },
    'rsvp.announce': { app: 'rsvp', role: 'guest', label: 'Announcements from the host', go: '#annc', icon: function () { return '📣'; },
      text: function (n, d) { return 'Host: ' + (d.snippet || ''); } },
    'wdw.response_new': { app: 'wdw', role: 'host', label: 'Someone added their days', go: '#people', icon: function () { return '📅'; },
      text: function (n) { return n + ' added their days'; } },
    'wdw.response_changed': { app: 'wdw', role: 'host', label: 'Someone changed their days', go: '#people', icon: function () { return '✏️'; },
      text: function (n) { return n + ' changed their days'; } },
    'wdw.final_date': { app: 'wdw', role: 'guest', label: 'The organizer picked the date', go: '#decided', icon: function () { return '🎯'; },
      text: function (n, d) { return 'The date is set: ' + day(d.date) + (d.days > 1 ? ' (' + d.days + ' days)' : ''); } },
    'poll.option': { app: 'poll', role: 'host', label: 'Someone adds a choice', go: '#opts', icon: function () { return '➕'; },
      text: function (n, d) { return (n && n !== 'Someone' ? n : 'Someone') + ' added “' + (d.label || '') + '”'; } },
    'poll.winner': { app: 'poll', role: 'guest', label: 'The winner is picked', go: '#winner', icon: function () { return '🏆'; },
      text: function (n, d) { return 'The winner is ' + n + (d.method === 'roulette' ? ' (picked by a spin)' : ''); } },
    'signup.signup': { app: 'signup', role: 'host', label: 'Someone signs up', go: '#slots', icon: function () { return '✍️'; },
      text: function (n, d) { return n + ' signed up' + (d.slot ? ' for ' + d.slot : ''); } },
    'santa.drawn': { app: 'santa', role: 'guest', label: 'Names are drawn', go: '#app', icon: function () { return '🎁'; },
      text: function () { return 'Names are drawn! Open it to see who you’re buying for.'; } },
    'bracket.champion': { app: 'bracket', role: 'guest', label: 'A winner is crowned', go: '#play', icon: function () { return '🏆'; },
      text: function (n) { return n + ' won!'; } }
  };

  // What a phone alert says (sw.js, for each push).
  function alertView(d) {
    if (d.test) return { title: 'Pebbly', body: 'Phone alerts are on. You’ll get one like this when something happens.', url: '/notifications/', tag: 'pebbly-test' };
    var t = TYPES[d.type], a = APPS[d.app], det = d.detail || {};
    return { title: (d.emoji ? d.emoji + ' ' : '') + (d.title || (a ? a.name : 'Pebbly')),
      body: t ? t.icon(det) + ' ' + t.text(d.name || 'Someone', det) : 'Something new',
      url: eventUrl(d.app, d.code), tag: d.tag || 'pebbly' };
  }
  // In the service worker: only the wording.
  if (typeof document === 'undefined') { self.PebblyNotify = { TYPES: TYPES, APPS: APPS, alertView: alertView }; return; }

  function load(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fid(app, code, role) { return app + ':' + code + ':' + role; }
  function norm(code) { return String(code || '').trim().toLowerCase(); }

  function raw(fn, args) {
    var headers = { 'Content-Type': 'application/json', apikey: KEY_ };
    if (!/^sb_/.test(KEY_)) headers.Authorization = 'Bearer ' + KEY_;
    return fetch(URL_ + '/rest/v1/rpc/' + fn, { method: 'POST', headers: headers, body: JSON.stringify(args) }).then(function (r) {
      return r.text().then(function (t) {
        var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) { var err = new Error((d && d.message) || 'error'); err.status = r.status; throw err; }
        return d;
      });
    });
  }
  function missingFn(e) { return !!e && (e.status === 404 || /could not find the function|function .* does not exist/i.test(e.message || '')); }

  /* ------------------------------------------------------------ feeds on this phone */

  function feeds() { return load(FEEDS, {}) || {}; }
  // Only roles that have something to hear about (e.g. Poll has nothing for hosts yet).
  function hasTypes(app, role) { return Object.keys(TYPES).some(function (t) { return TYPES[t].app === app && TYPES[t].role === role; }); }
  // Host feeds from the apps' own saved host links (so the homepage knows them all).
  function seed() {
    var all = feeds(), changed = false;
    Object.keys(APPS).forEach(function (app) {
      if (!hasTypes(app, 'host')) return;
      var owners = load(APPS[app].owners, {}) || {}, pid = load(APPS[app].pid, '') || '', only = null;
      // shared documents keep all their host keys together: only take the ones this app made
      if (APPS[app].only) { only = {}; (load(APPS[app].only, []) || []).forEach(function (r) { if (r && r.code) only[norm(r.code)] = true; }); }
      Object.keys(owners).forEach(function (code) {
        if (only && !only[norm(code)]) return;
        var id = fid(app, norm(code), 'host');
        // new, or the app now holds a different host key for it
        if (owners[code] && (!all[id] || all[id].key !== owners[code])) { all[id] = { app: app, code: norm(code), role: 'host', key: owners[code], pid: pid, at: Date.now() }; changed = true; }
      });
    });
    if (changed) save(FEEDS, all);
    return all;
  }
  function feed(app, code, role, key, pid) {
    if (!APPS[app] || !key || (role !== 'host' && role !== 'guest') || !hasTypes(app, role)) return;
    code = norm(code);
    var all = feeds(), id = fid(app, code, role), f = all[id], fresh = !f || f.dead;
    if (f && !f.dead && f.key === key && f.pid === (pid || '')) return;
    all[id] = { app: app, code: code, role: role, key: key, pid: pid || '', at: Date.now(), title: f && f.title, emoji: f && f.emoji, sent: f && !f.dead && f.key === key && f.sent };
    save(FEEDS, all);
    if (fresh) { var seen = load(SEEN, {}); if (!(id in seen)) { seen[id] = null; save(SEEN, seen); } }
    soon();
    setTimeout(keepPush, 300);   // phone alerts: include it now, even on a page without a bell
  }
  function drop(app, code) {
    code = norm(code);
    var all = feeds(), seen = load(SEEN, {});
    ['host', 'guest'].forEach(function (r) { delete all[fid(app, code, r)]; delete seen[fid(app, code, r)]; delete state[fid(app, code, r)]; });
    save(FEEDS, all); save(SEEN, seen); paint();
  }
  function lockKey(app, code) { return (load('pebbly_lock_keys', {}) || {})[((APPS[app] && APPS[app].lock) || app) + ':' + code] || null; }
  // A refused event (deleted, or no longer ours) is asked about again after a day.
  function isDead(f) { return typeof f.dead === 'number' && Date.now() - f.dead < 864e5; }
  function live() {
    var all = seed();
    return Object.keys(all).map(function (id) { return all[id]; }).filter(function (f) { return !isDead(f) && APPS[f.app] && hasTypes(f.app, f.role); })
      .sort(function (a, b) { return (b.at || 0) - (a.at || 0); }).slice(0, 40);
  }

  /* ------------------------------------------------------------ fetching */

  var state = {};          // feed id → last answer from notify_feed (ok, title, items, off)
  var off = false, busy = null, timer = null, last = 0, ready = false, failed = false;

  function fetchAll() {
    if (off) return Promise.resolve([]);
    if (busy) return busy;
    var list = live();
    if (!list.length) { ready = true; paint(); return Promise.resolve([]); }
    busy = raw('notify_feed', { p_feeds: list.map(function (f) {
      return { app: f.app, code: f.code, role: f.role, key: f.key, pid: f.pid || '', lock: lockKey(f.app, f.code) };
    }) }).then(function (res) {
      var all = feeds(), seen = load(SEEN, {}), offAll = load(OFF_ALL, {}) || {}, pending = [], news = [];
      (res || []).forEach(function (r, i) {
        var f = list[i], id = fid(f.app, f.code, f.role);
        if (!all[id]) return;
        if (!r || !r.ok) { all[id].dead = Date.now(); delete state[id]; return; }
        var top = r.items.length ? r.items[0].id : 0, before = state[id] ? (state[id].items[0] || {}).id || 0 : null;
        if (before !== null && top > before) news.push(f);
        state[id] = r;
        delete all[id].dead;
        all[id].title = r.title; all[id].emoji = r.emoji;
        if (seen[id] === null) seen[id] = r.items.length ? r.items[0].id : 0;   // a new feed starts with everything seen
        // turn off what this phone turned off for all events, once per new feed
        var defaults = offAll[f.app + ':' + f.role] || [];
        if (!all[id].sent) {
          all[id].sent = true;
          var want = union(r.off, defaults);
          if (want.length !== r.off.length) { pending.push({ f: f, off: want }); r.off = want; r.items = r.items.filter(function (n) { return want.indexOf(n.type) < 0; }); }
        }
      });
      save(FEEDS, all); save(SEEN, seen);
      if (pending.length) setOff(pending).catch(function () {});
      keepPush();
      ready = true; failed = false; last = Date.now(); busy = null; paint();
      // something new since the last check: the page can reload its data
      news.forEach(function (f) { window.dispatchEvent(new CustomEvent('pebbly-notify-new', { detail: { app: f.app, code: f.code, role: f.role } })); });
      return list.map(function (f) { return state[fid(f.app, f.code, f.role)]; }).filter(Boolean);
    }, function (e) {
      busy = null; failed = !missingFn(e);
      if (missingFn(e)) { off = true; paint(); }   // database not updated yet: no bell
      return [];
    });
    return busy;
  }
  function union(a, b) { var out = (a || []).slice(); (b || []).forEach(function (t) { if (out.indexOf(t) < 0) out.push(t); }); return out; }

  // list: [{ f: feed, off: [types] }] → saves which kinds are off for each event.
  function setOff(list) {
    return raw('notify_set_off', { p_feeds: list.map(function (x) {
      return { app: x.f.app, code: x.f.code, role: x.f.role, key: x.f.key, lock: lockKey(x.f.app, x.f.code), off: x.off };
    }) }).then(function (res) {
      list.forEach(function (x) { var s = state[fid(x.f.app, x.f.code, x.f.role)]; if (s) s.off = x.off.slice(); });
      last = 0;
      return res;
    });
  }

  function hasBells() { return !!document.querySelector('[data-pn-bell]'); }
  function tick() {
    clearTimeout(timer);
    if (off || !hasBells()) { timer = null; return; }
    if (document.visibilityState === 'visible') fetchAll();
    timer = setTimeout(tick, POLL_MS);
  }
  function soon() { clearTimeout(timer); timer = setTimeout(tick, 50); }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && Date.now() - last > 5000) soon();
  });

  /* ------------------------------------------------------------ what a bell shows */

  // Items for one event (app + code) or for all; a guest item is left out where this phone is the host.
  function itemsFor(app, code) {
    var out = [], seen = load(SEEN, {});
    Object.keys(state).forEach(function (id) {
      var s = state[id], p = id.split(':');
      if (app && (p[0] !== app || p[1] !== code)) return;
      if (p[2] === 'guest' && state[fid(p[0], p[1], 'host')]) return;
      s.items.forEach(function (n) {
        if (!TYPES[n.type]) return;
        out.push({ feed: id, app: p[0], code: p[1], title: s.title, emoji: s.emoji, n: n, unread: seen[id] != null && n.id > seen[id] });
      });
    });
    return out.sort(function (a, b) { return new Date(b.n.at) - new Date(a.n.at); });
  }
  function shows(app, code) {
    if (off || !ready) return false;
    if (!app) return Object.keys(state).length > 0;
    return !!(state[fid(app, code, 'host')] || state[fid(app, code, 'guest')]);
  }
  function markSeen(list) {
    var seen = load(SEEN, {});
    list.forEach(function (x) { if (seen[x.feed] == null || x.n.id > seen[x.feed]) seen[x.feed] = x.n.id; });
    save(SEEN, seen);
  }

  function relTime(ts) {
    var d = new Date(ts), s = (Date.now() - d.getTime()) / 1000;
    if (isNaN(s)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 6 * 86400) return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  var CSS =
    '[data-pn-bell]{display:inline-flex}[data-pn-bell][hidden]{display:none !important}' +
    '.pn-bell{position:relative;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;margin:-10px -8px -10px 0;' +
      'border:0;border-radius:999px;background:none;cursor:pointer;font-size:22px;line-height:1;color:inherit;-webkit-tap-highlight-color:transparent}' +
    '.pn-bell:active{background:var(--line,#DDE4E1)}' +
    '.pn-badge{position:absolute;top:4px;right:2px;min-width:19px;height:19px;padding:0 5px;border-radius:999px;background:var(--brand,var(--accent,#2F7A63));' +
      'color:var(--brand-ink,#fff);font:700 11px/19px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px var(--bg,#F4F6F5)}' +
    '.pn-wrap{position:fixed;inset:0;z-index:50;display:flex;justify-content:center;align-items:flex-start;padding:56px 12px 12px;background:rgba(10,20,16,.38)}' +
    '.pn-sheet{width:100%;max-width:440px;max-height:calc(100% - 20px);display:flex;flex-direction:column;overflow:hidden;' +
      'background:var(--surface,var(--card,#fff));color:var(--ink,var(--text,#1F2A27));border:1px solid var(--line,#DDE4E1);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25)}' +
    '.pn-head{display:flex;align-items:center;gap:4px;padding:8px 8px 8px 16px;border-bottom:1px solid var(--line,#DDE4E1)}' +
    '.pn-head h2{flex:1;margin:0;font:800 20px/1.2 "Bricolage Grotesque","Trebuchet MS",system-ui,sans-serif;text-transform:none;letter-spacing:0;color:inherit}' +
    '.pn-head a,.pn-head button{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0 10px;border:0;border-radius:10px;' +
      'background:none;color:var(--brand,var(--accent,#2F7A63));font-weight:600;font-size:15px;line-height:1;font-family:inherit;text-decoration:none;cursor:pointer}' +
    '.pn-head button{color:var(--muted,#5D6B66);font-size:20px}' +
    '.pn-list{overflow:auto;padding:6px 0 10px;margin:0;list-style:none;display:block}' +
    '.pn-ev{margin:10px 16px 2px;font-size:13px;font-weight:600;color:var(--muted,#5D6B66)}' +
    '.pn-item{display:flex;gap:10px;align-items:flex-start;width:100%;min-height:52px;padding:10px 16px;border:0;background:none;color:inherit;' +
      'font:inherit;font-size:15px;line-height:1.35;text-align:left;cursor:pointer}' +
    '.pn-item:active{background:var(--line,#DDE4E1)}' +
    '.pn-item.new{background:var(--brand-t,rgba(47,122,99,.12))}' +
    '.pn-ic{flex:none;width:26px;font-size:19px;text-align:center}' +
    '.pn-tx{flex:1;min-width:0;overflow-wrap:anywhere}' +
    '.pn-tm{display:block;margin-top:2px;font-size:13px;color:var(--muted,#5D6B66)}' +
    '.pn-dot{flex:none;width:9px;height:9px;margin-top:6px;border-radius:50%;background:var(--brand,var(--accent,#2F7A63))}' +
    '.pn-empty{padding:22px 16px;color:var(--muted,#5D6B66);font-size:15px}' +
    '.pn-foot{display:flex;align-items:center;min-height:48px;padding:0 16px;border-top:1px solid var(--line,#DDE4E1);color:var(--brand,var(--accent,#2F7A63));font-weight:600;font-size:15px;text-decoration:none}';
  function addCss() {
    if (document.getElementById('pn-css')) return;
    var s = document.createElement('style'); s.id = 'pn-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  function paint() {
    var els = document.querySelectorAll('[data-pn-bell]');
    if (!els.length) return;
    addCss();
    Array.prototype.forEach.call(els, function (el) {
      var app = el.dataset.app || '', code = norm(el.dataset.code);
      if (!el.firstChild) el.innerHTML = '<button type="button" class="pn-bell"><span aria-hidden="true">🔔</span><span class="pn-badge" hidden></span></button>';
      el.hidden = !shows(app, code);
      var n = itemsFor(app, code).filter(function (x) { return x.unread; }).length, b = el.querySelector('.pn-badge');
      b.hidden = !n; b.textContent = n > 9 ? '9+' : String(n);
      el.firstChild.setAttribute('aria-label', 'Notifications' + (n ? ', ' + n + ' new' : ''));
    });
  }

  var openEl = null;
  function close() { if (openEl) { openEl.remove(); openEl = null; document.removeEventListener('keydown', onKey); } }
  function onKey(e) { if (e.key === 'Escape') close(); }
  function open(app, code) {
    close(); addCss();
    var list = itemsFor(app, code), lastEv = '';
    var wrap = document.createElement('div');
    wrap.className = 'pn-wrap';
    wrap.innerHTML = '<div class="pn-sheet" role="dialog" aria-modal="true" aria-label="Notifications">' +
      '<div class="pn-head"><h2>Notifications</h2><a href="/notifications/">⚙ Settings</a><button type="button" data-pn="close" aria-label="Close">✕</button></div>' +
      (list.length ? '<ul class="pn-list">' + list.map(function (x, i) {
        var t = TYPES[x.n.type], d = x.n.detail || {}, head = '';
        if (!app && x.feed.replace(/:(host|guest)$/, '') !== lastEv) {
          lastEv = x.feed.replace(/:(host|guest)$/, '');
          head = '<li class="pn-ev">' + esc((x.emoji ? x.emoji + ' ' : '') + (x.title || APPS[x.app].name)) + '</li>';
        }
        return head + '<li><button type="button" class="pn-item' + (x.unread ? ' new' : '') + '" data-pn-i="' + i + '">' +
          '<span class="pn-ic" aria-hidden="true">' + esc(t.icon(d)) + '</span>' +
          '<span class="pn-tx">' + esc(t.text(x.n.name || 'Someone', d)) + '<span class="pn-tm">' + esc(relTime(x.n.at)) +
            (app ? '' : ' · ' + esc(APPS[x.app].name)) + '</span></span>' +
          (x.unread ? '<span class="pn-dot" aria-label="new"></span>' : '') + '</button></li>';
      }).join('') + '</ul>'
      : '<p class="pn-empty">Nothing yet. New replies, comments and updates for your events will show up here.</p>') +
      (pushSupport() === 'ok' && !load(PUSH, {}).on && Notification.permission !== 'denied'
        ? '<a class="pn-foot" href="/notifications/#alerts">📲 Get these on your lock screen too</a>' : '') + '</div>';
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap || e.target.closest('[data-pn="close"]')) { close(); return; }
      var b = e.target.closest('[data-pn-i]');
      if (!b) return;
      var x = list[Number(b.dataset.pnI)], go = TYPES[x.n.type].go, here = app && document.querySelector(go);
      close();
      if (here) here.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else location.href = eventUrl(x.app, x.code);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    openEl = wrap;
    markSeen(list);
    paint();
    var c = wrap.querySelector('[data-pn="close"]'); if (c) c.focus();
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.pn-bell');
    if (!b) return;
    var el = b.closest('[data-pn-bell]');
    open(el.dataset.app || '', norm(el.dataset.code));
  });
  // Bells can be added whenever a page redraws: show them straight away, and start checking.
  function watch() {
    new MutationObserver(function () {
      var fresh = document.querySelector('[data-pn-bell]:empty');
      if (fresh) { paint(); if (!timer) soon(); }
    }).observe(document.body, { childList: true, subtree: true });
    if (hasBells()) { paint(); soon(); }
  }
  if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch);

  /* ------------------------------------------------------------ phone alerts (Web Push) */

  var FUNC = URL_ + '/functions/v1/notify-push', PUSH = 'pebbly_push';   // { on, sig }
  function standalone() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  // 'ok', 'ios-install' (iPhone: only from the Home Screen app) or 'no'
  function pushSupport() {
    if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'ok';
    return isIOS() && !standalone() ? 'ios-install' : 'no';
  }
  function swReg() { return navigator.serviceWorker.register('/sw.js').then(function () { return navigator.serviceWorker.ready; }); }
  function bytes(b64) {
    var s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4)), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function sameKey(sub, pk) {
    var k = sub.options && sub.options.applicationServerKey;
    if (!k) return true;
    var a = new Uint8Array(k), b = bytes(pk);
    return a.length === b.length && a.every(function (x, i) { return x === b[i]; });
  }
  // Sends the subscription and this phone's events (only when they changed, unless force).
  function syncSub(sub, force) {
    var j = sub.toJSON(), list = live().map(function (f) {
      return { app: f.app, code: f.code, role: f.role, key: f.key, pid: f.pid || '', lock: lockKey(f.app, f.code) };
    });
    // (and once a day anyway, in case the server dropped it)
    var sig = new Date().toDateString() + '|' + j.endpoint + '|' + list.map(function (f) { return [f.app, f.code, f.role, f.key, f.pid, f.lock || ''].join(','); }).join(';');
    if (!force && load(PUSH, {}).sig === sig) return Promise.resolve(null);
    return raw('notify_push_sync', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_feeds: list }).then(function (r) {
      save(PUSH, { on: true, sig: sig });
      return r;
    });
  }
  function subscribe() {
    return Promise.all([swReg(), fetch(FUNC).then(function (r) {
      if (!r.ok) throw new Error('not_ready');
      return r.json();
    }, function () { throw new Error('network'); })]).then(function (x) {
      var reg = x[0], pk = x[1] && x[1].publicKey;
      if (!pk) throw new Error('not_ready');
      return reg.pushManager.getSubscription().then(function (old) {
        if (old && sameKey(old, pk)) return old;
        return (old ? old.unsubscribe() : Promise.resolve()).then(function () {
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(pk) });
        });
      });
    });
  }
  // Keeps an "on" phone's subscription and event list up to date (after each bell check).
  var keeping = false;
  function keepPush() {
    if (keeping || !load(PUSH, {}).on || pushSupport() !== 'ok' || Notification.permission !== 'granted') return;
    keeping = true;
    swReg().then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (sub) { return sub ? syncSub(sub) : subscribe().then(function (s) { return syncSub(s, true); }); })
      .catch(function () {}).then(function () { keeping = false; });
  }
  var push = {
    support: pushSupport,
    // 'on' | 'off' | 'blocked' | 'ios-install' | 'no'
    state: function () {
      var s = pushSupport();
      if (s !== 'ok') return Promise.resolve(s);
      if (Notification.permission === 'denied') return Promise.resolve('blocked');
      if (!load(PUSH, {}).on || Notification.permission !== 'granted') return Promise.resolve('off');
      return swReg().then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) { return sub ? 'on' : 'off'; }, function () { return 'off'; });
    },
    // Rejects with 'blocked', 'dismissed', 'not_ready' (sender not set up), 'network' or the browser's error.
    on: function () {
      return Promise.resolve(Notification.requestPermission()).then(function (perm) {
        if (perm !== 'granted') throw new Error(perm === 'denied' ? 'blocked' : 'dismissed');
        seed();
        return subscribe();
      }).then(function (sub) { return syncSub(sub, true); });
    },
    off: function () {
      save(PUSH, { on: false });
      return swReg().then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
        if (!sub) return;
        var ep = sub.endpoint;
        return sub.unsubscribe().catch(function () {}).then(function () { return raw('notify_push_remove', { p_endpoint: ep }); });
      });
    },
    // Resolves true when the alert was handed to the push service.
    test: function () {
      return swReg().then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
        if (!sub) throw new Error('off');
        return fetch(FUNC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ test: sub.endpoint }) });
      }).then(function (r) { return r.json().then(function (d) { return r.ok && d.sent > 0; }); });
    }
  };

  window.PebblyNotify = {
    push: push, alertView: alertView,
    feed: feed, drop: drop, TYPES: TYPES, APPS: APPS,
    check: function () { return fetchAll(); },   // check now (tests; normally every 30 s)
    // settings page
    load: function () { seed(); return fetchAll().then(function () { if (failed) throw new Error('network'); return live().filter(function (f) { return state[fid(f.app, f.code, f.role)]; })
      .map(function (f) { var s = state[fid(f.app, f.code, f.role)]; return { f: f, title: s.title, emoji: s.emoji, off: s.off.slice() }; }); }); },
    setOff: setOff,
    offAll: function () { return load(OFF_ALL, {}) || {}; },
    setOffAll: function (v) { save(OFF_ALL, v); },
    available: function () { return !off; }
  };
})();
