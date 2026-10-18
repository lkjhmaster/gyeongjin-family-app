'use strict';
// Pure calculation helpers only; no ledger mutation, network calls, or approvals.
const WALLETS = ['free','card','minus'];
function assertAmount(n){if(!Number.isSafeInteger(n)||n<0)throw new RangeError('amount must be a nonnegative integer');return n;}
function feeRate(source,destination){if(!WALLETS.includes(source)||!WALLETS.includes(destination))throw new Error('invalid wallet');if(destination==='minus'&&source!==destination)throw new Error('minus repayment requires existing app policy adapter');return ((source==='card'||source==='minus')&&destination==='free')?0.5:0;}
function quote(gross,source,destination){assertAmount(gross);const rate=feeRate(source,destination);const fee=Math.round(gross*rate);return {gross,fee,net:gross-fee,rate,source,destination};}
function repaymentQuote(gross,source,destination,outstanding){assertAmount(outstanding);const q=quote(gross,source,destination);if(q.net>outstanding)throw new RangeError('repayment exceeds outstanding principal');return {...q,principalReduction:q.net,remaining:outstanding-q.net};}
function refundQuote(original,refundGross,alreadyRefundedGross=0){const {gross,fee,net}=original;[gross,fee,net,refundGross,alreadyRefundedGross].forEach(assertAmount);if(gross!==fee+net||refundGross+alreadyRefundedGross>gross)throw new RangeError('invalid refund');const cumulativeFee=Math.round(fee*(refundGross+alreadyRefundedGross)/gross)||0;const priorFee=Math.round(fee*alreadyRefundedGross/gross)||0;const refundFee=cumulativeFee-priorFee;return {refundGross,refundFee,refundNet:refundGross-refundFee};}
module.exports={feeRate,quote,repaymentQuote,refundQuote};
