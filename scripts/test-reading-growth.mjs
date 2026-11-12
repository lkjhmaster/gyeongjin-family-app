import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/worker.js';
import {schoolYearOf, currentGrade} from '../src/reading-growth.js';

const tokenHash = async token => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
async function database({migrate = true} = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(fs.readFileSync('schema.sql', 'utf8'));
  if (migrate) sql.exec(fs.readFileSync('migrations/reading-growth/0001_reading_growth.sql', 'utf8'));
  if (migrate) sql.exec(fs.readFileSync('migrations/reading-growth/0002_reading_kinds.sql', 'utf8'));
  if (migrate) sql.exec(fs.readFileSync('migrations/reading-growth/0003_reading_levels.sql', 'utf8'));
  if (migrate) sql.exec(fs.readFileSync('migrations/reading-growth/0004_reading_details.sql', 'utf8'));
  if (migrate) sql.exec(fs.readFileSync('migrations/reading-growth/0005_reading_events.sql', 'utf8'));
  if (migrate) sql.exec(fs.readFileSync('migrations/memory-photos/0001_memory_photos.sql', 'utf8'));
  for (const f of ['family', 'other']) sql.prepare('INSERT INTO families(id,name) VALUES(?,?)').run(f, f);
  const members = [['admin', 'family', '엄마', 'parent', 1], ['child', 'family', '첫째', 'child', 0], ['sibling', 'family', '둘째', 'child', 0], ['outsider', 'other', '이웃', 'parent', 1]];
  for (const [id, family, name, role, admin] of members) {
    sql.prepare('INSERT INTO members(id,family_id,name,role,is_admin,password_hash,password_salt) VALUES(?,?,?,?,?,?,?)').run(id, family, name, role, admin, 'hash', 'salt');
    sql.prepare("INSERT INTO sessions(token_hash,member_id,expires_at) VALUES(?,?,datetime('now','+1 day'))").run(await tokenHash(id + '-token'), id);
  }
  const DB = {prepare(query) { let args = []; return {
    bind(...v) { args = v; return this; },
    async first() { return sql.prepare(query).get(...args) || null; },
    async run() { const r = sql.prepare(query).run(...args); return {meta: {changes: Number(r.changes)}}; },
    async all() { return {results: sql.prepare(query).all(...args)}; }
  }; }};
  return {env: {DB, RELEASE_SHA: 'test'}, sql};
}
const call = async (db, method, path, data, who = 'admin') => {
  const res = await worker.fetch(new Request('https://api.test' + path, {method, headers: {'content-type': 'application/json', ...(who ? {authorization: 'Bearer ' + who + '-token'} : {})}, ...(data === undefined ? {} : {body: JSON.stringify(data)})}), db.env);
  return {status: res.status, body: await res.json()};
};
const newBook = async (db, who = 'child') => (await call(db, 'POST', '/api/reading/books', {title: '어린 왕자', author: '생텍쥐페리'}, who)).body.id;

test('a child creates a book for self; parent sees all, siblings only their own, outsiders nothing', async () => {
  const db = await database();
  const id = await newBook(db);
  assert.ok(id);
  await call(db, 'POST', '/api/reading/books', {title: '동생 책'}, 'sibling');
  assert.equal((await call(db, 'GET', '/api/reading/books', undefined, 'admin')).body.books.length, 2);
  assert.deepEqual((await call(db, 'GET', '/api/reading/books', undefined, 'child')).body.books.map(b => b.title), ['어린 왕자']);
  assert.equal((await call(db, 'GET', '/api/reading/book?id=' + id, undefined, 'sibling')).status, 404);
  assert.equal((await call(db, 'GET', '/api/reading/book?id=' + id, undefined, 'outsider')).status, 404);
  assert.equal((await call(db, 'GET', '/api/reading/books', undefined, null)).status, 401);
  assert.equal((await call(db, 'POST', '/api/reading/books', {title: ''}, 'child')).status, 400);
});

