'use strict';
// Pure state-transition validation; persistence and ledger postings MUST be server-side and atomic.
const STATES=Object.freeze({REQUESTED:'requested',CONSENTED:'consented',APPROVED:'approved',HELD:'held',ACTIVE:'active',DELIVERY_PENDING:'delivery_pending',SETTLED:'settled',REJECTED:'rejected',CANCELLED:'cancelled',DISPUTED:'disputed'});
const allowed={
 requested:['consented','cancelled','rejected'],
 consented:['approved','cancelled','rejected'],
 approved:['active','held','cancelled'],
 held:['delivery_pending','disputed','cancelled'],
 delivery_pending:['settled','disputed','cancelled'],
 disputed:['delivery_pending','cancelled'],
 active:['settled','disputed'],
 settled:[],cancelled:[],rejected:[]
};
function transition(current,next){if(!allowed[current]||!allowed[current].includes(next))throw new Error('invalid transaction transition: '+current+' -> '+next);return next}
function canBorrow(loans,borrowerId){if(!borrowerId)throw new Error('borrower required');return !loans.some(x=>x.borrowerId===borrowerId&&x.outstanding>0&&!['cancelled','rejected'].includes(x.status))}
function canSettleGoods(tx){return tx.kind==='goods'&&tx.status==='delivery_pending'&&tx.buyerConfirmed===true&&tx.sellerConfirmed===true&&tx.parentApproved===true&&tx.holdActive===true}
function approvalReady(tx){return tx.requesterConsented===true&&tx.counterpartyConsented===true&&tx.parentApproved!==true&&tx.status==='consented'}
function idempotencyKey(id,revision,action){if(!id||!Number.isSafeInteger(revision)||revision<0||!action)throw new Error('invalid idempotency arguments');return [id,revision,action].join(':')}
module.exports={STATES,transition,canBorrow,canSettleGoods,approvalReady,idempotencyKey};
