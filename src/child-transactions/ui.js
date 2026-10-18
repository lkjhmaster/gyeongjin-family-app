const tradeActionName={request:'신청',consent:'동의',reject:'거절',cancel:'취소',reserve:'승인·예약',settle:'승인·정산',delivery:'전달 확인',delivery_settle:'양측 전달·정산',terms_changed:'조건 변경',dispute:'분쟁 신청',request_refund:'환불 협의',request_cancel:'취소 협의',request_revise:'조건 변경 협의',request_resolve:'분쟁 해제 협의',action_consent:'변경 동의',action_reject:'변경 거절',action_cancel:'변경 요청 취소',approve_refund:'환불 승인',approve_cancel:'취소 승인',approve_revise:'조건 변경 승인',approve_resolve:'분쟁 해제 승인',refund_insufficient_balance:'회수 잔액 부족·부모 조정',receipt_selected:'판매자 수령 선택·구매자 확인 대기'};
const tradeWalletName={free:'자유용돈',card:'카드용돈',minus:'마이너스'};
const tradeStateName={requested:'상대방 동의 대기',consented:'부모 승인 대기',held:'예약 중',delivery_pending:'전달 확인 중',active:'상환 중',settled:'완료',cancelled:'취소',rejected:'거절',disputed:'분쟁 조정 중'};
let childTradeScreen=null;
function tradeButton(label,command,extra=''){return '<button class="secondary" data-command="'+command+'" '+extra+' onclick="childTradeCommand(this)">'+label+'</button>'}
async function childTradePreview(encoded,tab='active'){
 const name=decodeURIComponent(encoded);if(!allowanceAccessibleChildren().some(m=>m.name===name)){toast('거래 화면 접근 권한이 없어요');return}
 try{
  const [list,summary,cap,alerts,balances]=await Promise.all([api('/api/child-trades?status='+encodeURIComponent(tab)+'&child='+encodeURIComponent(name)),api('/api/child-trades/summary?child='+encodeURIComponent(name)),api('/api/child-trades/capabilities'),api('/api/child-trades/notifications'),api('/api/child-trades/balances?child='+encodeURIComponent(name))]);
  childTradeScreen={encoded,tab,cap};
  let queue={transactions:[],actions:[]};if(currentAccount?.isAdmin)queue=await api('/api/child-trades/approval-queue');
  const walletSummary='<div class="card"><b>사용가능금액</b>'+balances.wallets.map(w=>'<p>'+tradeWalletName[w.wallet]+' '+Number(w.available).toLocaleString()+'원 <small>예약 '+Number(w.reserved).toLocaleString()+'원</small></p>').join('')+'</div>';
  const notice=(alerts.overdue||[]).length?'<div class="card">🔔 상환 예정일이 지난 대여 '+alerts.overdue.length+'건이 있습니다. 자동 출금은 하지 않습니다.</div>':'';
  const item=x=>'<div class="event"><b>'+esc(x.kind==='loan'?'대여':x.kind==='goods'?'물품 거래':'상환')+' · '+Number(x.gross_amount).toLocaleString()+'원</b><small>'+esc(tradeStateName[x.status]||x.status)+' · '+esc(String(x.created_at).slice(0,10))+'</small><small>'+(x.kind==='goods'&&x.status==='requested'?'수수료·실수령액은 거래 상세에서 확인':('수수료 '+Number(x.fee_amount).toLocaleString()+'원 · 실제 수령 '+Number(x.net_amount).toLocaleString()+'원'))+'</small>'+tradeButton('상세·처리','detail','data-id="'+esc(x.id)+'"')+'</div>';
  const nav=['active','completed','cancelled'].map((v,i)=>'<button class="'+(tab===v?'sel':'ghost')+'" data-tab="'+v+'" onclick="childTradePreview(childTradeScreen.encoded,this.dataset.tab)">'+['진행 중','완료','취소'][i]+'</button>').join('');
  const approvals=currentAccount?.isAdmin?'<div class="card"><b>부모 승인대기 '+(queue.transactions.length+queue.actions.length)+'건</b>'+queue.transactions.map(item).join('')+queue.actions.map(a=>'<div class="event">환불·취소·변경 승인 '+tradeButton('상세·처리','detail','data-id="'+esc(a.transaction_id)+'"')+'</div>').join('')+'</div>':'';
  shell('<div class="page"><button class="ghost back" onclick="allowanceChild(childTradeScreen.encoded)">← 용돈기입장</button><h1 class="title">🤝 자녀 간 거래</h1>'+notice+walletSummary+'<div class="grid"><div class="stat"><small>빌린 돈</small><b>'+Number(summary.borrowed).toLocaleString()+'원</b></div><div class="stat"><small>빌려준 돈</small><b>'+Number(summary.lent).toLocaleString()+'원</b></div></div><p class="label">예약금은 전달 확인 전까지 사용가능금액에서 제외됩니다. 모든 변경은 이력에 보관됩니다.</p>'+(!cap.canRequest?'<div class="card">거래 원장 준비 중입니다.</div>':!currentAccount?.isAdmin?tradeButton('대여·물품 거래 신청','new'):'')+'<div class="card"><div class="choice">'+nav+'</div>'+((list.transactions||[]).map(item).join('')||'<p>거래 내역이 없습니다.</p>')+'</div>'+approvals+'</div>');
 }catch(e){toast(e.message||'거래 내역을 불러오지 못했습니다.')}
}
async function childTradeRequireSplit(){const caps=await api('/api/child-trades/capabilities');if(caps.canSplitGoods!==true)throw Error('용돈 병합 기능을 준비 중입니다. 잠시 후 새로고침해주세요.');}
function childTradeFundingSummary(parts,pending=false){return parts?.length?'<div class="event"><b>용돈별 결제 내역</b>'+parts.map(p=>'<p>'+tradeWalletName[p.wallet]+' '+Number(p.gross).toLocaleString()+'원'+(pending?'':' <small>수수료 '+Number(p.fee||0).toLocaleString()+'원 · 실수령 '+Number(p.net??(p.gross-(p.fee||0))).toLocaleString()+'원</small>')+'</p>').join('')+'</div>':'';}
function childTradeFormKindChanged(){const goods=$('#tradeKind').value==='goods';$('#tradeSingleFunding').style.display=goods?'none':'';$('#tradeSplitFunding').style.display=goods?'':'none';$('#tradeReceiptFields').style.display=goods?'none':'';$('#tradeDueFields').style.display=goods?'none':'';$('#tradeGross').readOnly=goods;if(goods)childTradeFundingTotal();}
function childTradeFundingTotal(){if($('#tradeKind').value!=='goods')return;$('#tradeGross').value=['free','card','minus'].reduce((n,w)=>n+Number($('#tradeAllocation_'+w).value||0),0);}
function childTradePromptFunding(parts){const allocations={};for(const wallet of ['free','card','minus']){const text=prompt(tradeWalletName[wallet]+'에서 결제할 금액(원)',String(parts.find(p=>p.wallet===wallet)?.gross||0));if(text===null)return null;const n=Number(text);if(!Number.isSafeInteger(n)||n<0){toast('용돈별 금액을 확인해주세요');return null}allocations[wallet]=n;}return allocations;}
async function childTradeForm(loan=null){
 try{
  const participants=await api('/api/child-trades/participants');const p=participants.participants||[];
  const options=Object.entries(tradeWalletName).map(([v,l])=>'<option value="'+v+'">'+l+'</option>').join('');
  childTradeScreen.loan=loan;childTradeScreen.operationKey=crypto.randomUUID();
  shell('<div class="page"><button class="ghost back" onclick="childTradePreview(childTradeScreen.encoded)">← 거래 내역</button><h1 class="title">'+(loan?'대여금 상환':'거래 신청')+'</h1><div class="card"><label>거래 종류</label><select id="tradeKind" onchange="childTradeFormKindChanged()" '+(loan?'disabled':'')+'>'+(loan?'<option value="repayment">상환</option>':'<option value="loan">돈 빌리기</option><option value="goods">물건 구매</option>')+'</select><label>상대방</label><select id="tradePerson" '+(loan?'disabled':'')+'>'+p.filter(x=>!loan||x.id===loan.lender_id).map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join('')+'</select><p class="label">돈 빌리기는 상대방이 보내고 내가 받습니다. 물건 구매·상환은 내가 보내고 상대방이 받습니다. 물건 구매의 수령 용돈은 판매자가 선택하며, 구매자는 최종 수수료를 확인합니다.</p><label>총 출금액(원)</label><input id="tradeGross" type="number" min="1" max="10000000" inputmode="numeric"><div id="tradeSingleFunding"><label>보내는 용돈</label><select id="tradeSource">'+options+'</select></div><div id="tradeSplitFunding" style="display:none"><b>용돈 합쳐 결제</b><p class="label">각 용돈에서 사용할 금액을 입력하세요. 합계가 총 출금액입니다.</p>'+Object.entries(tradeWalletName).map(([w,label])=>'<label>'+label+'</label><input id="tradeAllocation_'+w+'" type="number" min="0" max="10000000" step="1" value="0" inputmode="numeric" oninput="childTradeFundingTotal()">').join('')+'</div><div id="tradeReceiptFields"><label>받는 용돈</label><select id="tradeDestination">'+options+'</select><label>받는 마이너스 사용 건</label><select id="tradeDebt"><option value="">마이너스 수령 시 선택</option></select><button class="ghost" onclick="childTradeLoadDebts()">마이너스 사용 건 불러오기</button></div><label>내용</label><input id="tradeTitle" maxlength="80"><div id="tradeDueFields"><label>상환 예정일(대여, 선택)</label><input id="tradeDue" type="date"></div>'+(loan?'<p>남은 원금 '+Number(loan.outstanding_amount).toLocaleString()+'원. 실제 수령액만큼 원금이 줄어듭니다.</p>':'')+'<p id="tradeQuote" class="label">아래 버튼에서 총 출금·수수료·실수령액을 확인한 후 신청합니다.</p>'+tradeButton('금액 확인 후 신청','submit')+'</div></div>');
 }catch(e){toast(e.message)}
}
async function childTradeLoadDebts(){
 try{const state=(await api('/api/state')).state||{},kind=$('#tradeKind').value,person=$('#tradePerson').value,participants=(await api('/api/child-trades/participants')).participants||[],name=kind==='loan'?currentAccount.name:participants.find(p=>p.id===person)?.name;
 const rows=state.allowance_ledger?.[name]||[];$('#tradeDebt').innerHTML='<option value="">사용 건 선택</option>'+rows.filter(r=>r.status==='approved'&&r.type==='expense'&&r.wallet==='minus'&&['free','card'].includes(r.debtOrigin)).map(r=>'<option value="'+esc(r.id)+'">'+esc(r.date||'')+' '+esc(r.title||'')+' ('+tradeWalletName[r.debtOrigin]+')</option>').join('');
 }catch(e){toast(e.message)}
}
async function childTradeReceiptForm(){
 const info=childTradeScreen.detail,tx=info.transaction;
 if(tx.kind!=='goods'||currentAccount?.id!==tx.payee_id){toast('판매자만 수령 용돈을 선택할 수 있습니다.');return}
 const response=await api('/api/state'),rows=response.state?.allowance_ledger?.[currentAccount.name]||[];
 const debts=rows.filter(r=>r.status==='approved'&&r.type==='expense'&&r.wallet==='minus'&&['free','card'].includes(r.debtOrigin)).map(r=>({...r,remaining:r.amount-rows.filter(c=>c.status==='approved'&&c.wallet==='minus'&&c.repaymentDebtId===r.id).reduce((n,c)=>n+(c.type==='income'?c.amount:c.type==='expense'?-c.amount:0),0)})).filter(r=>r.remaining>0);
 shell('<div class="page"><button class="ghost back" data-id="'+esc(tx.id)+'" onclick="childTradeDetail(this.dataset.id)">← 거래 상세</button><h1 class="title">판매대금 수령 설정</h1><div class="card"><p>수령 용돈을 선택하면 수수료와 실수령액을 계산합니다. 구매자가 최종 조건을 확인한 뒤 부모가 승인합니다.</p><label>판매대금 받을 용돈</label><select id="tradeReceiptWallet" onchange="document.getElementById(\'tradeReceiptDebtFields\').style.display=this.value===\'minus\'?\'\':\'none\'"><option value="">선택해주세요</option>'+Object.entries(tradeWalletName).map(([w,l])=>'<option value="'+w+'">'+l+'</option>').join('')+'</select><div id="tradeReceiptDebtFields" style="display:none"><label>판매대금으로 갚을 마이너스 사용 내역</label><select id="tradeReceiptDebt"><option value="">사용 내역 선택</option>'+debts.map(r=>'<option value="'+esc(r.id)+'">'+esc(r.title||'마이너스 사용')+' · 남은 금액 '+r.remaining.toLocaleString()+'원 ('+tradeWalletName[r.debtOrigin]+')</option>').join('')+'</select></div><p id="tradeReceiptQuote" class="label"></p>'+tradeButton('수령 금액 확인·판매 동의','receipt-save')+'</div></div>');
}
async function childTradeSaveReceipt(){
 const tx=childTradeScreen.detail.transaction,destinationWallet=$('#tradeReceiptWallet').value;
 if(!destinationWallet){toast('수령 용돈을 선택해주세요.');return}
 const data={transactionId:tx.id,revision:tx.revision,destinationWallet,destinationDebtId:destinationWallet==='minus'?$('#tradeReceiptDebt').value:null};
 const quote=await api('/api/child-trades/receipt/quote',{method:'POST',body:JSON.stringify(data)});
 const summary='구매자 총 출금 '+quote.gross.toLocaleString()+'원 · 수수료 '+quote.fee.toLocaleString()+'원 · 내가 받는 금액 '+quote.net.toLocaleString()+'원';$('#tradeReceiptQuote').textContent=summary;
 if(!confirm(summary+'\n수령 설정에 동의하고 구매자에게 최종 확인을 요청할까요?'))return;
 await api('/api/child-trades/receipt',{method:'POST',body:JSON.stringify(data)});await childTradeDetail(tx.id);
}
async function childTradeCommand(button){
 if(button.disabled)return;button.disabled=true;
 const command=button.dataset.command;
 try{
  if(command==='detail'){await childTradeDetail(button.dataset.id);return}
  if(command==='new'){await childTradeForm();return}
  if(command==='receipt'){await childTradeReceiptForm();return}
  if(command==='receipt-save'){await childTradeSaveReceipt();return}
  if(command==='submit'){
   const payload={kind:$('#tradeKind').value,counterpartyId:$('#tradePerson').value,gross:Number($('#tradeGross').value),sourceWallet:$('#tradeSource').value,destinationWallet:$('#tradeDestination').value,destinationDebtId:$('#tradeDebt').value||null,title:$('#tradeTitle').value,dueDate:$('#tradeDue').value||null,loanId:childTradeScreen.loan?.id,operationKey:childTradeScreen.operationKey};
   if(payload.kind==='goods'){delete payload.destinationWallet;delete payload.destinationDebtId;delete payload.dueDate;const caps=await api('/api/child-trades/capabilities');if(!caps.canSellerReceipt)throw Error('판매자 수령 선택 기능을준비 중입니다. 새로고침해주세요.');}
   if(payload.kind==='goods')payload.allocations=Object.fromEntries(['free','card','minus'].map(w=>[w,Number($('#tradeAllocation_'+w).value||0)]));
   if(payload.allocations)await childTradeRequireSplit();
   const quote=await api('/api/child-trades/quote',{method:'POST',body:JSON.stringify(payload)});
   if(payload.allocations&&(!quote.parts||Object.entries(payload.allocations).some(([w,n])=>Number(n)!==(quote.parts.find(p=>p.wallet===w)?.gross||0))))throw Error('서버의 용돈별 결제 금액을 확인할 수 없습니다. 새로고침해주세요.');
   $('#tradeQuote').textContent=quote.receiptPending?'총 출금 '+quote.gross.toLocaleString()+'원 · 수수료와 실수령액은 판매자 선택 후 다시 확인합니다.':'총 출금 '+quote.gross.toLocaleString()+'원 · 수수료 '+quote.fee.toLocaleString()+'원 · 실제 수령 '+quote.net.toLocaleString()+'원';
   const breakdown=quote.parts?.map(p=>tradeWalletName[p.wallet]+' '+p.gross.toLocaleString()+'원'+(quote.receiptPending?'':' (수수료 '+p.fee.toLocaleString()+'원)')).join('\n')||'';
   if(!confirm(breakdown+'\n'+$('#tradeQuote').textContent+'\n양측 동의와 부모 승인 후 처리됩니다. 신청할까요?'))return;
   const result=await api('/api/child-trades',{method:'POST',body:JSON.stringify(payload)});await childTradeDetail(result.id);return;
  }
  const info=childTradeScreen.detail,tx=info.transaction;
  if(command==='repay'){await childTradeForm(info.loan);return}
  let endpoint=command,data={transactionId:tx.id,revision:tx.revision};
  if(['consent','reject','cancel'].includes(command)){endpoint='decision';data.decision=command}
  if(command==='approve')endpoint='approval/approve';if(command==='parent-reject')endpoint='approval/reject';
  if(command==='dispute'){const reason=prompt('분쟁 사유를 입력해주세요.');if(reason===null)return;data.reason=reason}
  if(command==='terms'){
   const allocations=tx.kind==='goods'?childTradePromptFunding(info.funding||[{wallet:tx.source_wallet,gross:tx.gross_amount}]):undefined;if(allocations===null)return;const sourceWallet=allocations?Object.keys(allocations).find(w=>allocations[w]>0):prompt('보내는 용돈: free 자유 / card 카드 / minus 마이너스',tx.source_wallet);if(sourceWallet===null)return;
   const destinationWallet=tx.kind==='goods'?tx.destination_wallet:prompt('받는 용돈: free 자유 / card 카드 / minus 마이너스',tx.destination_wallet);if(destinationWallet===null)return;
   let destinationDebtId=tx.kind==='goods'?info.detail.destination_debt_id:null;if(destinationWallet==='minus'&&tx.kind!=='goods'){destinationDebtId=prompt('마이너스 사용 건 ID (거래 신청 화면에서 확인 가능)',info.detail.destination_debt_id||'');if(destinationDebtId===null)return}
   const gross=allocations?Object.values(allocations).reduce((a,b)=>a+b,0):Number(prompt('총 출금액(원)',String(tx.gross_amount)));if(!Number.isSafeInteger(gross)||gross<=0)return;
   data={...data,gross,sourceWallet,destinationWallet,destinationDebtId,...(allocations?{allocations}:{})};endpoint='terms';
  }
  if(command.startsWith('request-')){
   endpoint='action/request';data.kind=command.slice(8);data.reason=prompt('요청 사유를 입력해주세요.','')||'';
   if(data.kind==='refund'){const n=prompt('환불할 총 출금액(원)',String(tx.gross_amount-(info.detail.refunded_gross||0)));if(n===null)return;data.gross=Number(n)}
   if(data.kind==='revise'){
    const allocations=childTradePromptFunding(info.funding||[{wallet:tx.source_wallet,gross:tx.gross_amount}]);if(!allocations)return;data.allocations=allocations;data.gross=Object.values(allocations).reduce((a,b)=>a+b,0);data.sourceWallet=Object.keys(allocations).find(w=>allocations[w]>0);data.destinationWallet=tx.destination_wallet;data.destinationDebtId=info.detail.destination_debt_id;
   }
  }
  if(command.startsWith('action-')){endpoint='action/decision';data.actionId=button.dataset.action;data.decision=command.slice(7)}
  if(data.allocations)await childTradeRequireSplit();
  if(!confirm('표시된 조건으로 처리할까요? 거래 이력은 보존됩니다.'))return;
  await api('/api/child-trades/'+endpoint,{method:'POST',body:JSON.stringify(data)});await pullFamilyState();await childTradeDetail(tx.id);
 }catch(e){toast(e.message||'거래 처리에 실패했습니다.')}finally{button.disabled=false}
}
async function childTradeDetail(id){
 const info=await api('/api/child-trades/detail?id='+encodeURIComponent(id));childTradeScreen.detail=info;
 const tx=info.transaction,admin=!!currentAccount?.isAdmin,mine=currentAccount?.id,participant=mine===tx.requester_id||mine===tx.counterparty_id,open=info.actions.find(a=>['requested','consented'].includes(a.status));
 let controls='';
 if(!admin&&participant&&['requested','consented'].includes(tx.status)){
  if(tx.status==='requested'&&!info.receiptPending&&mine===(info.detail.consent_required_id||tx.counterparty_id))controls+=tradeButton('조건 확인·동의','consent')+tradeButton('거절','reject');
  if(tx.kind==='goods'&&mine===tx.payee_id)controls+=tradeButton('수령 용돈 선택·판매 동의','receipt');
  controls+=tradeButton('신청 취소','cancel')+tradeButton('용돈·금액 조건 변경 (재동의 필요)','terms');
 }
 if(admin&&tx.status==='consented')controls+=tradeButton(tx.kind==='goods'?'승인·예약':'승인·송금','approve')+tradeButton('거절','parent-reject');
 if(!admin&&participant&&!open){
  if(tx.kind==='goods'&&['held','delivery_pending'].includes(tx.status)&&!info.delivery.some(d=>d.actor_id===mine))controls+=tradeButton('물품 전달·수령 확인','delivery');
  if(info.loan?.borrower_id===mine&&info.loan.status==='active'&&info.loan.outstanding_amount>0)controls+=tradeButton('일부·전액 상환 신청','repay');
  if(['held','delivery_pending','active','settled','disputed'].includes(tx.status)){
   controls+=tradeButton('취소·전액 반환 협의','request-cancel');
   if(['active','settled','disputed'].includes(tx.status))controls+=tradeButton('부분 환불 협의','request-refund');
   if(tx.kind==='goods'&&['held','delivery_pending'].includes(tx.status))controls+=tradeButton('조건 변경 협의','request-revise');
   controls+=tx.status==='disputed'?tradeButton('분쟁 해제 협의','request-resolve'):tradeButton('분쟁 신청·지급 보류','dispute');
  }
 }
 const actions=info.actions.map(a=>{let buttons='';const extra='data-action="'+esc(a.id)+'"';if(a.status==='requested'&&mine===a.counterparty_id)buttons+=tradeButton('변경 동의','action-consent',extra)+tradeButton('변경 거절','action-reject',extra);if(a.status==='requested'&&mine===a.requester_id)buttons+=tradeButton('변경 요청 취소','action-cancel',extra);if(a.status==='consented'&&admin)buttons+=tradeButton('변경 승인','action-approve',extra)+tradeButton('변경 거절','action-reject',extra);let payload={};try{payload=JSON.parse(a.payload_json)}catch{}return '<div class="event"><b>'+esc(({refund:'환불',cancel:'취소',revise:'조건 변경',resolve:'분쟁 해제'})[a.kind]||a.kind)+' · '+esc(a.status)+'</b><small>'+esc(payload.reason||'')+(payload.gross?' · '+Number(payload.gross).toLocaleString()+'원':'')+'</small>'+childTradeFundingSummary(payload.parts)+buttons+'</div>'}).join('');
 const name=id=>info.members.find(m=>m.id===id)?.name||id;
 shell('<div class="page"><button class="ghost back" onclick="childTradePreview(childTradeScreen.encoded,childTradeScreen.tab)">← 거래 내역</button><h1 class="title">거래 상세</h1><div class="card"><b>'+esc(name(tx.payer_id))+' → '+esc(name(tx.payee_id))+'</b><p>'+esc(tx.kind==='goods'&&tx.status==='requested'?(info.receiptPending?'판매자 수령 선택 대기':info.detail.consent_required_id===tx.payer_id?'구매자 최종 확인 대기':tradeStateName[tx.status]):tradeStateName[tx.status]||tx.status)+'</p><p>'+esc(info.detail.title||'')+'</p><p>총 출금 '+tx.gross_amount.toLocaleString()+'원'+(info.receiptPending?' · 판매자 수령 선택 후 수수료·실수령액 확정':' · 수수료 '+tx.fee_amount.toLocaleString()+'원 · 실제 수령 '+tx.net_amount.toLocaleString()+'원')+'</p><p>'+(info.funding?.length>1?'용돈 합쳐 결제':tradeWalletName[tx.source_wallet])+' → '+(info.receiptPending?'판매자 선택 대기':tradeWalletName[tx.destination_wallet])+'</p>'+childTradeFundingSummary(info.funding,info.receiptPending)+(info.loan?'<p>남은 원금 '+Number(info.loan.outstanding_amount).toLocaleString()+'원 · 예정일 '+esc(info.loan.due_date||'미지정')+'</p>':'')+'<p>누적 환불 '+Number(info.detail.refunded_gross||0).toLocaleString()+'원 · 전달 확인 '+info.delivery.length+'/2</p><div class="choice" style="flex-wrap:wrap;gap:8px">'+controls+'</div></div>'+actions+'<div class="card"><b>전체 변경 이력</b>'+info.events.map(e=>'<div class="event"><small>'+esc(new Date(e.created_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))+' · '+esc(name(e.actor_id))+'</small><br>'+esc(tradeActionName[e.action]||'거래 변경')+' → '+esc(tradeStateName[e.next_state]||e.next_state||'')+'</div>').join('')+'</div></div>');
}
async function childTradeApprovalCards(){
 const queue=await api('/api/child-trades/approval-queue');
 return '<h2 class="section-title">자녀 간 거래 ('+(queue.transactions.length+queue.actions.length)+')</h2>'+queue.transactions.map(t=>'<div class="event"><b>'+esc(t.kind==='goods'?'물품 예약':t.kind==='loan'?'대여':'상환')+' · '+Number(t.gross_amount).toLocaleString()+'원</b><button class="secondary" data-id="'+esc(t.id)+'" onclick="childTradeFromApproval(this.dataset.id)">조건 확인·승인</button></div>').join('')+queue.actions.map(a=>'<div class="event">환불·취소·변경 승인 <button class="secondary" data-id="'+esc(a.transaction_id)+'" onclick="childTradeFromApproval(this.dataset.id)">상세 확인</button></div>').join('');
}
async function childTradeFromApproval(id){const children=allowanceAccessibleChildren();childTradeScreen={encoded:encodeURIComponent(children[0]?.name||''),tab:'active'};try{await childTradeDetail(id)}catch(e){toast(e.message)}}