test('parent can create a book for a child; invalid child is refused', async () => {
  const db = await database();
  assert.equal((await call(db, 'POST', '/api/reading/books', {title: 'A', childId: 'child'}, 'admin')).status, 201);
  assert.equal((await call(db, 'POST', '/api/reading/books', {title: 'A', childId: 'outsider'}, 'admin')).status, 404);
  assert.equal((await call(db, 'POST', '/api/reading/books', {title: 'A'}, 'admin')).status, 400);
});

test('answers are append-only: edits add versions, identical saves do nothing, only the owner writes', async () => {
  const db = await database(), id = await newBook(db);
  const save = (answer, who = 'child', promptId = 'intro1') => call(db, 'POST', '/api/reading/answers', {bookId: id, promptId, answer}, who);
  assert.equal((await save('표지가 예뻐서')).body.version, 1);
  assert.equal((await save('표지가 예뻐서')).body.unchanged, true);
  assert.equal((await save('표지가 예뻐서 골랐어요')).body.version, 2);
  assert.equal((await save('다른 질문 답', 'child', 'core1')).body.version, 1);
  assert.equal((await save('남의 답', 'sibling')).status, 404);
  assert.equal((await save('부모는 대신 못 씀', 'admin')).status, 404);
  assert.equal((await save('x', 'child', 'BAD ID!')).status, 400);
  assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM reading_answers').get().n, 3, 'old version is kept');
  const view = (await call(db, 'GET', '/api/reading/book?id=' + id, undefined, 'admin')).body;
  assert.deepEqual(view.answers.map(a => [a.prompt_id, a.version, a.answer]).sort(), [['core1', 1, '다른 질문 답'], ['intro1', 2, '표지가 예뻐서 골랐어요']]);
});

test('essay, submit, parent feedback with revision request, revised version, finalize keeps every version', async () => {
  const db = await database(), id = await newBook(db);
  const essay = body => call(db, 'POST', '/api/reading/essays', {bookId: id, body}, 'child');
  assert.equal((await call(db, 'POST', '/api/reading/submit', {bookId: id}, 'child')).status, 409, 'cannot submit before writing');
  assert.deepEqual((await essay('첫 초안')).body, {ok: true, version: 1, kind: 'draft'});
  assert.equal((await essay('첫 초안')).body.unchanged, true);
  assert.equal((await call(db, 'POST', '/api/reading/feedback', {bookId: id, praise: '좋아'}, 'admin')).status, 409, 'feedback only after submit');
  assert.equal((await call(db, 'POST', '/api/reading/submit', {bookId: id}, 'child')).status, 200);
  assert.equal((await essay('제출 후 수정')).status, 409, 'locked while under review');
  assert.equal((await call(db, 'POST', '/api/reading/feedback', {bookId: id, praise: '좋아'}, 'child')).status, 403);
  const fb = await call(db, 'POST', '/api/reading/feedback', {bookId: id, praise: '솔직해서 좋았어', improve: '이유를 더', questions: ['왜 그 장면이 기억에 남았어?', ''], requestRevision: true}, 'admin');
  assert.deepEqual(fb.body, {ok: true, status: 'writing'});
  assert.deepEqual((await essay('고친 글')).body, {ok: true, version: 2, kind: 'revision'});
  await call(db, 'POST', '/api/reading/submit', {bookId: id}, 'child');
  assert.equal((await call(db, 'POST', '/api/reading/finalize', {bookId: id}, 'child')).status, 403);
  assert.equal((await call(db, 'POST', '/api/reading/finalize', {bookId: id}, 'admin')).body.version, 3);
  const view = (await call(db, 'GET', '/api/reading/book?id=' + id, undefined, 'child')).body;
  assert.equal(view.book.status, 'done');
  assert.deepEqual(view.essays.map(e => [e.version, e.kind, e.body]), [[1, 'draft', '첫 초안'], [2, 'revision', '고친 글'], [3, 'final', '고친 글']]);
  assert.deepEqual(view.feedback[0].questions, ['왜 그 장면이 기억에 남았어?']);
  assert.equal(view.feedback[0].essayVersion, 1);
  assert.equal((await call(db, 'POST', '/api/reading/answers', {bookId: id, promptId: 'end1', answer: 'x'}, 'child')).status, 409, 'done books are closed');
});

