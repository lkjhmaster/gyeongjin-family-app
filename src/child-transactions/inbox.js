async function childApprovalCenter(){
 if(!authToken()||!currentAccount||currentAccount.isAdmin)return;
 const actor=currentAccount.id;
 try{
  const data=await api('/api/child-trades/notifications');if(currentAccount?.id!==actor||currentAccount.isAdmin)return;
  const requests=data.requests||[],waiting=data.waiting||[];
  const row=(r,label)=>'<div class="event"><b>'+esc(label)+'</b><p>'+esc(r.title||'자녀 간 거래')+' · '+Number(r.gross||0).toLocaleString()+'원</p><button class="secondary" data-id="'+esc(r.transactionId)+'" onclick="childTradeFromApproval(this.dataset.id)">상세 확인</button></div>';
  shell('<div class="page"><button class="ghost back" onclick="home()">← 홈</button><h1 class="title">내 확인·동의 요청</h1><p class="sub">내가 처리할 요청만 표시합니다. 부모의 최종 승인은 별도로 진행됩니다.</p><h2 class="section-title">확인할 요청 '+requests.length+'건</h2>'+(requests.map(r=>row(r,r.label)).join('')||'<div class="event">지금 확인할 요청이 없습니다.</div>')+'<h2 class="section-title">상대방·부모 확인 대기 '+waiting.length+'건</h2>'+(waiting.map(r=>row(r,'확인 대기')).join('')||'<p class="label">대기 중인 요청이 없습니다.</p>')+'</div>');
  refreshApprovalBadge();
 }catch(e){toast('요청을 불러오지 못했습니다. '+e.message)}
}
