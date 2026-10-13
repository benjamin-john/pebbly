// RSVP invite list (host only): add from contacts (stubbed Contact Picker) or by hand, matching RSVPs by
// phone / same name / confirmed suggestion, "Invited, no reply yet" texting, removal. Against a local Postgres.
// Setup: sh tests/setup_db.sh ri; serve the repo root on port 8771; NODE_PATH=$(npm root -g) node tests/rsvp_invites_test.js
// Before the migration: DB built with `nomigrations` hides the section (DB=ri0 NOMIG=1).
const { chromium, devices } = require('playwright');
const { phone } = require('./pg_bridge');
const B = 'http://localhost:8771/rsvp/';
const DB = process.env.DB || 'ri';
const SHOTS = process.env.SHOTS || '/tmp';
let pass = 0, fail = 0; const check = (ok, m) => ok ? pass++ : (fail++, console.log('FAIL', m));

async function rsvp(b, code, first, last, tel, status) {
  const g = await phone(b, devices, DB);
  await g.goto(B + '?e=' + code); await g.waitForSelector('#me');
  await g.click('#me [data-act=status][data-id=' + status + ']');
  await g.fill('#rFirst', first); await g.fill('#rLast', last);
  if (tel != null) await g.fill('#rPhone', tel);
  await g.click('#rsvpForm button[type=submit]');
  await g.waitForFunction(() => !document.getElementById('rsvpForm'));
  return g;
}

