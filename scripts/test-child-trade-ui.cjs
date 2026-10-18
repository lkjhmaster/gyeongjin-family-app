const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const html=fs.readFileSync('index.html','utf8');
const worker=fs.readFileSync('src/worker.js','utf8');
test('child trades remain non-settling until approval ledger is integrated',()=>{
 assert.match(worker,/canApprove:false/);
 assert.match(worker,/canSettle:false/);
 assert.match(html,/송금 승인 기능은 아직 준비 중입니다/);
});
test('loan request is backed by audit and idempotency inserts',()=>{
 assert.match(worker,/INSERT INTO child_trade_transactions/);
 assert.match(worker,/INSERT INTO child_trade_audit/);
 assert.match(worker,/INSERT INTO child_trade_idempotency/);
});
test('parents see pending queue and children have no approval controls',()=>{
 assert.match(html,/currentAccount\?\.isAdmin===true/);
 assert.match(html,/api\/child-trades\/approval-queue/);
 assert.doesNotMatch(html,/api\/child-trades\/approval\/approve/);
});

test('loan form is gated on server capability and includes idempotency',()=>{
 assert.match(html,/capability\?\.canRequest/);
 assert.match(html,/childTradeSubmitButton/);
 assert.match(html,/operationKey:button\.dataset\.key/);
 assert.match(worker,/api\/child-trades\/participants/);
});