test('missing tables answer 503 instead of crashing', async () => {
  const db = await database({migrate: false});
  assert.equal((await call(db, 'GET', '/api/reading/books')).status, 503);
});

test('kinds: book is the default, performance and exhibition are stored and listed, bad kinds are refused', async () => {
  const db = await database();
  const make = async kind => (await call(db, 'POST', '/api/reading/books', {title: kind || '기본', kind}, 'child')).body;
  const plain = await make(undefined), show = await make('performance'), expo = await make('exhibition');
  assert.equal(plain.kind, 'book');
  assert.equal((await call(db, 'POST', '/api/reading/books', {title: 'x', kind: 'movie'}, 'child')).status, 400);
  const list = (await call(db, 'GET', '/api/reading/books', undefined, 'child')).body.books;
  assert.deepEqual(Object.fromEntries(list.map(b => [b.id, b.kind])), {[plain.id]: 'book', [show.id]: 'performance', [expo.id]: 'exhibition'});
  assert.equal((await call(db, 'GET', '/api/reading/book?id=' + show.id, undefined, 'admin')).body.book.kind, 'performance');
  assert.equal((await call(db, 'GET', '/api/reading/book?id=' + plain.id, undefined, 'admin')).body.book.kind, 'book');
});

test('books created before kinds existed still read as books', async () => {
  const db = await database();
  db.sql.prepare("INSERT INTO reading_books(id,family_id,child_id,title) VALUES('old','family','child','옛 책')").run();
  assert.equal((await call(db, 'GET', '/api/reading/books', undefined, 'child')).body.books[0].kind, 'book');
});

test('migrations only add tables and are safe to run twice', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync('schema.sql', 'utf8'));
  for (const file of ['0001_reading_growth.sql', '0002_reading_kinds.sql', '0003_reading_levels.sql', '0004_reading_details.sql', '0005_reading_events.sql']) {
    const sql = fs.readFileSync('migrations/reading-growth/' + file, 'utf8');
    assert.doesNotMatch(sql.replace(/ON DELETE (CASCADE|SET NULL)/g, ''), /\b(DROP|ALTER|DELETE|UPDATE)\b/i);
    db.exec(sql); db.exec(sql);
  }
});

test('school year starts in March (Korea time) and grades advance one per school year, capped at 12th grade', () => {
  assert.equal(schoolYearOf(new Date('2026-11-13T00:00:00+09:00')), 2026);
  assert.equal(schoolYearOf(new Date('2027-02-28T23:59:00+09:00')), 2026);
  assert.equal(schoolYearOf(new Date('2027-03-01T00:00:00+09:00')), 2027);
  assert.equal(schoolYearOf(new Date('2027-02-28T15:00:00Z')), 2027, '2027-03-01 00:00 KST is still Feb 28 in UTC');
  assert.equal(currentGrade(9, 2026, new Date('2026-12-01T00:00:00+09:00')), 9);
  assert.equal(currentGrade(9, 2026, new Date('2027-03-02T00:00:00+09:00')), 10, '중3 becomes 고1');
  assert.equal(currentGrade(6, 2026, new Date('2027-03-02T00:00:00+09:00')), 7, '초6 becomes 중1');
  assert.equal(currentGrade(4, 2026, new Date('2028-03-02T00:00:00+09:00')), 6);
  assert.equal(currentGrade(12, 2026, new Date('2030-03-02T00:00:00+09:00')), 12);
});

