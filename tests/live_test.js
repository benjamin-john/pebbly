// Live Quiz (/live/): editor checks, the AI import reader with a messy reply, using a Trivia set, the QR
// encoder (decoded with OpenCV), and full sessions: a presenter page (1280×720) with 3 audience phones
// (names on: joining in the lobby, one joining mid-quiz with the code box, answering and changing an
// answer, progress counts, reveal percentages, right/wrong feedback, a poll question, Back, results,
// CSV download), a phone remote staying in sync, Restart, and an anonymous quiz.
// Setup: sh tests/setup_db.sh live; serve the repo root on port 8785 (python3 -m http.server 8785), then:
//   NODE_PATH=$(npm root -g) node tests/live_test.js
// Optional: DB=<name> PORT=<port> SHOTS=<folder for screenshots>
const { chromium, devices } = require('playwright');
const { phone } = require('./pg_bridge');
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const DB = process.env.DB || 'live', PORT = process.env.PORT || 8785, ORIGIN = 'http://localhost:' + PORT, BASE = ORIGIN + '/live/', SHOTS = process.env.SHOTS;
let pass = 0, fail = 0;
const check = (ok, m) => { if (ok) pass++; else { fail++; console.log('FAIL', m); } };
const shot = async (p, name, full) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/' + name + '.png', fullPage: full !== false }); };
const text = (p, sel) => p.locator(sel).first().innerText();
async function waitText(p, sel, t, ms) {
  try { await p.waitForFunction(([s, t]) => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0 && e.innerText.includes(t); }, [sel, t], { timeout: ms || 8000 }); return true; }
  catch (e) { return false; }
}
const DEC = 'import cv2,sys\nimg=cv2.imread(sys.argv[1]);out=""\n' +
  'for s in [1.0,0.5,0.75,0.35,1.5]:\n' +
  ' im=cv2.resize(img,None,fx=s,fy=s,interpolation=cv2.INTER_AREA if s<1 else cv2.INTER_NEAREST)\n' +
  ' v,_,_=cv2.QRCodeDetector().detectAndDecode(im)\n' +
  ' if v:\n  out=v;break\nsys.stdout.buffer.write(out.encode())';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liveqr-'));
async function decodeQr(p, sel) {
  const f = path.join(tmp, 'qr' + Date.now() + '.png');
  await p.locator(sel).first().screenshot({ path: f });
  return execFileSync('python3', ['-I', '-c', DEC, f]).toString();
}

const MESSY = 'Sure! Here is your quiz:\n```json\n{"title": "Space Mix", "questions": [\n' +
  ' {"q": "Which planet is red?", "choices": ["Venus", "Mars", "Jupiter"], "answer": "  MARS  "},\n' +
  ' {"question": "Pick C?", "options": ["One", "Two", "Three", "Four"], "correct_answer": "C"},\n' +
  ' {"text": "Third one?", "answers": ["x", "y", "z"], "correct": 3},\n' +
  ' {"q": "Wrong answer here?", "choices": ["Cat", "Dog"], "answer": "Fish"},\n' +
  ' {"q": "No choices here?", "answer": "Yes"},\n' +
  ' {"q": "Closest star?", "choices": ["A) Sirius", "B) The Sun", "C) Vega"], "answer": "B) The Sun", "explain": "Of course."},\n' +
  ']}\n```\nHope that helps! Let me know {if you want more}.';

