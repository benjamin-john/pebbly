// Trivia (/trivia/): the forgiving import reader, the AI prompt, making and editing sets by hand,
// a one-phone game to the end (with Undo), and a 3-phone "everyone's phones" game (host + 2 players:
// answering, reveal, scores the same on every phone, next question, end, then a timed set).
// Setup: sh tests/setup_db.sh agent_c; serve the repo root on port 8783 (python3 -m http.server 8783), then:
//   NODE_PATH=$(npm root -g) node tests/trivia_test.js
// Optional: DB=<name> PORT=<port> SHOTS=<folder for screenshots>
const { chromium, devices } = require('playwright');
const { phone } = require('./pg_bridge');
const { spawnSync } = require('child_process');
const DB = process.env.DB || 'agent_c', BASE = 'http://localhost:' + (process.env.PORT || 8783) + '/trivia/', SHOTS = process.env.SHOTS;
let pass = 0, fail = 0;
const check = (ok, m) => { if (ok) pass++; else { fail++; console.log('FAIL', m); } };
const sql = q => spawnSync('psql', ['-h', '/tmp/pebbly-pgtest', '-p', '5439', '-U', 'postgres', '-d', DB, '-At', '-c', q], { encoding: 'utf8' }).stdout.trim();
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/' + name + '.png', fullPage: true }); };
const text = (p, sel) => p.locator(sel).first().innerText();

const MESSY = 'Sure! Here are your questions:\n```json\n{"title": "Messy Mix", "questions": [\n' +
  ' {"q": "Which color is the sky?", "choices": ["Red", "Blue", "Green"], "answer": "  BLUE  "},\n' +
  ' {"question": "Pick C?", "options": ["One", "Two", "Three", "Four"], "correct_answer": "C"},\n' +
  ' {"text": "Third one?", "answers": ["x", "y", "z"], "correct": 3},\n' +
  ' {"q": "Wrong answer here?", "choices": ["Cat", "Dog"], "answer": "Fish"},\n' +
  ' {"q": "No choices here?", "answer": "Yes"},\n' +
  ' {"q": "Capital of Italy?", "choices": ["A) Paris", "B) Rome", "C) Oslo"], "answer": "B) Rome", "explain": "Rome!"},\n' +
  ']}\n```\nHope that helps! Let me know {if you want more}.';

