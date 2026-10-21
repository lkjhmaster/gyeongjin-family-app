import {fundingInputs,fundingRefund} from './funding.js';
// All writes use one D1 batch. Its first CHECK assertion validates the complete
// family snapshot, transaction revision and related tables read by the operation.
const wallets=['free','card','minus'];
const uid=()=>crypto.randomUUID();
class TradeError extends Error{constructor(message,status=409){super(message);this.status=status}}
const requireTrade=(condition,message,status=409)=>{if(!condition)throw new TradeError(message,status)};
const amount=n=>Number.isSafeInteger(n)&&n>0&&n<=10000000;
export async function childTradeLifecycle(req,env,me,json){
 const url=new URL(req.url),path=url.pathname.replace('/api/child-trades','');
 if(!url.pathname.startsWith('/api/child-trades'))return null;
 if(req.method==='GET'&&!['/capabilities','/detail','/approval-queue','/notifications','/balances'].includes(path))return null;
 if(!['GET','POST'].includes(req.method))return null;
 const db=env.DB,q=(sql,...args)=>db.prepare(sql).bind(...args),all=async(sql,...args)=>(await q(sql,...args).all()).results||[];
 try{
  if(path==='/capabilities'){
   let ready=false;try{await q('SELECT id FROM child_trade_actions LIMIT 0').all();await q('SELECT wallet FROM child_trade_funding LIMIT 0').all();ready=true}catch{}
   return json({ok:true,readOnly:!ready,canRequest:ready,canConsent:ready,canReject:ready,canApprove:ready,canSettle:ready,canRepay:ready,canRefund:ready,canSplitGoods:ready,canSellerReceipt:ready,requiresMigration:!ready});
  }
  const b=req.method==='POST'?await req.json():{};
  const members=await all("SELECT id,name,role,is_admin FROM members WHERE family_id=? ORDER BY id",me.family_id);
  const byId=Object.fromEntries(members.map(m=>[m.id,m]));
  const child=k=>byId[k]?.role==='child'&&!byId[k]?.is_admin;
  const parent=()=>requireTrade(me.role==='parent'&&!!me.is_admin,'부모 관리자만 처리할 수 있습니다.',403);
  // Snapshot includes all state (limits as well as balances), reservations,
  // loans, actions, deliveries and transactions. Serialized D1 batch checks it.
  const states=await all("SELECT state_key,value_json FROM family_state WHERE family_id=? AND state_key IN ('allowance_ledger','allowance_limits') ORDER BY state_key",me.family_id);
  const stateMap=Object.fromEntries(states.map(s=>[s.state_key,s.value_json]));
  const fundingSql="SELECT f.* FROM child_trade_funding f JOIN child_trade_transactions t ON t.id=f.transaction_id WHERE t.family_id=? ORDER BY f.transaction_id,f.wallet";
  const tables={funding:await all(fundingSql,me.family_id),
   transactions:await all('SELECT * FROM child_trade_transactions WHERE family_id=? ORDER BY id',me.family_id),
   loans:await all('SELECT l.* FROM child_trade_loans l JOIN child_trade_transactions t ON t.id=l.transaction_id WHERE t.family_id=? ORDER BY l.id',me.family_id),
   holds:await all('SELECT h.* FROM child_trade_holds h JOIN child_trade_transactions t ON t.id=h.transaction_id WHERE t.family_id=? ORDER BY h.id',me.family_id),
   actions:await all('SELECT a.* FROM child_trade_actions a JOIN child_trade_transactions t ON t.id=a.transaction_id WHERE t.family_id=? ORDER BY a.id',me.family_id),
   delivery:await all('SELECT d.* FROM child_trade_delivery d JOIN child_trade_transactions t ON t.id=d.transaction_id WHERE t.family_id=? ORDER BY d.transaction_id,d.actor_id,d.revision',me.family_id),
   details:await all('SELECT d.* FROM child_trade_details d JOIN child_trade_transactions t ON t.id=d.transaction_id WHERE t.family_id=? ORDER BY d.transaction_id',me.family_id),
   approvals:await all('SELECT a.* FROM child_trade_approvals a JOIN child_trade_transactions t ON t.id=a.transaction_id WHERE t.family_id=? ORDER BY a.id',me.family_id)
  };
  const snapshotQueries=[[fundingSql,tables.funding],
   ["SELECT state_key,value_json FROM family_state WHERE family_id=? AND state_key IN ('allowance_ledger','allowance_limits') ORDER BY state_key",states],
   ['SELECT * FROM child_trade_transactions WHERE family_id=? ORDER BY id',tables.transactions],
   ['SELECT l.* FROM child_trade_loans l JOIN child_trade_transactions t ON t.id=l.transaction_id WHERE t.family_id=? ORDER BY l.id',tables.loans],
   ['SELECT h.* FROM child_trade_holds h JOIN child_trade_transactions t ON t.id=h.transaction_id WHERE t.family_id=? ORDER BY h.id',tables.holds],
   ['SELECT a.* FROM child_trade_actions a JOIN child_trade_transactions t ON t.id=a.transaction_id WHERE t.family_id=? ORDER BY a.id',tables.actions],
   ['SELECT d.* FROM child_trade_delivery d JOIN child_trade_transactions t ON t.id=d.transaction_id WHERE t.family_id=? ORDER BY d.transaction_id,d.actor_id,d.revision',tables.delivery],
   ['SELECT d.* FROM child_trade_details d JOIN child_trade_transactions t ON t.id=d.transaction_id WHERE t.family_id=? ORDER BY d.transaction_id',tables.details],
   ['SELECT a.* FROM child_trade_approvals a JOIN child_trade_transactions t ON t.id=a.transaction_id WHERE t.family_id=? ORDER BY a.id',tables.approvals],
   ['SELECT id,name,role,is_admin FROM members WHERE family_id=? ORDER BY id',members]
  ];
  // SQLite json_group_array over json_object gives deterministic snapshot equality.
  const guards=snapshotQueries.map(([sql,rows])=>{
   const columns=rows.length?Object.keys(rows[0]):null;
   // Empty result sets use a count guard; nonempty sets compare every value.
   if(!columns)return {sql:'(SELECT COUNT(*) FROM ('+sql+'))=0',args:[me.family_id]};
   return {sql:'(SELECT json_group_array(json_object('+columns.map(c=>"'"+c+"',"+c).join(',')+')) FROM ('+sql+'))=?',args:[me.family_id,JSON.stringify(rows)]};
  });
  const now=new Date().toISOString(),day=new Date(Date.now()+32400000).toISOString().slice(0,10);
  const writes=[];
  const add=(sql,...args)=>writes.push(q(sql,...args));
  const audit=(tx,action,next,payload={})=>add('INSERT INTO child_trade_audit(id,transaction_id,actor_id,action,previous_state,next_state,revision,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',uid(),tx.id,me.id,action,tx.status||null,next,tx.revision,JSON.stringify(payload),now);
  const approval=(tx,decision,role)=>add('INSERT INTO child_trade_approvals(id,transaction_id,revision,actor_id,actor_role,decision,created_at) VALUES(?,?,?,?,?,?,?)',uid(),tx.id,tx.revision,me.id,role,decision,now);
  const change=(tx,next)=>{add('UPDATE child_trade_transactions SET status=?,revision=revision+1,updated_at=? WHERE id=?',next,now,tx.id);tx.revision++;};
  let ledger=JSON.parse(stateMap.allowance_ledger||'{}'),ledgerChanged=false;
  requireTrade(ledger&&typeof ledger==='object'&&!Array.isArray(ledger),'용돈 원장 형식 오류');
  const limits=JSON.parse(stateMap.allowance_limits||'{}');
  const rows=owner=>{requireTrade(child(owner),'자녀 계정을 확인해주세요.',403);const name=byId[owner].name;requireTrade(!ledger[name]||Array.isArray(ledger[name]),'용돈 원장 형식 오류');return ledger[name]||(ledger[name]=[])};
  const balance=(owner,wallet)=>rows(owner).filter(r=>(r.status||'approved')==='approved'&&r.wallet===wallet).reduce((sum,r)=>{requireTrade(Number.isSafeInteger(r.amount)&&r.amount>=0,'원장 금액 오류');return sum+(r.type==='income'?r.amount:r.type==='expense'?-r.amount:0)},0);
  const activeHolds=()=>[...tables.holds,...tables.funding.filter(f=>f.hold_status==='active').map(f=>({...f,status:'active',owner_id:tables.transactions.find(t=>t.id===f.transaction_id).payer_id}))];
  const available=(owner,wallet,ignore)=>{const limit=wallet==='minus'?Number(limits[byId[owner].name]||0):0;requireTrade(Number.isSafeInteger(limit)&&limit>=0,'마이너스 한도 오류');return balance(owner,wallet)+limit-activeHolds().filter(h=>h.owner_id===owner&&h.wallet===wallet&&h.status==='active'&&h.transaction_id!==ignore).reduce((s,h)=>s+h.gross_amount,0)};
  const detail=tx=>tables.details.find(d=>d.transaction_id===tx.id)||{refunded_gross:0};
  const loanFor=tx=>tables.loans.find(l=>l.transaction_id===tx.id);
  function quote(gross,source,dest,owner,debtId,allowZero=false){
   requireTrade(amount(gross)&&wallets.includes(source)&&wallets.includes(dest),'금액·용돈 종류를 확인해주세요.',400);
   let origin=dest;
   if(dest==='minus'){
    const debt=rows(owner).find(r=>r.id===debtId&&r.type==='expense'&&r.wallet==='minus'&&r.status==='approved'&&['free','card'].includes(r.debtOrigin));
    requireTrade(debt,'수령할 마이너스 사용 건과 출처를 선택해주세요.');origin=debt.debtOrigin;
   }
   const fee=Math.round(gross*((source==='card'||source==='minus')&&origin==='free'?0.5:0));
   requireTrade(allowZero||gross-fee>0,'실수령액이 없습니다.',400);return {gross,fee,net:gross-fee};
  }
  function paymentQuote(kind,gross,source,dest,owner,debtId,allocations){
   let parts;try{parts=fundingInputs(kind,gross,source,allocations)}catch(e){throw new TradeError(e.message,400)}
   parts=parts.map(p=>({...p,...quote(p.gross,p.wallet,dest,owner,debtId,true)}));
   const fee=parts.reduce((n,p)=>n+p.fee,0);requireTrade(gross-fee>0,'실수령액이 없습니다.',400);
   return {gross,fee,net:gross-fee,parts};
  }
  const usesMinus=parts=>parts.some(p=>p.wallet==='minus'&&p.gross>0);
  const enforceGoodsReceipt=(parts,destination)=>requireTrade(!usesMinus(parts)||destination==='card','마이너스용돈이 포함된 구매는 판매자 카드용돈으로만 입금할 수 있습니다.',400);
  const funding=tx=>{const found=tables.funding.filter(f=>f.transaction_id===tx.id);return found.length?wallets.flatMap(wallet=>found.filter(f=>f.wallet===wallet).map(f=>({wallet,gross:f.gross_amount,fee:f.fee_amount,net:f.gross_amount-f.fee_amount}))):[{wallet:tx.source_wallet,gross:tx.gross_amount,fee:tx.fee_amount,net:tx.net_amount}];};
  const held=tx=>{const holds=activeHolds().filter(h=>h.transaction_id===tx.id&&h.status==='active');return holds.length?{gross_amount:holds.reduce((n,h)=>n+h.gross_amount,0)}:null;};
  const setFunding=(tx,parts)=>{add('DELETE FROM child_trade_funding WHERE transaction_id=?',tx.id);for(const p of parts)add("INSERT INTO child_trade_funding(transaction_id,wallet,gross_amount,fee_amount,hold_status) VALUES(?,?,?,?,'planned')",tx.id,p.wallet,p.gross,p.fee);};
  const releaseFunding=(tx,status)=>{add('UPDATE child_trade_holds SET status=?,released_at=? WHERE transaction_id=?',status,now,tx.id);add('UPDATE child_trade_funding SET hold_status=? WHERE transaction_id=?',status,tx.id);};
  function fundsAvailable(tx,parts=funding(tx)){return parts.every(p=>available(tx.payer_id,p.wallet,tx.id)>=p.gross);}
  function receiveCapacity(owner,tx,net,debtId=detail(tx).destination_debt_id){if(tx.destination_wallet!=='minus')return;
   const debt=rows(owner).find(r=>r.id===debtId&&r.status==='approved'&&r.wallet==='minus'&&r.type==='expense');requireTrade(debt,'마이너스 사용 건을 확인해주세요.');
   const repaid=rows(owner).filter(r=>r.status==='approved'&&r.wallet==='minus'&&r.repaymentDebtId===debt.id).reduce((s,r)=>s+(r.type==='income'?r.amount:r.type==='expense'?-r.amount:0),0);
   requireTrade(net<=debt.amount-repaid,'마이너스 사용 잔액을 초과합니다.');
  }
  function posting(tx,owner,wallet,value,kind,original=null,repaymentDebtId=null){
   if(!value)return;requireTrade(Number.isSafeInteger(value),'분개 금액 오류');const postingId=uid();
   add('INSERT INTO child_trade_postings(id,transaction_id,owner_id,wallet,amount,kind,original_posting_id,created_at) VALUES(?,?,?,?,?,?,?,?)',postingId,tx.id,owner,wallet,value,kind,original,now);
   if(!owner.startsWith('fee:')){rows(owner).push({id:postingId,childTradeId:tx.id,date:day,type:value>0?'income':'expense',wallet,amount:Math.abs(value),debtOrigin:wallet==='minus'&&value<0?(tx.destination_wallet==='minus'?(rows(tx.payee_id).find(r=>r.id===detail(tx).destination_debt_id)?.debtOrigin||'card'):tx.destination_wallet):'',...(repaymentDebtId?{repaymentDebtId}:{}),title:kind==='refund'?'자녀 간 거래 환불':tx.kind==='loan'?'자녀 간 대여':tx.kind==='repayment'?'자녀 간 상환':'자녀 간 물품 거래',status:'approved',requestedBy:me.name,approvedBy:me.name,createdAt:now,approvedAt:now});ledgerChanged=true;}
   return postingId;
  }
  function transfer(tx){
   requireTrade(fundsAvailable(tx),'용돈별 잔액 또는 마이너스 한도가 부족합니다.');receiveCapacity(tx.payee_id,tx,tx.net_amount);
   for(const part of funding(tx)){
    posting(tx,tx.payer_id,part.wallet,-part.gross,'debit');
    posting(tx,'fee:'+me.family_id,part.wallet,part.fee,'fee');
   }
   posting(tx,tx.payee_id,tx.destination_wallet,tx.net_amount,tx.destination_wallet==='minus'?'minus_repayment':'credit',null,detail(tx).destination_debt_id);
  }
  async function commit(result,status=200){
   if(ledgerChanged)add("INSERT INTO family_state(family_id,state_key,value_json,updated_by) VALUES(?,'allowance_ledger',?,?) ON CONFLICT(family_id,state_key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP,updated_by=excluded.updated_by",me.family_id,JSON.stringify(ledger),me.id);
   const guard=uid();
   await db.batch([q('INSERT INTO child_trade_guards(id,valid) SELECT ?,CASE WHEN '+guards.map(g=>g.sql).join(' AND ')+' THEN 1 ELSE 0 END',guard,...guards.flatMap(g=>g.args)),...writes,q('DELETE FROM child_trade_guards WHERE id=?',guard)]);
   return json({...result,...(ledgerChanged?{ledger}:{})},status);
  }
  if(path==='/balances'&&req.method==='GET'){
   const selected=members.find(m=>m.name===url.searchParams.get('child')&&child(m.id));requireTrade(selected,'조회할 자녀를 찾을 수 없습니다.',404);requireTrade(me.is_admin||me.id===selected.id,'다른 자녀 잔액을 조회할 수 없습니다.',403);
   return json({ok:true,wallets:wallets.map(wallet=>({wallet,balance:balance(selected.id,wallet),available:available(selected.id,wallet),reserved:activeHolds().filter(h=>h.owner_id===selected.id&&h.wallet===wallet&&h.status==='active').reduce((sum,h)=>sum+h.gross_amount,0)}))});
  }
  if(path==='/notifications'&&req.method==='GET'){
   const loans=tables.loans.filter(l=>l.outstanding_amount>0&&l.due_date&&l.due_date<day&&(me.is_admin||l.borrower_id===me.id||l.lender_id===me.id));
   const pending=tables.transactions.filter(t=>(me.is_admin&&t.status==='consented')||(!me.is_admin&&(detail(t).consent_required_id||t.counterparty_id)===me.id&&t.status==='requested'));
   const requests=[];
   if(!me.is_admin){
    const item=(t,kind,label)=>({id:t.id+':'+kind,transactionId:t.id,kind,label,title:detail(t).title||'',gross:t.gross_amount,createdAt:t.created_at});
    for(const t of pending)requests.push(item(t,'consent',t.kind==='goods'&&t.payee_id===me.id?'판매대금 수령 선택·동의':t.kind==='goods'?'구매 조건 최종 확인':t.kind==='repayment'?'상환 요청 동의':'대여 요청 동의'));
    for(const a of tables.actions.filter(a=>a.status==='requested'&&a.counterparty_id===me.id)){
     const t=tables.transactions.find(t=>t.id===a.transaction_id);if(t)requests.push({...item(t,'action',({refund:'환불',cancel:'취소',revise:'조건 변경',resolve:'분쟁 해제'})[a.kind]+' 협의 요청'),actionId:a.id,createdAt:a.created_at});
    }
    for(const t of tables.transactions.filter(t=>t.kind==='goods'&&['held','delivery_pending'].includes(t.status)&&(t.requester_id===me.id||t.counterparty_id===me.id))){
     if(!tables.actions.some(a=>a.transaction_id===t.id&&['requested','consented'].includes(a.status))&&!tables.delivery.some(d=>d.transaction_id===t.id&&d.actor_id===me.id&&d.revision>=(detail(t).delivery_epoch||0)))requests.push(item(t,'delivery','물품 전달·수령 확인'));
    }
   }
   requests.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
   const waiting=!me.is_admin?tables.transactions.filter(t=>(t.requester_id===me.id||t.counterparty_id===me.id)&&!requests.some(r=>r.transactionId===t.id)&&(['requested','consented','held','delivery_pending','disputed'].includes(t.status)||tables.actions.some(a=>a.transaction_id===t.id&&['requested','consented'].includes(a.status)))).map(t=>({transactionId:t.id,kind:t.kind,title:detail(t).title||'',gross:t.gross_amount,status:t.status})):[];
   return json({ok:true,overdue:loans,pending,requests,waiting});
  }
  if(path==='/approval-queue'&&req.method==='GET'){parent();return json({ok:true,transactions:tables.transactions.filter(t=>t.status==='consented'),actions:tables.actions.filter(a=>a.status==='consented')});}
  if(path==='/quote'&&req.method==='POST'){
   requireTrade(child(me.id)&&child(b.counterpartyId)&&b.counterpartyId!==me.id,'자녀 거래 상대방을 확인해주세요.',403);
   const payee=b.kind==='loan'?me.id:b.counterpartyId;
   if(b.kind==='loan'){
    requireTrade(['free','card'].includes(b.sourceWallet)&&b.destinationWallet===b.sourceWallet&&!b.allocations,'대여는 자유→자유 또는 카드→카드만 가능합니다. 마이너스 대여는 불가합니다.',400);
    requireTrade(typeof b.dueDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate)&&b.dueDate>=day,'대여 상환 예정일을 오늘 이후로 지정해주세요.',400);
   }
   if(b.kind==='goods'&&b.destinationWallet)enforceGoodsReceipt(fundingInputs('goods',b.gross,b.sourceWallet,b.allocations),b.destinationWallet);
   const receiptPending=b.kind==='goods'&&!b.destinationWallet;
   return json({ok:true,receiptPending,...paymentQuote(b.kind,b.gross,b.sourceWallet,receiptPending?'card':b.destinationWallet,payee,b.destinationDebtId,b.allocations)});
  }
  if(path===''&&req.method==='POST'){
   requireTrade(child(me.id),'자녀만 거래를 신청할 수 있습니다.',403);
   requireTrade(['loan','goods','repayment'].includes(b.kind),'거래 유형 오류',400);
   let other=b.counterpartyId,loan;
   if(b.kind==='repayment'){loan=tables.loans.find(l=>l.id===b.loanId&&l.borrower_id===me.id&&l.status==='active'&&l.outstanding_amount>0);requireTrade(loan,'상환할 대여금을 찾을 수 없습니다.');other=loan.lender_id;}
   requireTrade(child(other)&&other!==me.id,'다른 자녀를 선택해주세요.',403);
   const payer=b.kind==='loan'?other:me.id,payee=b.kind==='loan'?me.id:other;
   if(b.kind==='loan'){
    requireTrade(['free','card'].includes(b.sourceWallet)&&b.destinationWallet===b.sourceWallet&&!b.allocations,'대여는 자유→자유 또는 카드→카드만 가능합니다. 마이너스 대여는 불가합니다.',400);
    requireTrade(typeof b.dueDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate)&&b.dueDate>=day,'대여 상환 예정일을 오늘 이후로 지정해주세요.',400);
   }
   if(b.kind==='repayment'){
    requireTrade(['free','card'].includes(b.sourceWallet)&&b.sourceWallet===tables.transactions.find(t=>t.id===loan.transaction_id)?.source_wallet&&b.destinationWallet===tables.transactions.find(t=>t.id===loan.transaction_id)?.source_wallet&&!b.allocations,'상환은 대여 당시 용돈 출처와 동일한 자유/카드용돈으로만 가능합니다.',400);
   }
   if(b.kind==='goods'&&b.destinationWallet)enforceGoodsReceipt(fundingInputs('goods',b.gross,b.sourceWallet,b.allocations),b.destinationWallet);
   const receiptPending=b.kind==='goods'&&!b.destinationWallet;
   const destination=receiptPending?'card':b.destinationWallet;
   const payment=paymentQuote(b.kind,b.gross,b.sourceWallet,destination,payee,b.destinationDebtId,b.allocations);const source=payment.parts[0].wallet;
   requireTrade(typeof b.operationKey==='string'&&/^[a-zA-Z0-9_-]{16,100}$/.test(b.operationKey),'중복 방지 요청 키가 필요합니다.',400);
   requireTrade(!b.dueDate||(/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate)&&Number.isFinite(Date.parse(b.dueDate+'T00:00:00Z'))&&new Date(b.dueDate+'T00:00:00Z').toISOString().slice(0,10)===b.dueDate),'상환기한을 확인해주세요.',400);
   const input={kind:b.kind,counterpartyId:other,gross:b.gross,sourceWallet:source,...(b.allocations?{allocations:Object.fromEntries(payment.parts.map(p=>[p.wallet,p.gross]))}:{}),destinationWallet:destination,destinationDebtId:b.destinationDebtId||null,loanId:b.loanId||null,dueDate:b.dueDate||null,title:String(b.title||'').slice(0,80),...(receiptPending?{receiptPending:true}:{})};
   const key=me.family_id+':'+me.id+':'+b.operationKey;
   const prior=await q('SELECT result_json FROM child_trade_idempotency WHERE operation_key=?',key).first();
   if(prior){const r=JSON.parse(prior.result_json);requireTrade(JSON.stringify(r.input)===JSON.stringify(input),'같은 요청 키로 조건을 변경할 수 없습니다.');return json(r);}
   if(b.kind==='loan')requireTrade(!tables.loans.some(l=>l.borrower_id===me.id&&l.outstanding_amount>0)&&!tables.transactions.some(t=>t.kind==='loan'&&t.payee_id===me.id&&['requested','consented','approved'].includes(t.status)),'미상환 또는 진행 중인 차입이 있습니다.');
   if(loan)requireTrade(payment.net<=loan.outstanding_amount,'남은 원금을 초과한 상환입니다.');
   const tx={id:uid(),kind:b.kind,status:'requested',revision:0};
   add('INSERT INTO child_trade_transactions(id,family_id,kind,requester_id,counterparty_id,payer_id,payee_id,source_wallet,destination_wallet,gross_amount,fee_amount,net_amount,status,revision,due_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)',tx.id,me.family_id,b.kind,me.id,other,payer,payee,source,destination,payment.gross,payment.fee,payment.net,'requested',input.dueDate,now,now);
   add('INSERT INTO child_trade_details(transaction_id,loan_id,title,destination_debt_id) VALUES(?,?,?,?)',tx.id,loan?.id||null,input.title,input.destinationDebtId);
   if(b.allocations)setFunding(tx,payment.parts);approval(tx,'consent','requester');audit(tx,'request','requested',input);
   const result={ok:true,id:tx.id,status:'requested',...payment,input};
   add('INSERT INTO child_trade_idempotency(operation_key,transaction_id,result_json,created_at) VALUES(?,?,?,?)',key,tx.id,JSON.stringify(result),now);
   return await commit(result,201);
  }
  const transactionId=b.transactionId||url.searchParams.get('id');
  const tx=tables.transactions.find(t=>t.id===transactionId);requireTrade(tx,'거래를 찾을 수 없습니다.',404);
  const participant=me.id===tx.requester_id||me.id===tx.counterparty_id;
  requireTrade(me.is_admin||participant,'이 거래에 접근할 수 없습니다.',403);
  async function needsReceipt(){
   if(tx.kind!=='goods')return false;
   const request=await q("SELECT payload_json FROM child_trade_audit WHERE transaction_id=? AND action='request' ORDER BY revision LIMIT 1",tx.id).first();
   if(!JSON.parse(request?.payload_json||'{}').receiptPending)return false;
   const latest=await q("SELECT action FROM child_trade_audit WHERE transaction_id=? AND action IN ('receipt_selected','terms_changed','approve_revise') ORDER BY revision DESC LIMIT 1",tx.id).first();
   return latest?.action!=='receipt_selected';
  }
  if(path==='/detail'&&req.method==='GET'){
   const events=await all('SELECT * FROM child_trade_audit WHERE transaction_id=? ORDER BY created_at,id',tx.id);
   const postings=await all('SELECT * FROM child_trade_postings WHERE transaction_id=? ORDER BY created_at,id',tx.id);
   return json({ok:true,receiptPending:await needsReceipt(),transaction:tx,funding:funding(tx),detail:detail(tx),loan:loanFor(tx)||tables.loans.find(l=>l.id===detail(tx).loan_id),actions:tables.actions.filter(a=>a.transaction_id===tx.id),delivery:tables.delivery.filter(d=>d.transaction_id===tx.id&&d.revision>=(detail(tx).delivery_epoch||0)),events,postings,members:members.map(m=>({id:m.id,name:m.name}))});
  }
  requireTrade(req.method==='POST','지원하지 않는 요청입니다.',405);
  // UI sends the revision; repeat submissions and stale tabs cannot mutate again.
  requireTrade(Number.isInteger(b.revision)&&b.revision===tx.revision,'거래가 변경되었습니다. 새로고침해주세요.');
  const open=tables.actions.find(a=>a.transaction_id===tx.id&&['requested','consented'].includes(a.status));
  if(path==='/receipt'||path==='/receipt/quote'){
   requireTrade(tx.kind==='goods'&&me.id===tx.payee_id&&!me.is_admin,'판매자만 수령 용돈을 선택할 수 있습니다.',403);
   requireTrade(['requested','consented'].includes(tx.status),'부모 승인 전 거래에서 선택해주세요.');
   const parts=funding(tx),payment=paymentQuote('goods',tx.gross_amount,tx.source_wallet,b.destinationWallet,tx.payee_id,b.destinationDebtId,Object.fromEntries(parts.map(p=>[p.wallet,p.gross])));
   enforceGoodsReceipt(parts,b.destinationWallet);
   receiveCapacity(tx.payee_id,{...tx,destination_wallet:b.destinationWallet},payment.net,b.destinationDebtId);
   if(path==='/receipt/quote')return json({ok:true,...payment});
   add('UPDATE child_trade_transactions SET destination_wallet=?,fee_amount=?,net_amount=? WHERE id=?',b.destinationWallet,payment.fee,payment.net,tx.id);
   if(tables.funding.some(f=>f.transaction_id===tx.id))setFunding(tx,payment.parts);
   add('UPDATE child_trade_details SET destination_debt_id=?,consent_required_id=? WHERE transaction_id=?',b.destinationDebtId||null,tx.payer_id,tx.id);
   change(tx,'requested');approval(tx,'consent','counterparty');audit(tx,'receipt_selected','requested',{...payment,destinationWallet:b.destinationWallet,destinationDebtId:b.destinationDebtId||null});
   return await commit({ok:true,buyerConfirmationRequired:true});
  }
  if(path==='/terms'){
   requireTrade(participant&&!me.is_admin&&['requested','consented'].includes(tx.status),'승인 전 거래 당사자만 조건을 변경할 수 있습니다.',403);
   if(tx.kind==='goods'&&me.id===tx.payer_id)requireTrade(b.destinationWallet===tx.destination_wallet&&(b.destinationDebtId||null)===(detail(tx).destination_debt_id||null),'수령 용돈은 판매자가 선택합니다.',403);
   const allocations=b.allocations??(tables.funding.some(f=>f.transaction_id===tx.id)?Object.fromEntries(funding(tx).map(p=>[p.wallet,p.gross])):undefined);const payment=paymentQuote(tx.kind,b.gross,b.sourceWallet,b.destinationWallet,tx.payee_id,b.destinationDebtId,allocations);if(tx.kind==='goods'&&b.destinationWallet)enforceGoodsReceipt(payment.parts,b.destinationWallet);
   add('UPDATE child_trade_transactions SET gross_amount=?,fee_amount=?,net_amount=?,source_wallet=?,destination_wallet=? WHERE id=?',payment.gross,payment.fee,payment.net,payment.parts[0].wallet,b.destinationWallet,tx.id);if(allocations)setFunding(tx,payment.parts);
   add('UPDATE child_trade_details SET destination_debt_id=?,consent_required_id=? WHERE transaction_id=?',b.destinationDebtId||null,me.id===tx.requester_id?tx.counterparty_id:tx.requester_id,tx.id);
   change(tx,'requested');approval(tx,'consent','requester');audit(tx,'terms_changed','requested',{...payment,sourceWallet:b.sourceWallet,destinationWallet:b.destinationWallet});return await commit({ok:true});
  }
  if(path==='/decision'){
   requireTrade(participant&&!me.is_admin,'거래 당사자만 처리할 수 있습니다.',403);
   requireTrade(['requested','consented'].includes(tx.status),'이미 승인된 거래입니다.');
   requireTrade(['consent','reject','cancel'].includes(b.decision),'결정 오류',400);
   if(b.decision==='consent')requireTrade(me.id===(detail(tx).consent_required_id||tx.counterparty_id)&&tx.status==='requested','상대방만 동의할 수 있습니다.',403);
   if(b.decision==='consent')requireTrade(!await needsReceipt(),'판매자가 먼저 수령 용돈을 선택해야 합니다.');
   const next=b.decision==='consent'?'consented':b.decision==='reject'?'rejected':'cancelled';
   change(tx,next);approval(tx,b.decision,me.id===tx.requester_id?'requester':'counterparty');audit(tx,b.decision,next);return await commit({ok:true,status:next});
  }
  if(path==='/approval/reject'){parent();requireTrade(tx.status==='consented','승인대기 상태가 아닙니다.');change(tx,'rejected');approval(tx,'reject','parent');audit(tx,'reject','rejected');return await commit({ok:true});}
  if(path==='/approval/approve'){
   parent();requireTrade(tx.status==='consented','승인대기 상태가 아닙니다.');
   requireTrade(!await needsReceipt(),'판매자 수령 용돈 선택이 필요합니다.');
   requireTrade(tables.approvals.some(a=>a.transaction_id===tx.id&&a.revision===tx.revision&&a.actor_id===(detail(tx).consent_required_id||tx.counterparty_id)&&a.decision==='consent'),'현재 조건에 대한 상대방 동의가 없습니다.');
   const parts=funding(tx);const payment=paymentQuote(tx.kind,tx.gross_amount,tx.source_wallet,tx.destination_wallet,tx.payee_id,detail(tx).destination_debt_id,tx.kind==='goods'?Object.fromEntries(parts.map(p=>[p.wallet,p.gross])):undefined);
   requireTrade(payment.fee===tx.fee_amount&&payment.net===tx.net_amount&&parts.every((p,i)=>p.fee===payment.parts[i].fee),'수수료가 변경되었습니다. 재신청해주세요.');
   requireTrade(fundsAvailable(tx),'용돈별 잔액 또는 마이너스 한도가 부족합니다.');receiveCapacity(tx.payee_id,tx,tx.net_amount);
   if(tx.kind==='goods'){
    if(tables.funding.some(f=>f.transaction_id===tx.id))add("UPDATE child_trade_funding SET hold_status='active' WHERE transaction_id=?",tx.id);else add("INSERT INTO child_trade_holds(id,transaction_id,owner_id,wallet,gross_amount,status,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(transaction_id) DO UPDATE SET owner_id=excluded.owner_id,wallet=excluded.wallet,gross_amount=excluded.gross_amount,status='active',created_at=excluded.created_at,released_at=NULL",uid(),tx.id,tx.payer_id,tx.source_wallet,tx.gross_amount,'active',now);
    change(tx,'held');approval(tx,'approve','parent');audit(tx,'reserve','held');
   }else{
    if(tx.kind==='loan'){
     requireTrade(!tables.loans.some(l=>l.borrower_id===tx.payee_id&&l.outstanding_amount>0),'미상환 차입이 있습니다.');
     add('INSERT INTO child_trade_loans(id,transaction_id,borrower_id,lender_id,principal_amount,outstanding_amount,due_date,status) VALUES(?,?,?,?,?,?,?,?)',uid(),tx.id,tx.payee_id,tx.payer_id,tx.net_amount,tx.net_amount,tx.due_date,'active');
    }else{
     const loan=tables.loans.find(l=>l.id===detail(tx).loan_id);requireTrade(loan&&loan.status==='active'&&loan.outstanding_amount>=tx.net_amount&&loan.borrower_id===tx.payer_id&&loan.lender_id===tx.payee_id,'상환할 원금을 확인해주세요.');
     add("UPDATE child_trade_loans SET outstanding_amount=outstanding_amount-?,status=CASE WHEN outstanding_amount=? THEN 'settled' ELSE 'active' END WHERE id=?",tx.net_amount,tx.net_amount,loan.id);
     if(loan.outstanding_amount===tx.net_amount)add("UPDATE child_trade_transactions SET status='settled',revision=revision+1,updated_at=? WHERE id=?",now,loan.transaction_id);
     add('INSERT INTO child_trade_repayments(id,loan_id,transaction_id,gross_amount,fee_amount,principal_reduction,created_at) VALUES(?,?,?,?,?,?,?)',uid(),loan.id,tx.id,tx.gross_amount,tx.fee_amount,tx.net_amount,now);
    }
    transfer(tx);const next=tx.kind==='loan'?'active':'settled';change(tx,next);approval(tx,'approve','parent');audit(tx,'settle',next);
   }return await commit({ok:true});
  }
  if(path==='/delivery'){
   requireTrade(participant&&!me.is_admin,'거래 당사자만 전달 확인할 수 있습니다.',403);requireTrade(tx.kind==='goods'&&['held','delivery_pending'].includes(tx.status)&&!open,'전달 확인이 보류되었거나 완료되었습니다.');
   requireTrade(!tables.delivery.some(d=>d.transaction_id===tx.id&&d.actor_id===me.id&&d.revision>=(detail(tx).delivery_epoch||0)),'이미 전달 확인했습니다.');
   add('INSERT INTO child_trade_delivery(transaction_id,actor_id,revision,created_at) VALUES(?,?,?,?)',tx.id,me.id,tx.revision,now);
   const both=tables.delivery.some(d=>d.transaction_id===tx.id&&d.actor_id!==me.id&&d.revision>=(detail(tx).delivery_epoch||0));
   if(both){const hold=held(tx);requireTrade(hold&&hold.gross_amount===tx.gross_amount,'예약금 원장 오류');releaseFunding(tx,'released');transfer(tx);change(tx,'settled');audit(tx,'delivery_settle','settled');}
   else{change(tx,'delivery_pending');audit(tx,'delivery','delivery_pending');}
   return await commit({ok:true});
  }
  if(path==='/dispute'){
   requireTrade(participant&&!me.is_admin,'거래 당사자만 분쟁을 신청할 수 있습니다.',403);requireTrade(['held','delivery_pending','active','settled'].includes(tx.status),'분쟁을 신청할 수 없는 상태입니다.');
   const previous=tx.status;if(tx.kind==='loan')add("UPDATE child_trade_loans SET status='disputed' WHERE transaction_id=?",tx.id);change(tx,'disputed');audit(tx,'dispute','disputed',{reason:String(b.reason||'').slice(0,500),resumeStatus:previous});return await commit({ok:true});
  }
  if(path==='/action/request'){
   requireTrade(participant&&!me.is_admin,'거래 당사자만 변경을 신청할 수 있습니다.',403);requireTrade(!open,'진행 중인 변경 요청이 있습니다.');
   requireTrade(['refund','cancel','revise','resolve'].includes(b.kind),'변경 유형 오류',400);
   const unspent=!!held(tx);
   requireTrade(['held','delivery_pending','active','settled','disputed'].includes(tx.status),'승인된 거래에서 신청해주세요.');
   if(b.kind==='revise')requireTrade(tx.kind==='goods'&&unspent,'정산된 거래 조건은 환불·반환 후 새로 신청해주세요.');
   if(b.kind==='resolve')requireTrade(tx.status==='disputed','분쟁 상태가 아닙니다.');
   if(b.kind==='refund')requireTrade(!unspent&&amount(b.gross),'정산된 거래의 환불 금액을 확인해주세요.',400);
   const payload={resumeStatus:tx.status,gross:b.gross||0,reason:String(b.reason||'').slice(0,500)};
   if(b.kind==='revise'){
    const allocations=b.allocations??(tables.funding.some(f=>f.transaction_id===tx.id)?Object.fromEntries(funding(tx).map(p=>[p.wallet,p.gross])):undefined);const payment=paymentQuote(tx.kind,b.gross,b.sourceWallet,b.destinationWallet,tx.payee_id,b.destinationDebtId,allocations);
    Object.assign(payload,payment,{...(allocations?{allocations:Object.fromEntries(payment.parts.map(p=>[p.wallet,p.gross]))}:{}),sourceWallet:payment.parts[0].wallet,destinationWallet:b.destinationWallet,destinationDebtId:b.destinationDebtId||null});
   }
   const actionId=uid();add('INSERT INTO child_trade_actions(id,transaction_id,kind,requester_id,counterparty_id,payload_json,status,revision,created_at) VALUES(?,?,?,?,?,?,?,?,?)',actionId,tx.id,b.kind,me.id,me.id===tx.requester_id?tx.counterparty_id:tx.requester_id,JSON.stringify(payload),'requested',tx.revision+1,now);
   change(tx,tx.status);audit(tx,'request_'+b.kind,tx.status,payload);return await commit({ok:true,actionId});
  }
  if(path==='/action/decision'){
   requireTrade(open&&open.id===b.actionId,'변경 요청을 찾을 수 없습니다.');
   requireTrade(['consent','approve','reject','cancel'].includes(b.decision),'결정 오류',400);
   if(b.decision==='consent')requireTrade(open.status==='requested'&&me.id===open.counterparty_id,'변경 상대방만 동의할 수 있습니다.',403);
   if(b.decision==='cancel')requireTrade(me.id===open.requester_id,'변경 신청자만 취소할 수 있습니다.',403);
   if(b.decision==='reject')requireTrade(me.id===open.counterparty_id||(me.is_admin&&open.status==='consented'),'거절 권한이 없습니다.',403);
   if(b.decision!=='approve'){
    const next=b.decision==='consent'?'consented':b.decision==='cancel'?'cancelled':'rejected';
    add('UPDATE child_trade_actions SET status=? WHERE id=?',next,open.id);change(tx,tx.status);approval(tx,b.decision,me.is_admin?'parent':me.id===tx.requester_id?'requester':'counterparty');audit(tx,'action_'+b.decision,tx.status,{actionId:open.id});return await commit({ok:true});
   }
   parent();requireTrade(open.status==='consented','양측 동의가 필요합니다.');
   const payload=JSON.parse(open.payload_json),hold=held(tx);let next=tx.status;
   if(open.kind==='resolve'){
    requireTrade(tx.status==='disputed','분쟁 상태가 아닙니다.');
    const dispute=await q("SELECT payload_json,previous_state FROM child_trade_audit WHERE transaction_id=? AND next_state='disputed' AND previous_state<>'disputed' ORDER BY revision DESC,created_at DESC LIMIT 1",tx.id).first();
    requireTrade(dispute,'조정 이전 상태의 감사 기록을 확인해주세요.');
    next=JSON.parse(dispute.payload_json||'{}').resumeStatus||dispute.previous_state;
    requireTrade(['held','delivery_pending','active','settled'].includes(next),'조정 이전 상태를 확인해주세요.');
    if(tx.kind==='loan'){const loan=loanFor(tx);requireTrade(loan,'대여 원장을 확인해주세요.');next=loan.outstanding_amount===0?'settled':'active';add("UPDATE child_trade_loans SET status=? WHERE transaction_id=?",next,tx.id);}
   }else if(open.kind==='revise'){
    requireTrade(hold&&tx.kind==='goods','예약된 물품 거래만 변경할 수 있습니다.');
    releaseFunding(tx,'cancelled');
    // Reuse hold row on reapproval; delivery confirmations belong to old terms.
    add('UPDATE child_trade_transactions SET gross_amount=?,fee_amount=?,net_amount=?,source_wallet=?,destination_wallet=? WHERE id=?',payload.gross,payload.fee,payload.net,payload.sourceWallet,payload.destinationWallet,tx.id);if(payload.allocations)setFunding(tx,payload.parts);
    add('UPDATE child_trade_details SET destination_debt_id=? WHERE transaction_id=?',payload.destinationDebtId,tx.id);
    add('UPDATE child_trade_details SET delivery_epoch=? WHERE transaction_id=?',tx.revision+1,tx.id);next='requested';
   }else if(hold){
    requireTrade(open.kind==='cancel','예약금은 취소로 해제해주세요.');releaseFunding(tx,'cancelled');next='cancelled';
   }else{
    const refunded=detail(tx).refunded_gross||0,gross=open.kind==='cancel'?tx.gross_amount-refunded:payload.gross;
    requireTrade(amount(gross)&&gross<=tx.gross_amount-refunded,'누적 환불액이 원거래를 초과합니다.');
    const refunds=fundingRefund(funding(tx),refunded,refunded+gross);const fee=refunds.reduce((n,p)=>n+p.fee,0),net=gross-fee;
    Object.assign(payload,{refundParts:refunds,refundFee:fee,refundNet:net});
    if(available(tx.payee_id,tx.destination_wallet)<net){if(tx.kind==='loan')add("UPDATE child_trade_loans SET status='disputed' WHERE transaction_id=?",tx.id);change(tx,'disputed');audit(tx,'refund_insufficient_balance','disputed',{actionId:open.id,resumeStatus:tx.status});return await commit({ok:true,status:'disputed',message:'회수 잔액이 부족하여 부모 조정 상태로 전환했습니다.'});}
    const original=await all("SELECT * FROM child_trade_postings WHERE transaction_id=? AND kind IN ('debit','credit','minus_repayment','fee')",tx.id);
    const credit=original.find(p=>p.kind==='credit'||p.kind==='minus_repayment');requireTrade(credit&&refunds.every(r=>original.some(p=>p.kind==='debit'&&p.wallet===r.wallet)),'원거래 분개가 없습니다.');
    if(tx.kind==='loan'){const loan=loanFor(tx);requireTrade(loan&&net<=loan.outstanding_amount,'이미 상환된 원금은 대여 환불로 줄일 수 없습니다.');add("UPDATE child_trade_loans SET outstanding_amount=outstanding_amount-?,status=CASE WHEN outstanding_amount=? THEN 'settled' ELSE 'active' END WHERE id=?",net,net,loan.id);}
    if(tx.kind==='repayment'){const loan=tables.loans.find(l=>l.id===detail(tx).loan_id);requireTrade(loan&&loan.outstanding_amount+net<=loan.principal_amount,'복원할 원금 오류');add("UPDATE child_trade_loans SET outstanding_amount=outstanding_amount+?,status=CASE WHEN status='disputed' THEN 'disputed' ELSE 'active' END WHERE id=?",net,loan.id);add("UPDATE child_trade_transactions SET status=CASE WHEN status='disputed' THEN 'disputed' ELSE 'active' END,revision=revision+1,updated_at=? WHERE id=?",now,loan.transaction_id);}
    posting(tx,tx.payee_id,tx.destination_wallet,-net,'refund',credit.id,tx.destination_wallet==='minus'?detail(tx).destination_debt_id:null);for(const part of refunds){const debit=original.find(p=>p.kind==='debit'&&p.wallet===part.wallet),feePosting=original.find(p=>p.kind==='fee'&&p.wallet===part.wallet);posting(tx,tx.payer_id,part.wallet,part.gross,'refund',debit.id,part.wallet==='minus'?debit.id:null);posting(tx,'fee:'+me.family_id,part.wallet,-part.fee,'refund',feePosting?.id||null);}
    add('UPDATE child_trade_details SET refunded_gross=refunded_gross+? WHERE transaction_id=?',gross,tx.id);
    next=refunded+gross===tx.gross_amount?'cancelled':(payload.resumeStatus||tx.status);
    if(tx.kind==='loan'&&loanFor(tx).outstanding_amount===net&&next!=='cancelled')next='settled';
    if(tx.kind==='loan'&&next==='disputed')add("UPDATE child_trade_loans SET status='disputed' WHERE transaction_id=?",tx.id);
   }
   add("UPDATE child_trade_actions SET status='approved' WHERE id=?",open.id);change(tx,next);approval(tx,'approve','parent');audit(tx,'approve_'+open.kind,next,{actionId:open.id,...payload});return await commit({ok:true});
  }
  throw new TradeError('지원하지 않는 거래 요청입니다.',404);
 }catch(e){if(e instanceof TradeError)return json({error:e.message},e.status);console.error('child-trade operation failed',e.message);return json({error:'거래 저장 충돌 또는 원장 오류입니다. 새로고침 후 확인해주세요.',code:'CHILD_TRADE_CONFLICT'},409);}
}
