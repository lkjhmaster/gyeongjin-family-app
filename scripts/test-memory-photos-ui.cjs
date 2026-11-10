const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const grab = name => {
  const m = html.match(new RegExp('^(?:async )?function ' + name + '\\b[^\\n]*$', 'm'));
  assert.ok(m, name + ' exists');
  return m[0];
};
const REF = 'photo:123e4567-e89b-12d3-a456-426614174000';
const DATA = 'data:image/jpeg;base64,QUJD';

function context(api) {
  const ctx = {
    esc: s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])),
    api, API_BASE: 'https://api.test', authToken: () => 'tok', fetch: async () => ({ok: true, text: async () => DATA}),
    document: {querySelectorAll: () => []}, Map, Error, RegExp, Promise
  };
  vm.createContext(ctx);
  vm.runInContext(html.match(/^const PHOTO_PLACEHOLDER=[^\n]*$/m)[0] + '\n' + ['isPhotoRef', 'photoImg', 'uploadMemoryPhoto', 'loadPhoto', 'hydratePhotos', 'setViewerPhoto'].map(grab).join('\n'), ctx);
  return ctx;
}

test('upload returns a photo ref and remembers the data for instant display', async () => {
  const ctx = context(async (path, options) => {
    assert.equal(path, '/api/photos');
    assert.equal(JSON.parse(options.body).dataUrl, DATA);
    return {ok: true, ref: REF};
  });
  assert.equal(await ctx.uploadMemoryPhoto(DATA), REF);
  assert.equal(await ctx.loadPhoto(REF), DATA);
});

test('server not ready or offline falls back to the inline photo so saving still works', async () => {
  for (const message of ['사진 저장소를 준비 중입니다. 잠시 후 다시 시도해주세요.', '서버 요청에 실패했습니다.', 'Failed to fetch']) {
    const ctx = context(async () => { throw new Error(message); });
    assert.equal(await ctx.uploadMemoryPhoto(DATA), DATA, message);
  }
});

test('storage, daily and size limit messages are shown instead of silently saving inline', async () => {
  for (const message of ['사진 저장 공간 한도에 가까워 더 올릴 수 없습니다. 관리자에게 알려주세요.', '하루에 올릴 수 있는 사진 수를 넘었습니다.', '사진 한 장의 크기가 너무 큽니다.']) {
    const ctx = context(async () => { throw new Error(message); });
    await assert.rejects(() => ctx.uploadMemoryPhoto(DATA), {message});
  }
});

test('refs render as lazy images while legacy inline photos keep their original markup', () => {
  const ctx = context(async () => ({}));
  assert.match(ctx.photoImg(REF), /data-photo-ref="photo:123e4567-e89b-12d3-a456-426614174000" src="data:image\/gif/);
  assert.equal(ctx.photoImg(DATA), 'src="' + DATA + '"');
  assert.equal(ctx.isPhotoRef('photo:../../x'), false);
  assert.equal(ctx.isPhotoRef(DATA), false);
  assert.doesNotMatch(ctx.photoImg('photo:"><script>'), /<script>/);
});

test('viewer shows the placeholder first, then the loaded photo, and ignores stale loads', async () => {
  const ctx = context(async () => ({}));
  const img = {dataset: {}, src: ''};
  ctx.setViewerPhoto(img, REF);
  assert.match(img.src, /^data:image\/gif/);
  await new Promise(r => setImmediate(r));
  assert.equal(img.src, DATA);
  ctx.setViewerPhoto(img, REF);
  ctx.setViewerPhoto(img, DATA);
  await new Promise(r => setImmediate(r));
  assert.equal(img.src, DATA, 'a late result of an earlier photo does not overwrite the current one');
});

test('memory save paths upload photos and never store a duplicate photoData', () => {
  assert.equal((html.match(/uploadMemoryPhoto\(await compressPhoto\(/g) || []).length, 3);
  assert.doesNotMatch(html, /photoData:photos\[0\]/);
  assert.doesNotMatch(html, /photos\.push\(await compressPhoto/);
  assert.match(html, /photoName:files\[0\]\?\.name\|\|'',photoData:'',photos\}/);
});
