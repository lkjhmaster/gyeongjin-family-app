const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto').webcrypto;
const source=fs.readFileSync('src/worker.js','utf8').replace(/export default\\s*\\{[\\s\\S]*$/,'globalThis.testHandler=handler;');
function setup({admin=true,balance=2000,status='consented'}={}){
 const calls=[],ledger={Borrower:[],Lender:[{id:'existing',type:'income',wallet:'card',amount:balance,status:'approved'}]};
 const DB={prepare(sql){return {bind(...args){this.args=args;return this},async first(){calls.push({sql,args:this.args});if(sql.includes('FROM sessions s'))return {id:admin?'parent':'borrower',family_id:'family',name:admin?'Parent':'Borrower',is_admin:admin?1:0};if(sql.includes('FROM child_trade_transactions WHERE id=?'))return {id:'loan1',requester_id:'borrower',counterparty_id:'lender',source_wallet:'card',destination_wallet:'free',gross_amount:1000,fee_amount:500,net_amount:500,due_date:null,status,revision:1};if(sql.includes('FROM members WHERE id=?'))return {name:this.args[0]==='borrower'?'Borrower':'Lender'};if(sql.includes('COUNT(*)'))return {count:0};if(sql.includes("state_key='allowance_ledger'"))return {value_json:JSON.stringify(ledger)};return null}}},async batch(stmts){calls.push({batch:stmts.map(x=>({sql:x.sql,args:x.args}))});return stmts.map(()=>({meta:{changes:1}}))}};
 const wrapped={prepare(sql){const q=DB.prepare(sql);q.sql=sql;return q},batch:DB.batch};
 const sandbox={crypto,TextEncoder,Response,Request,URL,Headers,Date,console};vm.runInNewContext(source,sandbox);
 return {calls,DB:wrapped,handler:sandbox.testHandler};
}
async function approve(w){return w.handler.fetch(new Request('https://api.test/api/child-trades/approval/approve',{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({transactionId:'loan1'})}),{DB:w.DB})}
test('parent approval creates balanced ledger and loan postings in one batch',async()=>{const w=setup();const r=await approve(w);assert.equal(r.status,200);const batch=w.calls.find(x=>x.batch).batch;assert.equal(batch.length,8);const update=batch[0];assert.match(update.sql,/value_json=\\?/);const ledger=JSON.parse(update.args[0]);assert.equal(ledger.Lender.at(-1).amount,1000);assert.equal(ledger.Lender.at(-1).type,'expense');assert.equal(ledger.Borrower.at(-1).amount,500);assert.equal(ledger.Borrower.at(-1).type,'income');assert.match(batch[1].sql,/ELSE NULL END/);assert.equal(batch.filter(x=>x.sql.includes('child_trade_postings')).length,3)});
test('children cannot approve',async()=>{const w=setup({admin:false});const r=await approve(w);assert.equal(r.status,403);assert.equal(w.calls.some(x=>x.batch),false)});
test('insufficient balance does not mutate ledger',async()=>{const w=setup({balance:200});const r=await approve(w);assert.equal(r.status,409);assert.equal(w.calls.some(x=>x.batch),false)});
test('already processed approvals cannot settle twice',async()=>{const w=setup({status:'active'});const r=await approve(w);assert.equal(r.status,409);assert.equal(w.calls.some(x=>x.batch),false)});
