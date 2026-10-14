// Baby Names (/babynames/) end to end against a local Postgres (see CLAUDE.md → Testing).
// Setup: sh tests/setup_db.sh babynames; serve the repo root: python3 -m http.server 8792
// Run:   NODE_PATH=$(npm root -g) node tests/babynames_test.js [db] [port] [screenshot dir]
// Covers: catalog, name keys, import parsing and the AI prompt; create; swiping (drag both ways, buttons, keys),
// star rating, undo; second phone joining as the partner; partner's likes come first; matches and the match toast;
// our list (order by stars, moving up/down, comments, changing a rating, "only one likes", find a name);
// adding your own name (matches an existing row by name or nickname, or adds a new one); AI import (dedup by
// name or nickname, "swipe just these", removing the list); gender and popularity filters; reload keeps
// everything (stored in the database); "I said no" names back; deleting; plus screenshots (light, dark, 320px).
const { chromium, devices } = require('playwright');
const { phone } = require('./pg_bridge');
const DB = process.argv[2] || 'babynames', PORT = process.argv[3] || '8792', SS = process.argv[4] || '';
const B = 'http://localhost:' + PORT + '/babynames/';
let pass = 0, fail = 0; const check = (ok, m) => ok ? pass++ : (fail++, console.log('FAIL', m));
const all = [];
async function mk(b, opts) { const p = await phone(b, devices, DB, opts); all.push(p); return p; }
const shot = async (p, name, full) => { if (SS) await p.screenshot({ path: SS + '/' + name + '.png', fullPage: full !== false }); };
const cardName = p => p.$eval('#card .big', e => e.textContent).catch(() => '');
const st = p => p.evaluate(() => JSON.parse(JSON.stringify(__names.state())));
async function like(p, stars) {
  const n = await cardName(p);
  await p.click('#acts .yes'); await p.waitForSelector('dialog [data-star]');
  await p.click('dialog [data-star="' + stars + '"]');
  await p.waitForFunction(n => !document.querySelector('dialog') && document.querySelector('#card .big') && document.querySelector('#card .big').textContent !== n, n);
  return n;
}
async function nope(p) {
  const n = await cardName(p);
  await p.click('#acts .no');
  await p.waitForFunction(n => { const c = document.querySelector('#card .big'); return !c || c.textContent !== n; }, n);
  return n;
}
async function drag(p, dx) {
  const box = await (await p.$('#card')).boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await p.mouse.move(x, y); await p.mouse.down();
  for (let i = 1; i <= 6; i++) await p.mouse.move(x + dx * i / 6, y + 4);
  await p.mouse.up();
}
async function tab(p, v) { await p.click('.tabs [data-v=' + v + ']'); }