test('a parent sets each child grade; the child reads only their own; others are refused', async () => {
  const db = await database();
  assert.equal((await call(db, 'GET', '/api/reading/levels', undefined, 'child')).body.me, null, 'unset until a parent sets it');
  assert.equal((await call(db, 'POST', '/api/reading/levels', {childId: 'child', grade: 9}, 'child')).status, 403);
  assert.equal((await call(db, 'POST', '/api/reading/levels', {childId: 'child', grade: 13}, 'admin')).status, 400);
  assert.equal((await call(db, 'POST', '/api/reading/levels', {childId: 'child', grade: 2.5}, 'admin')).status, 400);
  assert.equal((await call(db, 'POST', '/api/reading/levels', {childId: 'outsider', grade: 3}, 'admin')).status, 404, 'not a child of this family');
  assert.equal((await call(db, 'POST', '/api/reading/levels', {childId: 'admin', grade: 3}, 'admin')).status, 404, 'parents have no grade');
  assert.equal((await call(db, 'POST', '/api/reading/levels', {childId: 'child', grade: 9}, 'admin')).status, 200);
  assert.equal((await call(db, 'POST', '/api/reading/levels', {childId: 'child', grade: 8}, 'admin')).status, 200, 'setting again replaces it');
  assert.equal((await call(db, 'GET', '/api/reading/levels', undefined, 'child')).body.me, 8);
  assert.equal((await call(db, 'GET', '/api/reading/levels', undefined, 'sibling')).body.me, null);
  const list = (await call(db, 'GET', '/api/reading/levels', undefined, 'admin')).body.children;
  assert.deepEqual(list.map(c => [c.id, c.grade]).sort(), [['child', 8], ['sibling', null]]);
  assert.equal((await call(db, 'GET', '/api/reading/levels', undefined, 'outsider')).body.children.length, 0, 'other families see nothing of ours');
});

test('a stored grade advances by itself when the school year changes', async () => {
  const db = await database(), year = schoolYearOf();
  db.sql.prepare("INSERT INTO reading_levels(member_id,grade,school_year) VALUES('child',6,?)").run(year - 1);
  assert.equal((await call(db, 'GET', '/api/reading/levels', undefined, 'child')).body.me, 7);
  db.sql.prepare("INSERT INTO reading_levels(member_id,grade,school_year) VALUES('sibling',4,?)").run(year);
  assert.equal((await call(db, 'GET', '/api/reading/levels', undefined, 'sibling')).body.me, 4);
});

test('formats: only valid formats for the kind are accepted and they come back in lists and details', async () => {
  const db = await database();
  const make = (kind, format) => call(db, 'POST', '/api/reading/books', {title: kind + format, kind, format}, 'child');
  const orch = await make('performance', 'gugak_orch');
  assert.equal(orch.status, 201); assert.equal(orch.body.format, 'gugak_orch');
  assert.equal((await make('performance', 'art')).status, 400, 'an exhibition format is not a performance format');
  assert.equal((await make('exhibition', 'museum')).status, 201);
  assert.equal((await make('book', 'opera')).status, 400, 'books have no format');
  assert.equal((await make('performance', 'nope')).status, 400);
  assert.equal((await call(db, 'POST', '/api/reading/books', {title: '판소리 공연', kind: 'performance'}, 'child')).body.format, null, 'format is optional');
  assert.equal((await call(db, 'GET', '/api/reading/book?id=' + orch.body.id, undefined, 'admin')).body.book.format, 'gugak_orch');
  const list = (await call(db, 'GET', '/api/reading/books', undefined, 'child')).body.books;
  assert.deepEqual(list.map(b => b.format).sort(), ['gugak_orch', 'museum', null]);
});

