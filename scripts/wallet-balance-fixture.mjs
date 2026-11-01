export const approved=(id,wallet,type,amount,more={})=>({id,wallet,type,amount,status:'approved',date:'2026-11-01',...more});
export const walletFixtures=()=>Object.fromEntries(['Alice','Bob','Cara'].map((name,i)=>{const k=i+1;return [name,[
 approved('card-fund-'+k,'card','income',10000*k),approved('card-request-'+k,'card','minus_repayment',6000*k),approved('card-debit-'+k,'card','expense',6000*k,{repaymentRequestId:'card-request-'+k}),
 approved('free-fund-'+k,'free','income',20000*k),approved('free-request-'+k,'free','minus_repayment',4000*k),approved('free-debit-'+k,'free','expense',4000*k,{repaymentRequestId:'free-request-'+k}),
 approved('minus-transfer-'+k,'minus','minus_transfer',5000*k),approved('minus-debit-'+k,'minus','expense',5000*k),approved('minus-expense-'+k,'minus','expense',1000*k),
 approved('pending-'+k,'card','expense',100000,{status:'pending'}),approved('cancelled-'+k,'card','expense',100000,{status:'cancelled'}),approved('rejected-'+k,'free','expense',100000,{status:'rejected'}),
 approved('split-parent-'+k,'split','split_payment',2000*k),approved('future-wrapper-'+k,'card','request_summary',900000)
 ]]}));
