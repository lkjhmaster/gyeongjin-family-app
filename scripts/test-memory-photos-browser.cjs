const assert = require('node:assert/strict'), fs = require('node:fs'), http = require('node:http');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const REF = 'photo:123e4567-e89b-12d3-a456-426614174000', MISSING = 'photo:00000000-0000-4000-8000-000000000000';
(async () => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(fs.readFileSync('index.html')); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 360, height: 800}, serviceWorkers: 'block'}), errors = [], fetched = [];
    page.on('pageerror', e => errors.push(e.message));
    const jpeg = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 8; c.height = 8; return c.toDataURL('image/jpeg', .8); });
    const jpeg2 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 9; c.height = 9; const x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 9, 9); return c.toDataURL('image/jpeg', .8); });
    const cors = {'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS'};
    await page.route('https://gyeongjin-family-api.muse-hooni.workers.dev/**', async route => {
      const req = route.request(), url = new URL(req.url());
      if (req.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
      if (url.pathname === '/api/photos/' + REF.slice(6) && req.method() === 'GET') { fetched.push(req.headers().authorization); return route.fulfill({status: 200, headers: {...cors, 'content-type': 'text/plain'}, body: jpeg}); }
      if (url.pathname === '/api/photos/' + MISSING.slice(6)) return route.fulfill({status: 404, headers: cors, json: {error: 'no'}});
      if (url.pathname === '/api/photos' && req.method() === 'POST') return route.fulfill({status: 200, headers: cors, json: {ok: true, id: REF.slice(6), ref: REF}});
      return route.fulfill({status: 401, headers: cors, json: {error: 'login'}});
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => typeof family !== 'undefined' && typeof memories === 'function');
    await page.evaluate(([ref, missing, legacy]) => {
      localStorage.setItem('gyeongjin_auth_token', 'tok'); currentAccount = {id: 'p', name: 'Parent', isAdmin: true};
      state.memories = [
        {id: 'new', kind: '일상', title: '새 앨범', date: '2026-11-10', text: 'ref', photoName: '', photoData: '', photos: [ref, missing]},
        {id: 'old', kind: '여행', title: '옛 앨범', date: '2026-10-01', text: 'inline', photoName: 'a.jpg', photoData: legacy, photos: [legacy]}
      ];
      memoriesViewMode = 'list'; memories();
    }, [REF, MISSING, jpeg2]);
    const refImg = page.locator('img[data-photo-ref="' + REF + '"]').first();
    await page.waitForFunction(r => { const i = document.querySelector('img[data-photo-ref="' + r + '"]'); return i && i.src.startsWith('data:image/jpeg'); }, REF);
    assert.ok((await refImg.getAttribute('src')).startsWith('data:image/jpeg'), 'stored photo is shown after loading');
    assert.equal(fetched[0], 'Bearer tok', 'photo request carries the login token');
    await page.waitForFunction(m => document.querySelector('img[data-photo-ref="' + m + '"]')?.dataset.photoState === 'failed', MISSING);
    assert.equal(await page.locator('img[data-photo-ref="' + MISSING + '"]').getAttribute('alt'), '사진을 불러오지 못했어요');
    const legacyImg = page.locator('#main img[src="' + jpeg2 + '"]').first();
    assert.equal(await legacyImg.count(), 1, 'legacy inline photo still renders unchanged');
    assert.equal(await page.locator('img[data-photo-ref]').count(), 2);
    const before = fetched.length;
    await page.evaluate(() => { memories(); }); await page.waitForTimeout(300);
    assert.equal(fetched.length, before, 'photos already loaded are not downloaded again');
    await page.evaluate(id => openMemoryPhotoViewer(id, 0), 'new');
    await page.waitForFunction(() => document.querySelector('#memoryPhotoViewer img')?.src.startsWith('data:image/jpeg'));
    assert.equal(await page.locator('#memoryPhotoViewer span').first().innerText(), '1 / 2');
    const uploaded = await page.evaluate(d => uploadMemoryPhoto(d), jpeg2);
    assert.equal(uploaded, REF, 'upload helper returns the ref in the real page');
    for (const width of [320, 360, 768]) { await page.setViewportSize({width, height: 800}); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); }
    assert.deepEqual(errors, []);
    console.log('PASS memory photos browser: stored photos load with the login token, failed photo is labeled, legacy inline photos unchanged, no repeat downloads, viewer, upload helper');
  } finally { await browser.close(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
