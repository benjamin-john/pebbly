// RSVP: the host's FAQ and the "Group text" button, against a local Postgres.
// Setup: sh tests/setup_db.sh rf; serve the repo root on port 8773; NODE_PATH=$(npm root -g) node tests/rsvp_faq_test.js
const { chromium, devices } = require('playwright');
const { phone } = require('./pg_bridge');
const B = 'http://localhost:8773/rsvp/';
const DB = process.env.DB || 'rf', SHOTS = process.env.SHOTS || '/tmp';
let pass = 0, fail = 0; const check = (ok, m) => ok ? pass++ : (fail++, console.log('FAIL', m));
(async () => {
  const b = await chromium.launch();
  const host = await phone(b, devices, DB);
  await host.goto(B);
  await host.fill('input[name=title]', 'Thanksgiving');
  // FAQ: an answer without a question is caught
  await host.fill('[data-faq="a"][data-i="0"]', 'Yes, on a leash');
  await host.click('#eventForm button[type=submit]');
  check((await host.textContent('#formErr')).includes('needs its question'), 'answer without a question refused');
  await host.fill('[data-faq="q"][data-i="0"]', 'Can I bring my dog?');
  await host.click('[data-act=faq-add]');
  await host.fill('[data-faq="q"][data-i="1"]', 'Where do I park?');
  await host.fill('[data-faq="a"][data-i="1"]', 'On the street.\nMap: https://example.com/map');
  await host.click('[data-act=faq-add]'); // a blank third row is ignored
  await host.click('#eventForm button[type=submit]');
  await host.waitForSelector('.host');
  const code = new URL(host.url()).searchParams.get('e');
  const order = await host.$$eval('section[id]', l => l.map(x => x.id));
  check(order.indexOf('faq') === order.indexOf('comments') + 1, 'FAQ comes right after comments: ' + order.join(','));

  /* two guests with numbers, one without */
  for (const [f, l, ph] of [['Amy', 'Lee', '612 555 0101'], ['Cal', 'Ng', '(612) 555-0102'], ['Dee', 'Ox', '']]) {
    const g = await phone(b, devices, DB);
    await g.goto(B + '?e=' + code); await g.waitForSelector('#me');
    await g.click('[data-act=status][data-id=going]');
    await g.fill('#rFirst', f); await g.fill('#rLast', l);
    if (ph) await g.fill('#rPhone', ph);
    await g.click('#rsvpForm button[type=submit]'); await g.waitForSelector('.myans');
    if (f === 'Amy') {
      const qs = await g.$$eval('.faq summary', l => l.map(x => x.textContent));
      check(qs.length === 2 && qs[0] === 'Can I bring my dog?' && qs[1] === 'Where do I park?', 'guest sees the two questions: ' + qs);
      check(!(await g.isVisible('.faq details:nth-child(2) p')), 'answers start closed');
      await g.click('.faq details:nth-child(2) summary');
      check((await g.textContent('.faq details:nth-child(2) p')).includes('On the street.\nMap:'), 'answer keeps its line break');
      check(await g.getAttribute('.faq details:nth-child(2) p a', 'href') === 'https://example.com/map', 'web address in an answer is a link');
      await g.screenshot({ path: SHOTS + '/rsvp-faq-guest.png', fullPage: true });
      await g.emulateMedia({ colorScheme: 'dark' });
      await g.screenshot({ path: SHOTS + '/rsvp-faq-guest-dark.png', fullPage: true });
    }
    check(!g.errs.length, f + ' page errors: ' + g.errs.join('; '));
    await g.context().close();
  }

  /* group text */
  await host.reload(); await host.waitForSelector('#textList');
  await host.uncheck('#smsLink');
  check(!(await host.locator('.grouptext').count()), 'no group button with nothing to send');
  await host.check('#smsLink');
  await host.fill('#smsBody', 'Dinner at 4!');
  await host.waitForSelector('.grouptext a');
  const href = await host.getAttribute('.grouptext a', 'href');
  const m = /^sms:([^?]+)\?body=(.*)$/.exec(href);
  check(m && m[1] === '+16125550101,+16125550102', 'both numbers, in order: ' + href);
  check(m && decodeURIComponent(m[2]) === 'Dinner at 4!\n\n' + B + '?e=' + code || (m && decodeURIComponent(m[2]).startsWith('Dinner at 4!\n\nhttp')), 'message and link prefilled: ' + (m && decodeURIComponent(m[2])));
  check((await host.textContent('.grouptext a')).includes('all 2'), 'button says how many');
  await host.locator('#host').scrollIntoViewIfNeeded();
  await host.locator('.grouptext').screenshot({ path: SHOTS + '/rsvp-grouptext.png' });
  await host.evaluate(() => document.addEventListener('click', e => { if (e.target.closest('a[href^="sms:"]')) e.preventDefault(); }, true));
  await host.click('.grouptext a');
  await host.waitForSelector('.texts li.done:nth-child(2)');
  check(await host.locator('.texts li.done').count() === 2, 'everyone ticked off after the group text');
  // iPhone uses the other address form
  const owner = await host.evaluate(() => { for (const k of Object.keys(localStorage)) { const v = localStorage.getItem(k); if (/owner/i.test(k) && v) return v; } });
  const tok = (owner.match(/[0-9a-f]{32,}/) || [])[0];
  const ios = await phone(b, devices, DB, { ...devices['iPhone 13'] });
  await ios.goto(B + '?e=' + code + '&o=' + tok); await ios.waitForSelector('#textList');
  await ios.fill('#smsBody', 'Hi');
  const ih = await ios.getAttribute('.grouptext a', 'href');
  check(/^sms:\/open\?addresses=\+16125550101,\+16125550102&body=Hi/.test(ih), 'iPhone link form: ' + ih);
  await ios.context().close();

  /* edit: remove the dog question */
  await host.click('[data-act=edit-event]');
  check(await host.inputValue('[data-faq="q"][data-i="1"]') === 'Where do I park?', 'edit form shows the saved FAQ');
  await host.click('[data-act=faq-rm][data-i="0"]');
  await host.click('#eventForm button[type=submit]'); await host.waitForSelector('.host');
  const left = await host.$$eval('.faq summary', l => l.map(x => x.textContent));
  check(left.length === 1 && left[0] === 'Where do I park?', 'one question left after removing: ' + left);
  // removing every question hides the section
  await host.click('[data-act=edit-event]');
  await host.click('[data-act=faq-rm][data-i="0"]');
  await host.click('#eventForm button[type=submit]'); await host.waitForSelector('.host');
  check(!(await host.locator('.faq').count()) && !(await host.textContent('#faq')), 'no FAQ section when empty');
  check(!host.errs.length, 'host page errors: ' + host.errs.join('; '));

  console.log(pass + ' passed, ' + fail + ' failed'); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
