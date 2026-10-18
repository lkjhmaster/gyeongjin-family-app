const JSON_HEADERS={"content-type":"application/json; charset=utf-8"};
const CORS={"access-control-allow-origin":"https://gyeongjin-family-app.pages.dev","access-control-allow-methods":"GET,POST,PUT,OPTIONS","access-control-allow-headers":"authorization,content-type","vary":"Origin"};
const enc=new TextEncoder();
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...JSON_HEADERS,...CORS}});
const id=()=>crypto.randomUUID();
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
async function digest(v){return hex(await crypto.subtle.digest("SHA-256",enc.encode(v)))}
async function passwordHash(password,salt){let data=enc.encode(password+":"+salt);for(let i=0;i<120000;i++)data=new Uint8Array(await crypto.subtle.digest("SHA-256",data));return hex(data)}
async function body(req){try{return await req.json()}catch{return {}}}
async function auth(req,env){const raw=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");if(!raw)return null;const h=await digest(raw);return env.DB.prepare(`SELECT m.id,m.family_id,m.name,m.role,m.is_admin,m.emoji FROM sessions s JOIN members m ON m.id=s.member_id WHERE s.token_hash=? AND s.expires_at>datetime('now')`).bind(h).first()}
async function createSession(memberId,env){const token=crypto.randomUUID()+crypto.randomUUID();const tokenHash=await digest(token);await env.DB.prepare("INSERT INTO sessions(token_hash,member_id,expires_at) VALUES(?,?,datetime('now','+30 days'))").bind(tokenHash,memberId).run();return token}
async function processRecurring(env){
 const now=new Date(Date.now()+9*60*60*1000),y=now.getUTCFullYear(),m=now.getUTCMonth()+1,day=now.getUTCDate(),last=new Date(Date.UTC(y,m,0)).getUTCDate(),period=y+"-"+String(m).padStart(2,"0"),date=period+"-"+String(day).padStart(2,"0");
 const all=await env.DB.prepare("SELECT * FROM recurring_expenses WHERE active=1").all();
 for(const r of all.results||[]){const due=Math.min(Number(r.billing_day),last);if(day!==due)continue;
  try{await env.DB.prepare("INSERT INTO recurring_expense_runs(recurring_id,period) VALUES(?,?)").bind(r.id,period).run()}catch{continue}
  const states=await env.DB.prepare("SELECT state_key,value_json FROM family_state WHERE family_id=? AND state_key IN ('household_ledger','allowance_ledger','allowance_audit')").bind(r.family_id).all(),map={};
  for(const s of states.results||[]){try{map[s.state_key]=JSON.parse(s.value_json)}catch{}}
  const household=Array.isArray(map.household_ledger)?map.household_ledger:[],tx={id:id(),date,type:"fixed",amount:Number(r.amount),fixedKind:r.kind,title:r.title,createdBy:"시스템",createdAt:new Date().toISOString(),recurringId:r.id,period};
  household.push(tx);
  const writes=[env.DB.prepare("INSERT INTO family_state(family_id,state_key,value_json,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(family_id,state_key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP").bind(r.family_id,"household_ledger",JSON.stringify(household))];
  if(r.kind==="allowance"&&r.allowance_member_name){const ledger=map.allowance_ledger&&typeof map.allowance_ledger==="object"?map.allowance_ledger:{},rows=Array.isArray(ledger[r.allowance_member_name])?ledger[r.allowance_member_name]:[];rows.push({id:id(),date,type:"income",wallet:"card",amount:Number(r.amount),title:r.title,status:"approved",requestedBy:"시스템",approvedBy:"시스템",createdAt:new Date().toISOString(),approvedAt:new Date().toISOString(),recurringId:r.id,period});ledger[r.allowance_member_name]=rows;writes.push(env.DB.prepare("INSERT INTO family_state(family_id,state_key,value_json,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(family_id,state_key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP").bind(r.family_id,"allowance_ledger",JSON.stringify(ledger)));
   const audit=Array.isArray(map.allowance_audit)?map.allowance_audit:[];audit.unshift({id:id(),action:"고정지출 자동 용돈",child:r.allowance_member_name,actor:"시스템",at:new Date().toISOString(),before:null,after:rows[rows.length-1]});writes.push(env.DB.prepare("INSERT INTO family_state(family_id,state_key,value_json,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(family_id,state_key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP").bind(r.family_id,"allowance_audit",JSON.stringify(audit.slice(0,1000))));
  }
  await env.DB.batch(writes);
 }
}
const handler={async scheduled(event,env,ctx){ctx.waitUntil(processRecurring(env))},async fetch(req,env){const url=new URL(req.url);
if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});if(url.pathname==="/api/health"){
 try{await env.DB.prepare("SELECT 1 FROM families LIMIT 1").first();return json({ok:true,service:"gyeongjin-family-api",database:true,release:env.RELEASE_SHA||"unknown",features:["minus-repayment-cancel","split-payment"]})}
 catch{return json({ok:false,service:"gyeongjin-family-api",database:false},503)}
}
if(url.pathname==="/api/setup-status"&&req.method==="GET"){const row=await env.DB.prepare("SELECT COUNT(*) c FROM families").first();return json({initialized:Number(row?.c||0)>0})}
if(url.pathname==="/api/setup"&&req.method==="POST"){const b=await body(req);if(!b.familyName||!b.parentName||!b.password||b.password.length<4)return json({error:"가족명, 부모 이름, 4자 이상 비밀번호가 필요합니다."},400);const exists=await env.DB.prepare("SELECT COUNT(*) c FROM families").first();if(Number(exists?.c||0)>0)return json({error:"초기 가족 설정이 이미 완료되었습니다."},409);const familyId=id(),memberId=id(),salt=id(),hash=await passwordHash(b.password,salt);await env.DB.batch([env.DB.prepare("INSERT INTO families(id,name) VALUES(?,?)").bind(familyId,b.familyName),env.DB.prepare("INSERT INTO members(id,family_id,name,role,is_admin,emoji,password_hash,password_salt) VALUES(?,?,?,?,1,?,?,?)").bind(memberId,familyId,b.parentName,"parent",b.emoji||"🙂",hash,salt)]);const token=await createSession(memberId,env);return json({token,member:{id:memberId,name:b.parentName,role:"parent",isAdmin:true,emoji:b.emoji||"🙂"}})}
if(url.pathname==="/api/login"&&req.method==="POST"){const b=await body(req);const m=await env.DB.prepare("SELECT * FROM members WHERE name=? LIMIT 1").bind(b.name||"").first();if(!m||await passwordHash(b.password||"",m.password_salt)!==m.password_hash)return json({error:"이름 또는 비밀번호를 확인해주세요."},401);const token=await createSession(m.id,env);return json({token,member:{id:m.id,name:m.name,role:m.role,isAdmin:!!m.is_admin,emoji:m.emoji}})}
const me=await auth(req,env);if(!me)return json({error:"로그인이 필요합니다."},401);
if(url.pathname==="/api/child-trades"&&req.method==="GET"){
 const status=url.searchParams.get("status")||"active";
 if(!["active","completed","cancelled"].includes(status))return json({error:"잘못된 조회 상태입니다."},400);
 const visible=status==="active"?["requested","consented","approved","held","active","delivery_pending","disputed"]:status==="completed"?["settled"]:["cancelled","rejected"];
 const placeholders=visible.map(()=>"?").join(",");
 try{
  const sql="SELECT id,kind,requester_id,counterparty_id,payer_id,payee_id,source_wallet,destination_wallet,gross_amount,fee_amount,net_amount,status,revision,due_date,created_at,updated_at FROM child_trade_transactions WHERE family_id=? AND (requester_id=? OR counterparty_id=? OR ?=1) AND status IN ("+placeholders+") ORDER BY created_at DESC LIMIT 100";
  const rows=await env.DB.prepare(sql).bind(me.family_id,me.id,me.id,me.is_admin?1:0,...visible).all();
  return json({ok:true,transactions:rows.results||[],status});
 }catch(e){return json({error:"거래 원장 준비 중",code:"CHILD_TRADES_UNAVAILABLE"},503)}
}
if(url.pathname==="/api/me")return json({member:{id:me.id,name:me.name,role:me.role,isAdmin:!!me.is_admin,emoji:me.emoji}});
if(url.pathname==="/api/members"&&req.method==="GET"){const rows=await env.DB.prepare("SELECT id,name,role,is_admin,emoji,created_at FROM members WHERE family_id=? ORDER BY created_at").bind(me.family_id).all();return json({members:(rows.results||[]).map(m=>({id:m.id,name:m.name,role:m.role,isAdmin:!!m.is_admin,emoji:m.emoji}))})}
if(url.pathname==="/api/members"&&req.method==="POST"){if(!me.is_admin)return json({error:"관리자만 가족을 등록할 수 있습니다."},403);const b=await body(req);if(!b.name||!b.password||b.password.length<4||!["parent","child"].includes(b.role))return json({error:"이름, 역할, 4자 이상 비밀번호가 필요합니다."},400);const memberId=id(),salt=id(),hash=await passwordHash(b.password,salt);try{await env.DB.prepare("INSERT INTO members(id,family_id,name,role,is_admin,emoji,password_hash,password_salt) VALUES(?,?,?,?,?,?,?,?)").bind(memberId,me.family_id,b.name,b.role,b.role==="parent"?1:0,b.emoji||"🙂",hash,salt).run()}catch(e){return json({error:"이미 등록된 이름이거나 저장할 수 없습니다."},409)}return json({member:{id:memberId,name:b.name,role:b.role,isAdmin:b.role==="parent",emoji:b.emoji||"🙂"}},201)}
if(url.pathname==="/api/members/password"&&req.method==="PUT"){if(!me.is_admin)return json({error:"관리자만 비밀번호를 재설정할 수 있습니다."},403);const b=await body(req);if(!b.memberId||!b.password||b.password.length<4)return json({error:"구성원과 4자 이상 새 비밀번호가 필요합니다."},400);const target=await env.DB.prepare("SELECT id,family_id,role FROM members WHERE id=? AND family_id=?").bind(b.memberId,me.family_id).first();if(!target)return json({error:"가족 구성원을 찾을 수 없습니다."},404);if(target.id===me.id)return json({error:"본인 비밀번호 변경은 별도 절차를 이용해주세요."},400);const salt=id(),hash=await passwordHash(b.password,salt);await env.DB.batch([env.DB.prepare("UPDATE members SET password_hash=?,password_salt=? WHERE id=?").bind(hash,salt,target.id),env.DB.prepare("DELETE FROM sessions WHERE member_id=?").bind(target.id)]);return json({ok:true})}
if(url.pathname==="/api/account"&&req.method==="PUT"){const b=await body(req);const fields=[];if(b.name!==undefined){const name=String(b.name||"").trim();if(!name)return json({error:"이름을 입력해주세요."},400);try{await env.DB.prepare("UPDATE members SET name=? WHERE id=? AND family_id=?").bind(name,me.id,me.family_id).run()}catch(e){return json({error:"이미 사용 중인 이름입니다."},409)}}if(b.emoji!==undefined){const emoji=String(b.emoji||"").trim();if(!emoji)return json({error:"아이콘을 입력해주세요."},400);await env.DB.prepare("UPDATE members SET emoji=? WHERE id=? AND family_id=?").bind(emoji,me.id,me.family_id).run()}if(b.password!==undefined){if(String(b.password).length<4)return json({error:"새 비밀번호는 4자 이상이어야 합니다."},400);const salt=id(),hash=await passwordHash(String(b.password),salt);if(me.role==="child"){await env.DB.prepare("UPDATE password_change_requests SET status='rejected',reviewed_at=CURRENT_TIMESTAMP WHERE member_id=? AND status='pending'").bind(me.id).run();await env.DB.prepare("INSERT INTO password_change_requests(id,family_id,member_id,password_hash,password_salt) VALUES(?,?,?,?,?)").bind(id(),me.family_id,me.id,hash,salt).run();return json({ok:true,pendingApproval:true,message:"부모님께 비밀번호 변경 승인을 요청했어요."})}await env.DB.prepare("UPDATE members SET password_hash=?,password_salt=? WHERE id=?").bind(hash,salt,me.id).run();await env.DB.prepare("DELETE FROM sessions WHERE member_id=? AND token_hash<>?").bind(me.id,await digest((req.headers.get("authorization")||"").replace(/^Bearer\s+/i,""))).run()}const updated=await env.DB.prepare("SELECT id,name,role,is_admin,emoji FROM members WHERE id=?").bind(me.id).first();return json({ok:true,member:{id:updated.id,name:updated.name,role:updated.role,isAdmin:!!updated.is_admin,emoji:updated.emoji}})}
if(url.pathname==="/api/members/account"&&req.method==="PUT"){if(!me.is_admin)return json({error:"관리자만 가족 계정을 변경할 수 있습니다."},403);const b=await body(req);if(!b.memberId)return json({error:"구성원을 선택해주세요."},400);const target=await env.DB.prepare("SELECT id FROM members WHERE id=? AND family_id=?").bind(b.memberId,me.family_id).first();if(!target)return json({error:"가족 구성원을 찾을 수 없습니다."},404);if(b.name!==undefined){const name=String(b.name||"").trim();if(!name)return json({error:"이름을 입력해주세요."},400);try{await env.DB.prepare("UPDATE members SET name=? WHERE id=?").bind(name,target.id).run()}catch(e){return json({error:"이미 사용 중인 이름입니다."},409)}}if(b.emoji!==undefined){const emoji=String(b.emoji||"").trim();if(!emoji)return json({error:"아이콘을 입력해주세요."},400);await env.DB.prepare("UPDATE members SET emoji=? WHERE id=?").bind(emoji,target.id).run()}if(b.password!==undefined){if(String(b.password).length<4)return json({error:"새 비밀번호는 4자 이상이어야 합니다."},400);const salt=id(),hash=await passwordHash(String(b.password),salt);await env.DB.prepare("UPDATE members SET password_hash=?,password_salt=? WHERE id=?").bind(hash,salt,target.id).run();await env.DB.prepare("DELETE FROM sessions WHERE member_id=?").bind(target.id).run()}return json({ok:true})}
if(url.pathname==="/api/password-requests"&&req.method==="GET"){if(!me.is_admin)return json({error:"관리자만 승인 요청을 확인할 수 있습니다."},403);const rows=await env.DB.prepare(`SELECT r.id,r.member_id,m.name,m.emoji,r.created_at FROM password_change_requests r JOIN members m ON m.id=r.member_id WHERE r.family_id=? AND r.status='pending' ORDER BY r.created_at`).bind(me.family_id).all();return json({requests:rows.results||[]})}
if(url.pathname==="/api/password-requests/review"&&req.method==="POST"){if(!me.is_admin)return json({error:"관리자만 승인할 수 있습니다."},403);const b=await body(req);if(!b.requestId||!["approve","reject"].includes(b.action))return json({error:"승인 요청과 처리 방법을 확인해주세요."},400);const r=await env.DB.prepare("SELECT * FROM password_change_requests WHERE id=? AND family_id=? AND status='pending'").bind(b.requestId,me.family_id).first();if(!r)return json({error:"처리할 승인 요청이 없습니다."},404);if(b.action==="approve"){await env.DB.batch([env.DB.prepare("UPDATE members SET password_hash=?,password_salt=? WHERE id=?").bind(r.password_hash,r.password_salt,r.member_id),env.DB.prepare("DELETE FROM sessions WHERE member_id=?").bind(r.member_id),env.DB.prepare("UPDATE password_change_requests SET status='approved',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").bind(me.id,r.id)])}else await env.DB.prepare("UPDATE password_change_requests SET status='rejected',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").bind(me.id,r.id).run();return json({ok:true,approved:b.action==="approve"})}
if(url.pathname==="/api/recurring-expenses"&&req.method==="GET"){if(!me.is_admin)return json({error:"관리자만 확인할 수 있습니다."},403);const rows=await env.DB.prepare("SELECT * FROM recurring_expenses WHERE family_id=? ORDER BY created_at").bind(me.family_id).all();return json({items:rows.results||[]})}
if(url.pathname==="/api/recurring-expenses"&&req.method==="POST"){if(!me.is_admin)return json({error:"관리자만 등록할 수 있습니다."},403);const b=await body(req),kind=String(b.kind||""),amount=Number(b.amount),billingDay=Number(b.billingDay);if(!["insurance","allowance","other"].includes(kind)||!b.title||!Number.isInteger(amount)||amount<=0||!Number.isInteger(billingDay)||billingDay<1||billingDay>31)return json({error:"고정지출 정보를 확인해주세요."},400);if(kind==="allowance"&&!b.allowanceMemberName)return json({error:"용돈 대상 자녀를 선택해주세요."},400);const rid=id();await env.DB.prepare("INSERT INTO recurring_expenses(id,family_id,kind,title,amount,billing_day,allowance_member_name,allowance_wallet,created_by) VALUES(?,?,?,?,?,?,?,?,?)").bind(rid,me.family_id,kind,String(b.title).trim(),amount,billingDay,kind==="allowance"?String(b.allowanceMemberName):null,kind==="allowance"?"card":null,me.id).run();return json({ok:true,id:rid},201)}
if(url.pathname==="/api/recurring-expenses"&&req.method==="PUT"){if(!me.is_admin)return json({error:"관리자만 수정할 수 있습니다."},403);const b=await body(req),kind=String(b.kind||""),amount=Number(b.amount),billingDay=Number(b.billingDay);if(!b.id||!["insurance","allowance","other"].includes(kind)||!b.title||!Number.isInteger(amount)||amount<=0||!Number.isInteger(billingDay)||billingDay<1||billingDay>31)return json({error:"고정지출 정보를 확인해주세요."},400);if(kind==="allowance"&&!b.allowanceMemberName)return json({error:"용돈 대상 자녀를 선택해주세요."},400);const target=await env.DB.prepare("SELECT id FROM recurring_expenses WHERE id=? AND family_id=?").bind(b.id,me.family_id).first();if(!target)return json({error:"고정지출을 찾을 수 없습니다."},404);await env.DB.prepare("UPDATE recurring_expenses SET kind=?,title=?,amount=?,billing_day=?,allowance_member_name=?,allowance_wallet=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND family_id=?").bind(kind,String(b.title).trim(),amount,billingDay,kind==="allowance"?String(b.allowanceMemberName):null,kind==="allowance"?"card":null,b.id,me.family_id).run();return json({ok:true})}
if(url.pathname==="/api/allowance/minus-debt/origin"&&req.method==="POST"){if(!me.is_admin)return json({error:"부모 관리자만 채무 성격을 지정할 수 있습니다."},403);const b=await body(req);if(typeof b.child!=="string"||typeof b.id!=="string"||!["free","card"].includes(b.origin))return json({error:"입력값 오류"},400);for(let attempt=0;attempt<5;attempt++){const state=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='allowance_ledger'").bind(me.family_id).first();if(!state)return json({error:"용돈 원장이 없습니다."},404);let ledger;try{ledger=JSON.parse(state.value_json)}catch{return json({error:"원장 오류"},500)}const rows=Array.isArray(ledger[b.child])?ledger[b.child]:[],tx=rows.find(x=>x.id===b.id&&x.wallet==="minus"&&x.type==="expense"&&x.status==="approved");if(!tx)return json({error:"마이너스 사용 건을 찾을 수 없습니다."},404);if(tx.debtOrigin&&tx.debtOrigin!==b.origin)return json({error:"이미 지정된 출처는 변경할 수 없습니다."},409);tx.debtOrigin=b.origin;tx.debtOriginSetBy=me.name;tx.debtOriginSetAt=new Date().toISOString();const result=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='allowance_ledger' AND value_json=?").bind(JSON.stringify(ledger),me.id,me.family_id,state.value_json).run();if(result.meta?.changes===1)return json({ok:true,ledger})}return json({error:"동시 변경으로 저장하지 못했습니다."},409)}
if(url.pathname==="/api/allowance/minus-repayment/cancel"&&req.method==="POST"){
 if(!me.is_admin)return json({error:"부모 관리자만 변제를 취소할 수 있습니다."},403);
 const b=await body(req);if(typeof b.child!=="string"||typeof b.id!=="string")return json({error:"요청 형식이 올바르지 않습니다."},400);
 for(let attempt=0;attempt<5;attempt++){
  const state=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='allowance_ledger'").bind(me.family_id).first();
  if(!state)return json({error:"용돈 원장을 찾을 수 없습니다."},404);
  let ledger;try{ledger=JSON.parse(state.value_json)}catch{return json({error:"원장 데이터 오류"},500)}
  const rows=Array.isArray(ledger[b.child])?ledger[b.child]:[],request=rows.find(x=>x.id===b.id&&x.type==="minus_repayment");
  if(!request)return json({error:"변제 요청을 찾지 못했습니다."},404);
  if(!["approved","pending"].includes(request.status))return json({error:"이미 취소 또는 처리된 변제입니다."},409);
  const linked=rows.filter(x=>x.repaymentRequestId===request.id);
  if(request.status==="pending"&&linked.length)return json({error:"승인 전 변제에 정산 거래가 연결되어 있어 취소할 수 없습니다."},409);
  if(request.status==="approved"&&(!request.settlementId||linked.length!==2||linked.some(x=>x.settlementId!==request.settlementId||x.status!=="approved")||linked.filter(x=>x.type==="expense"&&x.wallet===request.wallet&&Number(x.amount)===Number(request.amount)).length!==1||linked.filter(x=>x.type==="income"&&x.wallet==="minus"&&x.repaymentDebtId===request.repaymentDebtId&&Number(x.amount)===Number(request.repaymentAmount)).length!==1))return json({error:"변제 연결 원장에 불일치가 있어 취소를 중단했습니다."},409);
  const settlementIds=new Set(linked.map(x=>x.id));
  if(settlementIds.size!==linked.length||rows.filter(x=>x.id===request.id).length!==1||rows.some(x=>x!==request&&!linked.includes(x)&&request.settlementId&&x.settlementId===request.settlementId))return json({error:"변제 연결 거래를 모두 확인하지 못했습니다."},409);
  const stamp=new Date().toISOString();for(const x of [request,...linked]){x.status="cancelled";x.cancelledAt=stamp;x.cancelledBy=me.name;x.cancellationReason="관리자 변제 취소"}
  const update=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='allowance_ledger' AND value_json=?").bind(JSON.stringify(ledger),me.id,me.family_id,state.value_json).run();
  if(update.meta?.changes===1)return json({ok:true,ledger});
 }
 return json({error:"동시 변경으로 취소하지 못했습니다. 다시 시도해주세요."},409);
}
if(url.pathname==="/api/allowance/minus-repayment/review"&&req.method==="POST"){
 if(!me.is_admin)return json({error:"부모 관리자만 처리할 수 있습니다."},403);
 const b=await body(req);if(typeof b.child!=="string"||typeof b.id!=="string"||!["approve","reject"].includes(b.action))return json({error:"요청 형식이 올바르지 않습니다."},400);
 for(let attempt=0;attempt<5;attempt++){
  const state=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='allowance_ledger'").bind(me.family_id).first();
  if(!state)return json({error:"용돈 원장을 찾을 수 없습니다."},404);
  let ledger;try{ledger=JSON.parse(state.value_json)}catch{return json({error:"원장 데이터 오류"},500)}
  const rows=Array.isArray(ledger[b.child])?ledger[b.child]:[],idx=rows.findIndex(x=>x.id===b.id);
  if(idx<0)return json({error:"요청을 찾을 수 없습니다."},404);
  const tx=rows[idx];if(tx.type!=="minus_repayment")return json({error:"변제 요청이 아닙니다."},400);
  if(tx.status!=="pending")return json({error:"이미 처리된 요청입니다."},409);
  const amount=Number(tx.amount),wallet=tx.wallet;
  if(!Number.isSafeInteger(amount)||amount<=0||!["free","card"].includes(wallet))return json({error:"변제 금액 또는 출금 지갑이 올바르지 않습니다."},400);
  if(b.action==="approve"){

   const approved=rows.filter(x=>x.status==="approved"),balance=approved.filter(x=>x.wallet===wallet).reduce((n,x)=>n+(x.type==="income"?Number(x.amount||0):x.type==="expense"?-Number(x.amount||0):0),0);
   const debtEntries=approved.filter(x=>x.wallet==="minus"&&x.type==="expense"),repaid=new Map();
   for(const x of approved.filter(x=>x.wallet==="minus"&&x.type==="income"&&x.repaymentDebtId)){repaid.set(x.repaymentDebtId,(repaid.get(x.repaymentDebtId)||0)+Number(x.amount||0))}
   const debtId=tx.repaymentDebtId,debtEntry=debtEntries.find(x=>x.id===debtId),origin=debtEntry?.debtOrigin;
   if(!debtEntry||!["free","card"].includes(origin))return json({error:"변제할 마이너스 사용 건의 출처가 미지정입니다. 부모가 출처를 확인해야 합니다."},409);
   const remaining=Number(debtEntry.amount||0)-(repaid.get(debtId)||0),fee=wallet==="card"&&origin==="free"?Math.round(amount*.5):0,repayment=amount-fee;
   if(balance<amount)return json({error:"출금 지갑 잔고가 부족합니다."},409);
   if(repayment<=0||repayment>remaining)return json({error:"선택한 채무의 남은 사용액을 초과합니다."},409);
   const stamp=new Date().toISOString(),settlementId=id();
   rows.push({id:settlementId+":debit",date:tx.date,type:"expense",wallet,amount,title:"마이너스 변제 · "+(tx.title||""),status:"approved",requestedBy:tx.requestedBy,approvedBy:me.name,approvedAt:stamp,createdAt:stamp,settlementId,repaymentRequestId:tx.id});
   rows.push({id:settlementId+":credit",date:tx.date,type:"income",wallet:"minus",amount:repayment,title:"마이너스 변제 상환",status:"approved",requestedBy:tx.requestedBy,approvedBy:me.name,approvedAt:stamp,createdAt:stamp,settlementId,repaymentRequestId:tx.id,repaymentDebtId:debtId,debtOrigin:origin});
   tx.status="approved";tx.approvedBy=me.name;tx.approvedAt=stamp;tx.settlementId=settlementId;tx.fee=fee;tx.repaymentAmount=repayment;tx.repaymentDebtId=debtId;
  }else{tx.status="rejected";tx.rejectedBy=me.name;tx.rejectedAt=new Date().toISOString()}
  ledger[b.child]=rows;
  const update=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='allowance_ledger' AND value_json=?").bind(JSON.stringify(ledger),me.id,me.family_id,state.value_json).run();
  if(update.meta?.changes===1)return json({ok:true,ledger});
 }
 return json({error:"다른 변경과 충돌했습니다. 다시 시도해주세요."},409);
}
if(url.pathname==="/api/allowance/split/request"&&req.method==="POST"){
 const b=await body(req),a=b.allocations||{},wallets=["free","card","minus"],amount=b.amount;
 if(typeof b.child!=="string"||typeof b.title!=="string"||!b.title.trim()||b.title.length>40||typeof b.date!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(b.date)||!Number.isSafeInteger(amount)||amount<=0||wallets.some(k=>!Number.isSafeInteger(a[k])||a[k]<0)||wallets.reduce((n,k)=>n+a[k],0)!==amount)return json({error:"통합결제 입력 오류"},400);
 if(!Number.isFinite(Date.parse(b.date+"T00:00:00Z"))||new Date(b.date+"T00:00:00Z").toISOString().slice(0,10)!==b.date)return json({error:"날짜 오류"},400);
 if(a.minus>0&&!["free","card"].includes(b.debtOrigin))return json({error:"마이너스 사용 출처를 선택하세요"},400);
 const child=await env.DB.prepare("SELECT id FROM members WHERE family_id=? AND name=?").bind(me.family_id,b.child).first();
 if(!child)return json({error:"가족 구성원을 찾을 수 없습니다"},404);
 if(!me.is_admin&&me.name!==b.child)return json({error:"본인의 결제만 요청할 수 있습니다"},403);
 const requestId=typeof b.requestId==="string"&&/^split_[a-zA-Z0-9_-]{8,90}$/.test(b.requestId)?b.requestId:null;
 if(!requestId)return json({error:"요청 식별자가 올바르지 않습니다"},400);
 const stamp=new Date().toISOString(),tx={id:requestId,date:b.date,type:"split_payment",wallet:"split",amount,allocations:{free:a.free,card:a.card,minus:a.minus},debtOrigin:a.minus?b.debtOrigin:"",title:b.title.trim(),status:"pending",requestedBy:me.name,createdAt:stamp};
 for(let attempt=0;attempt<5;attempt++){
  const state=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='allowance_ledger'").bind(me.family_id).first();
  if(!state)return json({error:"용돈 원장을 찾을 수 없습니다"},404);
  let ledger;try{ledger=JSON.parse(state.value_json)}catch{return json({error:"원장 오류"},500)}
  const rows=Array.isArray(ledger[b.child])?ledger[b.child]:[];
  if(rows.some(x=>x.id===tx.id)){const existing=rows.find(x=>x.id===tx.id);if(existing.type!=="split_payment"||existing.amount!==tx.amount||JSON.stringify(existing.allocations)!==JSON.stringify(tx.allocations)||existing.date!==tx.date||existing.title!==tx.title||existing.debtOrigin!==tx.debtOrigin)return json({error:"동일 식별자의 다른 요청이 존재합니다"},409);return json({ok:true,ledger,duplicate:true})}
  ledger[b.child]=[...rows,tx];
  const update=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='allowance_ledger' AND value_json=?").bind(JSON.stringify(ledger),me.id,me.family_id,state.value_json).run();
  if(update.meta?.changes===1)return json({ok:true,ledger});
 }
 return json({error:"동시 수정 충돌"},409);
}
if(url.pathname==="/api/allowance/split/review"&&req.method==="POST"){
 if(!me.is_admin)return json({error:"부모 관리자만 처리할 수 있습니다."},403);
 const b=await body(req);
 if(typeof b.child!=="string"||typeof b.id!=="string"||!["approve","reject","cancel"].includes(b.action))return json({error:"요청 형식 오류"},400);
 for(let attempt=0;attempt<5;attempt++){
  const state=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='allowance_ledger'").bind(me.family_id).first();
  if(!state)return json({error:"용돈 원장 없음"},404);
  let ledger;try{ledger=JSON.parse(state.value_json)}catch{return json({error:"원장 형식 오류"},500)}
  const rows=Array.isArray(ledger[b.child])?ledger[b.child]:[],tx=rows.find(x=>x.id===b.id&&x.type==="split_payment");
  if(!tx)return json({error:"통합결제 요청 없음"},404);
  if(b.action==="cancel"?tx.status!=="approved":tx.status!=="pending")return json({error:"이미 처리된 요청입니다."},409);
  const a=tx.allocations||{},wallets=["free","card","minus"],amount=tx.amount;
  if(!Number.isSafeInteger(amount)||amount<=0||wallets.some(k=>!Number.isSafeInteger(a[k])||a[k]<0)||wallets.reduce((n,k)=>n+a[k],0)!==amount)return json({error:"금액 검증 실패"},400);
  if(b.action==="approve"&&a.minus>0&&!["free","card"].includes(tx.debtOrigin))return json({error:"마이너스 출처 지정이 필요합니다."},409);
  const stamp=new Date().toISOString();
  if(b.action==="approve"){
   const approved=rows.filter(x=>(x.status||"approved")==="approved");
   const balance=w=>approved.filter(x=>x.wallet===w).reduce((n,x)=>n+(x.type==="income"?Number(x.amount||0):x.type==="expense"?-Number(x.amount||0):0),0);
   const lim=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='allowance_limits'").bind(me.family_id).first();
   let limits={};try{limits=JSON.parse(lim?.value_json||"{}")||{}}catch{}
   const rawLimit=limits[b.child];const minusLimit=Number(rawLimit||0);if(!Number.isSafeInteger(minusLimit)||minusLimit<0)return json({error:"마이너스 한도 설정 오류"},409);
   const minusAvailable=Math.max(0,minusLimit+balance("minus"));
   if(a.free>balance("free")||a.card>balance("card")||a.minus>minusAvailable)return json({error:"결제수단 잔액이 부족합니다."},409);
   for(const wallet of wallets)if(a[wallet]>0)rows.push({id:tx.id+"_"+wallet,splitPaymentId:tx.id,date:tx.date,type:"expense",wallet,amount:a[wallet],debtOrigin:wallet==="minus"?tx.debtOrigin:"",title:tx.title,status:"approved",requestedBy:tx.requestedBy,approvedBy:me.name,createdAt:stamp,approvedAt:stamp});
   tx.status="approved";tx.approvedBy=me.name;tx.approvedAt=stamp;
  }else if(b.action==="reject"){tx.status="rejected";tx.reviewedBy=me.name;tx.reviewedAt=stamp}
  else{
   const parts=rows.filter(x=>x.splitPaymentId===tx.id&&x.status==="approved");
   if(parts.length!==wallets.filter(k=>a[k]>0).length||parts.some(x=>!wallets.includes(x.wallet)||a[x.wallet]!==x.amount)||new Set(parts.map(x=>x.wallet)).size!==parts.length)return json({error:"연결 거래 검증 실패"},409);
   for(const part of parts){part.status="cancelled";part.cancelledBy=me.name;part.cancelledAt=stamp}
   tx.status="cancelled";tx.cancelledBy=me.name;tx.cancelledAt=stamp;
  }
  ledger[b.child]=rows;
  const updated=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='allowance_ledger' AND value_json=?").bind(JSON.stringify(ledger),me.id,me.family_id,state.value_json).run();
  if(updated.meta?.changes===1)return json({ok:true,ledger});
 }
 return json({error:"동시 변경 충돌. 다시 시도해주세요."},409);
}
if(url.pathname==="/api/state"&&req.method==="GET"){const rows=await env.DB.prepare("SELECT state_key,value_json,updated_at FROM family_state WHERE family_id=?").bind(me.family_id).all();const state={};for(const r of rows.results||[]){try{state[r.state_key]=JSON.parse(r.value_json)}catch{}}return json({state})}
if(url.pathname==="/api/state"&&req.method==="PUT"){const b=await body(req),allowed=new Set(["daily_schedules","family_schedules","monthly_memos","event","memories","member_albums","profile_photos","allowance_ledger","allowance_audit","allowance_limits","allowance_notices","savings_goals","chore_templates","chores","household_ledger"]);if(!allowed.has(b.key))return json({error:"지원하지 않는 데이터 종류입니다."},400);if(b.key==="allowance_notices"&&!me.is_admin)return json({error:"공지사항은 부모 관리자만 수정할 수 있습니다."},403);if(b.key==="allowance_ledger"){if(typeof b.expectedJson!=="string")return json({error:"용돈 데이터의 동기화 기준이 없습니다. 새로고침 후 다시 시도해주세요."},409);const current=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='allowance_ledger'").bind(me.family_id).first();const oldJson=current?.value_json??"null";if(oldJson!==b.expectedJson)return json({error:"다른 기기에서 용돈 내역이 변경되었습니다. 최신 내역을 불러온 후 다시 시도해주세요."},409);let oldLedger,newLedger;try{oldLedger=JSON.parse(oldJson)||{};newLedger=b.value||{}}catch{return json({error:"원장 형식 오류"},400)}if(!newLedger||typeof newLedger!=="object"||Array.isArray(newLedger))return json({error:"원장 형식 오류"},400);for(const [child,rows] of Object.entries(newLedger)){if(!Array.isArray(rows))continue;const old=Array.isArray(oldLedger[child])?oldLedger[child]:[];if(rows.some(x=>(x.type==='split_payment'||x.splitPaymentId)&&!old.some(y=>y.id===x.id)))return json({error:'통합결제 생성은 전용 API로만 가능합니다.'},409)}for(const [child,rows] of Object.entries(oldLedger)){if(!Array.isArray(rows))continue;const next=Array.isArray(newLedger[child])?newLedger[child]:[];for(const tx of rows.filter(x=>x.type==='split_payment'||x.splitPaymentId)){const found=next.find(x=>x.id===tx.id);if(!found||JSON.stringify(found)!==JSON.stringify(tx))return json({error:'통합결제 변경은 전용 API로만 가능합니다.'},409)}}for(const [child,rows] of Object.entries(oldLedger)){if(!Array.isArray(rows))continue;const next=Array.isArray(newLedger[child])?newLedger[child]:[];for(const tx of rows.filter(x=>x.settlementId||x.repaymentRequestId||x.splitPaymentId||x.type==="split_payment")){const found=next.find(x=>x.id===tx.id);if(!found||JSON.stringify(found)!==JSON.stringify(tx))return json({error:"확정된 마이너스 정산 내역은 수정하거나 삭제할 수 없습니다."},409)}}const nextJson=JSON.stringify(newLedger);let result;if(current){result=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='allowance_ledger' AND value_json=?").bind(nextJson,me.id,me.family_id,oldJson).run()}else{result=await env.DB.prepare("INSERT OR IGNORE INTO family_state(family_id,state_key,value_json,updated_at,updated_by) VALUES(?,?,?,CURRENT_TIMESTAMP,?)").bind(me.family_id,b.key,nextJson,me.id).run()}if(result.meta?.changes!==1)return json({error:"동시 수정 충돌. 다시 불러온 후 시도해주세요."},409);return json({ok:true,value:newLedger})}await env.DB.prepare(`INSERT INTO family_state(family_id,state_key,value_json,updated_at,updated_by) VALUES(?,?,?,CURRENT_TIMESTAMP,?) ON CONFLICT(family_id,state_key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP,updated_by=excluded.updated_by`).bind(me.family_id,b.key,JSON.stringify(b.value??null),me.id).run();return json({ok:true})}
return json({error:"Not found"},404)}};
const APP_ORIGINS=new Set(["https://gyeongjin-family-app.pages.dev","https://gyeongjin-family-app.muse-hooni.workers.dev"]);
export default {
 scheduled:handler.scheduled,
 async fetch(req,env){
  const response=await handler.fetch(req,env),headers=new Headers(response.headers),origin=req.headers.get("origin");
  if(APP_ORIGINS.has(origin))headers.set("access-control-allow-origin",origin);
  else headers.delete("access-control-allow-origin");
  return new Response(response.body,{status:response.status,headers});
 }
};
