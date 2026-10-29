// One repayment covers all eligible debts; original source and FIFO links remain intact.
const wallets=['free','card'];
const approved=x=>(x.status||'approved')==='approved';
const money=n=>{if(!Number.isSafeInteger(n)||n<0)throw Error('변제 원장의 금액을 확인해주세요.');return n};
const sum=xs=>money(xs.reduce((a,b)=>a+b,0));
export function repaymentSnapshot(rows,wallet){
 if(!wallets.includes(wallet))throw Error('변제 출금 지갑을 확인해주세요.');
 const entries=rows.filter(approved),seen=new Set();
 for(const x of entries){if(!x.id||seen.has(x.id))throw Error('원장 거래 식별자가 중복되거나 누락되었습니다.');seen.add(x.id)}
 const debts=entries.filter(x=>x.wallet==='minus'&&x.type==='expense'&&!x.repaymentDebtId),paid=new Map();
 for(const x of entries.filter(x=>x.wallet==='minus'&&x.repaymentDebtId&&['income','expense'].includes(x.type))){
  if(!debts.some(d=>d.id===x.repaymentDebtId))throw Error('원거래가 없는 마이너스 정산 기록을 확인해주세요.');
  paid.set(x.repaymentDebtId,(paid.get(x.repaymentDebtId)||0)+(x.type==='income'?1:-1)*money(Number(x.amount)));
 }
 if(entries.some(x=>x.wallet==='minus'&&x.type==='income'&&!x.repaymentDebtId&&Number(x.amount)>0))throw Error('원거래에 연결되지 않은 마이너스 입금이 있어 관리자 확인이 필요합니다.');
 const remaining=debts.map(x=>{const repaid=paid.get(x.id)||0;if(repaid<0||repaid>Number(x.amount))throw Error('마이너스 원거래와 변제 기록이 일치하지 않습니다.');return {debtId:x.id,origin:x.debtOrigin,date:x.date||'',createdAt:x.createdAt||'',title:x.title||'',remaining:money(Number(x.amount))-repaid}}).filter(x=>x.remaining>0);
 remaining.sort((a,b)=>(a.origin===wallet?0:1)-(b.origin===wallet?0:1)||a.date.localeCompare(b.date)||a.createdAt.localeCompare(b.createdAt)||a.debtId.localeCompare(b.debtId));
 const byOrigin={free:sum(remaining.filter(x=>x.origin==='free').map(x=>x.remaining)),card:sum(remaining.filter(x=>x.origin==='card').map(x=>x.remaining)),unknown:sum(remaining.filter(x=>!wallets.includes(x.origin)).map(x=>x.remaining))};
 const balance=entries.filter(x=>(x.wallet||'free')===wallet).reduce((n,x)=>n+(x.type==='income'?money(Number(x.amount)):x.type==='expense'?-money(Number(x.amount)):0),0);
 if(!Number.isSafeInteger(balance))throw Error('출금 지갑 잔액을 확인해주세요.');
 return {wallet,balance,total:sum(Object.values(byOrigin)),byOrigin,maxDebit:sum([byOrigin.card,byOrigin.free*(wallet==='card'?2:1)]),debts:remaining.filter(x=>wallets.includes(x.origin))};
}
export function planRepayment(rows,wallet,amount){
 const s=repaymentSnapshot(rows,wallet);money(amount);
 if(!amount)return {...s,amount:0,fee:0,repayment:0,remainingAfter:s.total,allocations:[]};
 if(amount>s.balance)throw Error('출금 지갑 잔고가 부족합니다.');
 if(amount>s.maxDebit)throw Error('출금액이 전체 미변제액과 수수료를 초과합니다.');
 let budget=amount;const allocations=[];
 // Apply the 50% fee once to the total card-to-free portion, avoiding per-debt rounding.
 for(const origin of [wallet,...wallets.filter(x=>x!==wallet)]){
  const group=s.debts.filter(x=>x.origin===origin),total=sum(group.map(x=>x.remaining)),taxed=wallet==='card'&&origin==='free';
  const gross=Math.min(budget,total*(taxed?2:1));if(!gross)continue;
  let net=taxed?Math.floor(gross/2):gross;if(!net)throw Error('수수료 차감 후 변제액이 0원입니다. 출금액을 조정해주세요.');
  const fee=gross-net;let extra=taxed?gross%2:0;
  for(const debt of group){if(!net)break;const repayment=Math.min(net,debt.remaining);net-=repayment;const partFee=taxed?repayment+(!net?extra:0):0;
   allocations.push({debtId:debt.debtId,origin,date:debt.date,title:debt.title,amount:repayment+partFee,fee:partFee,repayment});
  }
  budget-=gross;
 }
 if(budget)throw Error('출처가 확인된 미변제액 범위 안에서 입력해주세요.');
 const fee=sum(allocations.map(x=>x.fee)),repayment=sum(allocations.map(x=>x.repayment));
 return {...s,amount,fee,repayment,remainingAfter:s.total-repayment,allocations};
}
export function validRepaymentSettlement(request,linked){
 if(request.repaymentMode!=='aggregate-v1')return !!request.settlementId&&linked.length===2&&linked.every(x=>x.settlementId===request.settlementId&&x.status==='approved')&&linked.filter(x=>x.type==='expense'&&x.wallet===request.wallet&&Number(x.amount)===Number(request.amount)).length===1&&linked.filter(x=>x.type==='income'&&x.wallet==='minus'&&x.repaymentDebtId===request.repaymentDebtId&&Number(x.amount)===Number(request.repaymentAmount)).length===1;
 const p=request.repaymentPlan,a=p?.allocations;
 if(!request.settlementId||!a?.length||linked.length!==a.length+1||new Set(a.map(x=>x.debtId)).size!==a.length||linked.some(x=>x.status!=='approved'||x.settlementId!==request.settlementId))return false;
 if(!a.every(x=>wallets.includes(x.origin)&&Number.isSafeInteger(x.repayment)&&x.repayment>0&&Number.isSafeInteger(x.fee)&&x.fee>=0&&x.amount===x.fee+x.repayment))return false;
 if(a.reduce((n,x)=>n+x.amount,0)!==request.amount||a.reduce((n,x)=>n+x.fee,0)!==request.fee||a.reduce((n,x)=>n+x.repayment,0)!==request.repaymentAmount)return false;
 return linked.filter(x=>x.type==='expense'&&x.wallet===request.wallet&&x.amount===request.amount).length===1&&a.every(p=>linked.filter(x=>x.type==='income'&&x.wallet==='minus'&&x.repaymentDebtId===p.debtId&&x.debtOrigin===p.origin&&x.amount===p.repayment).length===1);
}