test('cover photos must be photos stored by the same family and can be added later by the owner only', async () => {
  const db = await database(), ref = id => 'photo:' + id;
  db.sql.prepare("INSERT INTO memory_photos(id,family_id,data,size) VALUES('123e4567-e89b-42d3-a456-426614174000','family','x',1)").run();
  db.sql.prepare("INSERT INTO memory_photos(id,family_id,data,size) VALUES('223e4567-e89b-42d3-a456-426614174000','other','x',1)").run();
  const mine = ref('123e4567-e89b-42d3-a456-426614174000'), theirs = ref('223e4567-e89b-42d3-a456-426614174000');
  assert.equal((await call(db, 'POST', '/api/reading/books', {title: 'a', cover: theirs}, 'child')).status, 400, 'another family photo');
  assert.equal((await call(db, 'POST', '/api/reading/books', {title: 'a', cover: 'data:image/jpeg;base64,AAAA'}, 'child')).status, 400, 'inline data is not accepted');
  assert.equal((await call(db, 'POST', '/api/reading/books', {title: 'a', cover: 'photo:../../x'}, 'child')).status, 400);
  assert.equal(db.sql.prepare('SELECT COUNT(*) n FROM reading_books').get().n, 0, 'a refused cover creates nothing');
  const made = await call(db, 'POST', '/api/reading/books', {title: '표지 책', cover: mine}, 'child');
  assert.equal(made.body.cover, mine);
  const plain = (await call(db, 'POST', '/api/reading/books', {title: '나중에'}, 'child')).body.id;
  assert.equal((await call(db, 'POST', '/api/reading/cover', {bookId: plain, cover: mine}, 'admin')).status, 404, 'parents do not change a child record');
  assert.equal((await call(db, 'POST', '/api/reading/cover', {bookId: plain, cover: theirs}, 'child')).status, 400);
  assert.equal((await call(db, 'POST', '/api/reading/cover', {bookId: plain, cover: mine}, 'child')).status, 200);
  assert.equal((await call(db, 'GET', '/api/reading/book?id=' + plain, undefined, 'admin')).body.book.cover, mine);
});

test('timeline: every step is listed in order with who did it, including submit and revision request', async () => {
  const db = await database(); let n = 0;
  const tick = () => { n++; for (const tb of ['reading_books', 'reading_answers', 'reading_essays', 'reading_feedback', 'reading_events']) db.sql.exec(`UPDATE ${tb} SET created_at='2026-11-13 06:00:${String(n).padStart(2, '0')}' WHERE created_at NOT LIKE '2026-11-13 06:00:%'`); };
  const step = async (...a) => { const r = await call(db, ...a); tick(); return r; };
  const id = (await step('POST', '/api/reading/books', {title: '기록', kind: 'performance'}, 'child')).body.id;
  await step('POST', '/api/reading/answers', {bookId: id, promptId: 'intro1', answer: '처음'}, 'child');
  await step('POST', '/api/reading/answers', {bookId: id, promptId: 'intro1', answer: '고친 답'}, 'child');
  await step('POST', '/api/reading/essays', {bookId: id, body: '초안'}, 'child');
  await step('POST', '/api/reading/submit', {bookId: id}, 'child');
  await step('POST', '/api/reading/feedback', {bookId: id, praise: '좋아', requestRevision: true}, 'admin');
  await step('POST', '/api/reading/essays', {bookId: id, body: '수정'}, 'child');
  await step('POST', '/api/reading/submit', {bookId: id}, 'child');
  await step('POST', '/api/reading/finalize', {bookId: id}, 'admin');
  const t = (await call(db, 'GET', '/api/reading/book?id=' + id, undefined, 'child')).body.timeline;
  const seq = t.map(x => x.action).join(',');
  assert.match(seq, /^created,answer_saved,answer_edited,essay_saved,submitted,feedback,revision_requested,essay_saved,submitted,finalized$/);
  assert.equal(t.find(x => x.action === 'feedback').actor, '엄마', 'feedback is attributed to the parent');
  assert.equal(t.find(x => x.action === 'submitted').actor, '첫째');
  assert.equal(t.find(x => x.action === 'answer_edited').promptId, 'intro1');
  assert.equal((await call(db, 'GET', '/api/reading/book?id=' + id, undefined, 'admin')).body.timeline.length, t.length, 'parents see the same trail');
});

test('timeline still works and actions still succeed when the events table is missing', async () => {
  const db = await database(); db.sql.exec('DROP TABLE reading_events');
  const id = (await call(db, 'POST', '/api/reading/books', {title: '기록'}, 'child')).body.id;
  await call(db, 'POST', '/api/reading/essays', {bookId: id, body: '초안'}, 'child');
  assert.equal((await call(db, 'POST', '/api/reading/submit', {bookId: id}, 'child')).status, 200, 'submit does not depend on the audit table');
  const r = await call(db, 'GET', '/api/reading/book?id=' + id, undefined, 'child');
  assert.equal(r.status, 200); assert.equal(r.body.timeline[0].action, 'created');
});
