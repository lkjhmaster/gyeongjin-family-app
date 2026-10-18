const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto').webcrypto;
const worker=fs.readFileSync('src/worker.js','utf8');
const source=worker.slice(0,worker.lastIndexOf('export default'))+'globalThis.testHandler=handler;';
function harness(member){
 const calls=[];let saved=null;
 const DB={prepare(sql){return {bind(...args){this.args=args;return this},async first(){calls.push({sql,args:this.args});if(sql.includes('FROM sessions s'))return member;if(sql.includes('FROM members WHERE id=?'))return {id:'lender'};if(sql.includes('FROM child_trade_idempotency'))return saved;if(sql.includes('COUNT(*)'))return {count:0};return null}}},async batch(statements){calls.push({batch:statements.length});const insert=statements.find(x=>x.args?.[0]&&x.args?.[2]==='loan');if(!insert)throw Error('missing transaction insert');saved={result_json:JSON.stringify({ok:true,id:insert.args[0],status:'requested',gross:insert.args[9],fee:insert.args[10],net:insert.args[11]})};return []}};
 const sandbox={crypto,TextEncoder,Response,Request,URL,Headers,Date,console};vm.runInNewContext(source,sandbox);return {calls,DB,handler:sandbox.testHandler};
}
async function post(h,payload){return h.handler.fetch(new Request('https://api.test/api/child-trades',{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify(payload)}),{DB:h.DB})}
const request={kind:'loan',counterpartyId:'lender',gross:1000,sourceWallet:'card',destinationWallet:'free',operationKey:'request-1234567890'};
test('loan request is audit logged and idempotent',async()=>{const h=harness({id:'borrower',family_id:'family',is_admin:0});const a=await post(h,request);assert.equal(a.status,201);const first=await a.json();assert.equal(first.net,500);assert.equal(first.fee,500);assert.equal(h.calls.filter(x=>x.batch).length,1);const b=await post(h,request);assert.equal(b.status,200);assert.equal((await b.json()).id,first.id);assert.equal(h.calls.filter(x=>x.batch).length,1)});
test('parents cannot initiate loans',async()=>{const h=harness({id:'parent',family_id:'family',is_admin:1});const r=await post(h,request);assert.equal(r.status,403)});
test('invalid amounts cannot create postings',async()=>{const h=harness({id:'borrower',family_id:'family',is_admin:0});const r=await post(h,{...request,gross:-100});assert.equal(r.status,400);assert.equal(h.calls.some(x=>x.batch),false)});

test('loan request requires replay protection key',async()=>{const h=harness({id:'borrower',family_id:'family',is_admin:0});const {operationKey,...payload}=request;const r=await post(h,payload);assert.equal(r.status,400);assert.equal(h.calls.some(x=>x.batch),false)});
test('goods trades remain disabled before hold accounting is implemented',async()=>{const h=harness({id:'borrower',family_id:'family',is_admin:0});const r=await post(h,{...request,kind:'goods'});assert.equal(r.status,503);assert.equal(h.calls.some(x=>x.batch),false)});
test('destination minus is blocked until repayment accounting is implemented',async()=>{const h=harness({id:'borrower',family_id:'family',is_admin:0});const r=await post(h,{...request,destinationWallet:'minus'});assert.equal(r.status,409);assert.equal(h.calls.some(x=>x.batch),false)});