(async () => {
  const b = await chromium.launch();
  const host = await phone(b, devices, DB);
  // Stub Android's contact picker: returns the people below.
  await host.addInitScript(() => {
    window.ContactsManager = function () {};
    navigator.contacts = { select: async () => [
      { name: ['Amy Lee'], tel: ['(612) 555-0101', '+1 612 555 0199'] },
      { name: ['Mike Smith'], tel: ['612.555.0102'] },
      { name: ['Grandma'], tel: [] },
      { name: ['Cara Diaz'], tel: ['6125550104'] },
      { name: [], tel: [] }] };
  });
  await host.goto(B);
  await host.fill('input[name=title]', 'Wedding');
  await host.click('#eventForm button[type=submit]');
  await host.waitForSelector('.host');
  const code = new URL(host.url()).searchParams.get('e');

  if (process.env.NOMIG) {
    check((await host.textContent('#invites')).trim() === '', 'no invite section before the migration');
    check(!host.errs.length, host.errs.join());
    console.log(pass + ' passed, ' + fail + ' failed'); await b.close(); process.exit(fail ? 1 : 0);
  }

  check(/Invited/.test(await host.textContent('#invites')), 'host sees the Invited section');
  await host.click('[data-act=inv-contacts]');
  await host.waitForSelector('#invites .gbox.wait');
  const t1 = await host.textContent('#invites');
  check(/4 invited · 0 replied · 4 no reply yet/.test(t1), 'four people added: ' + t1);
  check(t1.includes('(612) 555-0101 (+1 more)') && t1.includes('No phone number'), 'numbers shown');
  check(await host.evaluate(() => document.querySelector('#toast').textContent.includes('phone number')), 'told that phone numbers are now required');
  // picking the same people again adds nobody
  await host.click('[data-act=inv-contacts]');
  await host.waitForFunction(() => /Nobody new/.test(document.querySelector('#toast').textContent));
  check(true, 'duplicates skipped');
  // by hand
  await host.click('[data-act=inv-manual]');
  await host.fill('#invName', 'Dan Wu'); await host.fill('#invPhone', '12');
  await host.click('#invForm button[type=submit]');
  await host.waitForFunction(() => /doesn’t look right/.test(document.querySelector('#toast').textContent));
  await host.fill('#invPhone', '612-555-0105');
  await host.click('#invForm button[type=submit]');
  await host.waitForFunction(() => /5 invited/.test(document.querySelector('#invites').textContent));
  check(await host.inputValue('#invName') === '', 'form cleared for the next person');
  await host.click('[data-act=inv-manual-close]');

  // guests can't see it
  const amy = await rsvp(b, code, 'Amy', 'Lee', '612 555 0199', 'going');   // her second number
  check((await amy.textContent('#invites')).trim() === '', 'guest sees no invite list');
  check(/phone/i.test(await amy.evaluate(() => document.body.textContent)), 'guest page loads');
  await rsvp(b, code, 'Michael', 'Smith', '612 555 7777', 'maybe');          // different number, similar name
  await rsvp(b, code, 'Cara', 'Diaz', '612 555 8888', 'no');                 // same name, different number
  await rsvp(b, code, 'Nana', 'Jones', '612 555 6666', 'going');             // Grandma, picked by hand

  await host.click('[data-act=refresh]');
  await host.waitForFunction(() => /2 replied/.test(document.querySelector('#invites').textContent));
  let t = await host.textContent('#invites');
  check(/5 invited · 2 replied · 3 no reply yet/.test(t), 'Amy (phone) and Cara (name) matched: ' + t);
  check(/Is this Michael Smith \(Maybe\)\?/.test(t), 'Mike → Michael suggested');
  await host.click('#invites .replied summary');
  await host.locator('#invites').screenshot({ path: SHOTS + '/rsvp-invites.png' });
  await host.click('[data-act=inv-yes]');
  await host.waitForFunction(() => /3 replied/.test(document.querySelector('#invites').textContent));
  t = await host.textContent('#invites');
  check(/Maybe · as Michael Smith/.test(t), 'confirmed match shows the RSVP name');
  check(await host.evaluate(() => document.querySelector('#invites details').open), 'replied list stays open');
  // Grandma: pick her RSVP from the list
  const opt = await host.evaluate(() => [...document.querySelector('[data-inv-pick]').options].find(o => /Nana/.test(o.text)).value);
  await host.selectOption('[data-inv-pick]', opt);
  await host.waitForFunction(() => /4 replied/.test(document.querySelector('#invites').textContent));
  check(/Going · as Nana Jones/.test(await host.textContent('#invites')), 'picked match');
  // undo a confirmed match
  await host.click('#invites li:has-text("Grandma") [data-act=inv-unlink]');
  await host.waitForFunction(() => /3 replied/.test(document.querySelector('#invites').textContent));
  check(/Grandma/.test(await host.textContent('#invites .wait')), 'Not them moves back');

  // texting: only people without a reply
  await host.click('[data-aud=going]'); await host.click('[data-aud=maybe]');
  await host.click('[data-aud=invited]');
  await host.fill('#smsBody', 'Please RSVP!');
  const rows = await host.$$eval('#textList .texts li', ls => ls.map(l => l.textContent));
  check(rows.length === 1 && /Dan Wu/.test(rows[0]) && /No reply yet/.test(rows[0]), 'text list = unanswered invites with numbers: ' + rows.join(' | '));
  check(/no number: Grandma/.test(await host.textContent('#textList')), 'unanswered without number mentioned');
  check((await host.getAttribute('#textList a[data-text]', 'href')).startsWith('sms:+16125550105?body=Please%20RSVP!'), 'sms link');

  // download includes the invite list
  const [dl] = await Promise.all([host.waitForEvent('download'), host.click('[data-act=dl][data-id=invited]')]);
  const csv = require('fs').readFileSync(await dl.path(), 'utf8');
  check(csv.includes('"Amy Lee","(612) 555-0101","(612) 555-0199","Going","Amy Lee"') && csv.includes('"Mike Smith","(612) 555-0102","","Maybe","Michael Smith"') && csv.includes('"Dan Wu","(612) 555-0105","","No reply yet",""'), 'csv: ' + csv);

  // remove someone
  await host.click('#invites .wait [data-act=inv-rm][data-name="Dan Wu"]');
  await host.waitForFunction(() => /4 invited/.test(document.querySelector('#invites').textContent));
  check(true, 'removed');
  // removing a guest RSVP drops a confirmed link (FK set null) without errors
  await host.click('#guests [data-act=rm-guest][data-name="Michael Smith"]');
  await host.waitForFunction(() => !/Michael Smith/.test(document.querySelector('#guests').textContent));
  check(/Mike Smith/.test(await host.textContent('#invites .wait')), 'Mike back to no reply after his RSVP is removed');

  check(!host.errs.length, host.errs.join());
  console.log(pass + ' passed, ' + fail + ' failed'); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