(async () => {
  const browser = await chromium.launch();
  const all = [];
  const mk = async (opts) => { const p = await phone(browser, devices, DB, opts); all.push(p); return p; };

  /* ---------------- Import reader (pure function) */
  if (process.env.VERBOSE) console.log("== Import reader (pure function)");
  const a = await mk({ permissions: ['clipboard-read', 'clipboard-write'] });
  await a.goto(BASE);
  const parse = t => a.evaluate(t => PebblyTrivia.parse(t), t);
  { // An AI reply whose last question is missing its "}" ("…stew."]}]}): every question still read.
    const qs = [1, 2, 3].map(i => `{"q": "Q${i}?", "choices": ["a", "b"], "answer": "b", "explain": "fact ${i}."}`).join(', ');
    const r = await parse(`{"title": "T", "questions": [${qs.slice(0, -1)}]}]}`);
    check(r.qs && r.qs.length === 3 && !r.partial && r.qs.every(q => !q.problem), 'mismatched closing brackets are repaired');
    const m = await parse('{"questions":[{"q":"A?","choices":["x","y"],"answer":"x"}, {"q": "B? "choices": ["x"]}, {"q":"C?","choices":["x","y"],"answer":"y"}]}');
    check(m.partial === true, 'a reply that is only partly readable is flagged');
  }
  let r = await parse(MESSY);
  check(r.title === 'Messy Mix' && r.qs.length === 6, 'messy: title and 6 questions ' + JSON.stringify(r).slice(0, 200));
  check(JSON.stringify(r.qs.map(q => q.answer)) === '[1,2,2,-1,-1,1]', 'messy answers: ' + r.qs.map(q => q.answer));
  check(r.qs[3].problem === 'the answer isn’t one of the choices' && r.qs[4].problem === 'the answer choices are missing', 'messy problems');
  check(r.qs[5].choices.join() === 'Paris,Rome,Oslo' && r.qs[5].explain === 'Rome!', 'letter prefixes stripped, explain kept');
  r = await parse('[{"q":"a?","choices":["x","y"],"answer":0},{"q":"b?","choices":["x","y","z"],"answer":2}]');
  check(r.zero && r.qs.map(q => q.answer).join() === '0,2', 'bare array, 0-based numbers detected');
  r = await parse('[{"q":"a?","choices":["x","y"],"answer":2},{"q":"b?","choices":["x","y","z"],"answer":"1"}]');
  check(!r.zero && r.qs.map(q => q.answer).join() === '1,0', '1-based numbers');
  r = await parse('{"quiz":{"name":"Nested","items":[{"Question":"n?","Options":{"A":"p","B":"q"},"Correct Answer":"b"}]}}');
  check(r.title === 'Nested' && r.qs[0].answer === 1, 'nested object, keyed options, odd key names');
  r = await parse('{"results":[{"question":"o?","correct_answer":"Right","incorrect_answers":["W1","W2","W3"]}]}');
  check(r.qs[0].choices.length === 4 && r.qs[0].choices[r.qs[0].answer] === 'Right', 'Open Trivia style');
  r = await parse('[{"q":"c?","choices":[{"text":"no"},{"text":"yes","correct":true}]}]');
  check(r.qs[0].answer === 1, 'choices flagged correct');
  r = await parse('[{"q":"d?","choices":["6","8","10"],"answer":"8"}]');
  check(r.qs[0].answer === 1, 'numeric-looking text answer matches the choice text');
  r = await parse('{“q”: “Smart?”, “choices”: [“Yes”, “No”], “answer”: “Yes”}');
  check(r.qs && r.qs[0].answer === 0, 'curly quotes fixed');
  r = await parse('I could not do that, sorry.');
  check(!!r.error && /doesn’t look like/.test(r.error), 'plain text → friendly error');
  r = await parse('{"title":"Cut","questions":[{"q":"a?","choices":["x","y"],"ans');
  check(!!r.error || r.partial === true, 'cut off → error or "part couldn’t be read" warning');
  r = await parse('{"title":"Cut","questions":[{"q":"a?","choices":["x","y"],"answer":"x"},{"q":"b?","choi');
  check(r.qs && r.qs.length === 1 && r.partial === true, 'cut off after one good question → keeps it and warns');

  /* ---------------- Start screen + AI prompt */
  if (process.env.VERBOSE) console.log("== Start screen + AI prompt");
  check((await text(a, '#setList')).includes('Fun Facts (sample)'), 'built-in set listed');
  await a.click('#importBtn');
  await a.click('#imCopy');
  check((await text(a, '#imCatErr')).includes('Type a topic first'), 'prompt needs a topic');
  await a.fill('#imCat', '80s movies');
  await a.selectOption('#imNum', '10');
  await a.click('#imCopy');
  const prompt = await a.evaluate(() => navigator.clipboard.readText());
  check(prompt.startsWith('Write 10 multiple-choice trivia questions about 80s movies, medium difficulty') &&
    prompt.includes('"answer": "Steven Spielberg"') && prompt.includes('copy it to my clipboard with one click') && prompt.includes('1 means the first choice'), 'AI prompt copied');
  await shot(a, 'import-empty');

  /* ---------------- Import UI: fix path */
  if (process.env.VERBOSE) console.log("== Import UI: fix path");
  await a.fill('#imText', MESSY);
  await a.waitForSelector('#imResult .res');
  const res = await text(a, '#imResult');
  check(res.includes('4 questions ready') && res.includes('Question 4: the answer isn’t one of the choices') &&
    res.includes('Question 5: the answer choices are missing'), 'import summary: ' + res);
  check(await a.inputValue('#imTitle') === 'Messy Mix', 'title from JSON');
  check((await text(a, '#imSave')).includes('Skip those 2, save 4 questions'), 'skip button wording');
  await shot(a, 'import-result');
  await a.click('#imFix');
  check(await a.locator('#editor .eq').count() === 6 && await a.locator('#editor .eq.bad').count() === 2, 'editor shows 6, 2 flagged');
  await shot(a, 'editor-fix');
  await a.click('#edSave');
  check((await text(a, '#edErr')).includes('Question 4: the answer isn’t one of the choices'), 'save blocked with question number');
  await a.locator('.eqb').nth(3).click();
  await a.click('#qChoices [data-mark="1"]');
  await a.click('#qSave');
  await a.locator('.eqb').nth(4).click();
  await a.fill('#qChoices [data-ci="0"]', 'Yes'); await a.fill('#qChoices [data-ci="1"]', 'No');
  await a.click('#qSave');
  check((await text(a, '#qErr')).includes('Tap ✓ next to the right answer'), 'needs a marked answer');
  await a.click('#qChoices [data-mark="0"]');
  await a.click('#qSave');
  check(await a.locator('#editor .eq.bad').count() === 0, 'all fixed');
  await a.click('#edSave');
  await a.waitForSelector('#home:not([hidden])');
  let sets = await a.evaluate(() => JSON.parse(localStorage.pebbly_trivia_sets));
  check(sets[0].title === 'Messy Mix' && sets[0].questions.length === 6 && sets[0].questions.map(q => q.answer).join() === '1,2,2,1,0,1', 'fixed set saved ' + JSON.stringify(sets[0].questions.map(q => q.answer)));

  /* ---------------- Import UI: skip path */
  if (process.env.VERBOSE) console.log("== Import UI: skip path");
  await a.click('#importBtn');
  await a.fill('#imText', MESSY);
  await a.waitForSelector('#imResult .res');
  await a.fill('#imTitle', 'Messy Skip');
  await a.click('#imSave');
  sets = await a.evaluate(() => JSON.parse(localStorage.pebbly_trivia_sets));
  check(sets[0].title === 'Messy Skip' && sets[0].questions.length === 4 && sets[0].questions.map(q => q.answer).join() === '1,2,2,1', 'skipped set saved');

  /* ---------------- Make a set by hand */
  if (process.env.VERBOSE) console.log("== Make a set by hand");
  await a.click('#newSetBtn');
  await a.fill('#edTitle', 'Hand Made');
  await a.click('#edAdd');
  await a.fill('#qText', 'First made?'); await a.fill('#qChoices [data-ci="0"]', 'Alpha'); await a.fill('#qChoices [data-ci="1"]', 'Beta');
  await a.click('#qChoices [data-mark="1"]'); await a.click('#qSave');
  await a.click('#edAdd');
  await a.fill('#qText', 'Second made?'); await a.click('#qAddChoice');
  check(await a.locator('#qChoices li').count() === 5, 'add a choice');
  for (let i = 0; i < 5; i++) await a.fill(`#qChoices [data-ci="${i}"]`, 'C' + i);
  await a.click('#qChoices [data-rm="0"]');
  await a.click('#qChoices [data-mark="3"]'); await a.click('#qSave');   // C4
  await a.click('.eqm [data-act="up"][data-i="1"]');
  check((await text(a, '#edList')).indexOf('Second made?') < (await text(a, '#edList')).indexOf('First made?'), 'reorder');
  await a.locator('.eqb').nth(1).click(); await a.click('#qDel');   // delete "First made?"
  await a.click('#edAdd'); await a.fill('#qText', 'Third made?'); await a.fill('#qChoices [data-ci="0"]', 'Yes'); await a.fill('#qChoices [data-ci="1"]', 'No');
  await a.click('#qChoices [data-mark="0"]'); await a.click('#qSave');
  await a.click('#edSave');
  sets = await a.evaluate(() => JSON.parse(localStorage.pebbly_trivia_sets));
  check(sets[0].title === 'Hand Made' && sets[0].questions.length === 2 && sets[0].questions[0].choices.join() === 'C1,C2,C3,C4' &&
    sets[0].questions[0].answer === 3 && sets[0].questions[1].choices.length === 2, 'hand-made set ' + JSON.stringify(sets[0]));
  // Export
  await a.click('#setList [data-act="edit"][data-id="' + sets[0].id + '"]');
  await a.click('#edCopy');
  await a.waitForTimeout(200);
  const ex = JSON.parse(await a.evaluate(() => navigator.clipboard.readText()));
  check(ex.title === 'Hand Made' && ex.questions[0].answer === 'C4' && ex.questions[1].answer === 'Yes', 'export as JSON');
  await a.click('#edCancel');
  // Delete a set
  await a.click('#setList [data-act="del"][data-id="' + sets[0].id + '"]');
  check(!(await text(a, '#setList')).includes('Hand Made'), 'set deleted');
  await shot(a, 'home');

  /* ---------------- One-phone game, built-in set */
  if (process.env.VERBOSE) console.log("== One-phone game, built-in set");
  await a.click('#setList [data-act="play"][data-id="sample"]');
  for (const n of ['Amy', 'Bob']) { await a.fill('#newPlayer', n); await a.click('#addPlayerForm button'); }
  await a.uncheck('#shufQ'); await a.uncheck('#shufA');
  await shot(a, 'setup-local');
  await a.click('#startBtn');
  await a.waitForSelector('#play:not([hidden])');
  check(await a.locator('.ch').count() === 4 && (await text(a, '.qtext')).includes('largest planet'), 'first question shown');
  await shot(a, 'local-question');
  for (let i = 0; i < 10; i++) {
    await a.click('[data-act="reveal"]');
    if (i === 0) { check((await text(a, '.ch.right')).includes('Jupiter'), 'right answer highlighted'); }
    if (i > 0) await a.click('.tog:has-text("Amy")');
    if (i < 3) await a.click('.tog:has-text("Bob")');
    if (i === 1) {
      await a.click('.tog:has-text("Bob")');   // oops
      check(await a.getAttribute('.tog:has-text("Bob")', 'aria-pressed') === 'false', 'toggle off');
      await a.click('#undoBtn');
      check(await a.getAttribute('.tog:has-text("Bob")', 'aria-pressed') === 'true', 'undo the last scoring tap');
      await shot(a, 'local-reveal');
    }
    await a.click('[data-act="next"]');
  }
  check((await text(a, '#winCard')).includes('Amy') && (await text(a, '#winCard')).includes('9 out of 10'), 'winner card: ' + await text(a, '#stage'));
  check((await text(a, '.board')).replace(/\s+/g, ' ').includes('Bob 3'), 'standings');
  await shot(a, 'local-over');
  const mem = await a.evaluate(() => JSON.parse(localStorage.pebbly_score_memory).players);
  check(mem.includes('Amy') && mem.includes('Bob'), 'names remembered');
  await a.click('[data-act="again"]');
  check((await text(a, '#pSub')) === 'Question 1 of 10' && !(await a.locator('.tog').count()), 'play again');
  await a.click('[data-act="reveal"]');
  check((await text(a, '.toggles')).replace(/\s+/g, ' ').includes('Amy 0'), 'scores reset');

  /* ---------------- 3 phones */
  if (process.env.VERBOSE) console.log("== 3 phones");
  const H = await mk(), P1 = await mk(), P2 = await mk();
  await H.goto(BASE);
  await H.click('#setList [data-act="play"][data-id="sample"]');
  await H.click('.ps-mode[data-m="1"]');
  await H.waitForSelector('#hostCard:not([hidden])');
  check(await H.locator('#playersCard').isHidden(), 'no players list when everyone uses their own phone');
  await H.fill('#myName', 'Quizzy');
  await H.uncheck('#shufQ');
  await shot(H, 'setup-shared');
  await H.click('#startBtn');
  await H.waitForSelector('.ps-code');
  const code = (await text(H, '.ps-code')).trim();
  check(/^[A-Z0-9]{5}$/.test(code), 'shared code ' + code);
  await H.click('.ps-dlg [data-ps-close]');
  check((await text(H, '#lobbyCode')).trim() === code, 'lobby shows code');
  check(await H.locator('[data-act="begin"]').isDisabled(), 'start waits for players');
  const joinAs = async (p, name) => {
    await p.goto(BASE);
    await p.click('.ps-join'); await p.fill('#psCode', code); await p.click('#psNext');
    await p.waitForSelector('#psName'); await p.fill('#psName', name); await p.click('#psJoinGo');
    await p.waitForSelector('#play:not([hidden])');
  };
  await joinAs(P1, 'Pia');
  await joinAs(P2, 'Ned');
  check((await text(P2, '#stage')).includes('You’re in'), 'player lobby');
  await H.waitForFunction(() => document.querySelectorAll('#stage .whos span').length === 2, null, { timeout: 10000 });
  await shot(H, 'shared-lobby');
  await H.click('[data-act="begin"]');
  for (const p of [P1, P2]) await p.waitForSelector('.qtext', { timeout: 10000 });
  check((await text(P1, '.qtext')).includes('largest planet'), 'players see question 1');
  // The right answer isn't in the shared game before reveal.
  let st = JSON.parse(sql(`select state from play_games where code='${code}'`));
  check(st && st.q && st.q.choices.length === 4 && JSON.stringify(st.key) === '{}' && !JSON.stringify(st).includes('"answer"') && !JSON.stringify(st).includes('Jupiter is so big'), 'no answer in shared state before reveal');
  await P1.click('.ch[data-i="1"]');
  await P2.click('.ch[data-i="0"]');
  check((await text(P2, '.status')).includes('Locked in: A'), 'locked in');
  await P2.click('.ch[data-i="2"]');   // change of mind
  check((await text(P2, '.status')).includes('Locked in: C'), 'answer changed');
  await shot(P2, 'player-question');
  await H.waitForFunction(() => /Answered: 2 of 2/i.test(document.getElementById('stage').innerText), null, { timeout: 10000 });
  await P1.waitForTimeout(2000);
  await shot(H, 'host-question');
  await H.click('[data-act="reveal"]');
  st = JSON.parse(sql(`select state from play_games where code='${code}'`));
  check(st.key[st.qk] === 1, 'answer shared at reveal');
  await P1.waitForSelector('.result', { timeout: 10000 }); await P2.waitForSelector('.result', { timeout: 10000 });
  check((await text(P1, '.result')).includes('You got it'), 'P1 right');
  check((await text(P2, '.result')).includes('Not this time') && (await text(P2, '.result')).includes('Jupiter'), 'P2 wrong');
  check((await text(P1, '.explain')).includes('Jupiter is so big'), 'fun fact shown');
  await shot(P1, 'player-reveal');
  await shot(H, 'host-reveal');
  const board = p => p.$$eval('.board li', ls => ls.map(l => l.querySelector('.nm').firstChild.textContent + ' ' + (l.querySelector('.gt') ? '+1 ' : '') + l.querySelector('.sc').textContent).join(' | '));
  const bH = await board(H);
  check(bH.includes('Pia +1 1') && bH.includes('Ned 0'), 'host board ' + bH);
  check(await board(P1) === bH && await board(P2) === bH, 'same scores on all phones: ' + [bH, await board(P1), await board(P2)].join(' | '));
  check(await P1.locator('[data-act="next"]').count() === 0, 'players can’t move on');
  await H.click('[data-act="next"]');
  for (const p of [P1, P2]) await p.waitForFunction(() => /spider/.test(document.querySelector('.qtext') && document.querySelector('.qtext').innerText), null, { timeout: 10000 });
  check(await P1.locator('.ch.sel').count() === 0, 'fresh question, no answer yet');
  await P1.click('.ch[data-i="0"]'); await P2.click('.ch[data-i="1"]');
  await H.waitForFunction(() => /Answered: 2 of 2/i.test(document.getElementById('stage').innerText), null, { timeout: 10000 });
  await P1.waitForTimeout(2000);
  await H.click('[data-act="reveal"]');
  for (const p of [P1, P2]) await p.waitForSelector('.result', { timeout: 10000 });
  await P1.waitForTimeout(500);
  const b2 = await board(H);
  check(/Pia 1/.test(b2) && /Ned \+1 1/.test(b2), 'host board after Q2 ' + b2);
  check(await board(P1) === b2 && await board(P2) === b2, 'same scores on all phones after Q2');
  // End now
  await H.click('#menuBtn'); await H.click('#mEnd');
  for (const p of [H, P1, P2]) await p.waitForSelector('#winCard', { timeout: 10000 });
  check(/It’s a tie!/i.test(await text(P1, '#winCard')) && (await text(P2, '#winCard')).includes('Pia and Ned'), 'tie card on players');
  check((await text(P1, '#stage')).includes('Waiting for the quizmaster'), 'players wait for the host');
  await shot(P1, 'player-over');
  await shot(H, 'host-over');

  /* ---------------- New set, same group, with a 10 s timer */
  if (process.env.VERBOSE) console.log("== New set, same group, with a 10 s timer");
  await H.click('[data-act="newset"]');
  await H.click('#importBtn'); await H.fill('#imText', MESSY); await H.waitForSelector('#imResult .res'); await H.click('#imSave');
  await H.click('#setList [data-act="play"]:not([data-id="sample"])');   // Messy Skip
  check(await H.locator('#contNote').isVisible() && (await text(H, '#contNote')).includes(code), 'continue with the same group');
  await H.click('#timerSeg [data-t="10"]'); await H.uncheck('#shufQ'); await H.uncheck('#shufA');
  await H.click('#startBtn');
  for (const p of [P1, P2]) await p.waitForFunction(() => /sky/.test(document.querySelector('.qtext') && document.querySelector('.qtext').innerText), null, { timeout: 10000 });
  check(await P1.locator('#timer').count() === 1, 'timer shown');
  await shot(P2, 'player-timer');
  await P1.click('.ch[data-i="1"]');
  await P2.waitForTimeout(10500);
  check(await P2.locator('.ch[data-i="0"]').isDisabled() && (await text(P2, '.status')).includes('Time’s up'), 'answers lock when time runs out');
  await H.waitForFunction(() => /Answered: 1 of 2/i.test(document.getElementById('stage').innerText), null, { timeout: 5000 });
  await H.click('[data-act="reveal"]');
  for (const p of [P1, P2]) await p.waitForSelector('.result', { timeout: 10000 });
  check((await text(P2, '.result')).includes('You didn’t answer'), 'no answer result');
  const b3 = await board(P2);
  check(/Pia \+1 1/.test(b3) && /Ned 0/.test(b3) && await board(H) === b3, 'new round scores from zero ' + b3);
  // Play to the end: 3 more questions
  for (let i = 0; i < 3; i++) { await H.click('[data-act="next"]'); await H.click('[data-act="reveal"]'); }
  check((await text(H, '[data-act="next"]')).includes('See the final results'), 'last question button');
  await H.click('[data-act="next"]');
  for (const p of [H, P1, P2]) await p.waitForSelector('#winCard', { timeout: 15000 });
  check((await text(P2, '#winCard')).includes('Pia') && (await text(P2, '#winCard')).includes('1 out of 4'), 'final winner on all phones: ' + await text(P2, '#winCard'));

  /* ---------------- Dark mode + narrow screens (screenshots only) */
  if (process.env.VERBOSE) console.log("== Dark mode + narrow screens (screenshots only)");
  if (SHOTS) {
    const d = await mk({ colorScheme: 'dark' });
    await d.goto(BASE); await shot(d, 'dark-home');
    await d.click('#setList [data-act="play"][data-id="sample"]');
    await d.fill('#newPlayer', 'Amy'); await d.click('#addPlayerForm button'); await d.fill('#newPlayer', 'Bob'); await d.click('#addPlayerForm button');
    await d.click('#startBtn'); await shot(d, 'dark-question');
    await d.click('[data-act="reveal"]'); await d.click('.tog >> nth=0'); await shot(d, 'dark-reveal');
    await d.click('#menuBtn'); await d.click('#mEnd'); await d.waitForTimeout(2600); await shot(d, 'dark-over');
    await shot(P1, 'player-over-final');
    const n = await mk({ viewport: { width: 320, height: 640 } });
    await n.goto(BASE); await shot(n, 'narrow-home');
    await n.click('#importBtn'); await n.fill('#imText', MESSY); await n.waitForSelector('#imResult .res'); await shot(n, 'narrow-import');
    await n.click('#imFix'); await shot(n, 'narrow-editor');
    await n.locator('.eqb').nth(5).click(); await shot(n, 'narrow-qdialog'); await n.click('#qDlg [data-close]');
    await n.click('#edCancel');
    await n.click('#setList [data-act="play"][data-id="sample"]'); await n.click('.ps-mode[data-m="1"]'); await shot(n, 'narrow-setup-shared');
    await n.click('.ps-mode[data-m="0"]'); await n.fill('#newPlayer', 'Alexandra'); await n.click('#addPlayerForm button');
    await n.fill('#newPlayer', 'Bartholomew'); await n.click('#addPlayerForm button'); await n.click('#startBtn');
    await n.click('[data-act="reveal"]'); await shot(n, 'narrow-reveal');
    const w = await n.evaluate(() => document.documentElement.scrollWidth);
    check(w <= 320, 'no horizontal scroll at 320px: ' + w);
  }

  for (const p of all) check(!p.errs.length, 'page errors: ' + p.errs.join(' | '));
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ' passed:', e.message.split('\n').slice(0, 3).join(' '), (e.stack.match(/trivia_test.js:\d+/) || [''])[0]); process.exit(1); });
