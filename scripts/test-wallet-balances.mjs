import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fixture} from './trade-test-fixture.mjs';
const html=fs.readFileSync('index.html','utf8');
const extract=name=>html.split('\n').find(line=>line.startsWith('function '+name+'('));
import {approved,walletFixtures} from './wallet-balance-fixture.mjs';
function ui(ledger,limits){const ctx={readJSON:(key,fallback)=>key==='gyeongjin_allowance_ledger'?ledger:key==='gyeongjin_allowance_limits'?limits:fallback};vm.createContext(ctx);vm.runInContext(['allowanceStore','allowanceLimits','allowanceBook','allowanceApprovedBalance'].map(extract).join('\n')+'\n'+html.match(/function splitPaymentBalances\(name\)\{[\s\S]*?\n\}/)[0],ctx);return ctx}
test('all three children and all three wallets: approved request wrappers never count as postings',()=>{
 const ledger=walletFixtures(),limits={Alice:30000,Bob:60000,Cara:90000},ctx=ui(ledger,limits);
 for(const [i,name] of ['Alice','Bob','Cara'].entries()){const k=i+1;assert.equal(ctx.allowanceApprovedBalance(name,'card'),4000*k);assert.equal(ctx.allowanceApprovedBalance(name,'free'),16000*k);assert.equal(ctx.allowanceApprovedBalance(name,'minus'),-6000*k);assert.deepEqual(JSON.parse(JSON.stringify(ctx.splitPaymentBalances(name))),{free:16000*k,card:4000*k,minus:24000*k})}
});
test('legacy wallet/status, savings, child trades, split parts, refunds and cancellation count exactly once',()=>{
 const ledger={Alice:[{id:'legacy',type:'income',amount:500},approved('saving','card','expense',1000),approved('trade-credit','card','income',7000),approved('split-part','card','expense',2000,{splitPaymentId:'split'}),approved('refund','card','income',500),approved('cancelled-part','card','expense',999,{status:'cancelled'})]},ctx=ui(ledger,{Alice:10000});
 assert.equal(ctx.allowanceApprovedBalance('Alice','free'),500);assert.equal(ctx.allowanceApprovedBalance('Alice','card'),4500);assert.equal(ctx.allowanceApprovedBalance('Bob','card'),0);
});
test('server split approval agrees with each child UI, cancellation restores and other children remain untouched',async()=>{
 const h=await fixture(),ledger=walletFixtures(),limits={Alice:30000,Bob:60000,Cara:90000};
 h.sql.prepare("UPDATE family_state SET value_json=? WHERE state_key='allowance_ledger'").run(JSON.stringify(ledger));h.sql.prepare("UPDATE family_state SET value_json=? WHERE state_key='allowance_limits'").run(JSON.stringify(limits));
 for(const [i,name] of ['Alice','Bob','Cara'].entries()){
  const actor=['a','b','c'][i],before=h.ledger(),requestId='split_balances_'+i,allocations={free:100,card:100,minus:100};
  assert.equal((await h.call(actor,'/allowance/split/request',{child:name,requestId,date:'2026-11-01',title:'test purchase',amount:300,allocations,debtOrigin:'card'})).status,200);
  assert.equal((await h.call('p','/allowance/split/review',{child:name,id:requestId,action:'approve'})).status,200);
  const ctx=ui(h.ledger(),limits),base=ui(before,limits).splitPaymentBalances(name);for(const w of ['free','card','minus'])assert.equal(ctx.splitPaymentBalances(name)[w],base[w]-100);
  for(const other of Object.keys(before).filter(x=>x!==name))assert.deepEqual(h.ledger()[other],before[other]);
  assert.equal((await h.call('p','/allowance/split/review',{child:name,id:requestId,action:'cancel'})).status,200);
  for(const w of ['free','card','minus'])assert.equal(ui(h.ledger(),limits).splitPaymentBalances(name)[w],base[w]);
 }
});
test('server accepts legacy free wallet and caps minus capacity at its configured limit',async()=>{
 const h=await fixture(),ledger=h.ledger();ledger.Alice=[{id:'legacy',type:'income',amount:500},approved('minus-credit','minus','income',10000)];h.sql.prepare("UPDATE family_state SET value_json=? WHERE state_key='allowance_ledger'").run(JSON.stringify(ledger));
 let r=await h.call('a','/allowance/split/request',{child:'Alice',requestId:'split_legacy_free',date:'2026-11-01',title:'legacy',amount:500,allocations:{free:500,card:0,minus:0},debtOrigin:''});assert.equal(r.status,200);
 assert.equal((await h.call('p','/allowance/split/review',{child:'Alice',id:'split_legacy_free',action:'approve'})).status,200);
 r=await h.call('a','/allowance/split/request',{child:'Alice',requestId:'split_limit_cap',date:'2026-11-01',title:'limit',amount:5001,allocations:{free:0,card:0,minus:5001},debtOrigin:'card'});assert.equal(r.status,200);const before=h.ledger();
 assert.equal((await h.call('p','/allowance/split/review',{child:'Alice',id:'split_limit_cap',action:'approve'})).status,409);assert.deepEqual(h.ledger(),before);
});
test('minus transfer uses actual postings, ignoring already-approved transfer request',async()=>{
 const ledger=walletFixtures();let written=null;
 const ctx=ui(ledger,{Alice:30000});Object.assign(ctx,{decodeURIComponent,currentAccount:{name:'Parent'},localStorage:{setItem(k,v){written=JSON.parse(v)}},$:selector=>selector==='#minusTransferDestination'?{value:'card'}:null,pushFamilyStateKey:async()=>true,toast(){},confirm:()=>true,allowanceChild(){},localDateKey:()=> '2026-11-01',Date,Math,JSON});
 vm.runInContext(html.split('\n').find(x=>x.startsWith('async function requestMinusTransfer(')),ctx);
 await ctx.requestMinusTransfer('Alice',24001);assert.equal(written,null);await ctx.requestMinusTransfer('Alice',24000);assert.equal(written.Alice.at(-1).amount,24000);
});
