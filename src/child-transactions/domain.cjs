'use strict';
// Server integration must supply authoritative balances and persist changes atomically.
// This module intentionally has no database writes.
const {quote,repaymentQuote,refundQuote}=require('./settlement.cjs');
const {canBorrow,canSettleGoods,approvalReady,idempotencyKey}=require('./workflow.cjs');
function positive(n){if(!Number.isSafeInteger(n)||n<=0)throw new RangeError('positive integer amount required');return n}
function ensureChild(a,b){if(!a||!b||a===b)throw new Error('distinct child accounts required')}
function loanRequest({borrower,lender,gross,sourceWallet,destinationWallet,loans=[]}){
 ensureChild(borrower,lender);positive(gross);if(!canBorrow(loans,borrower))throw new Error('unpaid loan blocks borrowing');
 const payment=quote(gross,sourceWallet,destinationWallet);if(payment.net<=0)throw new Error('zero loan proceeds');
 return {kind:'loan',borrower,lender,payer:lender,payee:borrower,payment,principal:payment.net,status:'requested'};
}
function goodsRequest({buyer,seller,gross,sourceWallet,destinationWallet}){
 ensureChild(buyer,seller);positive(gross);const payment=quote(gross,sourceWallet,destinationWallet);
 if(payment.net<=0)throw new Error('zero sale proceeds');
 return {kind:'goods',buyer,seller,payer:buyer,payee:seller,payment,holdGross:gross,status:'requested'};
}
function prepareApproval(tx,{available,revision=0}){
 if(!tx||!['loan','goods'].includes(tx.kind)||!tx.id||!tx.payment)throw new Error('invalid transaction');
 if(!approvalReady(tx))throw new Error('both consents required');
 positive(tx.payment.gross);if(!Number.isSafeInteger(available)||available<tx.payment.gross)throw new Error('insufficient available balance');
 return {transactionId:tx.id,revision,idempotencyKey:idempotencyKey(tx.id,revision,'approve'),holdGross:tx.kind==='goods'?tx.payment.gross:0,immediateTransfer:tx.kind==='loan'};
}
function prepareGoodsSettlement(tx){if(!tx||!tx.id||!tx.payment||!Number.isSafeInteger(tx.payment.gross)||tx.payment.gross<=0||!Number.isSafeInteger(tx.payment.net)||!Number.isSafeInteger(tx.payment.fee)||tx.payment.gross!==tx.payment.net+tx.payment.fee)throw new Error('invalid settlement');if(!canSettleGoods(tx))throw new Error('delivery or hold not confirmed');return {transactionId:tx.id,releaseHold:tx.payment.gross,debitGross:tx.payment.gross,creditNet:tx.payment.net,fee:tx.payment.fee};}
function prepareRepayment({gross,sourceWallet,destinationWallet,outstanding}){positive(gross);positive(outstanding);const q=repaymentQuote(gross,sourceWallet,destinationWallet,outstanding);if(!q.principalReduction)throw new Error('zero principal reduction');return q}
function prepareRefund({payment,refundGross,refundedGross=0}){positive(refundGross);return refundQuote(payment,refundGross,refundedGross)}
module.exports={loanRequest,goodsRequest,prepareApproval,prepareGoodsSettlement,prepareRepayment,prepareRefund};
