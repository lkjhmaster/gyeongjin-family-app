import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {webcrypto} from 'node:crypto';
globalThis.crypto=webcrypto;
const {default:worker}=await import(pathToFileURL(process.cwd()+'/src/worker.js'));
const family='family-test',child='시원이';
let ledger={[child]:[{id:'income1',date:'2026-10-17',type:'income',wallet:'free',amount:10000,status:'approved'},{id:'income2',date:'2026-10-17',type:'income',wallet:'card',amount:5000,status:'approved'}]};
const db={
 prepare(sql){return {bind(...args){return {
 async first(){
  if(sql.includes('FROM sessions'))return {id:'parent',family_id:family,name:'후니요',is_admin:1};
  if(sql.includes('FROM members'))return {id:'child-id'};
  if(sql.includes('state_key=')&&sql.includes('allowance_limits'))return {value_json:JSON.stringify({[child]:30000})};
  if(sql.includes('state_key=')&&sql.includes('allowance_ledger'))return {value_json:JSON.stringify(ledger)};
  return null;
 },
 async run(){
  if(sql.startsWith('UPDATE family_state')&&sql.includes("state_key='allowance_ledger'")){
   const next=JSON.parse(args[0]),before=args[args.length-1];
   if(before!==JSON.stringify(ledger))return {meta:{changes:0}};
   ledger=next;return {meta:{changes:1}};
  }
  return {meta:{changes:0}};
 },
 async all(){return {results:[]}}
 }}}
}};
async function call(path,data){
 const req=new Request('https://example.test'+path,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify(data)});
 const res=await worker.fetch(req,{DB:db});return {status:res.status,data:await res.json()};
}
const allocations={free:2000,card:3000,minus:1000},requestId='split_test_request_001';
let r=await call('/api/allowance/split/request',{child,requestId,date:'2026-10-17',title:'문구 구매',amount:6000,allocations,debtOrigin:'card'});
assert.equal(r.status,200);assert.equal(ledger[child].filter(x=>x.type==='split_payment').length,1);
r=await call('/api/allowance/split/request',{child,requestId,date:'2026-10-17',title:'문구 구매',amount:6000,allocations,debtOrigin:'card'});
assert.equal(r.status,200);assert.equal(r.data.duplicate,true);
r=await call('/api/allowance/split/request',{child,requestId,date:'2026-10-17',title:'변경된 품목',amount:6000,allocations,debtOrigin:'card'});
assert.equal(r.status,409);
r=await call('/api/allowance/split/review',{child,id:requestId,action:'approve'});
assert.equal(r.status,200);assert.equal(ledger[child].filter(x=>x.splitPaymentId===requestId).length,3);
assert.equal(ledger[child].find(x=>x.id===requestId+'_minus').debtOrigin,'card');
r=await call('/api/allowance/split/review',{child,id:requestId,action:'approve'});
assert.equal(r.status,409);
r=await call('/api/allowance/split/review',{child,id:requestId,action:'cancel'});
assert.equal(r.status,200);assert.equal(ledger[child].filter(x=>x.splitPaymentId===requestId&&x.status==='cancelled').length,3);
r=await call('/api/allowance/split/review',{child,id:requestId,action:'cancel'});
assert.equal(r.status,409);
console.log('PASS: request retry, approval, duplicate prevention, debt origin, atomic cancellation');