(async () => {
  const browser = await chromium.launch();
  const all = [];
  const mk = async (opts) => { const p = await phone(browser, devices, DB, opts); all.push(p); return p; };
  const BIG = { viewport: { width: 1280, height: 720 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };

  /* ---------------- Import reader + QR encoder (pure functions) */
  const a = await mk({ permissions: ['clipboard-read', 'clipboard-write'] });
  await a.goto(BASE);
  let r = await a.evaluate(t => PebblyLive.parse(t), MESSY);
  check(r.title === 'Space Mix' && r.qs.length === 6, 'messy reply: title and 6 questions');
  check(JSON.stringify(r.qs.map(q => q.answer)) === '[1,2,2,-1,-1,1]', 'messy answers ' + r.qs.map(q => q.answer));
  check(!!r.qs[3].problem && !!r.qs[4].problem && !r.qs[0].problem && r.qs[5].choices.join() === 'Sirius,The Sun,Vega', 'messy problems + letter prefixes');
  r = await a.evaluate(() => PebblyLive.parse('I can’t help with that.'));
  check(!!r.error, 'plain text → friendly error');
  for (const [t, label] of [[ORIGIN + '/live/?c=ABCDE', 'join link'], ['https://pebbly.dev/live/?c=XY7KQ&o=' + '0123456789abcdef'.repeat(4), 'organizer link (64-char token)'],
    ['Ünïcödé ✓ quiz – ' + 'x'.repeat(200), 'UTF-8, version 10+']]) {
    const info = await a.evaluate(t => { const q = PebblyLive.qr(t); const d = document.createElement('div'); d.id = 'qrt'; d.style.cssText = 'position:fixed;inset:0;width:400px;background:#fff;z-index:99';
      d.innerHTML = PebblyLive.qrSvg(t); document.body.appendChild(d); return q.version; }, t);
    check(await decodeQr(a, '#qrt') === t, 'QR decodes: ' + label + ' (version ' + info + ')');
    await a.evaluate(() => document.getElementById('qrt').remove());
  }

  /* ---------------- Editor validation */
  await a.click('#newQuizBtn');
  await a.click('#edSave');
  check((await text(a, '#edErr')).includes('Give the quiz a title'), 'editor: title needed');
  await a.fill('#edTitle', 'Office Quiz');
  await a.click('#edSave');
  check((await text(a, '#edErr')).includes('Add at least one question'), 'editor: a question needed');
  await a.click('#edAdd');
  check(await a.locator('#qChoices input').count() === 4, 'new question has 4 answer boxes');
  await a.fill('#qText', 'Which planet is biggest?');
  const ins = a.locator('#qChoices input');
  await ins.nth(0).fill('Earth'); await ins.nth(1).fill('Jupiter'); await ins.nth(2).fill('Mars');
  await a.click('#qSave');
  check(/tap ✓/i.test(await text(a, '#qErr')), 'right answer must be marked: ' + await text(a, '#qErr'));
  await ins.nth(3).fill('Earth');
  await a.click('[data-mark="1"]');
  await a.click('#qSave');
  check((await text(a, '#qErr')).includes('the same'), 'duplicate answers refused: ' + (await a.locator('#qDlg').isVisible() ? await text(a, '#qErr') : await text(a, '#edList')));
  await ins.nth(3).fill('Venus');
  await a.click('#qAddChoice'); await a.click('#qAddChoice');
  check(await a.locator('#qChoices input').count() === 6 && await a.locator('#qAddChoice').isHidden(), 'up to 6 answers');
  await a.click('[data-rm="5"]'); await a.click('[data-rm="4"]');
  check(await a.getAttribute('#qText', 'maxlength') === '300' && await a.getAttribute('#qChoices input', 'maxlength') === '120', 'length limits 300/120');
  await a.click('#qSave');
  check((await text(a, '#edList')).includes('✓ Jupiter'), 'question saved with right answer: ' + (await a.locator('#qDlg').isVisible() ? await text(a, '#qErr') + ' / ' + JSON.stringify(await a.locator('#qChoices input').evaluateAll(e => e.map(x => x.value))) : await text(a, '#edList')));
  await a.click('#edAdd');
  await a.fill('#qText', 'Tea or coffee?');
  await a.locator('#qChoices input').nth(0).fill('Tea'); await a.locator('#qChoices input').nth(1).fill('Coffee');
  await a.click('[data-rm="3"]'); await a.click('[data-rm="2"]');
  await a.check('#qPoll');
  check(await a.locator('.mark').first().isHidden(), 'poll hides the ✓ buttons');
  await a.click('#qSave');
  check((await text(a, '#edList')).includes('Poll'), 'poll question saved');
  await a.click('#edList [data-act=up][data-i="1"]');
  check((await text(a, '#edList li:first-child')).includes('Tea or coffee'), 'move up');
  await a.check('#edNames');
  await shot(a, 'phone-editor');
  await a.click('#edSave');
  let saved = await a.evaluate(() => JSON.parse(localStorage.pebbly_live_quizzes));
  check(saved.length === 1 && saved[0].requireName === true && saved[0].questions[0].answer === null && saved[0].questions[1].answer === 1, 'quiz saved: ' + JSON.stringify(saved).slice(0, 200));
  // Duplicate + delete
  await a.click('#quizList [data-act=dup]');
  check((await text(a, '#quizList')).includes('Office Quiz (copy)'), 'duplicate');
  await a.locator('#quizList [data-act=del]').nth(1).click();
  check(await a.locator('#quizList .item').count() === 1, 'delete');

  /* ---------------- Make with AI */
  await a.click('#aiBtn');
  await a.click('#imCopy');
  check((await text(a, '#imCatErr')).includes('Type a topic'), 'AI prompt needs a topic');
  await a.fill('#imCat', 'space');
  await a.click('#imCopy');
  const prompt = await a.evaluate(() => navigator.clipboard.readText());
  check(prompt.startsWith('Write 10 multiple-choice quiz questions about space') && prompt.includes('one single code block') && prompt.includes('"answer": "Steven Spielberg"'), 'AI prompt copied');
  await a.fill('#imText', MESSY);
  check(await waitText(a, '#imResult', '4 questions ready') && (await text(a, '#imResult')).includes('2 questions need fixing'), 'import result: ' + await text(a, '#imResult'));
  check(await a.inputValue('#imTitle') === 'Space Mix', 'import title');
  await shot(a, 'phone-import');
  await a.click('#imSave');
  check((await text(a, '#quizList')).includes('Space Mix') && (await text(a, '#quizList')).includes('4 questions'), 'AI quiz saved');

  /* ---------------- Trivia set */
  await a.click('#triviaBtn');
  check((await text(a, '#tList')).includes('No Trivia sets'), 'no trivia sets message');
  await a.click('#tDlg [data-close]');
  await a.evaluate(() => localStorage.pebbly_trivia_sets = JSON.stringify([{ id: 'x1', title: 'Family Night', created: 1, questions: [
    { q: 'How many legs does a spider have?', choices: ['6', '8', '10', '12'], answer: 1, explain: 'Arachnids.' },
    { q: 'Largest ocean?', choices: ['Atlantic', 'Pacific'], answer: 1 }] }]));
  await a.click('#triviaBtn');
  await a.click('#tList [data-ti="0"]');
  check(await a.inputValue('#edTitle') === 'Family Night' && (await text(a, '#edList')).includes('✓ 8'), 'trivia set copied into the editor');
  await a.click('#edSave');
  check((await text(a, '#quizList')).includes('Family Night'), 'trivia quiz saved');
  await shot(a, 'phone-home');

  /* ---------------- Full session, names on */
  const QUIZ = { id: 'q1', title: 'Team Quiz Night', requireName: true, created: 1, questions: [
    { q: 'Which planet is known as the Red Planet?', choices: ['Venus', 'Mars', 'Jupiter', 'Mercury'], answer: 1 },
    { q: 'Coffee or tea?', choices: ['Coffee', 'Tea', 'Both', 'Neither'], answer: null },
    { q: 'How many continents are there?', choices: ['7', '6', '5'], answer: 0 }] };
  const host = await mk(BIG);
  await host.goto(BASE);
  await host.evaluate(q => localStorage.pebbly_live_quizzes = JSON.stringify([q]), QUIZ);
  await host.reload();
  await host.click('#quizList [data-act=present]');
  await host.waitForSelector('#pCode');
  const code = (await text(host, '#pCode')).trim();
  const orgUrl = host.url();
  const token = new URL(orgUrl).searchParams.get('o');
  check(/^[A-Z0-9]{5}$/.test(code) && /^[0-9a-f]{64}$/.test(token), 'session created: ' + code);
  check((await text(host, '#pMain')).includes('localhost:' + PORT + '/live') && (await text(host, '#pMain')).includes(code), 'lobby shows the address and code');
  check(await decodeQr(host, '#pQr svg') === BASE + '?c=' + code, 'lobby QR scans to the join link');
  const sessions = await host.evaluate(() => JSON.parse(localStorage.pebbly_live_sessions));
  check(sessions[0].code === code && sessions[0].token === token && sessions[0].title === 'Team Quiz Night', 'session remembered on this device');

  const amy = await mk(), ben = await mk(), cat = await mk();
  await amy.goto(BASE + '?c=' + code);
  await amy.waitForSelector('#nmIn');
  await amy.click('#nmGo');
  check((await text(amy, '#nmErr')).includes('type your name'), 'name required');
  await amy.fill('#nmIn', 'Amy'); await amy.click('#nmGo');
  check(await waitText(amy, '#aBody', 'You’re in!'), 'Amy joined');
  await shot(amy, 'phone-name-joined');
  await ben.goto(BASE + '?c=' + code.toLowerCase());
  await ben.waitForSelector('#nmIn');
  await ben.fill('#nmIn', 'Ben'); await ben.press('#nmIn', 'Enter');
  check(await waitText(ben, '#aBody', 'You’re in!'), 'Ben joined (lower-case code in the link)');
  check(await waitText(host, '#pPeople', '2 people have joined'), 'presenter counts people');
  check(await waitText(host, '.lnames', 'Amy') && (await text(host, '.lnames')).includes('Ben'), 'presenter shows names');
  check((await text(host, '.lppl')).startsWith('2'), 'presenter: 2 joined');
  await shot(host, 'presenter-lobby-light', false);
  await host.emulateMedia({ colorScheme: 'dark' }); await shot(host, 'presenter-lobby-dark', false); await host.emulateMedia({ colorScheme: 'light' });
  // Amy renames herself
  await amy.click('[data-aud=rename]');
  await amy.fill('#nmIn', 'Amy L'); await amy.click('#nmGo');
  check(await waitText(amy, '#aBody', 'Amy L'), 'name changed');
  check(await waitText(host, '.lnames', 'Amy L'), 'presenter sees the new name');

  // Phone remote
  const rem = await mk();
  await rem.goto(orgUrl);
  check(await waitText(rem, '#rBody', 'Waiting for people'), 'remote shows the lobby');
  check(await waitText(rem, '#rSub', '2 people joined'), 'remote shows people');

  // Start with the keyboard
  await host.keyboard.press('Space');
  check(await waitText(host, '.qbig', 'Red Planet'), 'Space starts the quiz');
  check(await waitText(host, '#pProg', '0 of 2 answered'), 'progress 0 of 2');
  check(await decodeQr(host, '#pCorner svg') === BASE + '?c=' + code, 'corner QR scans to the join link');
  check(await waitText(amy, '.qtext', 'Red Planet') && await waitText(ben, '.qtext', 'Red Planet'), 'phones show question 1');
  check(await waitText(rem, '#rBody', 'Question 1 of 3') && (await text(rem, '#rBody')).includes('B · Mars'), 'remote in sync, shows right answer to organizer');
  await amy.click('[data-ch="0"]');
  check(await waitText(amy, '#aStatus', 'Locked in'), 'Amy locked in');
  await amy.click('[data-ch="1"]');
  check(await waitText(host, '#pProg', '1 of 2 answered'), 'presenter counts Amy');
  await ben.click('[data-ch="0"]');
  check(await waitText(host, '#pProg', '2 of 2 answered'), 'presenter counts Ben');
  check(await amy.locator('.ch.sel').getAttribute('data-ch') === '1', 'changed answer shown');
  // Cat joins mid-quiz with the code box (spaces, lower case)
  await cat.goto(BASE);
  await cat.fill('#joinCode', 'zzzzz'); await cat.click('#joinForm .btn');
  check(await waitText(cat, '#joinErr', 'no quiz with the code ZZZZZ'), 'unknown code → friendly error');
  await cat.fill('#joinCode', '');
  await cat.type('#joinCode', code.slice(0, 2).toLowerCase() + ' ' + code.slice(2).toLowerCase());
  check(await cat.inputValue('#joinCode') === code, 'code box upper-cases and drops spaces');
  await cat.click('#joinForm .btn');
  await cat.waitForSelector('#nmIn');
  check((await cat.locator('#nmChips .chip').count()) === 0, 'no remembered name chips on a fresh phone');
  await cat.fill('#nmIn', 'Cat'); await cat.click('#nmGo');
  check(await waitText(cat, '.qtext', 'Red Planet'), 'Cat lands on the current question');
  check(await waitText(host, '#pProg', '2 of 3 answered'), 'presenter: 2 of 3');
  await shot(host, 'presenter-question-light', false);
  await host.emulateMedia({ colorScheme: 'dark' }); await shot(host, 'presenter-question-dark', false); await host.emulateMedia({ colorScheme: 'light' });
  await shot(cat, 'phone-question-light');
  // Cat's phone stops hearing from the server; the answer is revealed; Cat's late tap gets a friendly message.
  await cat.context().route('**/rpc/live_state', rt => rt.abort());
  await rem.click('[data-ctl=next]');   // Reveal from the phone remote
  check(await waitText(host, '.bars', 'Mars'), 'remote reveals on the big screen');
  const right = await text(host, '.bar.right');
  check(right.includes('Mars') && right.includes('50%') && right.includes('1 vote'), 'presenter: right answer highlighted with % and count: ' + right);
  check((await text(host, '.rsum')).includes('50% got it right') && (await text(host, '.rsum')).includes('2 answers'), 'presenter summary');
  await cat.click('[data-ch="1"]');
  check(await waitText(cat, '#toast', 'Too late'), 'late answer → friendly message');
  await cat.context().unroute('**/rpc/live_state');
  check(await waitText(amy, '.result', 'Correct!'), 'Amy: correct');
  check(await waitText(ben, '.result', 'Not quite') && (await text(ben, '.result')).includes('B: Mars'), 'Ben: not quite, shows answer');
  check(await waitText(cat, '.result', 'You didn’t answer'), 'Cat: didn’t answer');
  check((await text(amy, '.scoreline')).includes('1 of 1') && (await text(ben, '.scoreline')).includes('0 of 1'), 'running scores');
  check((await text(ben, '.bar.mine')).includes('Venus') && (await text(ben, '.bar.right')).includes('50%'), 'phone bars');
  check(await waitText(rem, '#rBody', 'answer shown'), 'remote follows the reveal');
  await shot(host, 'presenter-reveal-light', false);
  await host.emulateMedia({ colorScheme: 'dark' }); await shot(host, 'presenter-reveal-dark', false); await host.emulateMedia({ colorScheme: 'light' });
  await shot(amy, 'phone-reveal-correct-light');
  await amy.emulateMedia({ colorScheme: 'dark' }); await shot(amy, 'phone-reveal-correct-dark'); await amy.emulateMedia({ colorScheme: 'light' });
  await shot(ben, 'phone-reveal-wrong');

  // Poll question
  await host.keyboard.press('ArrowRight');
  check(await waitText(host, '.qn', 'Poll') && await waitText(host, '.qbig', 'Coffee or tea'), 'next: poll question');
  check(await waitText(rem, '#rBody', 'Question 2 of 3'), 'remote: question 2');
  for (const [p, c] of [[amy, 0], [ben, 1], [cat, 1]]) { await waitText(p, '.qtext', 'Coffee'); await p.click(`[data-ch="${c}"]`); }
  check(await waitText(host, '#pProg', '3 of 3 answered'), 'all answered the poll');
  await host.keyboard.press('Enter');
  check(await waitText(host, '.bars', 'Tea'), 'poll revealed');
  check(await host.locator('.bars.scored').count() === 0 && (await text(host, '.bar.c1')).includes('67%'), 'poll: just percentages');
  check(await waitText(amy, '.result', 'Thanks for voting'), 'phone: poll thanks');
  await shot(cat, 'phone-poll-reveal');
  // Back, then forward again (answers kept)
  await host.keyboard.press('ArrowLeft');
  check(await waitText(host, '#pStep', 'Question 1 of 3') && await waitText(host, '.bar.right', 'Mars'), 'Back shows question 1 revealed');
  check(await waitText(amy, '.result', 'Correct!'), 'phones follow Back');
  await rem.click('[data-ctl=next]');
  check(await waitText(host, '.qbig', 'Coffee or tea') && await waitText(host, '#pProg', '3 of 3 answered'), 'forward again: poll reopened, answers kept');
  await host.click('#pNext');
  check(await waitText(host, '.bars', 'Tea'), 'poll revealed again');
  await host.click('#pNext');
  check(await waitText(host, '.qbig', 'continents'), 'question 3');
  await waitText(amy, '.qtext', 'continents'); await waitText(ben, '.qtext', 'continents'); await waitText(cat, '.qtext', 'continents');
  await amy.click('[data-ch="0"]'); await ben.click('[data-ch="0"]'); await cat.click('[data-ch="2"]');
  check(await waitText(host, '#pProg', '3 of 3 answered'), 'question 3 answered');
  await host.click('#pNext');
  check(await waitText(host, '#pNext', 'See results'), 'last question → See results');
  check(await waitText(cat, '.scoreline', '0 of 2') && await waitText(amy, '.scoreline', '2 of 2'), 'scores after question 3');
  await host.click('#pNext');
  check(await waitText(host, '.results', 'Everyone’s answers'), 'results shown');
  const rows = await host.locator('table.rt tbody tr').allInnerTexts();
  check(rows.length === 3 && rows[0].includes('Amy L') && rows[0].includes('2/2') && rows[1].includes('Ben') && rows[1].includes('1/2') && rows[2].includes('Cat') && rows[2].includes('0/2'), 'results table sorted by score: ' + JSON.stringify(rows));
  check((await text(host, '.podium')).includes('Amy L') && await host.locator('.pod').count() === 3, 'podium');
  check((await text(host, '.qsum')).includes('67% got it right') && (await text(host, '.qsum')).includes('Poll'), 'question summary');
  check(await waitText(amy, '#aBody', 'You got 2 of 2 right') && await waitText(cat, '#aBody', 'Thanks for playing'), 'phones: done');
  check(await waitText(rem, '#rBody', 'The quiz is over') && (await text(rem, '#rBody')).includes('Amy L'), 'remote: done with top 3');
  await shot(host, 'presenter-results-light');
  await host.emulateMedia({ colorScheme: 'dark' }); await shot(host, 'presenter-results-dark'); await host.emulateMedia({ colorScheme: 'light' });
  await shot(amy, 'phone-done');
  // CSV
  const [dl] = await Promise.all([host.waitForEvent('download'), host.click('.results [data-res=csv]')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  check(dl.suggestedFilename() === 'team-quiz-night-results.csv', 'csv name ' + dl.suggestedFilename());
  const lines = csv.split('\r\n');
  check(csv.startsWith('\uFEFF') && lines[0] === '\uFEFFName,Score (out of 2),Q1. Which planet is known as the Red Planet?,Q1 right?,Q2. Coffee or tea?,Q3. How many continents are there?,Q3 right?', 'csv header: ' + lines[0]);
  check(lines[1] === 'Amy L,2,Mars,Correct,Coffee,7,Correct' && lines[2] === 'Ben,1,Venus,Incorrect,Tea,7,Correct' && lines[3] === 'Cat,0,,No answer,Tea,5,Incorrect', 'csv rows: ' + JSON.stringify(lines.slice(1, 4)));
  // Organizer link QR (phone remote)
  await host.click('#pRemoteBtn');
  const orgQr = await decodeQr(host, '#rQr svg'); check(orgQr === orgUrl, 'remote QR scans to the organizer link: ' + orgQr + ' vs ' + orgUrl); if (SHOTS) await host.locator('#rQr svg').screenshot({ path: SHOTS + '/orgqr.png' });
  check((await text(host, '#rDlg')).includes('don’t show it to the room'), 'organizer link warning');
  await host.click('#rDlg [data-close]');
  // Back from the results goes to the last question, revealed
  await host.click('.results [data-res=back]');
  check(await waitText(host, '#pStep', 'Question 3 of 3') && await waitText(host, '.bar.right', '7'), 'Back from results → last question revealed');
  await host.keyboard.press('ArrowRight');
  check(await waitText(host, '.results', 'Everyone’s answers'), 'results again');
  // Restart
  await host.click('.results [data-res=restart]');
  check(await waitText(host, '#pMain', code) && await waitText(host, '.lppl', '3'), 'restart → lobby, people stay');
  check(await waitText(amy, '#aBody', 'You’re in!'), 'phones back in the lobby');
  check(await waitText(rem, '#rBody', 'Waiting for people'), 'remote back in the lobby');
  await rem.click('[data-ctl=next]');
  check(await waitText(host, '.qbig', 'Red Planet') && await waitText(host, '#pProg', '0 of 3 answered'), 'restart cleared answers');
  // Phone remote screenshot
  await shot(rem, 'phone-remote');
  // The running session is listed on the presenter's start screen
  await host.click('#pMenuBtn'); await host.click('#mHome');
  check((await text(host, '#sessList')).includes(code), 'running session listed');
  await host.click('#sessList [data-sact=open]');
  check(await waitText(host, '.qbig', 'Red Planet'), 'reopen the running session');

  /* ---------------- Anonymous quiz */
  const anonQ = { id: 'q2', title: 'Quick Poll', requireName: false, created: 2, questions: [
    { q: 'Best day for the party?', choices: ['Friday', 'Saturday'], answer: null },
    { q: '2 + 2?', choices: ['3', '4'], answer: 1 }] };
  await host.goto(BASE);
  await host.evaluate(q => localStorage.pebbly_live_quizzes = JSON.stringify([q]), anonQ);
  await host.reload();
  await host.click('#quizList [data-act=present]');
  await host.waitForSelector('#pCode');
  const code2 = (await text(host, '#pCode')).trim();
  check(await host.locator('.lnames').count() === 0, 'anonymous: no names shown');
  const dan = await mk();
  await dan.goto(BASE + '?c=' + code2);
  check(await waitText(dan, '#aBody', 'You’re in!') && await dan.locator('#nmIn').count() === 0, 'anonymous: joined without a name');
  check(await waitText(host, '.lppl', '1 person has joined'), 'anonymous: count');
  await shot(dan, 'phone-waiting');
  await host.keyboard.press('Space');
  await waitText(dan, '.qtext', 'party'); await dan.click('[data-ch="1"]');
  await waitText(host, '#pProg', '1 of 1'); await host.keyboard.press('Space');
  await waitText(host, '.bars', 'Saturday'); await host.keyboard.press('Space');
  await waitText(dan, '.qtext', '2 + 2'); await dan.click('[data-ch="1"]');
  await waitText(host, '#pProg', '1 of 1'); await host.keyboard.press('Space');
  check(await waitText(dan, '.result', 'Correct!'), 'anonymous: correct');
  await host.keyboard.press('Space');
  check(await waitText(host, '.results', 'Question by question'), 'anonymous results');
  check(await host.locator('.podium').count() === 0 && (await text(host, '.results')).includes('(anonymous)'), 'anonymous: no podium');
  await host.click('.results details summary');
  check((await text(host, 'table.rt')).includes('Person 1'), 'anonymous: Person 1 in the answers table');
  const [dl2] = await Promise.all([host.waitForEvent('download'), host.click('.results [data-res=csv]')]);
  const csv2 = fs.readFileSync(await dl2.path(), 'utf8').split('\r\n');
  check(csv2[0] === '\uFEFFQuestion number,Question,Answer,Votes,Percent,Right answer?' && csv2.includes('1,Best day for the party?,Saturday,1,100%,Poll') && csv2.includes('2,2 + 2?,4,1,100%,Yes'), 'summary csv: ' + JSON.stringify(csv2));
  check(await waitText(dan, '#aBody', 'You got 1 of 1 right'), 'anonymous phone score');

  /* ---------------- Narrow phones + presenter on a phone */
  const small = await mk({ viewport: { width: 320, height: 640 } });
  await small.goto(BASE + '?c=' + code);
  await small.waitForSelector('#nmIn');
  await shot(small, 'phone320-name');
  await small.fill('#nmIn', 'Sam'); await small.click('#nmGo');
  check(await waitText(small, '.qtext', 'Red Planet'), '320px phone joins');
  check(await small.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px: no sideways scroll (question)');
  await shot(small, 'phone320-question');
  await small.goto(BASE);
  check(await small.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px: no sideways scroll (start)');
  await small.evaluate(q => localStorage.pebbly_live_quizzes = JSON.stringify([q]), QUIZ); await small.reload();
  await shot(small, 'phone320-home');
  const darkHome = await mk({ colorScheme: 'dark' });
  await darkHome.goto(BASE); await darkHome.evaluate(q => localStorage.pebbly_live_quizzes = JSON.stringify([q]), QUIZ); await darkHome.reload();
  await shot(darkHome, 'phone-home-dark');
  await darkHome.goto(BASE + '?c=' + code);
  await darkHome.waitForSelector('#nmIn'); await darkHome.fill('#nmIn', 'Dee'); await darkHome.click('#nmGo');
  await waitText(darkHome, '.qtext', 'Red Planet'); await darkHome.click('[data-ch="2"]');
  await waitText(darkHome, '#aStatus', 'Locked in');
  await shot(darkHome, 'phone-question-dark');
  const ph = await mk();
  await ph.goto(orgUrl);
  check(await waitText(ph, '#rBody', 'Question 1 of 3'), 'organizer link on a phone → remote');
  await ph.click('#rMenuBtn'); await ph.click('#mBig');
  check(await waitText(ph, '.qbig', 'Red Planet') && await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'big-screen view on a phone, no sideways scroll');
  await shot(ph, 'phone-presenter');

  for (const p of all) for (const e of p.errs) { fail++; console.log('PAGE ERROR', e); }
  console.log(`live_test: ${pass} passed, ${fail} failed`);
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
