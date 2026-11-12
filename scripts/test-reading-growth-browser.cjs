const assert = require('node:assert/strict'), fs = require('node:fs'), http = require('node:http');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(fs.readFileSync('index.html')); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 360, height: 800}, serviceWorkers: 'block'}), errors = [], posts = [];
    page.on('pageerror', e => errors.push(e.message));
    const cors = {'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS'};
    const db = {books: [{id: 'b1', child_id: 'kid', child_name: '첫째', title: '어린 왕자', author: '생텍쥐페리', status: 'reading'}, {id: 'b2', child_id: 'kid', child_name: '첫째', title: '완료한 책', author: '', status: 'done'}], answers: [], essays: [], feedback: [], grade: null};
    await page.route('https://gyeongjin-family-api.muse-hooni.workers.dev/**', async route => {
      const req = route.request(), url = new URL(req.url()), ok = json => route.fulfill({status: 200, headers: cors, json});
      if (req.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
      if (url.pathname === '/api/reading/levels' && req.method() === 'GET') return ok({ok: true, me: db.grade, children: [{id: 'kid', name: '첫째', grade: db.grade}]});
      if (url.pathname === '/api/reading/levels') { const b = JSON.parse(req.postData()); posts.push(['grade', b]); db.grade = b.grade; return ok({ok: true, grade: b.grade}); }
      if (url.pathname === '/api/reading/books' && req.method() === 'GET') return ok({ok: true, books: db.books});
      if (url.pathname === '/api/reading/books') { const b = JSON.parse(req.postData()); posts.push(['book', b]); const nid = 'b' + (db.books.length + 1); db.books.unshift({id: nid, child_id: 'kid', child_name: '첫째', title: b.title, author: b.author, status: 'reading', kind: b.kind}); return route.fulfill({status: 201, headers: cors, json: {ok: true, id: nid}}); }
      if (url.pathname === '/api/reading/book') return ok({ok: true, book: {id: url.searchParams.get('id'), childId: 'kid', title: db.books.find(b => b.id === url.searchParams.get('id')).title, author: '', kind: db.books.find(b => b.id === url.searchParams.get('id')).kind || 'book', status: db.books.find(b => b.id === url.searchParams.get('id')).status}, answers: db.answers, essays: db.essays, feedback: db.feedback});
      if (url.pathname === '/api/reading/answers') { const b = JSON.parse(req.postData()); posts.push(['answer', b]); const cur = db.answers.find(a => a.prompt_id === b.promptId); if (cur) cur.answer = b.answer; else db.answers.push({prompt_id: b.promptId, answer: b.answer, version: 1}); return route.fulfill({status: 201, headers: cors, json: {ok: true, version: 1}}); }
      return route.fulfill({status: 401, headers: cors, json: {error: 'login'}});
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => typeof reading === 'function' && typeof family !== 'undefined');
    await page.evaluate(() => { localStorage.setItem('gyeongjin_auth_token', 'tok'); currentAccount = {id: 'kid', name: '첫째', isAdmin: false}; reading(); });
    await page.waitForSelector('text=어린 왕자');
    assert.equal(await page.locator('text=완료한 책').count(), 1);
    assert.equal(await page.locator('#nav-reading').count(), 1);
    await page.fill('#readingTitle', '새 책'); await page.click('text=기록 추가');
    await page.waitForSelector('text=아직 학년이 정해지지 않았어요');
    assert.equal(await page.locator('textarea#readingAnswer').count(), 0, 'no questions until a parent sets the grade');
    assert.equal(await page.locator('text=몇 학년이야?').count(), 0, 'the child is never asked for a grade');
    await page.evaluate(() => { currentAccount = {id: 'p', name: 'Parent', isAdmin: true}; reading(); });
    await page.waitForSelector('summary:has-text("아이별 학년 설정 (필요해요)")');
    await page.selectOption('details select', '6');
    await page.waitForFunction(() => !document.body.innerText.includes('(필요해요)'));
    assert.deepEqual(posts.at(-1), ['grade', {childId: 'kid', grade: 6}]);
    await page.evaluate(() => { currentAccount = {id: 'kid', name: '첫째', isAdmin: false}; reading(); });
    await page.waitForSelector('text=새 책'); await page.evaluate(() => readingOpen('b3')); await page.waitForSelector('textarea#readingAnswer');
    assert.match(await page.locator('small').first().innerText(), /1 \/ 5/, 'grade 6 gets 5 questions');
    assert.deepEqual(posts[0], ['book', {title: '새 책', author: '', kind: 'book'}]);
    assert.equal(await page.locator('button[disabled]:has-text("독후감")').count(), 1, 'essay tab locked for a brand-new book');
    assert.match(await page.locator('h3').first().innerText(), /왜 골랐어/);
    await page.fill('#readingAnswer', '표지가 예뻐서'); await page.waitForSelector('text=저장됐어요');
    assert.deepEqual(posts.filter(p => p[0] === 'answer')[0], ['answer', {bookId: 'b3', promptId: 'intro1', answer: '표지가 예뻐서'}]);
    await page.click('text=다음 →'); await page.waitForSelector('text=가장 기억에 남는 장면');
    await page.click('text=← 이전'); assert.equal(await page.inputValue('#readingAnswer'), '표지가 예뻐서', 'answer is restored');
    await page.evaluate(() => { readingView.myGrade = 4; readingRender(); }); assert.match(await page.locator('small').first().innerText(), /1 \/ 4/, 'grade 4 gets 4 questions');
    await page.evaluate(() => { readingView.myGrade = 8; readingRender(); }); assert.match(await page.locator('small').first().innerText(), /1 \/ 6/, 'middle school gets 6 questions');
    for (let i = 0; i < 4; i++) await page.click('text=다음 →');
    assert.match(await page.locator('h3').first().innerText(), /다른 사람은 다르게/);
    await page.click('text=다음 →'); assert.match(await page.locator('h3').first().innerText(), /말하고 싶은 한 가지/);
    for (const width of [320, 360, 768]) { await page.setViewportSize({width, height: 800}); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal scroll at ' + width); }
    await page.click('text=독후감'); await page.waitForSelector('text=내가 쓴 활동 답변 보기');
    await page.evaluate(() => { currentAccount = {id: 'p', name: 'Parent', isAdmin: true}; readingView.book.book.status = 'review'; readingView.book.essays = [{version: 1, kind: 'draft', body: '제출한 독후감 본문', created_at: '2026-11-10'}]; readingView.tab = 'feedback'; readingRender(); });
    await page.waitForSelector('text=제출한 독후감 본문');
    assert.equal(await page.locator('#fbPraise').count(), 1, 'parent reads the essay above the feedback form');
    await page.evaluate(() => { currentAccount = {id: 'kid', name: '첫째', isAdmin: false}; reading(); }); await page.waitForSelector('#readingKind');
    await page.selectOption('#readingKind', 'performance');
    assert.equal(await page.locator('#readingPlaceLabel').innerText(), '장소 (선택)');
    await page.fill('#readingTitle', '화충선생젼'); await page.click('text=기록 추가');
    await page.waitForSelector('textarea#readingAnswer');
    assert.deepEqual(posts.at(-1), ['book', {title: '화충선생젼', author: '', kind: 'performance'}]);
    assert.match(await page.locator('h3').first().innerText(), /이 공연을 왜 보러 갔어/);
    await page.fill('#readingAnswer', '판소리라서'); await page.waitForSelector('text=저장됐어요');
    await page.click('text=감상문');
    await page.waitForSelector('text=내가 쓴 활동 답변 보기');
    await page.evaluate(() => reading()); await page.waitForSelector('text=화충선생젼');
    await page.click('button:has-text("공연")');
    await page.waitForFunction(() => !document.body.innerText.includes('어린 왕자') && document.body.innerText.includes('화충선생젼'));
    assert.equal(await page.locator('text=어린 왕자').count(), 0, 'filter hides other kinds');
    assert.equal(await page.locator('text=화충선생젼').count(), 1);
    await page.evaluate(() => { currentAccount = {id: 'p', name: 'Parent', isAdmin: true}; readingView.book.answers = [{prompt_id: 'why3', answer: '다르게 생각해요', version: 1}]; readingView.tab = 'activity'; readingView.idx = 0; readingRender(); });
    assert.match(await page.locator('h3').first().innerText(), /다른 사람은 다르게/, 'parent sees answered questions whatever grade the child chose');
    assert.equal(await page.locator('textarea#readingAnswer').count(), 0, 'parent cannot edit the answer');
    assert.equal(await page.locator('text=몇 학년이야?').count(), 0, 'parent is never asked for a grade');
    assert.deepEqual(errors, []);
    console.log('PASS reading growth browser: list, add book, locked tabs, autosave, restore, grade mode, essay tab, no overflow');
  } finally { await browser.close(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
