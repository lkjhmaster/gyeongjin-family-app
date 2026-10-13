import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/worker.js';
const child='시원';
const fixture=()=>({[child]:[
 {id:'fund',status:'approved',type:'income',wallet:'card',amount:10000},
 {id:'debt',status:'approved',type:'expense',wallet:'minus',amount:3000,debtOrigin:'free'},
 {id:'request',status:'pending',type:'minus_repayment',wallet:'card',amount:2000,repaymentDebtId:'debt',date:'2026-10-13',title:'변제'}
],other:[{id:'untouched',status:'approved',type:'income',wallet:'free',amount:1234}]});
async function database(ledger=fixture(),admin=1){
 const sql=new DatabaseSync(':memory:');sql.exec(fs.readFileSync('schema.sql','utf8'));
 sql.prepare('INSERT INTO families(id,name) VALUES(?,?)').run('family','test');
 sql.prepare('INSERT INTO members(id,family_id,name,role,is_admin,password_hash,password_salt) VALUES(?,?,?,?,?,?,?)').run('member','family','관리자','parent',admin,'hash','salt');
 const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('test-token'))).toString('hex');
 sql.prepare("INSERT INTO sessions(token_hash,member_id,expires_at) VALUES(?,?,datetime('now','+1 day'))").run(hash,'member');
 sql.prepare('INSERT INTO family_state(family_id,state_key,value_json) VALUES(?,?,?)').run('family','allowance_ledger',JSON.stringify(ledger));
 let conflicts=0;
 const DB={prepare(query){let args=[];return {bind(...values){args=values;return this},async first(){return sql.prepare(query).get(...args)||null},async run(){if(query.startsWith('UPDATE family_state')&&conflicts){conflicts--;sql.prepare("UPDATE family_state SET value_json=json_set(value_json,'$.concurrent',1)").run();return {meta:{changes:0}}}const result=sql.prepare(query).run(...args);return {meta:{changes:Number(result.changes)}}}}}};
 return {env:{DB,RELEASE_SHA:'test'},sql,read:()=>JSON.parse(sql.prepare('SELECT value_json FROM family_state').get().value_json),conflict(n){conflicts=n}};
}
async function call(db,path,data,token=true){return worker.fetch(new Request('https://api.test'+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer test-token'}:{})},body:JSON.stringify(data)}),db.env)}
const cancel=db=>call(db,'/api/allowance/minus-repayment/cancel',{child,id:'request'});
const balance=(rows,wallet)=>rows.filter(x=>x.status==='approved'&&x.wallet===wallet).reduce((sum,x)=>sum+(x.type==='income'?x.amount:x.type==='expense'?-x.amount:0),0);
test('approval then cancellation restores both balances and preserves records',async()=>{
 const db=await database(),original=db.read();
 assert.equal((await call(db,'/api/allowance/minus-repayment/review',{child,id:'request',action:'approve'})).status,200);
 assert.equal(balance(db.read()[child],'card'),8000);assert.equal(balance(db.read()[child],'minus'),-2000);
 assert.equal((await cancel(db)).status,200);const rows=db.read()[child];
 assert.equal(balance(rows,'card'),10000);assert.equal(balance(rows,'minus'),-3000);
 assert.equal(rows.length,5);assert.equal(rows.filter(x=>x.status==='cancelled').length,3);
 assert.ok(rows.filter(x=>x.status==='cancelled').every(x=>x.cancelledBy==='관리자'&&x.cancelledAt));
 assert.deepEqual(db.read().other,original.other);
 const before=db.read();assert.equal((await cancel(db)).status,409);assert.deepEqual(db.read(),before);
});
test('pending cancellation leaves balances unchanged',async()=>{const db=await database();assert.equal((await cancel(db)).status,200);assert.equal(balance(db.read()[child],'card'),10000);assert.equal(db.read()[child].length,3)});
test('unauthenticated and non-admin cancellation cannot write',async()=>{const db=await database(fixture(),0),before=db.read();assert.equal((await cancel(db)).status,403);assert.equal((await call(db,'/api/allowance/minus-repayment/cancel',{child,id:'request'},false)).status,401);assert.deepEqual(db.read(),before)});
test('inconsistent settlement and duplicate IDs fail without changing ledger',async()=>{
 for(const corrupt of [rows=>rows.pop(),rows=>rows.push({...rows[3]}),rows=>rows.push({...rows[3],id:'extra',repaymentRequestId:'other'})]){
  const db=await database();await call(db,'/api/allowance/minus-repayment/review',{child,id:'request',action:'approve'});
  const ledger=db.read();corrupt(ledger[child]);db.sql.prepare('UPDATE family_state SET value_json=?').run(JSON.stringify(ledger));
  assert.equal((await cancel(db)).status,409);assert.deepEqual(db.read(),ledger);
 }
});
test('concurrent change retries while preserving the other writer',async()=>{const db=await database();db.conflict(1);assert.equal((await cancel(db)).status,200);assert.equal(db.read().concurrent,1)});
test('health requires working D1; CORS allows only existing apps',async()=>{
 const db=await database();for(const origin of ['https://gyeongjin-family-app.pages.dev','https://gyeongjin-family-app.muse-hooni.workers.dev','https://untrusted.test']){
  const r=await worker.fetch(new Request('https://api.test/api/health',{headers:{origin}}),db.env);assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),origin.includes('untrusted')?null:origin);assert.equal((await r.json()).database,true);
 }
 assert.equal((await worker.fetch(new Request('https://api.test/api/health'),{})).status,503);
});
test('UI cancellation invokes API and updates local state only after success',async()=>{
 const html=fs.readFileSync('index.html','utf8'),code=html.match(/async function cancelMinusRepayment[^\n]+/)[0];
 let stored={},expected='old',rendered=0;
 const context={currentAccount:{isAdmin:true},confirm:()=>true,decodeURIComponent,JSON,toast(){},localStorage:{setItem(k,v){stored[k]=v},getItem(){return 'card'}},allowanceLedgerExpectedJson:expected,allowanceChild(){rendered++},api:async(path,options)=>{assert.equal(path,'/api/allowance/minus-repayment/cancel');assert.deepEqual(JSON.parse(options.body),{child,id:'request'});return {ledger:fixture()}}};
 vm.createContext(context);vm.runInContext(code,context);await context.cancelMinusRepayment(encodeURIComponent(child),'request');
 assert.equal(stored.gyeongjin_allowance_ledger,JSON.stringify(fixture()));assert.equal(context.allowanceLedgerExpectedJson,JSON.stringify(fixture()));assert.equal(rendered,1);
 stored={};context.api=async()=>{throw new Error('conflict')};await context.cancelMinusRepayment(encodeURIComponent(child),'request');assert.deepEqual(stored,{});assert.equal(rendered,1);
 assert.ok(html.includes('onclick="cancelMinusRepayment(this.dataset.child,this.dataset.id)"'));
});
