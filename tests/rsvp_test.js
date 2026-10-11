// RSVP app end-to-end checks (Playwright, Pixel 7).
// Serve the app:   cd rsvp && python3 -m http.server 8767
// Preview mode:    node tests/rsvp_test.js
// Real database:   PGURL=postgres://postgres@localhost:5433/postgres node tests/rsvp_test.js
//   (needs the `pg` npm package; schema.sql + rsvp_admin.sql loaded, roles anon/authenticated present).
//   Supabase calls from the page are answered by running the same function in that Postgres as role anon.
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:8767/index.html';
const PGURL = process.env.PGURL;
let pass = 0, fail = 0;
function check(ok, msg) { if (ok) { pass++; } else { fail++; console.log('FAIL: ' + msg); } }
function day(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

let pg = null;
async function bridge(ctx) {
  if (!pg) {
    await ctx.route('**/config.js*', r => r.fulfill({ contentType: 'application/javascript', body: 'window.RSVP_CONFIG={SUPABASE_URL:"",SUPABASE_KEY:""};' }));
    return;
  }
  await ctx.route('**/rest/v1/rpc/*', async route => {
    const fn = route.request().url().split('/rpc/')[1];
    const args = JSON.parse(route.request().postData() || '{}');
    const names = Object.keys(args);
    const vals = names.map(k => { const v = args[k]; return (v && typeof v === 'object' && !Array.isArray(v)) ? JSON.stringify(v) : v; });
    if (!/^[a-z_]+$/.test(fn) || names.some(n => !/^p_[a-z_]+$/.test(n))) return route.fulfill({ status: 400, body: '{}' });
    const sql = 'select to_jsonb(public.' + fn + '(' + names.map((n, i) => n + ' => $' + (i + 1)).join(', ') + ')) as r';
    try {
      const res = await pg.query(sql, vals);
      const r = res.rows[0].r;
      await route.fulfill({ status: 200, contentType: 'application/json', body: r === null || r === '' ? 'null' : JSON.stringify(r) });
    } catch (e) {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: e.message, code: e.code }) });
    }
  });
}

