const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto').webcrypto;
const source=fs.readFileSync('src/worker.js','utf8').replace(/export default\s*\{[\s\S]*$/,'globalThis.__handler=handler;');
function createWorker(me){const calls=[];const env={DB:{prepare(sql){const q={bind(...args){this.args=args;return this},async first(){calls.push({sql,args:this.args});if(sql.includes('FROM sessions s'))return me;if(sql.includes('FROM members WHERE family_id=? AND name=?'))return {id:'child-1'};return null},async all(){calls.push({sql,args:this.args});return {results:[]}}};return q}}};const sandbox={crypto,TextEncoder,Response,Request,URL,Headers,Date,console};vm.runInNewContext(source,sandbox);return {env,calls,handler:sandbox.__handler}}
async function request(worker,query){return worker.handler.fetch(new Request('https://api.test/api/child-trades?'+query,{headers:{authorization:'Bearer test'}}),worker.env)}
test('child trade listing requires selected child',async()=>{const w=createWorker({id:'child-1',family_id:'family-1',is_admin:0});const r=await request(w,'status=active');assert.equal(r.status,400)});
test('non-admin cannot read other child transactions',async()=>{const w=createWorker({id:'child-2',family_id:'family-1',is_admin:0});const r=await request(w,'status=active&child=Child');assert.equal(r.status,403);assert.equal(w.calls.some(x=>x.sql.includes('FROM child_trade_transactions')),false)});
test('admin query scoped to selected child and family',async()=>{const w=createWorker({id:'parent-1',family_id:'family-1',is_admin:1});const r=await request(w,'status=completed&child=Child');assert.equal(r.status,200);const q=w.calls.find(x=>x.sql.includes('FROM child_trade_transactions'));assert.ok(q);assert.equal(q.args[0],'family-1');assert.equal(q.args[1],'child-1');assert.equal(q.args[2],'child-1');assert.ok(q.args.includes('settled'))});
test('invalid status rejected',async()=>{const w=createWorker({id:'parent-1',family_id:'family-1',is_admin:1});const r=await request(w,'status=unknown&child=Child');assert.equal(r.status,400)});

test('parent-only approval queue denies children',async()=>{const w=createWorker({id:'child-1',family_id:'family-1',is_admin:0});const r=await w.handler.fetch(new Request('https://api.test/api/child-trades/approval-queue',{headers:{authorization:'Bearer test'}}),w.env);assert.equal(r.status,403)});
test('parent approval queue is family-scoped',async()=>{const w=createWorker({id:'parent-1',family_id:'family-1',is_admin:1});const r=await w.handler.fetch(new Request('https://api.test/api/child-trades/approval-queue',{headers:{authorization:'Bearer test'}}),w.env);assert.equal(r.status,200);const q=w.calls.find(x=>x.sql.includes('FROM child_trade_transactions t'));assert.ok(q);assert.equal(q.args[0],'family-1')});
