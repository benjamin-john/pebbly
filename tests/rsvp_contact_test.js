// RSVP "Contact the host" (optional host phone and email), against a local Postgres.
// Setup: sh tests/setup_db.sh rc; serve the repo root on port 8770; NODE_PATH=$(npm root -g) node tests/rsvp_contact_test.js
const { chromium, devices } = require('playwright');
const { phone } = require('./pg_bridge');
const B = 'http://localhost:8770/rsvp/';
let pass = 0, fail = 0; const check = (ok, m) => ok ? pass++ : (fail++, console.log('FAIL', m));
(async () => {
  const b = await chromium.launch();
  const host = await phone(b, devices, process.env.DB || 'rc');
  await host.goto(B);
  await host.fill('input[name=title]', 'Game Night');
  await host.fill('input[name=host_phone]', '12');
  await host.click('#eventForm button[type=submit]');
  await host.waitForFunction(() => /phone number doesn’t look right/.test(document.getElementById('formErr').textContent));
  check(true, 'bad phone refused with a friendly message');
  await host.fill('input[name=host_phone]', '612 555 0134');
  await host.fill('input[name=host_email]', 'ben@example.com');
  await host.click('#eventForm button[type=submit]');
  await host.waitForSelector('.host');
  const code = new URL(host.url()).searchParams.get('e');

  const g = await phone(b, devices, process.env.DB || 'rc');
  await g.goto(B + '?e=' + code); await g.waitForSelector('#me');
  const txt = await g.textContent('#contact');
  check(/Contact the host/.test(txt) && txt.includes('(612) 555-0134') && txt.includes('ben@example.com'), 'guest sees contact: ' + txt);
  check(await g.getAttribute('#contact a[href^="tel:"]', 'href') === 'tel:+16125550134', 'call link');
  check(await g.getAttribute('#contact a[href^="sms:"]', 'href') === 'sms:+16125550134', 'text link');
  check((await g.getAttribute('#contact a.btn[href^="mailto:"]', 'href')).startsWith('mailto:ben@example.com?subject=Game%20Night'), 'email link');
  const order = await g.evaluate(() => [...document.querySelectorAll('#app section[id]')].map(s => s.id).join());
  check(/comments,contact/.test(order), 'contact comes right after comments: ' + order);
  await g.screenshot({ path: (process.env.SHOTS || '/tmp') + '/rsvp-contact.png', fullPage: true });

  // host removes the phone: only email remains; removing both hides the section
  await host.click('[data-act=edit-event]');
  await host.fill('input[name=host_phone]', '');
  await host.click('#eventForm button[type=submit]'); await host.waitForSelector('.host');
  await g.reload(); await g.waitForSelector('#me');
  check(!(await g.textContent('#contact')).includes('555') && (await g.textContent('#contact')).includes('ben@example.com'), 'phone removed, email stays');
  await host.click('[data-act=edit-event]');
  await host.fill('input[name=host_email]', '');
  await host.click('#eventForm button[type=submit]'); await host.waitForSelector('.host');
  await g.reload(); await g.waitForSelector('#me');
  check((await g.textContent('#contact')).trim() === '', 'no contact info → no section');

  // next new event remembers the host's contact details
  await host.goto(B);
  check(await host.inputValue('input[name=host_phone]') === '612 555 0134' && await host.inputValue('input[name=host_email]') === 'ben@example.com', 'remembered for the next event');
  for (const p of [host, g]) check(!p.errs.length, p.errs.join());
  console.log(pass + ' passed, ' + fail + ' failed'); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