(async () => {
  if (PGURL) {
    const { Client } = require('pg');
    pg = new Client({ connectionString: PGURL });
    await pg.connect();
    await pg.query(`create or replace function public._admin_check(p text) returns jsonb language sql as $$
      select case when p = 'pw' then '{"ok":true}'::jsonb else '{"error":"wrong_password"}'::jsonb end $$`);
    await pg.query('grant execute on function _admin_check(text) to anon');
    await pg.query('set role anon');
  }
  console.log(PGURL ? 'Mode: real database' : 'Mode: preview (localStorage)');
  const browser = await chromium.launch();
  const mk = async () => { const c = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] }); await bridge(c); return c; };
  const noHScroll = async (page, where) => check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no sideways scroll: ' + where);

  /* ---- host creates an event */
  const hostCtx = await mk(), host = await hostCtx.newPage();
  const errors = []; host.on('pageerror', e => errors.push(e.message));
  await host.goto(BASE);
  check(await host.locator('h1', { hasText: 'RSVP' }).isVisible(), 'home title');
  check(PGURL ? !(await host.locator('#conn').isVisible()) : await host.locator('.banner', { hasText: 'Preview mode' }).isVisible(), 'connection/preview banner');
  await noHScroll(host, 'home');
  await host.click('#eventForm button[type=submit]');
  check((await host.textContent('#formErr')).includes('name'), 'title required');
  await host.fill('input[name=title]', 'Fall Cookout');
  await host.click('.sw[aria-label=Ocean]');
  await host.click('.em:has-text("🍕")');
  check((await host.textContent('#formPreview')).includes('Fall Cookout') && (await host.textContent('#formPreview')).includes('🍕'), 'live preview');
  await host.fill('input[name=event_date]', day(7));
  await host.fill('input[name=start_time]', '17:30');
  await host.fill('input[name=end_time]', '21:00');
  await host.fill('input[name=location]', '123 Main St, Springfield');
  await host.fill('input[name=host_name]', 'Ben');
  await host.fill('textarea[name=description]', 'Burgers and games.\nBring a chair! Map: www.example.com/map.');
  await host.fill('#linkRows input[data-link=label]', 'Registry');
  await host.fill('#linkRows input[data-link=url]', 'example.com/registry');
  await host.click('[data-act=link-add]');
  await host.fill('#linkRows .linkrow >> nth=1 >> input[data-link=label]', 'Sign-up');
  await host.fill('#linkRows .linkrow >> nth=1 >> input[data-link=url]', 'https://example.org/signup');
  await host.selectOption('select[name=max_plus_ones]', '2');
  await host.fill('input[name=rsvp_by]', day(5));
  await host.fill('input[name=q] >> nth=0', 'Any allergies?');
  check(!(await host.locator('textarea[name=items]').isVisible()), 'bring list off by default');
  await host.check('input[name=bring_list]');
  await host.fill('textarea[name=items]', 'Chips\nDessert\nchips');
  await host.click('#eventForm button[type=submit]');
  await host.waitForSelector('.created');
  const share = await host.inputValue('#shareUrl');
  const code = new URL(share).searchParams.get('e');
  check(/^[a-z2-9]{8}$/.test(code), 'event code ' + code);
  check((await host.textContent('.hero')).includes('Fall Cookout') && (await host.textContent('.hero')).includes('Hosted by Ben'), 'hero');
  check((await host.textContent('#facts')).includes('In 7 days'), 'countdown');
  check((await host.textContent('#facts')).includes('5:30'), 'start time shown');
  check(await host.locator('text=You’re the host').isVisible(), 'host label');
  check(await host.locator('.host').isVisible(), 'host tools');
  check((await host.locator('.item').count()) === 2, 'two bring items (duplicate dropped)');
  check((await host.textContent('#me')).includes('reply by'), 'deadline line');
  check((await host.textContent('.desc')).includes('Bring a chair!'), 'description');
  check((await host.getAttribute('.desc a', 'href')) === 'https://www.example.com/map' && (await host.textContent('.desc')).includes('/map.'), 'description link detected, trailing dot kept as text');
  check((await host.locator('.linkbtns a').count()) === 2 && (await host.getAttribute('.linkbtns a >> nth=0', 'href')) === 'https://example.com/registry', 'link buttons at top');
  await host.click('[data-act=share-details]');
  const details = await host.evaluate(() => navigator.clipboard.readText());
  check(details.includes('🍕 Fall Cookout') && details.includes('📍 123 Main St') && details.includes('Registry: https://example.com/registry') && details.includes('RSVP here: ' + share), 'share details text');
  await noHScroll(host, 'event page');

  // directions + calendar
  check((await host.getAttribute('a:has-text("Directions")', 'href')).includes('123%20Main%20St'), 'directions link');
  await host.click('[data-act=cal]');
  check((await host.getAttribute('a:has-text("Google Calendar")', 'href')).includes('action=TEMPLATE'), 'google calendar link');
  const [dl] = await Promise.all([host.waitForEvent('download'), host.click('[data-act=ics]')]);
  const icsPath = await dl.path(); const ics = require('fs').readFileSync(icsPath, 'utf8');
  check(/DTSTART:\d{8}T\d{6}Z/.test(ics) && ics.includes('SUMMARY:Fall Cookout') && ics.includes('LOCATION:123 Main St\\, Springfield'), 'ics content');

  // announcement
  await host.fill('#annBody', 'Parking is out back. Info at https://example.com/parking');
  await host.click('#annForm button');
  await host.waitForSelector('.ann');
  check((await host.textContent('.ann')).includes('Parking is out back.') && (await host.getAttribute('.ann a', 'href')) === 'https://example.com/parking', 'announcement posted with link');

  // host adds an item that needs 2 people
  await host.fill('#newItem', 'Folding chairs');
  await host.selectOption('#newItemNeeded', '2');
  await host.click('#itemForm button');
  await host.waitForSelector('.item:has-text("Folding chairs")');
  check((await host.textContent('.item:has-text("Folding chairs")')).includes('Needs 2 people'), 'needs 2');

  // In preview mode every "person" shares this browser's storage, so switch identities by hand.
  // With a real database each person gets their own browser context.
  const personPage = async () => (PGURL ? await mk() : hostCtx).newPage();
  const people = {};
  async function save(page, who) {
    if (PGURL) return;
    people[who] = await page.evaluate(() => ({ pid: JSON.parse(localStorage.getItem('rsvp.pid')), first: JSON.parse(localStorage.getItem('rsvp.first') || '""'), last: JSON.parse(localStorage.getItem('rsvp.last') || '""'), owners: localStorage.getItem('rsvp.owners') || '{}' }));
  }
  async function be(page, who) {
    if (PGURL) return;
    const p = people[who] || (people[who] = { pid: who + '-pid', first: '', last: '', owners: '{}' });
    await page.evaluate(p => { localStorage.setItem('rsvp.pid', JSON.stringify(p.pid)); localStorage.setItem('rsvp.first', JSON.stringify(p.first)); localStorage.setItem('rsvp.last', JSON.stringify(p.last)); localStorage.setItem('rsvp.name', '""'); localStorage.setItem('rsvp.phone', '""'); localStorage.setItem('rsvp.owners', p.owners); }, p);
  }
  await save(host, 'host');

  /* ---- guest Ana */
  const ana = await personPage();
  ana.on('pageerror', e => errors.push(e.message));
  await ana.goto(BASE); await be(ana, 'ana');
  await ana.goto(share);
  await ana.waitForSelector('#me');
  check(!(await ana.locator('.host').count()), 'guest sees no host tools');
  check((await ana.textContent('.ann')).includes('Parking'), 'guest sees announcement');
  await ana.click('[data-act=status][data-id=going]');
  await ana.fill('#rFirst', 'Ana');
  await ana.click('#rsvpForm button[type=submit]');
  check(await ana.locator('#rsvpForm').isVisible(), 'last name required');
  await ana.fill('#rLast', 'Lee');
  await ana.fill('#rPhone', '(612) 978-6322');
  await ana.selectOption('#rPlus', '2');
  await ana.fill('#rNote', 'Can’t wait!');
  await ana.fill('input[data-q]', 'peanuts');
  await ana.click('#rsvpForm button[type=submit]');
  await ana.waitForSelector('.myans');
  check((await ana.textContent('.myans')).includes('You’re going +2'), 'ana summary');
  check((await ana.textContent('.counts')).includes('3 going (incl. 2 plus-ones)'), 'counts include plus-ones');
  check((await ana.textContent('#guests')).includes('Ana') && (await ana.textContent('#guests')).includes('(you)'), 'ana in list');
  // claim + add item
  await ana.click('.item:has-text("Chips") [data-act=claim]');
  await ana.waitForSelector('.item:has-text("Chips") .cb[aria-pressed=true]');
  check(true, 'chips claimed');
  await ana.fill('#newItem', 'Ice');
  await ana.click('#itemForm button');
  await ana.waitForSelector('.item:has-text("Ice") .cb[aria-pressed=true]');
  check((await ana.locator('.item:has-text("Ice") [data-act=item-edit]').count()) === 1, 'ana can edit own item');
  check((await ana.locator('.item:has-text("Dessert") [data-act=item-edit]').count()) === 0, 'ana cannot edit host item');
  // comment
  await ana.fill('#cBody', 'See you all there!');
  await ana.click('#cmtForm button');
  await ana.waitForSelector('.cmt');
  check((await ana.textContent('.cmt')).includes('See you all there!') && (await ana.locator('.cmt [data-act=del-post]').count()) === 1, 'comment posted, deletable by author');
  // change RSVP to maybe keeps answers
  await ana.click('[data-act=rsvp-change]');
  check((await ana.inputValue('input[data-q]')) === 'peanuts', 'answers prefilled on change');
  await ana.click('[data-act=status][data-id=maybe]');
  check((await ana.inputValue('#rFirst')) === 'Ana' && (await ana.inputValue('#rLast')) === 'Lee', 'name kept when switching status');
  await ana.click('#rsvpForm button[type=submit]');
  await ana.waitForSelector('.me.maybe');
  check((await ana.textContent('.counts')).includes('3 maybe'), 'maybe count');

  /* ---- guest Bo (no RSVP yet) */
  const bo = await personPage();
  bo.on('pageerror', e => errors.push(e.message));
  await save(ana, 'ana');
  await bo.goto(BASE); await be(bo, 'bo');
  await bo.goto(share);
  await bo.waitForSelector('#me');
  check(!(await bo.textContent('body')).includes('peanuts'), 'answers hidden from other guests');
  check(await bo.locator('.item:has-text("Chips") .cb[disabled]').count() === 1, 'claimed item shows Covered');
  await bo.click('.item:has-text("Dessert") [data-act=claim]');
  await bo.waitForSelector('#rsvpForm');
  check(true, 'claim without name opens RSVP form');
  await bo.click('[data-act=status][data-id=no]');
  check(await bo.locator('#rPlus').count() === 0, 'no plus-ones when can’t go');
  await bo.fill('#rFirst', 'Bo');
  await bo.fill('#rLast', 'Diaz');
  await bo.click('#rsvpForm button[type=submit]');
  await bo.waitForSelector('.me.no');
  await bo.click('.item:has-text("Dessert") [data-act=claim]');
  await bo.waitForSelector('.item:has-text("Dessert") .cb[aria-pressed=true]');
  check((await bo.textContent('.item:has-text("Dessert")')).includes('You'), 'bo claimed dessert');
  await noHScroll(bo, 'guest page');

  /* ---- host view */
  await save(bo, 'bo');
  await be(host, 'host');
  await host.goto(share);
  await host.waitForSelector('#guests .g');
  check((await host.textContent('#guests')).includes('peanuts'), 'host sees answers');
  check((await host.textContent('#guests')).includes('Ana Lee') && (await host.locator('.g .stamp', { hasText: 'Replied' }).count()) === 2, 'host sees full names and reply times');
  check(!(await ana.locator('.stamp').count()), 'guests do not see reply times');
  check(!(await ana.locator('.av').count()) && !(await host.locator('.av').count()), 'no name circles');
  check((await host.textContent('#guests')).includes('(612) 978-6322'), 'host sees phone');
  check(!(await ana.textContent('#guests')).includes('978-6322'), 'guests do not see phones');
  // text guests
  await host.fill('#smsBody', 'See you Saturday!');
  const smsHref = await host.getAttribute('#textList a[data-text]', 'href');
  check(smsHref === 'sms:+16129786322?body=' + encodeURIComponent('See you Saturday!\n\n' + share), 'sms link: ' + smsHref);
  await host.check('.aud input[data-aud=no]');
  check((await host.textContent('#textList')).includes('didn’t give a number: Bo Diaz'), 'people without numbers listed');
  await host.uncheck('.aud input[data-aud=no]');
  await host.uncheck('#smsLink');
  check((await host.getAttribute('#textList a[data-text]', 'href')) === 'sms:+16129786322?body=See%20you%20Saturday!', 'link can be left off');
  await host.uncheck('.aud input[data-aud=maybe]');
  check(!(await host.locator('#textList a[data-text]').count()), 'audience filter (Ana is maybe)');
  await host.check('.aud input[data-aud=maybe]');
  await host.evaluate(() => { const a = document.querySelector('#textList a[data-text]'); a.addEventListener('click', e => e.preventDefault(), { once: true }); a.click(); });
  await host.waitForSelector('#textList li.done');
  check((await host.textContent('#textList')).includes('1 of 1 opened'), 'tick off after texting');
  // downloads
  const [csvDl] = await Promise.all([host.waitForEvent('download'), host.click('[data-act=dl][data-id=guests]')]);
  const csv = require('fs').readFileSync(await csvDl.path(), 'utf8');
  check(csvDl.suggestedFilename() === 'fall-cookout-responses.csv', 'csv name ' + csvDl.suggestedFilename());
  check(csv.startsWith('\ufeff"First name","Last name","Phone","Response"') && csv.includes('"Any allergies?"') && csv.includes('"Ana","Lee","(612) 978-6322","Maybe","2","3","Can’t wait!","peanuts"'), 'responses csv: ' + csv.slice(0, 300));
  const [zipDl] = await Promise.all([host.waitForEvent('download'), host.click('[data-act=dl][data-id=all]')]);
  const zipPath = await zipDl.path();
  const listing = require('child_process').execFileSync('python3', ['-I', '-c',
    'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print("|".join(z.namelist()));print(z.read("fall-cookout-bring-list.csv").decode("utf-8-sig"))', zipPath]).toString();
  check(listing.includes('fall-cookout-responses.csv|fall-cookout-bring-list.csv|fall-cookout-comments.csv|fall-cookout-announcements.csv|fall-cookout-event-details.csv'), 'zip contents: ' + listing.split('\n')[0]);
  check(listing.includes('"Chips","1","1","Ana Lee"'), 'bring list csv in zip');
  // unlimited item
  await host.fill('#newItem', 'Side dishes');
  await host.selectOption('#newItemNeeded', '0');
  await host.click('#itemForm button');
  await host.waitForSelector('.item:has-text("Side dishes")');
  await host.click('.item:has-text("Side dishes") [data-act=claim]');
  if (await host.locator('#rsvpForm').count()) { // host hasn't replied yet: asked for a name first
    await host.fill('#rFirst', 'Ben'); await host.fill('#rLast', 'Smith');
    await host.click('#rsvpForm button[type=submit]'); await host.waitForSelector('.myans');
    await host.click('.item:has-text("Side dishes") [data-act=claim]');
  }
  await host.waitForSelector('.item:has-text("Side dishes") .cb[aria-pressed=true]');
  host.once('dialog', d => d.accept());
  await host.click('.g:has-text("Bo") [data-act=rm-guest]');
  await host.waitForFunction(() => !document.querySelector('#guests').textContent.includes('Bo'));
  check((await host.textContent('.item:has-text("Dessert")')).includes('Nobody yet'), 'removed guest claims cleared');
  // edit event: hide list + count, lower plus-ones
  await host.click('[data-act=edit-event]');
  await host.waitForSelector('#eventForm');
  check((await host.inputValue('input[name=title]')) === 'Fall Cookout', 'edit form prefilled');
  check((await host.inputValue('input[name=q] >> nth=0')) === 'Any allergies?', 'question prefilled');
  await host.check('input[name=hide_guests]');
  await host.check('input[name=hide_count]');
  await host.selectOption('select[name=max_plus_ones]', '1');
  await host.fill('input[name=title]', 'Fall Cookout 2.0');
  await host.click('#eventForm button[type=submit]');
  await host.waitForSelector('.hero:has-text("Fall Cookout 2.0")');
  check((await host.textContent('#guests')).includes('Only you can see this list and the count.'), 'host privacy note');
  check((await host.textContent('#guests')).includes('peanuts'), 'answers survive edit (question id kept)');

  await save(host, 'host');
  await be(ana, 'ana');
  await ana.reload();
  await ana.waitForSelector('#me');
  check((await ana.textContent('#guests')).includes('keeping the guest list private'), 'guest sees private list');
  check(!(await ana.locator('.counts').count()), 'guest sees no count');
  check((await ana.textContent('.myans')).includes('+1'), 'plus-ones trimmed to new max');
  await ana.click('.item:has-text("Side dishes") [data-act=claim]');
  await ana.waitForSelector('.item:has-text("Side dishes") .cb[aria-pressed=true]');
  check((await ana.textContent('.item:has-text("Side dishes")')).includes('Ben') && (await ana.textContent('.item:has-text("Side dishes")')).includes('more welcome'), 'unlimited item takes several people');
  // ana deletes her comment
  ana.once('dialog', d => d.accept());
  await ana.click('.cmt [data-act=del-post]');
  await ana.waitForFunction(() => !document.querySelector('.cmt'));
  check(true, 'comment deleted');

  /* ---- host link on another device */
  if (PGURL) {
    await host.click('[data-act=copy-host]').catch(() => {});
    const tok = await host.evaluate(c => JSON.parse(localStorage.getItem('rsvp.owners'))[c], code);
    const other = await (await mk()).newPage();
    await other.goto(share + '&o=' + tok);
    await other.waitForSelector('.host');
    check(!other.url().includes('&o='), 'host link: key removed from address bar');
  }

  /* ---- closed RSVPs and past events */
  async function quickEvent(page, title, date, rsvpBy, more) {
    await page.goto(BASE);
    await page.fill('input[name=title]', title);
    if (date) await page.fill('input[name=event_date]', date);
    if (rsvpBy) await page.fill('input[name=rsvp_by]', rsvpBy);
    if (more) await more(page);
    await page.click('#eventForm button[type=submit]');
    await page.waitForSelector('.created');
    return page.inputValue('#shareUrl');
  }
  await be(host, 'host');
  const closedUrl = await quickEvent(host, 'Closed one', day(3), day(-1));
  check((await host.textContent('#me')).includes('As the host you can still change replies'), 'host can reply after deadline');
  const pastUrl = await quickEvent(host, 'Old party', day(-2), null);
  check((await host.textContent('#facts')).includes('This event has passed'), 'past banner');
  const tbdUrl = await quickEvent(host, 'Someday', null, null);
  { const f = await host.textContent('#facts'); check(f.includes('Date to be decided') && !(await host.locator('[data-act=cal]').count()), 'date TBD, no calendar: ' + f); }
  check(!(await host.locator('#bring .item, #bring form').count()), 'event without bring list');
  const phoneUrl = await quickEvent(host, 'Phone needed', day(6), null, async pg => { await pg.check('input[name=require_phone]'); });
  const softUrl = await quickEvent(host, 'Soft deadline', day(4), day(-1), async pg => { await pg.uncheck('input[name=rsvp_lock]'); });
  const multiUrl = await quickEvent(host, 'Camping trip', day(10), null, async pg => {
    await pg.fill('input[name=end_date]', day(12)); await pg.fill('input[name=start_time]', '16:00'); await pg.fill('input[name=end_time]', '11:00');
  });
  const ft = await host.textContent('#facts');
  check(ft.includes('–') && ft.includes('Starts 4:00') && ft.includes('ends 11:00') && ft.includes('In 10 days'), 'multi-day dates: ' + ft);
  await host.click('[data-act=cal]');
  const gcal = decodeURIComponent(await host.getAttribute('a:has-text("Google Calendar")', 'href'));
  check(/dates=\d{8}T\d{6}Z\/\d{8}T\d{6}Z/.test(gcal), 'multi-day calendar dates');
  const g2 = await personPage();
  await save(host, 'host');
  await g2.goto(BASE); await be(g2, 'cy');
  await g2.goto(closedUrl);
  await g2.waitForSelector('#me');
  check((await g2.textContent('#me')).includes('RSVPs are closed') && !(await g2.locator('[data-act=status]').count()), 'guest sees closed RSVPs');
  await g2.goto(phoneUrl);
  await g2.click('[data-act=status][data-id=going]');
  await g2.fill('#rFirst', 'Cy'); await g2.fill('#rLast', 'Ng'); await g2.fill('#rPhone', '');
  await g2.click('#rsvpForm button[type=submit]');
  check(await g2.locator('#rsvpForm').isVisible(), 'phone required blocks RSVP');
  await g2.fill('#rPhone', '12');
  await g2.click('#rsvpForm button[type=submit]');
  check(await g2.locator('#rsvpForm').isVisible(), 'bad phone rejected');
  await g2.fill('#rPhone', '612-555-0100');
  await g2.click('#rsvpForm button[type=submit]');
  await g2.waitForSelector('.myans');
  check(true, 'RSVP with required phone');
  await g2.goto(softUrl);
  await g2.waitForSelector('[data-act=status]');
  check((await g2.textContent('#me')).includes('Please reply by'), 'soft deadline still open');
  await g2.goto(BASE);
  check(await g2.locator('.recent li').count() >= 1, 'recent events on home');

  /* ---- admin */
  const adm = await (await mk()).newPage();
  await adm.goto(BASE + '?admin');
  if (PGURL) {
    await adm.fill('#adminPw', 'nope'); await adm.click('#adminForm button');
    await adm.waitForFunction(() => document.querySelector('#adminErr').textContent.includes('Wrong'));
    check(true, 'admin wrong password');
    await adm.fill('#adminPw', 'pw'); await adm.click('#adminForm button');
    await adm.waitForSelector('.admin-list');
    check((await adm.textContent('.admin-list')).includes('Fall Cookout 2.0'), 'admin list');
    await adm.click('.admin-list li:has-text("Old party") [data-act=admin-open]');
    await adm.waitForSelector('.host');
    check((await adm.textContent('.topnav')).includes('Admin: host view'), 'admin opens as host');
    await adm.click('[data-act=to-admin]');
    adm.once('dialog', d => d.accept());
    await adm.click('.admin-list li:has-text("Someday") [data-act=admin-del]');
    await adm.waitForFunction(() => !document.querySelector('.admin-list').textContent.includes('Someday'));
    check(true, 'admin delete');
  } else {
    check((await adm.textContent('body')).includes('Admin mode needs the Supabase connection'), 'admin needs supabase in preview');
  }

  /* ---- host deletes the event */
  await be(host, 'host');
  await host.goto(share);
  await host.waitForSelector('.host');
  host.once('dialog', d => d.accept());
  await host.click('[data-act=delete-event]');
  await host.waitForSelector('#eventForm');
  await host.goto(share);
  await host.waitForSelector('h1:has-text("Event not found")');
  check(true, 'deleted event shows not found');

  check(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  await host.screenshot({ path: process.env.SHOT || '/dev/null' }).catch(() => {});
  await browser.close();
  if (pg) await pg.end();
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
