const assert = require('node:assert/strict');
const fs = require('node:fs'), http = require('node:http');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html;charset=utf-8'); r.end(fs.readFileSync('index.html')); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({headless: true}), page = await browser.newPage({viewport: {width: 360, height: 800}, serviceWorkers: 'block'});
  const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Seoul'}).format(new Date());
  const state = {chores: {'김시원': [
    {id: 'a', title: '독서', active: true, dayRecords: {[today]: {state: 'exempt_requested', reason: '선교여행'}}},
    {id: 'b', title: '와캠 학습', active: true, dayRecords: {[today]: {state: 'exempt_requested', reason: '선교여행'}}},
    {id: 'c', title: '양치', active: true, dayRecords: {[today]: {state: 'done'}}}], '라원': [
    {id: 'd', title: '독서', active: true, dayRecords: {[today]: {state: 'exempt_requested', reason: '아파요'}}}]}};
  const reviews = [];
  await page.route('https://gyeongjin-family-api.muse-hooni.workers.dev/**', route => {
    const req = route.request(), url = new URL(req.url());
    const cors = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'}, ok = json => route.fulfill({status: 200, headers: cors, json});
    if (req.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (url.pathname === '/api/chores/exemption/review') { const b = JSON.parse(req.postData()); reviews.push(b); const it = state.chores[b.name].find(x => x.id === b.id); it.dayRecords[b.date].state = b.decision === 'approve' ? 'exempt_approved' : 'exempt_rejected'; return ok({ok: true}); }
    if (url.pathname === '/api/password-requests') return ok({requests: []});
    if (url.pathname === '/api/child-trades/approval-queue') return ok({transactions: [], actions: []});
    if (url.pathname === '/api/state') return ok({state});
    return ok({});
  });
  await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForFunction(() => typeof family !== 'undefined');
  await page.evaluate(() => { currentAccount = {id: 'p', name: '후니', isAdmin: true}; localStorage.setItem('gyeongjin_auth_token', 't'); });
  await page.evaluate(() => approvalCenter()); await page.getByRole('heading', {name: '전체 승인 요청'}).waitFor();
  const cards = await page.locator('.event:has-text("면제 요청")').allInnerTexts();
  assert.equal(cards.length, 2, 'one card per child and day, not one per chore item: ' + JSON.stringify(cards));
  const sw = cards.find(c => c.includes('김시원')); assert.match(sw, /면제 요청 \(2건\)/); assert.match(sw, /독서 · 선교여행/); assert.match(sw, /와캠 학습 · 선교여행/); assert.ok(!sw.includes('양치'), 'done items are not listed');
  assert.ok(sw.includes('모두 승인') && sw.includes('모두 거절'), 'bulk buttons for several items');
  const one = cards.find(c => c.includes('라원')); assert.ok(!one.includes('면제 요청 (') && !one.includes('모두 승인'), 'a single request keeps the plain card');
  assert.match(await page.locator('h2:has-text("할 일")').innerText(), /할 일 \(2\)/);
  page.on('dialog', d => d.accept());
  await page.locator('.event:has-text("김시원") >> text=모두 승인').click(); await page.waitForTimeout(600);
  assert.deepEqual(reviews.map(r => r.id + ':' + r.decision), ['a:approve', 'b:approve'], 'every item is reviewed with the existing per-item endpoint');
  assert.equal(await page.locator('.event:has-text("김시원"):has-text("면제 요청")').count(), 0, 'approved group leaves the list');
  assert.equal(await page.locator('.event:has-text("라원"):has-text("면제 요청")').count(), 1, 'other child untouched');
  console.log('PASS exemption group browser: one card per child/day, bulk approve reviews each item');
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
