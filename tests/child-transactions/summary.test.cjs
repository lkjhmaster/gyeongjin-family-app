const assert=require('node:assert/strict');
const test=require('node:test');
const {loanSummaryQuery,normalizeLoanSummary}=require('../../src/child-transactions/summary.cjs');
test('summary is scoped to family and selected child',()=>{
 const q=loanSummaryQuery('family-1','child-2');
 assert.deepEqual(q.args,['child-2','child-2','family-1']);
 assert.match(q.sql,/t\.family_id=\?/);
 assert.match(q.sql,/outstanding_amount>0/);
 assert.match(q.sql,/disputed/);
});
test('summary rejects absent tenancy scope',()=>{
 assert.throws(()=>loanSummaryQuery('','child'),/required/);
 assert.throws(()=>loanSummaryQuery('family',''),/required/);
});
test('summary normalizes safe balances and rejects corrupt values',()=>{
 assert.deepEqual(normalizeLoanSummary({borrowed:2000,lent:3000}),{borrowed:2000,lent:3000});
 assert.deepEqual(normalizeLoanSummary(null),{borrowed:0,lent:0});
 assert.throws(()=>normalizeLoanSummary({borrowed:-1,lent:0}),/invalid/);
 assert.throws(()=>normalizeLoanSummary({borrowed:'Infinity',lent:0}),/invalid/);
});
