// Read-only, parameterized query for outstanding child-to-child loans.
// Execute only after the additive child-trades migration is applied.
function loanSummaryQuery(familyId, childId) {
 if (typeof familyId !== 'string' || !familyId || typeof childId !== 'string' || !childId) throw new Error('family and child required');
 return {
  sql: "SELECT COALESCE(SUM(CASE WHEN l.borrower_id=? THEN l.outstanding_amount ELSE 0 END),0) borrowed, COALESCE(SUM(CASE WHEN l.lender_id=? THEN l.outstanding_amount ELSE 0 END),0) lent FROM child_trade_loans l JOIN child_trade_transactions t ON t.id=l.transaction_id WHERE t.family_id=? AND l.outstanding_amount>0 AND l.status IN ('active','disputed')",
  args: [childId,childId,familyId]
 };
}
function normalizeLoanSummary(row) {
 const borrowed=Number(row?.borrowed ?? 0),lent=Number(row?.lent ?? 0);
 if(!Number.isSafeInteger(borrowed)||borrowed<0||!Number.isSafeInteger(lent)||lent<0)throw new Error('invalid loan balances');
 return {borrowed,lent};
}
module.exports={loanSummaryQuery,normalizeLoanSummary};
