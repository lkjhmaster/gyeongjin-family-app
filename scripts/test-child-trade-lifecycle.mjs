import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './trade-test-fixture.mjs';
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
 const fs=await import('node:fs');for(const file of ['0001_additive_schema.sql','0002_atomic_lifecycle.sql'])h.sql.exec(fs.readFileSync('migrations/child-trades/'+file,'utf8'));
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
