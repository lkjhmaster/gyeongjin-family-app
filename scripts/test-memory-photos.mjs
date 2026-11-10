import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/worker.js';

const PREFIX = 'data:image/jpeg;base64,';
const jpeg = (n = 40) => PREFIX + 'QUJD'.repeat(n);
const tokenHash = async token => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');

async function database({migrate = true} = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(fs.readFileSync('schema.sql', 'utf8'));
  if (migrate) sql.exec(fs.readFileSync('migrations/memory-photos/0001_memory_photos.sql', 'utf8'));
  sql.prepare('INSERT INTO families(id,name) VALUES(?,?)').run('family', 'test');
  sql.prepare('INSERT INTO families(id,name) VALUES(?,?)').run('other', 'other');
  const members = [['admin', 'family', '관리자', 'parent', 1], ['child', 'family', '아이', 'child', 0], ['outsider', 'other', '이웃', 'parent', 1]];
  for (const [id, family, name, role, admin] of members) {
    sql.prepare('INSERT INTO members(id,family_id,name,role,is_admin,password_hash,password_salt) VALUES(?,?,?,?,?,?,?)').run(id, family, name, role, admin, 'hash', 'salt');
    sql.prepare("INSERT INTO sessions(token_hash,member_id,expires_at) VALUES(?,?,datetime('now','+1 day'))").run(await tokenHash(id + '-token'), id);
  }
  const DB = {
    prepare(query) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return sql.prepare(query).get(...args) || null; },
        async run() { const r = sql.prepare(query).run(...args); return {meta: {changes: Number(r.changes)}}; },
        async all() { return {results: sql.prepare(query).all(...args)}; }
      };
    }
  };
  return {env: {DB, RELEASE_SHA: 'test'}, sql};
}

const call = (db, method, path, data, who = 'admin') => worker.fetch(new Request('https://api.test' + path, {
  method,
  headers: {'content-type': 'application/json', ...(who ? {authorization: 'Bearer ' + who + '-token'} : {})},
  ...(data === undefined ? {} : {body: JSON.stringify(data)})
}), db.env);
const upload = async (db, dataUrl = jpeg(), who = 'admin') => {
  const res = await call(db, 'POST', '/api/photos', {dataUrl}, who);
  return {status: res.status, body: await res.json()};
};
const photoRows = db => db.sql.prepare('SELECT id,family_id,size FROM memory_photos ORDER BY id').all();
const seedMemories = (db, entries) => db.sql.prepare('INSERT OR REPLACE INTO family_state(family_id,state_key,value_json) VALUES(?,?,?)').run('family', 'memories', JSON.stringify(entries));
const readMemories = db => JSON.parse(db.sql.prepare("SELECT value_json FROM family_state WHERE family_id='family' AND state_key='memories'").get().value_json);

test('upload stores one row and returns a ref; only the same family can read it back', async () => {
  const db = await database(), photo = jpeg(60);
  const {status, body} = await upload(db, photo);
  assert.equal(status, 200);
  assert.match(body.ref, /^photo:[0-9a-f-]{36}$/);
  assert.equal(body.ref, 'photo:' + body.id);
  assert.deepEqual(photoRows(db).map(r => [r.id, r.family_id, r.size]), [[body.id, 'family', photo.length]]);
  const own = await call(db, 'GET', '/api/photos/' + body.id, undefined, 'child');
  assert.equal(own.status, 200);
  assert.equal(await own.text(), photo);
  assert.match(own.headers.get('cache-control'), /private/);
  assert.equal((await call(db, 'GET', '/api/photos/' + body.id, undefined, 'outsider')).status, 404);
  assert.equal((await call(db, 'GET', '/api/photos/' + body.id, undefined, null)).status, 401);
  assert.equal((await call(db, 'POST', '/api/photos', {dataUrl: photo}, null)).status, 401);
  assert.equal(photoRows(db).length, 1);
});

test('rejects non-JPEG data, unsafe characters and oversized photos without storing anything', async () => {
  const db = await database();
  for (const bad of ['data:image/png;base64,QUJD', PREFIX + '<script>', PREFIX, 'QUJD', 123, null, PREFIX + 'QUJD QUJD']) {
    assert.equal((await upload(db, bad)).status, 400, String(bad).slice(0, 30));
  }
  assert.equal((await upload(db, PREFIX + 'A'.repeat(900000))).status, 413);
  assert.equal(photoRows(db).length, 0);
});

