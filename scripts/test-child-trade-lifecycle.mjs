import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './trade-test-fixture.mjs';
import {fundingRefund} from '../src/child-transactions/funding.js';
test('real SQLite: consent, atomic loan, net principal, idempotency, immutable original rows',async()=>{
 const h=await fixture();const id=await h.create();await h.approve(id);
 assert.equal(h.sql.prepare('SELECT outstanding_amount FROM child_trade_loans').get().outstanding_amount,500);
 assert.equal(h.sql.prepare('SELECT SUM(amount) n FROM child_trade_postings').get().n,0);
 assert.equal(h.ledger().Alice.at(-1).amount,500);assert.equal(h.ledger().Bob.at(-1).amount,1000);
 assert.equal((await h.mutate('p','/child-trades/approval/approve',id)).status,409);
 const before=h.ledger(),changed=structuredClone(before);changed.Alice.pop();
 assert.equal((await h.call('p','/state',{key:'allowance_ledger',value:changed,expectedJson:JSON.stringify(before)},'PUT')).status,409);
 assert.throws(()=>h.sql.prepare("UPDATE child_trade_postings SET amount=1").run(),/immutable/);
});
test('real SQLite: goods hold protects other writers, two deliveries settle exactly once',async()=>{
 const h=await fixture(),id=await h.create('goods',{gross:18000,destinationWallet:'card'});const initial=h.ledger();await h.approve(id);assert.deepEqual(h.ledger(),initial);
 const over=structuredClone(initial);over.Alice.push({id:'spend',type:'expense',wallet:'card',amount:3000,status:'approved'});
 assert.throws(()=>h.sql.prepare("UPDATE family_state SET value_json=? WHERE state_key='allowance_ledger'").run(JSON.stringify(over)),/reserved/);
 assert.equal((await h.mutate('a','/child-trades/delivery',id)).status,200);assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM child_trade_postings').get().n,0);
 assert.equal((await h.mutate('b','/child-trades/delivery',id)).status,200);assert.equal(h.row(id).status,'settled');
 assert.equal((await h.mutate('b','/child-trades/delivery',id)).status,409);assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM child_trade_postings').get().n,2);
});
test('real SQLite: partial and full repayment reduce only received principal; overpayment blocked',async()=>{
 const h=await fixture(),id=await h.create();await h.approve(id);const loan=h.sql.prepare('SELECT * FROM child_trade_loans').get();
 const repay=await h.create('repayment',{loanId:loan.id,gross:400});await h.approve(repay);assert.equal(h.sql.prepare('SELECT outstanding_amount n FROM child_trade_loans').get().n,300);
 const bad=await h.call('a','/child-trades',{kind:'repayment',loanId:loan.id,gross:1000,sourceWallet:'card',destinationWallet:'free',operationKey:crypto.randomUUID()});assert.equal(bad.status,409);
 const rest=await h.create('repayment',{loanId:loan.id,gross:600});await h.approve(rest);assert.equal(h.row(id).status,'settled');assert.equal(h.sql.prepare('SELECT outstanding_amount n FROM child_trade_loans').get().n,0);
 assert.equal((await h.action(rest,'refund',{gross:200})).status,200);assert.equal(h.sql.prepare('SELECT outstanding_amount n FROM child_trade_loans').get().n,100);assert.equal(h.row(id).status,'active');
});
test('real SQLite: proportional refunds append inverse postings and preserve every original',async()=>{
 const h=await fixture(),id=await h.create('goods',{gross:1001});await h.approve(id);await h.mutate('a','/child-trades/delivery',id);await h.mutate('b','/child-trades/delivery',id);
 const original=h.sql.prepare('SELECT * FROM child_trade_postings').all();assert.equal((await h.action(id,'refund',{gross:333})).status,200);assert.equal((await h.action(id,'cancel')).status,200);
 assert.equal(h.row(id).status,'cancelled');assert.equal(h.sql.prepare('SELECT SUM(amount) n FROM child_trade_postings').get().n,0);
 for(const p of original)assert.deepEqual(h.sql.prepare('SELECT * FROM child_trade_postings WHERE id=?').get(p.id),p);
 assert.equal(h.sql.prepare("SELECT SUM(amount) n FROM child_trade_postings WHERE owner_id='fee:f'").get().n,0);
 assert.equal((await h.mutate('a','/child-trades/action/request',id,{kind:'refund',gross:1})).status,409);
});
test('real SQLite: failure midway and concurrent allowance update roll back ALL trade writes',async()=>{
 for(const failure of ['midway','race']){const h=await fixture(),id=await h.create();await h.mutate('b','/child-trades/decision',id,{decision:'consent'});const before=h.ledger();
  if(failure==='midway')h.fail(4);else h.race(sql=>sql.prepare("UPDATE family_state SET value_json=json_set(value_json,'$.other',json('[]')) WHERE state_key='allowance_ledger'").run());
  assert.equal((await h.mutate('p','/child-trades/approval/approve',id)).status,409);assert.equal(h.row(id).status,'consented');assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM child_trade_postings').get().n,0);assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM child_trade_loans').get().n,0);
  assert.deepEqual(h.ledger().Alice,before.Alice);assert.deepEqual(h.ledger().Bob,before.Bob);if(failure==='race')assert.deepEqual(h.ledger().other,[]);
 }
});
test('real SQLite: hold cancel, dispute blocks payout, mutual resolve, changed terms require fresh consent',async()=>{
 const h=await fixture(),id=await h.create('goods');await h.approve(id);await h.mutate('a','/child-trades/dispute',id,{reason:'delivery missing'});
 assert.equal((await h.mutate('b','/child-trades/delivery',id)).status,409);assert.equal((await h.action(id,'resolve')).status,200);assert.equal(h.row(id).status,'held');
 assert.equal((await h.action(id,'revise',{gross:2000,sourceWallet:'free',destinationWallet:'card'})).status,200);assert.equal(h.row(id).status,'requested');
 assert.equal((await h.mutate('p','/child-trades/approval/approve',id)).status,409);await h.approve(id);assert.equal((await h.action(id,'cancel')).status,200);
 assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM child_trade_postings').get().n,0);assert.equal(h.sql.prepare("SELECT COUNT(*) n FROM child_trade_holds WHERE status='active'").get().n,0);
});
test('real SQLite: family and role isolation, debt blocks new borrowing, due-date alerts never debit',async()=>{
 const h=await fixture(),id=await h.create('loan',{dueDate:'2020-01-01'});assert.equal((await h.mutate('c','/child-trades/decision',id,{decision:'consent'})).status,403);assert.equal((await h.mutate('a','/child-trades/approval/approve',id)).status,403);await h.approve(id);
 const r=await h.call('a','/child-trades',{kind:'loan',counterpartyId:'c',gross:100,sourceWallet:'card',destinationWallet:'card',operationKey:crypto.randomUUID()});assert.equal(r.status,409);
 const before=h.ledger();assert.equal((await h.call('a','/child-trades/notifications')).data.overdue.length,1);assert.deepEqual(h.ledger(),before);
});
test('real SQLite: minus debt receives net repayment and refund restores the same debt capacity',async()=>{
 const h=await fixture(),ledger=h.ledger();ledger.Bob.push({id:'debt-b',type:'expense',wallet:'minus',amount:2000,status:'approved',debtOrigin:'free'});
 h.sql.prepare("UPDATE family_state SET value_json=? WHERE state_key='allowance_ledger'").run(JSON.stringify(ledger));
 const id=await h.create('goods',{gross:1001,destinationWallet:'minus',destinationDebtId:'debt-b'});await h.approve(id);await h.mutate('a','/child-trades/delivery',id);await h.mutate('b','/child-trades/delivery',id);
 assert.equal(h.ledger().Bob.at(-1).repaymentDebtId,'debt-b');assert.equal(h.ledger().Bob.at(-1).amount,500);
 assert.equal((await h.action(id,'cancel')).status,200);assert.equal(h.ledger().Bob.at(-1).type,'expense');assert.equal(h.ledger().Bob.at(-1).repaymentDebtId,'debt-b');
 const next=await h.create('goods',{gross:4000,destinationWallet:'minus',destinationDebtId:'debt-b'});await h.approve(next);await h.mutate('a','/child-trades/delivery',next);assert.equal((await h.mutate('b','/child-trades/delivery',next)).status,200);
});
test('real SQLite: seller changes destination, buyer must reconsent; stale revisions fail',async()=>{
 const h=await fixture(),id=await h.create('goods');const revision=h.row(id).revision;
 assert.equal((await h.mutate('b','/child-trades/terms',id,{gross:1500,sourceWallet:'card',destinationWallet:'card'})).status,200);
 assert.equal((await h.call('b','/child-trades/decision',{transactionId:id,revision,decision:'consent'})).status,409);
 assert.equal((await h.mutate('b','/child-trades/decision',id,{decision:'consent'})).status,403);
 assert.equal((await h.mutate('a','/child-trades/decision',id,{decision:'consent'})).status,200);
 assert.equal((await h.mutate('p','/child-trades/approval/approve',id)).status,200);assert.equal(h.row(id).fee_amount,0);
});
test('real SQLite: insufficient refund enters parent adjustment without creating minus debt',async()=>{
 const h=await fixture(),id=await h.create('goods',{destinationWallet:'card'});await h.approve(id);await h.mutate('a','/child-trades/delivery',id);await h.mutate('b','/child-trades/delivery',id);
 const ledger=h.ledger();ledger.Bob.push({id:'spent',wallet:'card',type:'expense',status:'approved',amount:21000});h.sql.prepare("UPDATE family_state SET value_json=? WHERE state_key='allowance_ledger'").run(JSON.stringify(ledger));
 const before=h.ledger(),r=await h.action(id,'cancel');assert.equal(r.status,200);assert.equal(r.data.status,'disputed');assert.equal(h.row(id).status,'disputed');assert.deepEqual(h.ledger(),before);
});
test('real SQLite: reapplying additive migrations preserves all preexisting records',async()=>{
 const h=await fixture(),id=await h.create();await h.approve(id);const before=h.sql.prepare('SELECT * FROM child_trade_postings ORDER BY id').all(),ledger=h.ledger();
 const fs=await import('node:fs');for(const file of ['0001_additive_schema.sql','0002_atomic_lifecycle.sql','0003_split_funding.sql'])h.sql.exec(fs.readFileSync('migrations/child-trades/'+file,'utf8'));
 assert.deepEqual(h.sql.prepare('SELECT * FROM child_trade_postings ORDER BY id').all(),before);assert.deepEqual(h.ledger(),ledger);
});
test('real SQLite: cross-family reads and writes cannot reach another family transaction',async()=>{
 const h=await fixture(),id=await h.create();h.sql.prepare("INSERT INTO families(id,name) VALUES('other','other')").run();h.sql.prepare("UPDATE members SET family_id='other' WHERE id='c'").run();
 assert.equal((await h.call('c','/child-trades/detail?id='+id)).status,404);assert.equal((await h.mutate('c','/child-trades/decision',id,{decision:'consent'})).status,404);
});
test('real SQLite: recurring allowance atomically claims once, preserves trades and concurrent writes',async()=>{
 const {processRecurringAtomic}=await import('../src/recurring.js');const h=await fixture(),id=await h.create();await h.approve(id);
 const day=Number(new Date(Date.now()+32400000).toISOString().slice(8,10));
 h.sql.prepare('INSERT INTO recurring_expenses(id,family_id,kind,title,amount,billing_day,allowance_member_name) VALUES(?,?,?,?,?,?,?)').run('monthly','f','allowance','monthly',2000,day,'Alice');
 const before=h.ledger();h.race(sql=>sql.prepare("UPDATE family_state SET value_json=json_set(value_json,'$.concurrent',json('[]')) WHERE state_key='allowance_ledger'").run());
 await processRecurringAtomic(h.env);await processRecurringAtomic(h.env);
 assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM recurring_expense_runs').get().n,1);assert.equal(h.ledger().Alice.filter(r=>r.recurringId==='monthly').length,1);assert.deepEqual(h.ledger().concurrent,[]);
 for(const row of before.Alice)assert.ok(h.ledger().Alice.some(r=>JSON.stringify(r)===JSON.stringify(row)));
 assert.equal(h.sql.prepare("SELECT json_array_length(value_json) n FROM family_state WHERE state_key='household_ledger'").get().n,1);
});
test('parent can resolve a refund shortage after rejecting the pending refund',async()=>{
 const h=await fixture(),id=await h.create('goods',{destinationWallet:'card'});await h.approve(id);await h.mutate('a','/child-trades/delivery',id);await h.mutate('b','/child-trades/delivery',id);
 const ledger=h.ledger();ledger.Bob.push({id:'spent',wallet:'card',type:'expense',status:'approved',amount:21000});h.sql.prepare("UPDATE family_state SET value_json=? WHERE state_key='allowance_ledger'").run(JSON.stringify(ledger));
 await h.action(id,'cancel');const pending=h.sql.prepare("SELECT id FROM child_trade_actions WHERE status='consented'").get();
 assert.equal((await h.mutate('p','/child-trades/action/decision',id,{actionId:pending.id,decision:'reject'})).status,200);
 const before=h.ledger();const result=await h.action(id,'resolve');assert.equal(result.status,200,JSON.stringify(result));assert.equal(h.row(id).status,'settled');assert.deepEqual(h.ledger(),before);
});
test('refund shortage blocks loan repayment until the parents resolve the adjustment',async()=>{
 const h=await fixture(),id=await h.create();await h.approve(id);const ledger=h.ledger();ledger.Alice.push({id:'spent-free',wallet:'free',type:'expense',status:'approved',amount:10500});h.sql.prepare("UPDATE family_state SET value_json=? WHERE state_key='allowance_ledger'").run(JSON.stringify(ledger));
 await h.action(id,'cancel');const loan=h.sql.prepare('SELECT * FROM child_trade_loans').get();assert.equal(loan.status,'disputed');
 const repay=await h.call('a','/child-trades',{kind:'repayment',loanId:loan.id,gross:100,sourceWallet:'card',destinationWallet:'card',operationKey:crypto.randomUUID()});assert.equal(repay.status,409);
});
test('repayment reversal preserves an existing loan dispute and resolution uses restored principal',async()=>{
 const h=await fixture(),id=await h.create();await h.approve(id);const loan=h.sql.prepare('SELECT * FROM child_trade_loans').get();const repayment=await h.create('repayment',{loanId:loan.id,gross:1000});await h.approve(repayment);
 assert.equal(h.row(id).status,'settled');assert.equal((await h.mutate('a','/child-trades/dispute',id,{reason:'review'})).status,200);
 assert.equal((await h.action(repayment,'refund',{gross:200})).status,200);assert.equal(h.row(id).status,'disputed');assert.equal(h.sql.prepare('SELECT status FROM child_trade_loans').get().status,'disputed');
 assert.equal((await h.action(id,'resolve')).status,200);assert.equal(h.row(id).status,'active');assert.equal(h.sql.prepare('SELECT outstanding_amount n FROM child_trade_loans').get().n,100);
});
test('partial loan refund does not silently resolve an existing dispute',async()=>{
 const h=await fixture(),id=await h.create();await h.approve(id);await h.mutate('a','/child-trades/dispute',id,{reason:'review'});
 assert.equal((await h.action(id,'refund',{gross:200})).status,200);assert.equal(h.row(id).status,'disputed');assert.equal(h.sql.prepare('SELECT status FROM child_trade_loans').get().status,'disputed');
 assert.equal((await h.action(id,'resolve')).status,200);assert.equal(h.row(id).status,'active');assert.equal(h.sql.prepare('SELECT outstanding_amount n FROM child_trade_loans').get().n,400);
});
const split={free:300,card:400,minus:500};
test('goods combine three wallets, reserve without spending, and settle every leg once',async()=>{
 const h=await fixture(),before=h.ledger(),id=await h.create('goods',{gross:1200,allocations:split});
 assert.equal(h.row(id).fee_amount,450);assert.equal(h.row(id).net_amount,750);await h.approve(id);assert.deepEqual(h.ledger(),before);
 const balances=(await h.call('a','/child-trades/balances?child=Alice')).data.wallets;assert.deepEqual(balances.map(w=>w.reserved),[300,400,500]);
 const state=h.ledger();state.Alice.push({id:'overspend',wallet:'minus',type:'expense',amount:4600,status:'approved'});
 assert.throws(()=>h.sql.prepare("UPDATE family_state SET value_json=? WHERE state_key='allowance_ledger'").run(JSON.stringify(state)),/reserved/);
 assert.throws(()=>h.sql.prepare("UPDATE family_state SET value_json=? WHERE state_key='allowance_limits'").run(JSON.stringify({Alice:400,Bob:5000})),/reserved/);
 await h.mutate('a','/child-trades/delivery',id);assert.equal((await h.mutate('b','/child-trades/delivery',id)).status,200);
 const debits=h.sql.prepare("SELECT wallet,amount FROM child_trade_postings WHERE kind='debit' ORDER BY wallet").all();assert.deepEqual(debits.map(d=>[d.wallet,d.amount]),[['card',-400],['free',-300],['minus',-500]]);
 assert.equal(h.sql.prepare('SELECT SUM(amount) n FROM child_trade_postings').get().n,0);assert.equal(h.ledger().Bob.at(-1).amount,750);
 assert.equal((await h.mutate('b','/child-trades/delivery',id)).status,409);assert.equal(h.sql.prepare("SELECT COUNT(*) n FROM child_trade_funding WHERE hold_status='active'").get().n,0);
});
test('split partial then full refunds restore original wallets and their exact fees',async()=>{
 const h=await fixture(),id=await h.create('goods',{gross:1200,allocations:split});await h.approve(id);await h.mutate('a','/child-trades/delivery',id);await h.mutate('b','/child-trades/delivery',id);
 const original=h.sql.prepare('SELECT * FROM child_trade_postings ORDER BY id').all();assert.equal((await h.action(id,'refund',{gross:333})).status,200);assert.equal((await h.action(id,'cancel')).status,200);
 for(const wallet of ['free','card','minus'])assert.equal(h.sql.prepare('SELECT SUM(amount) n FROM child_trade_postings WHERE wallet=?').get(wallet).n,0);
 for(const p of original)assert.deepEqual(h.sql.prepare('SELECT * FROM child_trade_postings WHERE id=?').get(p.id),p);
 const incoming=h.ledger().Alice.filter(r=>r.childTradeId===id&&r.type==='income');assert.equal(incoming.reduce((n,r)=>n+r.amount,0),1200);assert.ok(incoming.filter(r=>r.wallet==='minus').every(r=>r.repaymentDebtId));
});
test('one insufficient wallet rejects the entire split and split holds include legacy holds',async()=>{
 const h=await fixture(),legacy=await h.create('goods',{gross:19000,sourceWallet:'card',destinationWallet:'card'});await h.approve(legacy);
 const id=await h.create('goods',{gross:1200,allocations:{free:100,card:1100}});await h.mutate('b','/child-trades/decision',id,{decision:'consent'});
 assert.equal((await h.mutate('p','/child-trades/approval/approve',id)).status,409);assert.equal(h.sql.prepare("SELECT COUNT(*) n FROM child_trade_funding WHERE hold_status='active'").get().n,0);assert.equal(h.row(id).status,'consented');
});
test('split cancellation releases every reservation and condition changes require new consent',async()=>{
 const h=await fixture(),id=await h.create('goods',{gross:1200,allocations:split});await h.approve(id);
 assert.equal((await h.action(id,'revise',{gross:1500,allocations:{free:1000,card:500},sourceWallet:'free',destinationWallet:'card'})).status,200);assert.equal(h.row(id).status,'requested');
 assert.equal((await h.mutate('p','/child-trades/approval/approve',id)).status,409);await h.approve(id);
 const parts=(await h.call('a','/child-trades/detail?id='+id)).data.funding;assert.deepEqual(parts.map(p=>[p.wallet,p.gross]),[['free',1000],['card',500]]);
 assert.equal((await h.action(id,'cancel')).status,200);assert.equal(h.sql.prepare("SELECT COUNT(*) n FROM child_trade_funding WHERE hold_status='active'").get().n,0);assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM child_trade_postings').get().n,0);
});
test('invalid splits and changed retry allocations do not create or duplicate a trade',async()=>{
 const h=await fixture(),base={kind:'goods',counterpartyId:'b',gross:1200,sourceWallet:'free',destinationWallet:'free',operationKey:crypto.randomUUID(),allocations:split};
 for(const allocations of [{free:1},{free:-1,card:1201},{free:1200.5},{free:1200,unknown:0}])assert.equal((await h.call('a','/child-trades',{...base,allocations})).status,400);
 const first=await h.call('a','/child-trades',base);assert.equal(first.status,201);assert.equal((await h.call('a','/child-trades',base)).data.id,first.data.id);
 assert.equal((await h.call('a','/child-trades',{...base,allocations:{free:500,card:700}})).status,409);assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM child_trade_transactions').get().n,1);
});
test('split settlement failures roll back reservation releases and every financial leg',async()=>{
 const h=await fixture(),id=await h.create('goods',{gross:1200,allocations:split});await h.approve(id);await h.mutate('a','/child-trades/delivery',id);const before=h.ledger();h.fail(6);
 assert.equal((await h.mutate('b','/child-trades/delivery',id)).status,409);assert.deepEqual(h.ledger(),before);assert.equal(h.sql.prepare('SELECT COUNT(*) n FROM child_trade_postings').get().n,0);assert.equal(h.sql.prepare("SELECT COUNT(*) n FROM child_trade_funding WHERE hold_status='active'").get().n,3);
});
test('cumulative wallet refunds are monotonic and exact even at one-won boundaries',()=>{
 for(const gross of [[1,1,1],[3,7,11],[13,23,31]]){
  const parts=gross.map((g,i)=>({wallet:['free','card','minus'][i],gross:g,fee:i?Math.round(g*.5):0})),total=gross.reduce((a,b)=>a+b),sums=[{gross:0,fee:0},{gross:0,fee:0},{gross:0,fee:0}];
  for(let n=1;n<=total;n++){const result=fundingRefund(parts,n-1,n);assert.equal(result.reduce((a,p)=>a+p.gross,0),1);result.forEach((r,i)=>{assert.ok(r.gross>=0&&r.fee>=0&&r.net>=0);sums[i].gross+=r.gross;sums[i].fee+=r.fee;});}
  sums.forEach((s,i)=>assert.deepEqual(s,{gross:parts[i].gross,fee:parts[i].fee}));
 }
});
test('split receipt can repay a minus debt using each source wallet fee policy',async()=>{
 const h=await fixture(),ledger=h.ledger();ledger.Bob.push({id:'minus-goods',type:'expense',wallet:'minus',amount:2000,status:'approved',debtOrigin:'free'});h.sql.prepare("UPDATE family_state SET value_json=? WHERE state_key='allowance_ledger'").run(JSON.stringify(ledger));
 const id=await h.create('goods',{gross:1200,allocations:split,destinationWallet:'minus',destinationDebtId:'minus-goods'});await h.approve(id);await h.mutate('a','/child-trades/delivery',id);assert.equal((await h.mutate('b','/child-trades/delivery',id)).status,200);assert.equal(h.ledger().Bob.at(-1).amount,750);assert.equal(h.ledger().Bob.at(-1).repaymentDebtId,'minus-goods');
 assert.equal((await h.action(id,'cancel')).status,200);assert.equal(h.ledger().Bob.at(-1).repaymentDebtId,'minus-goods');assert.equal(h.ledger().Bob.at(-1).amount,750);
});