(async () => {
  const b = await chromium.launch();
  const a = await mk(b);
  await a.goto(B);

  /* ---- pure functions */
  const u = await a.evaluate(() => {
    const N = window.__names;
    return { count: N.count(), k1: N.key(' Zoë '), k2: N.key('Mary-Kate'), k3: N.key('constructor'),
      p1: N.parseImport('Here you go:\n```json\n{"names": [{"name": "saoirse", "alternates": ["Seersha"], "gender": "girl", "popularity": 12.4},' +
        ' {"name": "Saoirse"}, {"name": "Rowan", "nicknames": "Ro, Row", "sex": "unisex", "popularity": 140}]}\n```\nEnjoy!'),
      p2: N.parseImport('1. Ada\n2. Hazel (nature)\n- Iris'),
      p3: N.parseImport('[{"first_name":"Finn","alternate_names":["Finnian"],"gender":"male","pop":"40"},]'),
      prompt: N.aiPrompt('g', 'Irish', 25, ['Olivia']) };
  });
  check(u.count > 2500, 'catalog has ' + u.count + ' names');
  check(u.k1 === 'zoe' && u.k2 === 'marykate', 'keys ignore accents and punctuation');
  check(u.p1.length === 2 && u.p1[0].n === 'Saoirse' && u.p1[0].g === 'g' && u.p1[0].p === 12 && u.p1[0].alt[0] === 'Seersha', 'parse JSON in a code block, dedup: ' + JSON.stringify(u.p1));
  check(u.p1[1].alt.join() === 'Ro,Row' && u.p1[1].g === 'u' && u.p1[1].p === 100, 'parse string alternates, unisex, clamp popularity');
  check(u.p2.map(x => x.n).join() === 'Ada,Hazel,Iris', 'plain list of names: ' + JSON.stringify(u.p2));
  check(u.p3.length === 1 && u.p3[0].n === 'Finn' && u.p3[0].g === 'b' && u.p3[0].p === 40 && u.p3[0].alt[0] === 'Finnian', 'other field names, trailing comma');
  check(/25 baby names for a baby girl/.test(u.prompt) && u.prompt.includes('Irish') && u.prompt.includes('Olivia') && u.prompt.includes('"alternates"') && u.prompt.includes('"popularity"'), 'AI prompt');
  await shot(a, 'home');

  /* ---- create */
  await a.click('#createForm [type=submit]');
  check((await a.textContent('#formErr')).includes('your name'), 'needs a name');
  await a.fill('[name=a]', 'Ben'); await a.fill('[name=b]', 'Sam');
  await a.click('.seg span:has-text("Girl names")');
  await a.click('#createForm [type=submit]');
  await a.waitForSelector('#card');
  const code = new URL(a.url()).searchParams.get('d');
  check(/^[a-z0-9]{8}$/.test(code), 'created ' + code);
  check((await a.textContent('h1')).includes('Ben & Sam'), 'title from both names');
  check((await a.textContent('.created')).includes('Send this link to Sam'), 'share card');
  check((await a.textContent('.mebar')).includes('Ben'), 'creator swipes as Ben');
  check((await a.textContent('#filterBtn')).includes('Girls'), 'gender preference from setup');
  check((await a.textContent('#card .g')).match(/Girl|Either/), 'only girl (or either) names');
  check(await a.isVisible('#card .pop') && (await a.textContent('#card .pop')).includes('/100'), 'popularity on the card');
  await shot(a, 'swipe');

  /* ---- swiping on Ben's phone */
  check(await a.isDisabled('#acts .undo'), 'nothing to undo yet');
  const dl = await cardName(a);
  await drag(a, 200);
  await a.waitForSelector('dialog [data-star]');
  check((await a.textContent('dialog')).includes(dl), 'swipe right asks for stars');
  await shot(a, 'stars', false);
  await a.click('dialog [data-star="5"]');
  await a.waitForFunction(n => document.querySelector('#card .big').textContent !== n, dl);
  let s = await st(a);
  check(s.votes.a[dl.toLowerCase()] === 5, 'drag right + 5 stars saved');
  const dn = await cardName(a);
  await drag(a, -200);
  await a.waitForFunction(n => document.querySelector('#card .big').textContent !== n, dn);
  s = await st(a);
  check(s.votes.a[dn.toLowerCase()] === 0, 'drag left = no');
  // small drag snaps back
  const keep = await cardName(a);
  await drag(a, 30); await a.waitForTimeout(300);
  check((await cardName(a)) === keep, 'short drag does nothing');
  // escape on stars puts the card back
  await a.click('#acts .yes'); await a.waitForSelector('dialog'); await a.keyboard.press('Escape');
  await a.waitForFunction(n => !document.querySelector('dialog') && document.querySelector('#card .big').textContent === n, keep);
  check((await st(a)).votes.a[keep.toLowerCase()] === undefined, 'closing the stars saves nothing');
  // buttons + keys
  const liked = [dl];
  liked.push(await like(a, 5)); liked.push(await like(a, 3));
  const n1 = await nope(a);
  await a.keyboard.press('ArrowLeft');
  await a.waitForFunction(() => Object.keys(__names.state().votes.a).length === 6);
  pass++;
  // undo
  await a.click('#acts .undo');
  await a.waitForFunction(() => Object.keys(__names.state().votes.a).length === 5);
  await a.click('#acts .undo');
  await a.waitForFunction(n => document.querySelector('#card .big').textContent === n, n1);
  check(!((n1.toLowerCase()) in (await st(a)).votes.a), 'undo twice brings back ' + n1);
  await nope(a);
  check((await a.textContent('#seen')).includes('decided on 5 of'), 'progress: ' + await a.textContent('#seen'));

  /* ---- Sam joins on a second phone */
  const c = await mk(b);
  await c.goto(B + '?d=' + code);
  await c.waitForSelector('[data-act=iam]');
  check((await c.textContent('#app')).includes('I’m Ben') && (await c.textContent('#app')).includes('I’m Sam'), 'who is swiping');
  await c.click('[data-act=iam][data-slot=b]');
  await c.waitForSelector('#card');
  check((await c.textContent('.mebar')).includes('Sam'), 'swiping as Sam');
  // Ben's two 5-star names come first for Sam
  const first2 = [await like(c, 4)];
  await c.waitForSelector('#toast.match');
  check((await c.textContent('#toast')).includes('match'), 'match toast');
  first2.push(await like(c, 5));
  check(first2.every(n => liked.includes(n)), 'partner’s likes first: ' + first2 + ' vs ' + liked);
  await shot(c, 'partner');
  // live on Ben's phone
  await a.waitForFunction(() => /\(2\)/.test(document.querySelector('#matchN').textContent), null, { timeout: 8000 });
  pass++;

  /* ---- our list */
  await tab(a, 'list');
  await a.waitForSelector('.nrow');
  let rows = await a.$$eval('ol.rows .open b', l => l.map(x => x.textContent));
  check(rows.length === 2 && rows.every(n => first2.includes(n)), 'both-liked list: ' + rows);
  // order: stars total (5+5 before 5+4)
  s = await st(a);
  const tot = n => s.votes.a[n.toLowerCase()] + s.votes.b[n.toLowerCase()];
  check(tot(rows[0]) >= tot(rows[1]), 'ordered by stars');
  await a.click('ol.rows li:nth-child(2) [data-act=up]');
  await a.waitForFunction(r => document.querySelector('ol.rows .open b').textContent === r, rows[1]);
  const moved = await a.$$eval('ol.rows .open b', l => l.map(x => x.textContent));
  check(moved[0] === rows[1], 'moved up');
  await c.click('.tabs [data-v=list]');
  await c.waitForFunction(r => { const x = document.querySelector('ol.rows .open b'); return x && x.textContent === r; }, rows[1], { timeout: 8000 });
  pass++;
  // comment + change rating from the name's page
  await a.click('ol.rows li:nth-child(1) [data-act=detail][data-note]');
  await a.waitForSelector('#noteForm');
  check(await a.evaluate(() => document.activeElement.name === 't'), 'comment box focused');
  await a.fill('#noteForm textarea', 'Love it with Rose as a middle name');
  await a.click('#noteForm [type=submit]');
  await a.waitForFunction(() => document.querySelector('#dNotes').textContent.includes('Rose'));
  await a.click('dialog [data-rate="2"]');
  await a.waitForFunction(n => __names.state().votes.a[n.toLowerCase()] === 2, moved[0]);
  check((await a.textContent('dialog')).includes('Sam'), 'shows Sam’s rating');
  await shot(a, 'detail', false);
  await a.click('dialog [data-close]');
  check((await a.textContent('ol.rows li:nth-child(1) .notes')).includes('Ben:') && (await a.textContent('ol.rows li:nth-child(1)')).includes('Rose'), 'comment under the name');
  check((await a.$$eval('ol.rows .open b', l => l.map(x => x.textContent)))[0] === moved[0], 'own order kept after re-rating');
  await c.waitForFunction(() => document.querySelector('ol.rows').textContent.includes('Rose'), null, { timeout: 8000 });
  pass++;
  // only one likes: Ben's 3-star name if Sam says no to it
  await c.click('ol.rows li:nth-child(1) [data-act=detail]:not([data-note])');
  await c.waitForSelector('#dTop');
  check((await c.textContent('#dTop')).includes('You both like it'), 'both like tag');
  await c.click('dialog [data-close]');
  // the four folded sections (Ben's view)
  const rest = liked.find(n => !first2.includes(n));
  const sec = (p, id) => p.$eval('details[data-s=' + id + ']', d => d.textContent);
  check(/You like, waiting for Sam \(1\)/.test(await sec(a, 'wait')) && (await sec(a, 'wait')).includes(rest), 'You like, waiting for Sam: ' + await sec(a, 'wait'));
  async function rateOn(p, name, v) {
    await p.fill('#findBox', name.toLowerCase());
    await p.click('#findRes button:has-text("' + name + '")');
    await p.waitForSelector('#dTop');
    await p.click('dialog [data-rate="' + v + '"]');
    await p.waitForFunction(([n, v]) => { const st = __names.state(); return Object.values(st.votes).some(x => x[n.toLowerCase()] === v); }, [name, v]);
    await p.click('dialog [data-close]'); await p.fill('#findBox', '');
  }
  await rateOn(c, rest, 0);          // Sam: no to Ben's 3-star name
  await rateOn(c, 'Mildred', 4);     // Sam likes one Ben hasn't seen
  await a.waitForFunction(() => document.querySelector('details[data-s=mine]').textContent.includes('Mildred'), null, { timeout: 8000 });
  check((await sec(a, 'nope')).includes(rest) && (await sec(a, 'nope')).includes('doesn’t'), 'You like, Sam doesn’t: ' + await sec(a, 'nope'));
  check(/Sam likes, waiting for you \(1\)/.test(await sec(a, 'mine')) && !(await sec(a, 'mine')).includes('4★'), 'Sam likes, waiting for you (no stars shown): ' + await sec(a, 'mine'));
  check(/None yet/.test(await sec(a, 'wait')), 'waiting for Sam now empty');
  await a.click('details[data-s=mine] summary');
  await shot(a, 'sections');
  await a.click('details[data-s=mine] .nchip');
  await a.waitForSelector('#dTop');
  await a.click('dialog .nobtn');
  await a.waitForFunction(() => __names.state().votes.a.mildred === 0);
  await a.click('dialog [data-close]');
  check((await sec(a, 'theirsNo')).includes('Mildred') && (await sec(a, 'theirsNo')).includes('Sam likes, you don’t'), 'Sam likes, you don’t: ' + await sec(a, 'theirsNo'));
  check(await a.$eval('details[data-s=mine]', d => d.open), 'opened section stays open after a change');
  // find a name
  await a.fill('#findBox', 'jimm');
  await a.waitForSelector('#findRes li');
  check((await a.textContent('#findRes')).includes('Jimmy') && (await a.textContent('#findRes')).includes('James'), 'find by name and nickname: ' + await a.textContent('#findRes'));
  await shot(a, 'list');

  /* ---- add your own name */
  await tab(a, 'swipe');
  await a.click('[data-act=menu]'); await a.click('dialog [data-m=suggest]');
  await a.fill('dialog [name=n]', 'james');
  await a.waitForSelector('dialog .preview');
  check((await a.textContent('dialog .preview')).includes('James is already here') && (await a.textContent('dialog .preview')).includes('Jimmy'), 'James matches the existing row (nicknames, popularity)');
  await shot(a, 'suggest', false);
  await a.click('dialog [data-star="4"]');
  await a.waitForFunction(() => __names.state().votes.a.james === 4);
  s = await st(a);
  check(s.names.james && s.names.james.by === 'a' && !s.names.james.n, 'James kept as the built-in row, marked as Ben’s suggestion');
  await a.click('[data-act=menu]'); await a.click('dialog [data-m=suggest]');
  await a.fill('dialog [name=n]', 'Jaimz');
  await a.waitForSelector('#sgNew:not([hidden])');
  await a.click('dialog .seg span:has-text("Boy")');
  await a.fill('dialog [name=alt]', 'Jai, Jim');
  await a.click('dialog [data-star="5"]');
  await a.waitForFunction(() => __names.state().votes.a.jaimz === 5);
  s = await st(a);
  check(s.names.jaimz.n === 'Jaimz' && s.names.jaimz.g === 'b' && s.names.jaimz.alt.join() === 'Jai,Jim', 'new name added');
  // nickname: "Ellie" is its own built-in name; "Nell" points to Eleanor if not built in
  const nick = await a.evaluate(() => [__names.findMatch('Ellie', []), __names.findMatch('Zzlenor', ['Eleanor'])]);
  check(nick[0] && nick[0].k === 'ellie' && nick[0].how === 'name', 'exact name wins over nickname');
  check(!nick[1], 'alternates only match when the other name lists it back');
  // add your own nickname: Beck for Beckett (from Find a name), shows on the card, matches when typed, removable
  await tab(a, 'list');
  await a.fill('#findBox', 'beckett');
  await a.click('#findRes button:has-text("Beckett")');
  await a.waitForSelector('#altForm');
  await a.fill('#altForm [name=alt]', 'beck, Beckett');
  await a.click('#altForm [type=submit]');
  await a.waitForFunction(() => document.querySelector('#dAlts').textContent.includes('Beck'));
  s = await st(a);
  check(JSON.stringify(s.names.beckett.alt) === '["Beck"]', 'nickname saved (capitalised, the name itself skipped): ' + JSON.stringify(s.names.beckett));
  check(await a.isVisible('#dAlts [data-delalt="Beck"]'), 'added nickname can be removed');
  await shot(a, 'nickname', false);
  const nb = await a.evaluate(() => __names.findMatch('Beck', []));
  check(nb && nb.k === 'beckett', 'typing Beck now finds Beckett: ' + JSON.stringify(nb));
  await c.waitForFunction(() => { const n = __names.state().names.beckett; return n && n.alt && n.alt[0] === 'Beck'; }, null, { timeout: 8000 });
  pass++;
  await a.click('#dAlts [data-delalt="Beck"]');
  await a.waitForFunction(() => !__names.state().names.beckett);
  pass++;
  await a.click('dialog [data-close]');
  await a.fill('#findBox', '');
  // from the swipe card
  await tab(a, 'swipe');
  const cn = await cardName(a);
  await a.click('#card [data-alt]');
  await a.waitForSelector('#altForm');
  check(await a.evaluate(() => document.activeElement.name === 'alt'), 'card link opens the nickname box');
  await a.fill('#altForm [name=alt]', 'Zuzu');
  await a.click('#altForm [type=submit]');
  await a.waitForFunction(() => document.querySelector('#dAlts').textContent.includes('Zuzu'));
  await a.click('dialog [data-close]');
  check((await cardName(a)) === cn && (await a.textContent('#card .alts')).includes('Zuzu'), 'card shows the new nickname, same card');
  // Sam (girls filter) doesn't get the boy name; switch gender for both
  await c.waitForFunction(() => __names.state().votes.a.jaimz === 5, null, { timeout: 8000 });
  await c.click('.tabs [data-v=swipe]');
  await c.click('#filterBtn');
  await c.click('dialog .seg span:has-text("Boys")');
  await c.click('dialog [type=submit]');
  await c.waitForFunction(() => document.querySelector('#card .g').textContent.match(/Boy|Either/));
  const sb = await cardName(c);
  check(sb === 'Jaimz' || sb === 'James', 'Ben’s suggestions first for Sam: ' + sb);
  await a.waitForFunction(() => document.querySelector('#filterBtn').textContent.includes('Boys'), null, { timeout: 8000 });
  pass++;
  await shot(c, 'boys');

  /* ---- AI import */
  await a.click('[data-act=menu]'); await a.click('dialog [data-m=ai]');
  await a.waitForSelector('#aiCopy');
  await a.click('dialog .seg span:has-text("Boy")');
  await a.fill('#aiVibe', 'Irish');
  check((await a.textContent('#aiPrompt')).includes('baby boy') && (await a.textContent('#aiPrompt')).includes('Irish'), 'prompt follows the form');
  await a.fill('#aiText', '```json\n{"names":[{"name":"Cillian","alternates":["Killian"],"gender":"boy","popularity":30},' +
    '{"name":"Liam","alternates":["William"],"gender":"boy","popularity":99},' +
    '{"name":"Jimmy","alternates":[],"gender":"boy","popularity":5},' +
    '{"name":"Oisin","alternates":["Osheen"],"gender":"boy","popularity":15},' +
    '{"name":"Osheen","alternates":["Oisin"],"gender":"boy","popularity":2},' +
    '{"name":"Ruairi","alternates":["Rory"],"gender":"boy","popularity":3}]}\n```');
  await a.click('#aiImport');
  await a.waitForSelector('#aiDone .result');
  const res = await a.textContent('#aiDone');
  s = await st(a);
  const lid = Object.keys(s.lists)[0], L = s.lists[lid];
  check(L && L.label === 'Irish (boys)', 'list label: ' + (L && L.label));
  check(L.keys.includes('liam') && L.keys.includes('jimmy') && L.keys.includes('oisin') && !L.keys.includes('osheen'), 'dedup by name and alternate spelling: ' + L.keys);
  check(!s.names.liam || !s.names.liam.n, 'Liam stays the built-in row');
  check(s.names.oisin && s.names.oisin.alt.includes('Osheen') && s.names.oisin.p === 15, 'new name keeps AI popularity and alternates');
  check(/already here/.test(res), 'result explains merged names: ' + res);
  await shot(a, 'ai', false);
  await a.click('#aiDone [data-x=only]');
  await a.waitForFunction(() => document.querySelector('#filterBtn').textContent.includes('Irish'));
  const seen = [];
  for (let i = 0; i < 10; i++) { const n = await cardName(a); if (!n) break; seen.push(n); await nope(a); }
  check(seen.length && seen.every(n => L.keys.includes(n.toLowerCase().replace(/[^a-z]/g, ''))), 'swipe just the AI list: ' + seen);
  check(await a.isVisible('.done'), 'end of the list');
  check((await a.textContent('.done')).includes('every name'), 'done message');
  await a.click('.done [data-act=filters]');
  await a.click('dialog .opt span:has-text("All names")');
  await a.click('dialog .seg span:has-text("Any")');
  await a.click('dialog [type=submit]');
  await a.waitForSelector('#card');
  pass++;
  // popularity filter
  await a.click('#filterBtn'); await a.click('dialog .seg span:has-text("Popular")'); await a.click('dialog [type=submit]');
  await a.waitForTimeout(200);
  check(+(await a.textContent('#card .pop b')).split('/')[0] >= 50, 'popular names only');
  await a.click('#filterBtn'); await a.click('dialog [name=pop][value=any] + span'); await a.click('dialog [type=submit]');
  // bring back the no's
  const noCount = Object.values((await st(a)).votes.a).filter(v => v === 0).length;
  await a.click('#filterBtn'); await a.click('dialog [data-x=again]');
  await a.waitForFunction(() => !Object.values(__names.state().votes.a).some(v => v === 0));
  check(noCount > 0, 'no’s cleared (' + noCount + ')');
  // remove the AI list: its new names go, Liam (built in) stays
  await a.click('[data-act=menu]'); await a.click('dialog [data-m=lists]');
  await a.click('dialog [data-del]');
  await a.waitForFunction(() => !Object.keys(__names.state().lists).length);
  s = await st(a);
  check(!s.names.oisin && !s.names.cillian.ai && !s.names.cillian.by && !s.names.liam.ai, 'AI list removed with its new names: ' + JSON.stringify([s.names.oisin, s.names.cillian, s.names.liam]));
  await a.click('dialog [data-close]');

  /* ---- stored in the database: a fresh phone (no saved data) sees everything */
  const f = await mk(b);
  await f.goto(B + '?d=' + code);
  await f.click('[data-act=iam][data-slot=a]');
  await f.waitForSelector('#card');
  await f.click('.tabs [data-v=list]');
  await f.click('[name=lg][value=any] + span');
  await f.waitForSelector('ol.rows');
  check((await f.textContent('ol.rows')).includes('Rose') && (await f.$$eval('ol.rows .open b', l => l[0].textContent)) === moved[0], 'list, order and comments come from the database');
  // the "Not you?" link
  await f.click('[data-act=switch]');
  await f.waitForSelector('[data-act=iam]');
  pass++;

  /* ---- screenshots */
  if (SS) {
    const dk = await mk(b, { colorScheme: 'dark' });
    await dk.goto(B + '?d=' + code); await dk.click('[data-act=iam][data-slot=b]'); await dk.waitForSelector('#card');
    await shot(dk, 'dark_swipe');
    await dk.click('.tabs [data-v=list]'); await dk.click('[name=lg][value=any] + span'); await dk.waitForSelector('ol.rows'); await shot(dk, 'dark_list');
    await dk.click('ol.rows li:nth-child(1) [data-act=detail]:not([data-note])'); await dk.waitForTimeout(200); await shot(dk, 'dark_detail', false);
    await dk.goto(B); await shot(dk, 'dark_home');
    const sm = await mk(b, { viewport: { width: 320, height: 640 } });
    await sm.goto(B + '?d=' + code); await sm.click('[data-act=iam][data-slot=b]'); await sm.waitForSelector('#card'); await shot(sm, 'w320_swipe');
    check(await sm.evaluate(() => document.documentElement.scrollWidth <= 320), 'no sideways scroll at 320');
    await sm.click('.tabs [data-v=list]'); await sm.click('[name=lg][value=any] + span'); await sm.waitForSelector('ol.rows'); await shot(sm, 'w320_list');
    check(await sm.evaluate(() => document.documentElement.scrollWidth <= 320), 'list no sideways scroll at 320');
  }

  /* ---- not found, delete */
  const n = await mk(b);
  await n.goto(B + '?d=zzzzzzzz');
  await n.waitForSelector('.state h1');
  check((await n.textContent('h1')) === 'Shortlist not found', 'not found');
  await a.click('[data-act=menu]'); await a.click('dialog [data-m=delete]');
  await a.waitForSelector('#createForm');
  check(!(await a.textContent('#app')).includes('Ben & Sam'), 'deleted and gone from Your shortlists');
  await c.waitForSelector('.banner', { timeout: 10000 });
  check((await c.textContent('.banner')).includes('deleted'), 'other phone told it was deleted');

  for (const p of all) check(!p.errs.length, 'page errors: ' + p.errs.join());
  console.log(pass + ' passed, ' + fail + ' failed'); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ' passed:', e.message.split('\n').slice(0, 3).join(' ')); process.exit(1); });