test('family storage cap and daily upload cap stop further uploads', async () => {
  const db = await database();
  db.sql.prepare("INSERT INTO memory_photos(id,family_id,data,size,created_by,created_at) VALUES('big','family','x',349999999,'child',datetime('now','-3 day'))").run();
  assert.equal((await upload(db, jpeg(10))).status, 507);
  assert.equal((await upload(db, jpeg(10), 'outsider')).status, 200, 'another family is not affected');
  db.sql.exec("DELETE FROM memory_photos WHERE id='big'");
  for (let i = 0; i < 100; i++) db.sql.prepare("INSERT INTO memory_photos(id,family_id,data,size,created_by) VALUES(?,?,?,?,?)").run('p' + i, 'family', 'x', 1, 'child');
  assert.equal((await upload(db, jpeg(10), 'child')).status, 429);
  assert.equal((await upload(db, jpeg(10), 'admin')).status, 200, 'the limit is per member');
});

test('deleting one photo or a whole memory removes only that memory photo rows', async () => {
  const db = await database();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await upload(db, jpeg(10 + i))).body.id);
  const outsiderPhoto = (await upload(db, jpeg(10), 'outsider')).body.id;
  seedMemories(db, [
    {id: 'm1', title: '여행', photoData: '', photos: ['photo:' + ids[0], 'photo:' + ids[1], jpeg(5)]},
    {id: 'm2', title: '일상', photoData: '', photos: ['photo:' + ids[2]]}
  ]);
  let res = await call(db, 'POST', '/api/memories/delete', {id: 'm1', photoIndex: 0});
  assert.equal(res.status, 200);
  assert.deepEqual(photoRows(db).map(r => r.id).sort(), [ids[1], ids[2], outsiderPhoto].sort());
  assert.deepEqual(readMemories(db)[0].photos, ['photo:' + ids[1], jpeg(5)]);
  assert.equal(readMemories(db)[0].photoData, '', 'no duplicate copy of the first photo is written');
  res = await call(db, 'POST', '/api/memories/delete', {id: 'm1', photoIndex: 1});
  assert.equal(res.status, 200);
  assert.equal(photoRows(db).length, 3, 'removing an inline legacy photo leaves stored photos alone');
  res = await call(db, 'POST', '/api/memories/delete', {id: 'm1'});
  assert.equal(res.status, 200);
  assert.deepEqual(photoRows(db).map(r => r.id).sort(), [ids[2], outsiderPhoto].sort());
  assert.deepEqual(readMemories(db).map(x => x.id), ['m2']);
  assert.equal((await call(db, 'POST', '/api/memories/delete', {id: 'm2'}, 'child')).status, 403);
  assert.equal(photoRows(db).length, 2, 'non-admin delete changes nothing');
});

test('a child cannot drop existing photo refs through a state save, but can add a new memory', async () => {
  const db = await database();
  const keep = (await upload(db, jpeg(10), 'admin')).body.ref, add = (await upload(db, jpeg(11), 'child')).body.ref;
  const existing = {id: 'm1', title: '여행', photoData: '', photos: [keep]};
  seedMemories(db, [existing]);
  let res = await call(db, 'PUT', '/api/state', {key: 'memories', value: [{...existing, photos: []}]}, 'child');
  assert.equal(res.status, 403);
  assert.deepEqual(readMemories(db), [existing]);
  const added = {id: 'm2', title: '새 추억', photoData: '', photos: [add]};
  res = await call(db, 'PUT', '/api/state', {key: 'memories', value: [added, existing]}, 'child');
  assert.equal(res.status, 200);
  assert.deepEqual(readMemories(db).map(x => x.id), ['m2', 'm1']);
  assert.deepEqual(readMemories(db)[1].photos, [keep]);
});

test('without the migration the upload fails cleanly with 503 instead of a crash', async () => {
  const db = await database({migrate: false});
  const {status, body} = await upload(db);
  assert.equal(status, 503);
  assert.match(body.error, /준비/);
});

test('the memory-photos migration is additive and safe to run repeatedly', async () => {
  const db = await database();
  const sqlText = fs.readFileSync('migrations/memory-photos/0001_memory_photos.sql', 'utf8');
  db.sql.exec(sqlText);
  assert.doesNotMatch(sqlText.replace(/--.*$/gm, ''), /\b(DROP\s|DELETE\s+FROM|UPDATE\s+\w+\s+SET|ALTER\s+TABLE|INSERT\s)/i);
  assert.match(sqlText, /CREATE TABLE IF NOT EXISTS memory_photos/);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM family_state").get().n, 0);
});
