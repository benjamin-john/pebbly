// Pebbly backup & restore (/backup/). See supabase/migrations/20261028200000_backups.sql.
//
// Pebbly keeps everything on the phone (localStorage): host links, which events you replied to, names,
// event passwords, settings. A backup key is six words (from the BIP39 English list below, 2048 words,
// any word known by its first four letters). From the words the phone works out (PBKDF2) the backup's
// id and an AES key; it keeps an encrypted copy of the data in the `backups` table and updates it when
// the data changes (on page load, every minute while open, and when you leave). The database only
// sees the id and ciphertext. Restoring on another phone merges the copy into what's already there:
// lists and host links are added together; for single values (your guest id, names) the backup wins.
// nav.js loads this file on every page once a phone has a key; /backup/ and the homepage load it too.
//
//   PebblyBackup.state()          → { on, words, savedAt, error }
//   PebblyBackup.create()         → Promise<words[]>   (makes a key and the first copy)
//   PebblyBackup.restore(text)    → Promise<summary>   (rejects: 'bad_words', 'not_found', 'network', …)
//   PebblyBackup.sync(force)      → Promise            (save now if anything changed)
//   PebblyBackup.forget() / remove()                   (stop on this phone / also delete the copy)
//   PebblyBackup.summary()        → { hosted, joined } counts on this phone
(function () {
  'use strict';
  if (window.PebblyBackup) return;
  var URL_ = 'https://xujtuijpbwujduuzlwat.supabase.co', KEY_ = 'sb_publishable_bpV96pme2gEyfeelqqDYXA_CpAoj9OZ';
  var ST = 'pebbly_backup', MAX = 380000, ITER = 200000;

  // BIP39 English word list (ISC licence, from the bip39 package).
  var WORDS = (
    'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve ' +
    'acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult ' +
    'advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album ' +
    'alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount ' +
    'amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique ' +
    'anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around ' +
    'arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete ' +
    'atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake ' +
    'aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball bamboo banana banner ' +
    'bar barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave ' +
    'behind believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird ' +
    'birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board ' +
    'boat body boil bomb bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand ' +
    'brass brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown ' +
    'brush bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy ' +
    'butter buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy cannon ' +
    'canoe canvas canyon capable capital captain car carbon card cargo carpet carry cart case cash casino castle ' +
    'casual cat catalog catch category cattle caught cause caution cave ceiling celery cement census century ' +
    'cereal certain chair chalk champion change chaos chapter charge chase chat cheap check cheese chef cherry ' +
    'chest chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen ' +
    'city civil claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog ' +
    'close cloth cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color ' +
    'column combine come comfort comic common company concert conduct confirm congress connect consider control ' +
    'convince cook cool copper copy coral core corn correct cost cotton couch country couple course cousin cover ' +
    'coyote crack cradle craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp ' +
    'critic crop cross crouch crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup ' +
    'cupboard curious current curtain curve cushion custom cute cycle dad damage damp dance danger daring dash ' +
    'daughter dawn day deal debate debris decade december decide decline decorate decrease deer defense define ' +
    'defy degree delay deliver demand demise denial dentist deny depart depend deposit depth deputy derive ' +
    'describe desert design desk despair destroy detail detect develop device devote diagram dial diamond diary ' +
    'dice diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover disease dish ' +
    'dismiss disorder display distance divert divide divorce dizzy doctor document dog doll dolphin domain donate ' +
    'donkey donor door dose double dove draft dragon drama drastic draw dream dress drift drill drink drip drive ' +
    'drop drum dry duck dumb dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east ' +
    'easy echo ecology economy edge edit educate effort egg eight either elbow elder electric elegant element ' +
    'elephant elevator elite else embark embody embrace emerge emotion employ empower empty enable enact end ' +
    'endless endorse enemy energy enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter ' +
    'entire entry envelope episode equal equip era erase erode erosion error erupt escape essay essence estate ' +
    'eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude excuse execute ' +
    'exercise exhaust exhibit exile exist exit exotic expand expect expire explain expose express extend extra eye ' +
    'eyebrow fabric face faculty fade faint faith fall false fame family famous fan fancy fantasy farm fashion fat ' +
    'fatal father fatigue fault favorite feature february federal fee feed feel female fence festival fetch fever ' +
    'few fiber fiction field figure file film filter final find fine finger finish fire firm first fiscal fish fit ' +
    'fitness fix flag flame flash flat flavor flee flight flip float flock floor flower fluid flush fly foam focus ' +
    'fog foil fold follow food foot force forest forget fork fortune forum forward fossil foster found fox fragile ' +
    'frame frequent fresh friend fringe frog front frost frown frozen fruit fuel fun funny furnace fury future ' +
    'gadget gain galaxy gallery game gap garage garbage garden garlic garment gas gasp gate gather gauge gaze ' +
    'general genius genre gentle genuine gesture ghost giant gift giggle ginger giraffe girl give glad glance ' +
    'glare glass glide glimpse globe gloom glory glove glow glue goat goddess gold good goose gorilla gospel ' +
    'gossip govern gown grab grace grain grant grape grass gravity great green grid grief grit grocery group grow ' +
    'grunt guard guess guide guilt guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh ' +
    'harvest hat have hawk hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high ' +
    'hill hint hip hire history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse ' +
    'hospital host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband ' +
    'hybrid ice icon idea identify idle ignore ill illegal illness image imitate immense immune impact impose ' +
    'improve impulse inch include income increase index indicate indoor industry infant inflict inform inhale ' +
    'inherit initial inject injury inmate inner innocent input inquiry insane insect inside inspire install intact ' +
    'interest into invest invite involve iron island isolate issue item ivory jacket jaguar jar jazz jealous jeans ' +
    'jelly jewel job join joke journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key ' +
    'kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife knock know lab label labor ladder ' +
    'lady lake lamp language laptop large later latin laugh laundry lava law lawn lawsuit layer lazy leader leaf ' +
    'learn leave lecture left leg legal legend leisure lemon lend length lens leopard lesson letter level liar ' +
    'liberty library license life lift light like limb limit link lion liquid list little live lizard load loan ' +
    'lobster local lock logic lonely long loop lottery loud lounge love loyal lucky luggage lumber lunar lunch ' +
    'luxury lyrics machine mad magic magnet maid mail main major make mammal man manage mandate mango mansion ' +
    'manual maple marble march margin marine market marriage mask mass master match material math matrix matter ' +
    'maximum maze meadow mean measure meat mechanic medal media melody melt member memory mention menu mercy merge ' +
    'merit merry mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle ' +
    'mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor monkey monster month moon ' +
    'moral more morning mosquito mother motion motor mountain mouse move movie much muffin mule multiply muscle ' +
    'museum mushroom music must mutual myself mystery myth naive name napkin narrow nasty nation nature near neck ' +
    'need negative neglect neither nephew nerve nest net network neutral never news next nice night noble noise ' +
    'nominee noodle normal north nose notable note nothing notice novel now nuclear number nurse nut oak obey ' +
    'object oblige obscure observe obtain obvious occur ocean october odor off offer office often oil okay old ' +
    'olive olympic omit once one onion online only open opera opinion oppose option orange orbit orchard order ' +
    'ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven over own owner ' +
    'oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper parade parent park ' +
    'parrot party pass patch path patient patrol pattern pause pave payment peace peanut pear peasant pelican pen ' +
    'penalty pencil people pepper perfect permit person pet phone photo phrase physical piano picnic picture piece ' +
    'pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate play please pledge ' +
    'pluck plug plunge poem poet point polar pole police pond pony pool popular portion position possible post ' +
    'potato pottery poverty powder power practice praise predict prefer prepare present pretty prevent price pride ' +
    'primary print priority prison private prize problem process produce profit program project promote proof ' +
    'property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy purchase ' +
    'purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote rabbit ' +
    'raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather raven raw ' +
    'razor ready real reason rebel rebuild recall receive recipe record recycle reduce reflect reform refuse ' +
    'region regret regular reject relax release relief rely remain remember remind remove render renew rent reopen ' +
    'repair repeat replace report require rescue resemble resist resource response result retire retreat return ' +
    'reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple risk ' +
    'ritual rival river road roast robot robust rocket romance roof rookie room rose rotate rough round route ' +
    'royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same ' +
    'sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme school science ' +
    'scissors scorpion scout scrap screen script scrub sea search season seat second secret section security seed ' +
    'seek segment select sell seminar senior sense sentence series service session settle setup seven shadow shaft ' +
    'shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove ' +
    'shrimp shrug shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since ' +
    'sing siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep slender slice ' +
    'slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap ' +
    'soccer social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup ' +
    'source south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit ' +
    'split spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff ' +
    'stage stairs stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone ' +
    'stool story stove strategy street strike strong struggle student stuff stumble style subject submit subway ' +
    'success such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge ' +
    'surprise surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim swing switch sword ' +
    'symbol symptom syrup system table tackle tag tail talent talk tank tape target task taste tattoo taxi teach ' +
    'team tell ten tenant tennis tent term test text thank that theme then theory there they thing this thought ' +
    'three thrive throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco ' +
    'today toddler toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic topple torch ' +
    'tornado tortoise toss total tourist toward tower town toy track trade traffic tragic train transfer trap ' +
    'trash travel tray treat tree trend trial tribe trick trigger trim trip trophy trouble truck true truly ' +
    'trumpet trust truth try tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two ' +
    'type typical ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit ' +
    'universe unknown unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used ' +
    'useful useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault ' +
    'vehicle velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious victory ' +
    'video view village vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume ' +
    'vote voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth ' +
    'weapon wear weasel weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip ' +
    'whisper wide width wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf ' +
    'woman wonder wood wool word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you ' +
    'young youth zebra zero zone zoo '
  ).trim().split(' ');

  // What's backed up: every Pebbly key except per-phone and in-progress things.
  var INCLUDE = /^(rsvp\.|meetup\.|pick\.|pebbly_)/;
  var SKIP = /(\.local\.db$|^pick\.justCreated$|_undo$|_ui$|_view$|_section$|_new$|^pebbly_push$|^pebbly_backup|^pebbly_play_|^pebbly_(bracket|codebreaker|colorstack|darts_game|dots|farkle|gomoku|mancala|namegame|qwixx2|score_game|teams|timer_cd|timer_game|trivia_game|worddash)$)/;
  // Dropped first if a backup gets too big.
  var OPTIONAL = /^pebbly_(trivia_|live_quizzes|live_sessions|colorstack_best|worddash_stats|names_prefs)/;
  var OWNERS = ['rsvp.owners', 'meetup.owners', 'pick.owners', 'pebbly_doc_owners', 'pebbly_santa_owners'];

  function load(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function rpc(fn, args) {
    var headers = { 'Content-Type': 'application/json', apikey: KEY_ };
    if (!/^sb_/.test(KEY_)) headers.Authorization = 'Bearer ' + KEY_;
    return fetch(URL_ + '/rest/v1/rpc/' + fn, { method: 'POST', headers: headers, body: JSON.stringify(args) }).then(function (r) {
      return r.text().then(function (t) {
        var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) {
          var m = (d && d.message) || '';
          throw new Error(/backup_conflict|backup_too_big|invalid_backup/.test(m) ? m.match(/backup_conflict|backup_too_big|invalid_backup/)[0] :
            r.status === 404 || /could not find the function|function .* does not exist/i.test(m) ? 'not_ready' : 'network');
        }
        return d;
      });
    }, function () { throw new Error('network'); });
  }

  /* ------------------------------------------------------------ words and keys */

  var BY4 = {}, EXACT = {};
  WORDS.forEach(function (w, i) { BY4[w.slice(0, 4)] = i; EXACT[w] = i; });
  function newWords() {
    var r = crypto.getRandomValues(new Uint16Array(6)), out = [];
    for (var i = 0; i < 6; i++) out.push(WORDS[r[i] & 2047]);
    return out;
  }
  // Six words from typed or pasted text (any case, any separators, first four letters are enough), or null.
  function parse(text) {
    var parts = String(text || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
    if (parts.length !== 6) return null;
    var out = [];
    for (var i = 0; i < 6; i++) {
      // every word is known by its first four letters (short words: the whole word)
      var p = parts[i], ix = p.length < 4 ? EXACT[p] : BY4[p.slice(0, 4)];
      if (ix === undefined) return null;
      out.push(WORDS[ix]);
    }
    return out;
  }
  var keyCache = {};
  // { id: 64 hex, key: AES-GCM CryptoKey } from the words.
  function derive(words) {
    var phrase = words.join(' ');
    if (keyCache[phrase]) return keyCache[phrase];
    var enc = new TextEncoder();
    keyCache[phrase] = crypto.subtle.importKey('raw', enc.encode(phrase), 'PBKDF2', false, ['deriveBits']).then(function (base) {
      return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode('pebbly-backup-v1'), iterations: ITER, hash: 'SHA-256' }, base, 512);
    }).then(function (bits) {
      var b = new Uint8Array(bits), id = Array.prototype.map.call(b.slice(0, 32), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      return crypto.subtle.importKey('raw', b.slice(32), 'AES-GCM', false, ['encrypt', 'decrypt']).then(function (key) { return { id: id, key: key }; });
    });
    return keyCache[phrase];
  }
  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function unb64(s) { var t = atob(s), out = new Uint8Array(t.length); for (var i = 0; i < t.length; i++) out[i] = t.charCodeAt(i); return out; }
  function seal(k, data) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k.key, new TextEncoder().encode(JSON.stringify({ v: 1, at: Date.now(), data: data }))).then(function (ct) {
      var c = new Uint8Array(ct), out = new Uint8Array(12 + c.length);
      out.set(iv); out.set(c, 12);
      return b64(out);
    });
  }
  function open(k, blob) {
    var all = unb64(blob);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, k.key, all.slice(12)).then(function (pt) {
      return JSON.parse(new TextDecoder().decode(pt)).data || {};
    }, function () { throw new Error('bad_words'); });
  }

  /* ------------------------------------------------------------ the data */

  function wanted(k) { return INCLUDE.test(k) && !SKIP.test(k); }
  function collect() {
    var out = {};
    try {
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (wanted(k)) out[k] = localStorage.getItem(k); }
    } catch (e) {}
    return out;
  }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function ident(x) { return x && typeof x === 'object' && (x.code || x.id) ? 'k:' + (x.code || x.id) : JSON.stringify(x); }
  // a wins for single values; lists and objects are added together.
  function mergeVal(a, b) {
    if (a === undefined || a === null) return b;
    if (b === undefined || b === null) return a;
    if (Array.isArray(a) && Array.isArray(b)) {
      var seen = {}, out = [];
      a.concat(b).forEach(function (x) { var id = ident(x); if (!seen[id]) { seen[id] = true; out.push(x); } });
      return out;
    }
    if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      var o = {};
      Object.keys(b).forEach(function (k) { o[k] = b[k]; });
      Object.keys(a).forEach(function (k) { o[k] = mergeVal(a[k], b[k]); });
      return o;
    }
    return a;
  }
  // Two snapshots ({ key: stored text }); a wins for single values.
  function merge(a, b) {
    var out = {};
    Object.keys(b).forEach(function (k) { if (wanted(k)) out[k] = b[k]; });
    Object.keys(a).forEach(function (k) {
      if (!(k in b)) { out[k] = a[k]; return; }
      var x, y;
      try { x = JSON.parse(a[k]); y = JSON.parse(b[k]); } catch (e) { out[k] = a[k]; return; }
      out[k] = JSON.stringify(mergeVal(x, y));
    });
    return out;
  }
  function fit(data) {
    if (JSON.stringify(data).length * 1.4 < MAX) return data;
    var out = {};
    Object.keys(data).forEach(function (k) { if (!OPTIONAL.test(k)) out[k] = data[k]; });
    return out;
  }
  function summary(data) {
    data = data || collect();
    var hosted = 0, joined = 0;
    OWNERS.forEach(function (k) { try { hosted += Object.keys(JSON.parse(data[k] || '{}') || {}).length; } catch (e) {} });
    try {
      var f = JSON.parse(data.pebbly_notify_feeds || '{}') || {};
      joined = Object.keys(f).filter(function (id) { return /:guest$/.test(id); }).length;
    } catch (e) {}
    return { hosted: hosted, joined: joined };
  }

  /* ------------------------------------------------------------ saving */

  var busy = null;
  function st() { return load(ST, null); }
  function setSt(s) { if (s) save(ST, s); else try { localStorage.removeItem(ST); } catch (e) {} }
  function hashOf(data) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(Object.keys(data).sort().map(function (k) { return [k, data[k]]; })))).then(function (h) { return b64(new Uint8Array(h)); }); }

  // Saves this phone's data (merged with whatever the copy already has) if it changed since the last save.
  function sync(force) {
    var s = st();
    if (!s || !s.words) return Promise.resolve(false);
    if (busy) return busy;
    var data = collect();
    busy = hashOf(data).then(function (h) {
      if (!force && h === s.hash) return false;
      return derive(s.words).then(function (k) {
        function attempt(tries) {
          return rpc('backup_get', { p_id: k.id }).then(function (cur) {
            return (cur ? open(k, cur.blob) : Promise.resolve({})).then(function (remote) {
              return seal(k, fit(merge(data, remote)));
            }).then(function (blob) {
              return rpc('backup_put', { p_id: k.id, p_blob: blob, p_version: cur ? cur.version : 0 });
            }).catch(function (e) {
              if (e.message === 'backup_conflict' && tries < 3) return attempt(tries + 1);
              throw e;
            });
          });
        }
        return attempt(0);
      }).then(function (v) {
        var now = st();
        if (now && now.words && now.words.join(' ') === s.words.join(' ')) { now.hash = h; now.version = v; now.savedAt = Date.now(); now.error = null; setSt(now); }
        return true;
      });
    }).then(function (r) { busy = null; return r; }, function (e) {
      busy = null;
      var now = st(); if (now) { now.error = e.message; setSt(now); }
      throw e;
    });
    return busy;
  }

  function create() {
    var words = newWords();
    setSt({ words: words, version: 0, hash: null, savedAt: null });
    return sync(true).then(function () { return words; }, function (e) { setSt(null); throw e; });
  }

  function restore(text) {
    var words = parse(text);
    if (!words) return Promise.reject(new Error('bad_words'));
    return derive(words).then(function (k) {
      return rpc('backup_get', { p_id: k.id }).then(function (cur) {
        if (!cur) throw new Error('not_found');
        return open(k, cur.blob);
      });
    }).then(function (remote) {
      var merged = merge(remote, collect());           // the backup wins for single values (who you are)
      Object.keys(merged).forEach(function (k) { try { localStorage.setItem(k, merged[k]); } catch (e) {} });
      setSt({ words: words, version: 0, hash: null, savedAt: null });
      return sync(true).catch(function () {}).then(function () { return summary(merged); });
    });
  }

  function forget() { setSt(null); }
  function remove() {
    var s = st();
    if (!s || !s.words) return Promise.resolve();
    return derive(s.words).then(function (k) { return rpc('backup_delete', { p_id: k.id }); }).then(function () { setSt(null); });
  }

  // Keep it up to date: shortly after each page opens, every minute while it's open, and when leaving.
  var s0 = st();
  if (s0 && s0.words) {
    setTimeout(function () { sync().catch(function () {}); }, 2500);
    setInterval(function () { if (document.visibilityState === 'visible') sync().catch(function () {}); }, 60000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') sync().catch(function () {}); });
  }

  window.PebblyBackup = {
    state: function () { var s = st(); return s && s.words ? { on: true, words: s.words.slice(), savedAt: s.savedAt, error: s.error } : { on: false }; },
    create: create, restore: restore, sync: sync, forget: forget, remove: remove, parse: parse,
    summary: function () { return summary(); },
    WORDS: WORDS
  };
})();
