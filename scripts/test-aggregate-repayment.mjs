import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/worker.js';
import {planRepayment} from '../src/minus-repayment.js';
const child='아이';
const debt=(id,amount,origin,date='2026-10-29')=>({id,amount,debtOrigin:origin,date,title:id,type:'expense',wallet:'minus',status:'approved'});
const fund=(wallet='free',amount=200000)=>({id:'fund',amount,type:'income',wallet,status:'approved'});
const request=(amount=10000,wallet='free',aggregate=false)=>({id:'request',amount,wallet,type:'minus_repayment',status:'pending',repaymentDebtId:'small',date:'2026-10-29',...(aggregate?{repaymentMode:'aggregate-v1'}:{})});
async function fixture(rows,admin=1){
 const sql=new DatabaseSync(':memory:');sql.exec(fs.readFileSync('schema.sql','utf8'));
 sql.prepare('INSERT INTO families(id,name) VALUES(?,?)').run('f','test');
 sql.prepare('INSERT INTO members(id,family_id,name,role,is_admin,password_hash,password_salt) VALUES(?,?,?,?,?,?,?)').run('u','f',child,'parent',admin,'h','s');
 const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('token'))).toString('hex');sql.prepare("INSERT INTO sessions(token_hash,member_id,expires_at) VALUES(?,?,datetime('now','+1 day'))").run(hash,'u');
 sql.prepare('INSERT INTO family_state(family_id,state_key,value_json) VALUES(?,?,?)').run('f','allowance_ledger',JSON.stringify({[child]:rows,Other:[fund()]}));
 let conflicts=0;
 const DB={prepare(query){let values=[];return {bind(...v){values=v;return this},async first(){return sql.prepare(query).get(...values)||null},async run(){if(query.startsWith('UPDATE family_state')&&conflicts){conflicts--;sql.prepare("UPDATE family_state SET value_json=json_set(value_json,'$.external',1)").run();return {meta:{changes:0}}}const r=sql.prepare(query).run(...values);return {meta:{changes:Number(r.changes)}}}}}};
 const read=()=>JSON.parse(sql.prepare('SELECT value_json FROM family_state').get().value_json);
 const call=async(path,data,token=true)=>{const r=await worker.fetch(new Request('https://test/api/allowance/minus-repayment/'+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer token'}:{})},body:JSON.stringify({child,...data})}),{DB});return {status:r.status,...await r.json()}};
 return {sql,read,call,conflict(){conflicts++}};
}
test('screen example: old 10000 request selected against 5000 debt now spans FIFO total 109000',async()=>{
 const rows=[fund(),debt('old',100000,'card','2026-10-08'),debt('small',5000,'card','2026-10-18'),debt('goods',4000,'card','2026-10-24'),request()];
 const f=await fixture(rows),quote=await f.call('quote',{id:'request'});assert.equal(quote.status,200);assert.equal(quote.plan.total,109000);assert.equal(quote.plan.remainingAfter,99000);assert.equal(quote.plan.allocations[0].debtId,'old');
 assert.equal((await f.call('review',{id:'request',action:'approve',quoteToken:quote.quoteToken})).status,200);
 const saved=f.read()[child].find(x=>x.id==='request');assert.equal(saved.repaymentPlan.allocations[0].debtId,'old');assert.equal(saved.repaymentDebtId,'small');assert.equal(saved.repaymentAmount,10000);
});
test('same source before FIFO; free source pays either debt without fee',()=>{
 const rows=[fund(),debt('older-card',3000,'card','2026-01-01'),debt('newer-free',2000,'free','2026-10-01')];const p=planRepayment(rows,'free',4000);
 assert.deepEqual(p.allocations.map(x=>[x.debtId,x.repayment]),[['newer-free',2000],['older-card',2000]]);assert.equal(p.fee,0);assert.equal(p.remainingAfter,1000);
});
test('card source pays card first; fee once on free portion even across several small debts',()=>{
 const rows=[fund('card'),debt('free-old',1000,'free','2026-01-01'),debt('free-new',1000,'free','2026-02-01'),debt('card',1000,'card','2026-03-01')],p=planRepayment(rows,'card',4001);
 assert.equal(p.fee,1501);assert.equal(p.repayment,2500);assert.equal(p.remainingAfter,500);assert.deepEqual(p.allocations.map(x=>x.amount),[1000,2000,1001]);assert.equal(p.allocations.reduce((n,x)=>n+x.fee,0),1501);
 const full=planRepayment(rows,'card',5000);assert.equal(full.remainingAfter,0);assert.equal(full.repayment,3000);assert.throws(()=>planRepayment(rows,'card',5001));
});
test('multiple-credit approval/cancel is atomic, preserves source links, restores whole balances',async()=>{
 const f=await fixture([fund('card'),debt('one',1000,'card'),debt('two',2000,'free'),request(4001,'card',true)]),before=f.read(),q=await f.call('quote',{id:'request'});
 assert.equal((await f.call('review',{id:'request',action:'approve',quoteToken:q.quoteToken})).status,200);
 const rows=f.read()[child],credits=rows.filter(x=>x.repaymentRequestId==='request'&&x.wallet==='minus');assert.equal(credits.length,2);assert.deepEqual(credits.map(x=>x.debtOrigin),['card','free']);assert.equal(credits.reduce((n,x)=>n+x.amount,0),2500);
 const beforeDup=f.read();assert.equal((await f.call('review',{id:'request',action:'approve',quoteToken:q.quoteToken})).status,409);assert.deepEqual(f.read(),beforeDup);
 assert.equal((await f.call('cancel',{id:'request'})).status,200);assert.deepEqual(f.read().Other,before.Other);assert.equal(f.read()[child].filter(x=>x.repaymentRequestId==='request'&&x.status==='approved').length,0);assert.equal(planRepayment(f.read()[child],'card',0).total,3000);
});
test('pending requests do not change debt or balance; rejection and duplicate cancellation do not pay',async()=>{
 const f=await fixture([fund(),debt('small',5000,'card'),request(1000,'free',true)]),before=f.read();assert.equal((await f.call('quote',{id:'request'})).plan.total,5000);assert.deepEqual(f.read(),before);
 assert.equal((await f.call('review',{id:'request',action:'reject'})).status,200);assert.equal(f.read()[child].length,3);assert.equal((await f.call('cancel',{id:'request'})).status,409);
});
test('stale approval quote, overpayment, insufficient balance and missing token cannot write',async()=>{
 for(const [funds,debtAmount,amount] of [[100,1000,1000],[10000,1000,1001]]){
  const f=await fixture([fund('free',funds),debt('small',debtAmount,'card'),request(amount)]),before=f.read();assert.equal((await f.call('review',{id:'request',action:'approve'})).status,409);assert.deepEqual(f.read(),before);
 }
 const f=await fixture([fund(),debt('small',10000,'card'),request(1000,'free',true)]),q=await f.call('quote',{id:'request'});
 assert.equal((await f.call('review',{id:'request',action:'approve'})).status,409);
 const changed=f.read();changed[child].push(debt('extra',500,'card'));f.sql.prepare('UPDATE family_state SET value_json=?').run(JSON.stringify(changed));
 assert.equal((await f.call('review',{id:'request',action:'approve',quoteToken:q.quoteToken})).status,409);assert.deepEqual(f.read(),changed);
});
test('concurrent unrelated write retries successfully; child cannot approve or inspect another child',async()=>{
 const f=await fixture([fund(),debt('small',5000,'card'),request(1000,'free',true)]),q=await f.call('quote',{id:'request'});f.conflict();assert.equal((await f.call('review',{id:'request',action:'approve',quoteToken:q.quoteToken})).status,200);assert.equal(f.read().external,1);
 const childDb=await fixture([fund(),debt('small',5000,'card')],0);assert.equal((await childDb.call('quote',{wallet:'free',amount:1000})).status,200);assert.equal((await childDb.call('quote',{child:'Other',wallet:'free',amount:0})).status,403);assert.equal((await childDb.call('review',{id:'request',action:'approve'})).status,403);assert.equal((await childDb.call('quote',{wallet:'free',amount:0},false)).status,401);
});
test('malformed multi-credit settlement refuses cancellation without partial writes',async()=>{
 const f=await fixture([fund(),debt('one',500,'card'),debt('small',500,'card'),request(1000)]);await f.call('review',{id:'request',action:'approve'});const ledger=f.read();ledger[child].pop();f.sql.prepare('UPDATE family_state SET value_json=?').run(JSON.stringify(ledger));assert.equal((await f.call('cancel',{id:'request'})).status,409);assert.deepEqual(f.read(),ledger);
});
test('unknown source stays visible and is not silently classified; reversals restore original debt',()=>{
 const rows=[fund(),debt('unknown',500,undefined),debt('one',500,'card'),{id:'credit',wallet:'minus',type:'income',status:'approved',amount:300,repaymentDebtId:'one'},{id:'undo',wallet:'minus',type:'expense',status:'approved',amount:100,repaymentDebtId:'one'}];const p=planRepayment(rows,'free',300);assert.equal(p.total,800);assert.equal(p.byOrigin.unknown,500);assert.equal(p.remainingAfter,500);assert.throws(()=>planRepayment(rows,'free',301));
});
