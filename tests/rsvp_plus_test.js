// RSVP: names for plus-ones and notes on bring-list claims, against a local Postgres.
// Setup: sh tests/setup_db.sh rp; serve the repo root on port 8772; NODE_PATH=$(npm root -g) node tests/rsvp_plus_test.js
const { chromium, devices } = require('playwright');
const { phone } = require('./pg_bridge');
const B = 'http://localhost:8772/rsvp/';
const DB = process.env.DB || 'rp', SHOTS = process.env.SHOTS || '/tmp';
let pass = 0, fail = 0; const check = (ok, m) => ok ? pass++ : (fail++, console.log('FAIL', m));
(async () => {
  const b = await chromium.launch();
  const host = await phone(b, devices, DB);
  await host.goto(B);
  await host.fill('input[name=title]', 'Thanksgiving');
  await host.selectOption('select[name=max_plus_ones]', '3');
  await host.click('#eventForm button[type=submit]');
  await host.waitForSelector('.host');
  const code = new URL(host.url()).searchParams.get('e');
  // bring list turned on afterwards: pg_bridge can't pass the create form's item list (a text array)
  await host.click('[data-act=edit-event]');
  await host.check('input[name=bring_list]');
  await host.click('#eventForm button[type=submit]'); await host.waitForSelector('#itemForm');
  // Pie needs three people
  await host.fill('#newItem', 'Pie'); await host.selectOption('#newItemNeeded', '3');
  await host.click('#itemForm button');
  await host.waitForSelector('.item:has-text("Pie") .meta:has-text("Needs 3 people")');

  /* Amy: going +2, names one of them */
  const amy = await phone(b, devices, DB);
  await amy.goto(B + '?e=' + code); await amy.waitForSelector('#me');
  await amy.click('[data-act=status][data-id=going]');
  await amy.fill('#rFirst', 'Amy'); await amy.fill('#rLast', 'Lee');
  check(!(await amy.locator('[data-pn]').count()), 'no name boxes for "Just me"');
  await amy.selectOption('#rPlus', '2');
  check(await amy.locator('[data-pn]').count() === 2, 'two name boxes for +2');
  check(await amy.inputValue('#rFirst') === 'Amy', 'typed name kept when the boxes appear');
  await amy.fill('[data-pn="0"]', 'bob lee');
  await amy.screenshot({ path: SHOTS + '/rsvp-plus-form.png' });
  await amy.click('#rsvpForm button[type=submit]');
  await amy.waitForSelector('.myans');
  const sum = await amy.textContent('.myans');
  check(sum.includes('You’re going +2') && sum.includes('with Bob Lee and +1'), 'summary names the guest: ' + sum);
  const rows = await amy.$$eval('.gbox.going .g', l => l.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  check(rows.length === 2 && /^Amy Lee\+1/.test(rows[0]) && rows[1] === 'Bob Lee', 'going list shows Bob right under Amy, +1 for the unnamed one: ' + rows.join(' | '));
  check((await amy.textContent('.gbox.going .ghead')).includes('(3)'), 'going header counts people');

  /* Cal: +1 without a name → just "+1" */
  const cal = await phone(b, devices, DB);
  await cal.goto(B + '?e=' + code); await cal.waitForSelector('#me');
  await cal.click('[data-act=status][data-id=going]');
  await cal.fill('#rFirst', 'Cal'); await cal.fill('#rLast', 'Ng');
  await cal.selectOption('#rPlus', '1');
  await cal.click('#rsvpForm button[type=submit]');
  await cal.waitForSelector('.myans');
  check(!(await cal.textContent('.myans')).includes('with'), 'no "with" line when names were skipped');
  const crow = await cal.textContent('.gbox.going .g:has-text("Cal Ng")');
  check(crow.includes('+1'), 'unnamed plus-one shows +1: ' + crow);

  /* bring list notes */
  await amy.reload(); await amy.waitForSelector('#bring .item');
  await amy.click('.item:has-text("Pie") [data-act=claim]');
  await amy.waitForSelector('.item:has-text("Pie") [data-act=note]');
  await amy.click('.item:has-text("Pie") [data-act=note]');
  await amy.fill('#noteText', 'I’ll bring pumpkin pie');
  await amy.click('#noteForm button[type=submit]');
  await amy.waitForSelector('.item:has-text("Pie") .cn');
  check((await amy.textContent('.item:has-text("Pie") .cn')).includes('You: “I’ll bring pumpkin pie”'), 'own note shown');
  check((await amy.textContent('.item:has-text("Pie") [data-act=note]')).includes('Edit your note'), 'edit note button');
  await cal.reload(); await cal.waitForSelector('#bring .item');
  check((await cal.textContent('.item:has-text("Pie")')).includes('Amy Lee: “I’ll bring pumpkin pie”'), 'others see the note');
  check(!(await cal.locator('[data-act=note]').count()), 'no note button before claiming');
  await cal.click('.item:has-text("Pie") [data-act=claim]');
  await cal.waitForSelector('.item:has-text("Pie") [data-act=note]');
  await cal.click('.item:has-text("Pie") [data-act=note]');
  await cal.fill('#noteText', 'Apple');
  await cal.click('#noteForm button[type=submit]');
  await cal.waitForSelector('.item:has-text("Pie") .cn >> nth=1');
  check((await cal.textContent('.item:has-text("Pie") .meta')).includes('2 of 3'), 'count still right');
  await cal.screenshot({ path: SHOTS + '/rsvp-plus-bring.png', fullPage: true });
  // clearing a note
  await amy.reload(); await amy.waitForSelector('.item:has-text("Pie") [data-act=note]');
  await amy.click('.item:has-text("Pie") [data-act=note]');
  check(await amy.inputValue('#noteText') === 'I’ll bring pumpkin pie', 'note prefilled');
  await amy.fill('#noteText', '');
  await amy.click('#noteForm button[type=submit]');
  await amy.waitForSelector('.item:has-text("Pie") [data-act=note]:has-text("Add a note")');
  check(!(await amy.textContent('.item:has-text("Pie")')).includes('pumpkin'), 'note removed');

  /* Amy changes to +1: the extra name drops, form keeps Bob */
  await amy.click('[data-act=rsvp-change]');
  check(await amy.inputValue('[data-pn="0"]') === 'Bob Lee', 'name prefilled on change');
  await amy.selectOption('#rPlus', '1');
  await amy.click('#rsvpForm button[type=submit]');
  await amy.waitForSelector('.myans');
  const rows2 = await amy.$$eval('.gbox.going .g', l => l.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  check(/^Amy Lee \(you\)/.test(rows2[0]) && !/\+/.test(rows2[0]) && /^Bob Lee/.test(rows2[1]), 'all guests named → no +N: ' + rows2.join(' | '));
  // host CSVs
  await host.reload(); await host.waitForSelector('#guests .g');
  const [dl] = await Promise.all([host.waitForEvent('download'), host.click('[data-act=dl][data-id=guests]')]);
  const csv = require('fs').readFileSync(await dl.path(), 'utf8');
  check(csv.includes('"Amy","Lee","","Going","1","Bob Lee","2"'), 'responses csv has plus-one names: ' + csv.slice(0, 400));
  const [dl2] = await Promise.all([host.waitForEvent('download'), host.click('[data-act=dl][data-id=bring]')]);
  const csv2 = require('fs').readFileSync(await dl2.path(), 'utf8');
  check(csv2.includes('"Cal Ng: Apple"'), 'bring csv has notes: ' + csv2);
  // can't go clears the names from the list
  await amy.click('[data-act=rsvp-change]');
  await amy.click('[data-act=status][data-id=no]');
  await amy.click('#rsvpForm button[type=submit]');
  await amy.waitForSelector('.me.no');
  check(!(await amy.textContent('#guests')).includes('Bob'), 'no plus-one names when can’t go');
  for (const p of [host, amy, cal]) check(!p.errs.length, p.errs.join());
  console.log(pass + ' passed, ' + fail + ' failed'); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
