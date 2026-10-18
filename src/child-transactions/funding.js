const wallets=['free','card','minus'];
export function fundingInputs(kind,gross,source,allocations){
 if(!Number.isSafeInteger(gross)||gross<=0||gross>10000000)throw Error('총 출금액을 확인해주세요.');
 if(allocations===undefined||allocations===null){if(!wallets.includes(source))throw Error('보내는 용돈을 확인해주세요.');return [{wallet:source,gross}];}
 if(kind!=='goods'||typeof allocations!=='object'||Array.isArray(allocations)||Object.keys(allocations).some(k=>!wallets.includes(k)))throw Error('용돈 병합은 물품거래에서만 지원합니다.');
 const parts=wallets.map(wallet=>({wallet,gross:allocations[wallet]??0}));
 if(parts.some(p=>!Number.isSafeInteger(p.gross)||p.gross<0)||parts.reduce((n,p)=>n+p.gross,0)!==gross)throw Error('용돈별 금액의 합계가 총 출금액과 같아야 합니다.');
 return parts.filter(p=>p.gross>0);
}
// Nested cumulative apportionment is monotonic for every wallet, unlike largest
// remainder allocation. Every partial refund is nonnegative and the final refund
// restores exactly the original amounts and each wallet's original fee.
export function fundingRefund(parts,previous,next){
 const total=parts.reduce((n,p)=>n+p.gross,0);
 if(!Number.isSafeInteger(previous)||!Number.isSafeInteger(next)||previous<0||next<=previous||next>total)throw Error('누적 환불 금액을 확인해주세요.');
 const cumulative=value=>{let left=value,weight=total;return parts.map((p,i)=>{const gross=i===parts.length-1?left:Math.round(left*p.gross/weight);left-=gross;weight-=p.gross;return {gross,fee:Math.round(p.fee*gross/p.gross)};});};
 const before=cumulative(previous),after=cumulative(next);
 return parts.map((p,i)=>({wallet:p.wallet,gross:after[i].gross-before[i].gross,fee:after[i].fee-before[i].fee,net:after[i].gross-before[i].gross-after[i].fee+before[i].fee}));
}
