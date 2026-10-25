import {processRecurringAtomic} from './recurring.js';
import {childTradeLifecycle} from './child-transactions/lifecycle.js';
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
async function renameMemberSafely(env,familyId,memberId,newName){
 const db=env.DB,member=await db.prepare("SELECT name FROM members WHERE id=? AND family_id=?").bind(memberId,familyId).first();
 if(!member)throw new Error('구성원을 찾을 수 없습니다.');
 const oldName=member.name;if(oldName===newName)return;
 const duplicate=await db.prepare("SELECT id FROM members WHERE family_id=? AND name=?").bind(familyId,newName).first();
 if(duplicate)throw new Error('이미 사용 중인 이름입니다.');
 const rows=(await db.prepare("SELECT state_key,value_json FROM family_state WHERE family_id=? AND state_key IN ('allowance_ledger','allowance_audit','household_ledger')").bind(familyId).all()).results||[];
 const writes=[];
 for(const row of rows){
  const value=JSON.parse(row.value_json);let changed=false;
  if(row.state_key==='allowance_ledger'&&value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,oldName)){
   if(Object.hasOwn(value,newName))throw new Error('변경할 이름의 용돈 원장이 이미 존재하여 안전하게 통합할 수 없습니다.');
   value[newName]=value[oldName];delete value[oldName];changed=true;
  }
  // Keep historic audit recipient names unchanged: they describe who was paid at that time.
  if(changed)writes.push(db.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP WHERE family_id=? AND state_key=?").bind(JSON.stringify(value),familyId,row.state_key));
 }
 const scheduled=(await db.prepare("SELECT id FROM recurring_expenses WHERE family_id=? AND allowance_member_name=?").bind(familyId,oldName).all()).results||[];
 const actions=[db.prepare("UPDATE members SET name=? WHERE id=? AND family_id=?").bind(newName,memberId,familyId),
 db.prepare("UPDATE recurring_expenses SET allowance_member_name=?,updated_at=CURRENT_TIMESTAMP WHERE family_id=? AND allowance_member_name=?").bind(newName,familyId,oldName),...writes];
 await db.batch(actions);
 return {previousName:oldName,currentName:newName,recurringUpdated:scheduled.length};
}
async function createSession(memberId,env){const token=crypto.randomUUID()+crypto.randomUUID();const tokenHash=await digest(token);await env.DB.prepare("INSERT INTO sessions(token_hash,member_id,expires_at) VALUES(?,?,datetime('now','+30 days'))").bind(tokenHash,memberId).run();return token}
const handler={async scheduled(event,env,ctx){ctx.waitUntil(processRecurringAtomic(env))},async fetch(req,env){const url=new URL(req.url);
if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});if(url.pathname==="/api/health"){
 try{await env.DB.prepare("SELECT 1 FROM families LIMIT 1").first();const schema=await env.DB.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name IN ('child_trade_actions','child_trade_delivery','child_trade_details','child_trade_guards','child_trade_funding')").first();return json({childTradeSchema:schema?.count===5,ok:true,service:"gyeongjin-family-api",database:true,release:env.RELEASE_SHA||"unknown",features:["minus-repayment-cancel","split-payment","child-trade-loan-approval","child-trade-lifecycle-v2","child-trade-split-goods","child-trade-seller-receipt","child-trade-child-inbox"]})}
 catch{return json({ok:false,service:"gyeongjin-family-api",database:false},503)}
}
if(url.pathname==="/api/setup-status"&&req.method==="GET"){const row=await env.DB.prepare("SELECT COUNT(*) c FROM families").first();return json({initialized:Number(row?.c||0)>0})}
if(url.pathname==="/api/setup"&&req.method==="POST"){const b=await body(req);if(!b.familyName||!b.parentName||!b.password||b.password.length<4)return json({error:"가족명, 부모 이름, 4자 이상 비밀번호가 필요합니다."},400);const exists=await env.DB.prepare("SELECT COUNT(*) c FROM families").first();if(Number(exists?.c||0)>0)return json({error:"초기 가족 설정이 이미 완료되었습니다."},409);const familyId=id(),memberId=id(),salt=id(),hash=await passwordHash(b.password,salt);await env.DB.batch([env.DB.prepare("INSERT INTO families(id,name) VALUES(?,?)").bind(familyId,b.familyName),env.DB.prepare("INSERT INTO members(id,family_id,name,role,is_admin,emoji,password_hash,password_salt) VALUES(?,?,?,?,1,?,?,?)").bind(memberId,familyId,b.parentName,"parent",b.emoji||"🙂",hash,salt)]);const token=await createSession(memberId,env);return json({token,member:{id:memberId,name:b.parentName,role:"parent",isAdmin:true,emoji:b.emoji||"🙂"}})}
if(url.pathname==="/api/login"&&req.method==="POST"){const b=await body(req);const m=await env.DB.prepare("SELECT * FROM members WHERE name=? LIMIT 1").bind(b.name||"").first();if(!m||await passwordHash(b.password||"",m.password_salt)!==m.password_hash)return json({error:"이름 또는 비밀번호를 확인해주세요."},401);const token=await createSession(m.id,env);return json({token,member:{id:m.id,name:m.name,role:m.role,isAdmin:!!m.is_admin,emoji:m.emoji}})}
const me=await auth(req,env);if(!me)return json({error:"로그인이 필요합니다."},401);
if(url.pathname.startsWith('/api/child-trades')){const result=await childTradeLifecycle(req,env,me,json);if(result)return result}
if(url.pathname==="/api/child-trades/participants"&&req.method==="GET"){
 if(me.is_admin)return json({error:"자녀 계정에서만 거래를 신청할 수 있습니다."},403);
 const rows=await env.DB.prepare("SELECT id,name,emoji FROM members WHERE family_id=? AND is_admin=0 AND id<>? ORDER BY name").bind(me.family_id,me.id).all();
 return json({ok:true,participants:rows.results||[]});
}
if(url.pathname==="/api/child-trades/summary"&&req.method==="GET"){
 const childName=url.searchParams.get("child");
 if(!childName||childName.length>80)return json({error:"조회할 자녀를 지정해주세요."},400);
 const child=await env.DB.prepare("SELECT id FROM members WHERE family_id=? AND name=? AND is_admin=0").bind(me.family_id,childName).first();
 if(!child)return json({error:"조회할 자녀를 찾을 수 없습니다."},404);
 if(!me.is_admin&&child.id!==me.id)return json({error:"다른 자녀의 채권·채무는 조회할 수 없습니다."},403);
 try{
  const row=await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN l.borrower_id=? THEN l.outstanding_amount ELSE 0 END),0) borrowed,COALESCE(SUM(CASE WHEN l.lender_id=? THEN l.outstanding_amount ELSE 0 END),0) lent FROM child_trade_loans l JOIN child_trade_transactions t ON t.id=l.transaction_id WHERE t.family_id=? AND l.outstanding_amount>0 AND l.status IN ('active','disputed')").bind(child.id,child.id,me.family_id).first();
  const borrowed=Number(row?.borrowed||0),lent=Number(row?.lent||0);
  if(!Number.isSafeInteger(borrowed)||!Number.isSafeInteger(lent)||borrowed<0||lent<0)throw Error("invalid totals");
  return json({ok:true,borrowed,lent});
 }catch{return json({error:"채권·채무 원장 준비 중",code:"CHILD_TRADES_UNAVAILABLE"},503)}
}
if(url.pathname==="/api/child-trades/audit"&&req.method==="GET"){
 const transactionId=url.searchParams.get("id");
 if(!transactionId)return json({error:"거래번호가 필요합니다."},400);
 try{
  const trade=await env.DB.prepare("SELECT requester_id,counterparty_id FROM child_trade_transactions WHERE id=? AND family_id=?").bind(transactionId,me.family_id).first();
  if(!trade)return json({error:"거래를 찾을 수 없습니다."},404);
  if(!me.is_admin&&trade.requester_id!==me.id&&trade.counterparty_id!==me.id)return json({error:"열람 권한이 없습니다."},403);
  const rows=await env.DB.prepare("SELECT actor_id,action,previous_state,next_state,revision,created_at FROM child_trade_audit WHERE transaction_id=? ORDER BY created_at ASC LIMIT 100").bind(transactionId).all();
  return json({ok:true,history:rows.results||[]});
 }catch{return json({error:"감사기록을 조회할 수 없습니다."},503)}
}
if(url.pathname==="/api/child-trades/approval-queue"&&req.method==="GET"){
 if(!me.is_admin)return json({error:"부모 관리자만 승인대기를 조회할 수 있습니다."},403);
 try{
  const rows=await env.DB.prepare("SELECT t.id,t.kind,t.requester_id,t.counterparty_id,t.gross_amount,t.fee_amount,t.net_amount,t.source_wallet,t.destination_wallet,t.status,t.revision,t.created_at FROM child_trade_transactions t WHERE t.family_id=? AND t.status='consented' ORDER BY t.created_at ASC LIMIT 100").bind(me.family_id).all();
  return json({ok:true,transactions:rows.results||[]});
 }catch{return json({error:"거래 원장이 준비되지 않았습니다.",code:"CHILD_TRADES_UNAVAILABLE"},503)}
}
if(url.pathname==="/api/child-trades"&&req.method==="GET"){
 const status=url.searchParams.get("status")||"active",childName=url.searchParams.get("child");
 if(!["active","completed","cancelled"].includes(status))return json({error:"잘못된 조회 상태입니다."},400);
 if(!childName||childName.length>80)return json({error:"조회할 자녀를 지정해주세요."},400);
 const child=await env.DB.prepare("SELECT id FROM members WHERE family_id=? AND name=? AND is_admin=0").bind(me.family_id,childName).first();
 if(!child)return json({error:"조회할 자녀를 찾을 수 없습니다."},404);
 if(!me.is_admin&&child.id!==me.id)return json({error:"다른 자녀의 거래는 조회할 수 없습니다."},403);
 const visible=status==="active"?["requested","consented","approved","held","active","delivery_pending","disputed"]:status==="completed"?["settled"]:["cancelled","rejected"];
 const placeholders=visible.map(()=>"?").join(",");
 try{
  const sql="SELECT id,kind,requester_id,counterparty_id,payer_id,payee_id,source_wallet,destination_wallet,gross_amount,fee_amount,net_amount,status,revision,due_date,created_at,updated_at FROM child_trade_transactions WHERE family_id=? AND (requester_id=? OR counterparty_id=?) AND status IN ("+placeholders+") ORDER BY created_at DESC LIMIT 100";
  const rows=await env.DB.prepare(sql).bind(me.family_id,child.id,child.id,...visible).all();
  return json({ok:true,transactions:rows.results||[],status});
 }catch(e){return json({error:"거래 원장 준비 중",code:"CHILD_TRADES_UNAVAILABLE"},503)}
}
if(url.pathname==="/api/me")return json({member:{id:me.id,name:me.name,role:me.role,isAdmin:!!me.is_admin,emoji:me.emoji}});
if(url.pathname==="/api/members"&&req.method==="GET"){const rows=await env.DB.prepare("SELECT id,name,role,is_admin,emoji,created_at FROM members WHERE family_id=? ORDER BY created_at").bind(me.family_id).all();return json({members:(rows.results||[]).map(m=>({id:m.id,name:m.name,role:m.role,isAdmin:!!m.is_admin,emoji:m.emoji}))})}
if(url.pathname==="/api/members"&&req.method==="POST"){if(!me.is_admin)return json({error:"관리자만 가족을 등록할 수 있습니다."},403);const b=await body(req);if(!b.name||!b.password||b.password.length<4||!["parent","child"].includes(b.role))return json({error:"이름, 역할, 4자 이상 비밀번호가 필요합니다."},400);const memberId=id(),salt=id(),hash=await passwordHash(b.password,salt);try{await env.DB.prepare("INSERT INTO members(id,family_id,name,role,is_admin,emoji,password_hash,password_salt) VALUES(?,?,?,?,?,?,?,?)").bind(memberId,me.family_id,b.name,b.role,b.role==="parent"?1:0,b.emoji||"🙂",hash,salt).run()}catch(e){return json({error:"이미 등록된 이름이거나 저장할 수 없습니다."},409)}return json({member:{id:memberId,name:b.name,role:b.role,isAdmin:b.role==="parent",emoji:b.emoji||"🙂"}},201)}
if(url.pathname==="/api/members/password"&&req.method==="PUT"){if(!me.is_admin)return json({error:"관리자만 비밀번호를 재설정할 수 있습니다."},403);const b=await body(req);if(!b.memberId||!b.password||b.password.length<4)return json({error:"구성원과 4자 이상 새 비밀번호가 필요합니다."},400);const target=await env.DB.prepare("SELECT id,family_id,role FROM members WHERE id=? AND family_id=?").bind(b.memberId,me.family_id).first();if(!target)return json({error:"가족 구성원을 찾을 수 없습니다."},404);if(target.id===me.id)return json({error:"본인 비밀번호 변경은 별도 절차를 이용해주세요."},400);const salt=id(),hash=await passwordHash(b.password,salt);await env.DB.batch([env.DB.prepare("UPDATE members SET password_hash=?,password_salt=? WHERE id=?").bind(hash,salt,target.id),env.DB.prepare("DELETE FROM sessions WHERE member_id=?").bind(target.id)]);return json({ok:true})}
if(url.pathname==="/api/account"&&req.method==="PUT"){const b=await body(req);const fields=[];if(b.name!==undefined){const name=String(b.name||"").trim();if(!name)return json({error:"이름을 입력해주세요."},400);try{await renameMemberSafely(env,me.family_id,me.id,name)}catch(e){return json({error:e.message||"이름 변경에 실패했습니다."},409)}}if(b.emoji!==undefined){const emoji=String(b.emoji||"").trim();if(!emoji)return json({error:"아이콘을 입력해주세요."},400);await env.DB.prepare("UPDATE members SET emoji=? WHERE id=? AND family_id=?").bind(emoji,me.id,me.family_id).run()}if(b.password!==undefined){if(String(b.password).length<4)return json({error:"새 비밀번호는 4자 이상이어야 합니다."},400);const salt=id(),hash=await passwordHash(String(b.password),salt);if(me.role==="child"){await env.DB.prepare("UPDATE password_change_requests SET status='rejected',reviewed_at=CURRENT_TIMESTAMP WHERE member_id=? AND status='pending'").bind(me.id).run();await env.DB.prepare("INSERT INTO password_change_requests(id,family_id,member_id,password_hash,password_salt) VALUES(?,?,?,?,?)").bind(id(),me.family_id,me.id,hash,salt).run();return json({ok:true,pendingApproval:true,message:"부모님께 비밀번호 변경 승인을 요청했어요."})}await env.DB.prepare("UPDATE members SET password_hash=?,password_salt=? WHERE id=?").bind(hash,salt,me.id).run();await env.DB.prepare("DELETE FROM sessions WHERE member_id=? AND token_hash<>?").bind(me.id,await digest((req.headers.get("authorization")||"").replace(/^Bearer\s+/i,""))).run()}const updated=await env.DB.prepare("SELECT id,name,role,is_admin,emoji FROM members WHERE id=?").bind(me.id).first();return json({ok:true,member:{id:updated.id,name:updated.name,role:updated.role,isAdmin:!!updated.is_admin,emoji:updated.emoji}})}
if(url.pathname==="/api/members/account"&&req.method==="PUT"){if(!me.is_admin)return json({error:"관리자만 가족 계정을 변경할 수 있습니다."},403);const b=await body(req);if(!b.memberId)return json({error:"구성원을 선택해주세요."},400);const target=await env.DB.prepare("SELECT id FROM members WHERE id=? AND family_id=?").bind(b.memberId,me.family_id).first();if(!target)return json({error:"가족 구성원을 찾을 수 없습니다."},404);if(b.name!==undefined){const name=String(b.name||"").trim();if(!name)return json({error:"이름을 입력해주세요."},400);try{await renameMemberSafely(env,me.family_id,target.id,name)}catch(e){return json({error:e.message||"이름 변경에 실패했습니다."},409)}}if(b.emoji!==undefined){const emoji=String(b.emoji||"").trim();if(!emoji)return json({error:"아이콘을 입력해주세요."},400);await env.DB.prepare("UPDATE members SET emoji=? WHERE id=?").bind(emoji,target.id).run()}if(b.password!==undefined){if(String(b.password).length<4)return json({error:"새 비밀번호는 4자 이상이어야 합니다."},400);const salt=id(),hash=await passwordHash(String(b.password),salt);await env.DB.prepare("UPDATE members SET password_hash=?,password_salt=? WHERE id=?").bind(hash,salt,target.id).run();await env.DB.prepare("DELETE FROM sessions WHERE member_id=?").bind(target.id).run()}return json({ok:true})}
if(url.pathname==="/api/password-requests"&&req.method==="GET"){if(!me.is_admin)return json({error:"관리자만 승인 요청을 확인할 수 있습니다."},403);const rows=await env.DB.prepare(`SELECT r.id,r.member_id,m.name,m.emoji,r.created_at FROM password_change_requests r JOIN members m ON m.id=r.member_id WHERE r.family_id=? AND r.status='pending' ORDER BY r.created_at`).bind(me.family_id).all();return json({requests:rows.results||[]})}
if(url.pathname==="/api/password-requests/review"&&req.method==="POST"){if(!me.is_admin)return json({error:"관리자만 승인할 수 있습니다."},403);const b=await body(req);if(!b.requestId||!["approve","reject"].includes(b.action))return json({error:"승인 요청과 처리 방법을 확인해주세요."},400);const r=await env.DB.prepare("SELECT * FROM password_change_requests WHERE id=? AND family_id=? AND status='pending'").bind(b.requestId,me.family_id).first();if(!r)return json({error:"처리할 승인 요청이 없습니다."},404);if(b.action==="approve"){await env.DB.batch([env.DB.prepare("UPDATE members SET password_hash=?,password_salt=? WHERE id=?").bind(r.password_hash,r.password_salt,r.member_id),env.DB.prepare("DELETE FROM sessions WHERE member_id=?").bind(r.member_id),env.DB.prepare("UPDATE password_change_requests SET status='approved',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").bind(me.id,r.id)])}else await env.DB.prepare("UPDATE password_change_requests SET status='rejected',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").bind(me.id,r.id).run();return json({ok:true,approved:b.action==="approve"})}
if(url.pathname==="/api/audit/identity"&&req.method==="GET"){
 if(!me.is_admin)return json({error:"관리자만 전체 감사기록을 조회할 수 있습니다."},403);
 const members=(await env.DB.prepare("SELECT id,name FROM members WHERE family_id=?").bind(me.family_id).all()).results||[];
 const byName=new Map(members.map(m=>[m.name,m.id]));
 const keys=['allowance_audit','allowance_ledger','household_ledger','chore_daily_requests','chores'];
 const rows=(await env.DB.prepare("SELECT state_key,value_json FROM family_state WHERE family_id=? AND state_key IN ('allowance_audit','allowance_ledger','household_ledger','chore_daily_requests','chores')").bind(me.family_id).all()).results||[];
 const records=[],counts={};
 const resolve=(v)=>{if(typeof v!=='string'||!v)return null;return byName.get(v)||null};
 const collect=(module,record,subjectName,actorName)=>{
  if(!record||typeof record!=='object')return;
  const subjectId=record.childId||record.memberId||record.allowanceMemberId||record.subjectId||null;
  const actorId=record.actorId||record.approvedById||record.updatedById||null;
  const id=subjectId||resolve(subjectName),actor=actorId||resolve(actorName);
  const status=subjectId?'recorded':id?'current_name_match':'unresolved';
  records.push({module,recordId:record.id||record.transactionId||record.recurringId||null,memberId:id,memberNameAtTime:record.childNameAtTime||subjectName||null,actorId:actor,actorNameAtTime:actorName||null,identityResolution:status,action:record.action||record.type||record.state||null,date:record.at||record.createdAt||record.date||null});
  counts[status]=(counts[status]||0)+1;
 };
 for(const row of rows){
  let value;try{value=JSON.parse(row.value_json)}catch{continue}
  if(row.state_key==='allowance_audit'&&Array.isArray(value))for(const a of value)collect(row.state_key,a,a.child,a.actor);
  else if(row.state_key==='allowance_ledger'&&value&&typeof value==='object')for(const [name,items] of Object.entries(value))if(Array.isArray(items))for(const item of items)collect(row.state_key,item,name,item.approvedBy||item.requestedBy);
  else if(row.state_key==='household_ledger'&&Array.isArray(value))for(const item of value)collect(row.state_key,item,item.allowanceMemberName,item.createdBy);
  else if(row.state_key==='chore_daily_requests'&&value&&typeof value==='object')for(const item of Object.values(value))collect(row.state_key,item,item.name,item.reviewedBy||item.requestedBy);
  else if(row.state_key==='chores'&&value&&typeof value==='object')for(const [name,items] of Object.entries(value))if(Array.isArray(items))for(const item of items)collect(row.state_key,item,name,item.updatedBy);
 }
 return json({records,counts,readOnly:true,warning:"과거 이름 일치는 추정이며 영구 ID를 소급 확정하지 않습니다. 원본 거래와 잔액은 변경하지 않았습니다."});
}
if(url.pathname==="/api/allowance-audit/identity"&&req.method==="GET"){
 if(!me.is_admin)return json({error:"관리자만 감사기록을 조회할 수 있습니다."},403);
 const members=(await env.DB.prepare("SELECT id,name FROM members WHERE family_id=?").bind(me.family_id).all()).results||[];
 const state=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='allowance_audit'").bind(me.family_id).first();
 let audit=[];try{audit=JSON.parse(state?.value_json||"[]")}catch{return json({error:"감사기록 형식 오류"},409)}
 if(!Array.isArray(audit))return json({error:"감사기록 형식 오류"},409);
 const memberByName=new Map(members.map(m=>[m.name,m.id]));
 const records=audit.map(a=>{
  const childName=a.childNameAtTime||a.child||null,actorName=a.actor||null;
  const memberId=a.childId||a.memberId||memberByName.get(childName)||null;
  const actorId=a.actorId||memberByName.get(actorName)||null;
  return {...a,memberId,actorId,identityResolution:a.childId||a.memberId?'recorded':memberId?'current_name_match':'unresolved'};
 });
 return json({records,readOnly:true,warning:"기존 이름 기반 기록은 현재 이름이 일치하는 경우에만 추정 연결됩니다. 과거 개명 기록은 자동 확정하지 않습니다."});
}
if(url.pathname==="/api/recurring-audit"&&req.method==="GET"){
 if(!me.is_admin)return json({error:"관리자만 확인할 수 있습니다."},403);
 const period=url.searchParams.get("period")||new Date(Date.now()+32400000).toISOString().slice(0,7);
 if(!/^\d{4}-\d{2}$/.test(period))return json({error:"조회 월을 확인해주세요."},400);
 const configs=(await env.DB.prepare("SELECT id,kind,title,amount,billing_day,allowance_member_name FROM recurring_expenses WHERE family_id=? ORDER BY created_at").bind(me.family_id).all()).results||[];
 const members=(await env.DB.prepare("SELECT id,name FROM members WHERE family_id=?").bind(me.family_id).all()).results||[];
 const rows=(await env.DB.prepare("SELECT state_key,value_json FROM family_state WHERE family_id=? AND state_key IN ('household_ledger','allowance_ledger')").bind(me.family_id).all()).results||[];
 const map=Object.fromEntries(rows.map(r=>[r.state_key,JSON.parse(r.value_json)]));
 const ledger=map.allowance_ledger||{},household=map.household_ledger||[];
 const items=configs.map(c=>{
  const expense=household.filter(x=>x.recurringId===c.id&&(x.period||String(x.date||'').slice(0,7))===period);
  const credits=[];for(const [name,entries] of Object.entries(ledger)){if(!Array.isArray(entries))continue;for(const tx of entries)if(tx.recurringId===c.id&&(tx.period||String(tx.date||'').slice(0,7))===period)credits.push({recipient:name,transactionId:tx.id,memberId:tx.memberId||null,memberNameAtTime:tx.memberNameAtTime||null,amount:tx.amount,wallet:tx.wallet,status:tx.status,date:tx.date})}
  const current=members.find(m=>m.name===c.allowance_member_name);
  return {recurringId:c.id,title:c.title,kind:c.kind,amount:c.amount,configuredRecipient:c.allowance_member_name,memberId:current?.id||null,recipientMatched:!!current,expenseRecorded:expense.length>0,expenseCount:expense.length,credits,needsReview:c.kind==='allowance'&&(!current||credits.length!==1||credits[0].recipient!==c.allowance_member_name||Number(credits[0].amount)!==Number(c.amount))};
 });
 return json({period,items,readOnly:true});
}
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
if(url.pathname==="/api/allowance/minus-transfer/cancel"&&req.method==="POST"){
 if(!me.is_admin)return json({error:"부모 관리자만 취소할 수 있습니다."},403);
 const b=await body(req);if(typeof b.child!=="string"||typeof b.id!=="string")return json({error:"요청 형식 오류"},400);
 for(let attempt=0;attempt<5;attempt++){
  const state=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='allowance_ledger'").bind(me.family_id).first();
  if(!state)return json({error:"원장을 찾을 수 없습니다."},404);
  let ledger;try{ledger=JSON.parse(state.value_json)}catch{return json({error:"원장 데이터 오류"},500)}
  const rows=Array.isArray(ledger[b.child])?ledger[b.child]:[],tx=rows.find(x=>x.id===b.id&&x.type==="minus_transfer");
  if(!tx)return json({error:"이동 거래를 찾을 수 없습니다."},404);
  if(tx.status!=="approved"||!tx.settlementId)return json({error:"취소할 승인 거래가 아닙니다."},409);
  const linked=rows.filter(x=>x.settlementId===tx.settlementId&&x.transferRequestId===tx.id);
  if(linked.length!==2||linked.some(x=>x.status!=="approved")||!linked.some(x=>x.type==="expense"&&x.wallet==="minus")||!linked.some(x=>x.type==="income"&&x.wallet===tx.destination))return json({error:"연결 정산 내역 불일치"},409);
  const later=rows.filter(x=>x.status==="approved"&&x.wallet===tx.destination&&x.type!=="minus_transfer");
  const balance=later.reduce((n,x)=>n+(x.type==="income"?Number(x.amount||0):x.type==="expense"?-Number(x.amount||0):0),0);
  if(balance<Number(tx.net))return json({error:"받은 용돈의 잔액이 부족해 취소할 수 없습니다."},409);
  const debt=linked.find(x=>x.wallet==="minus"),repaid=rows.filter(x=>x.status==="approved"&&x.repaymentDebtId===debt.id).reduce((n,x)=>n+(x.type==="income"?Number(x.amount||0):x.type==="expense"?-Number(x.amount||0):0),0);
  if(repaid>0)return json({error:"이동으로 생성된 채무에 변제 이력이 있어 취소할 수 없습니다."},409);
  const stamp=new Date().toISOString();
  for(const x of [tx,...linked]){x.status="cancelled";x.cancelledAt=stamp;x.cancelledBy=me.name;x.cancellationReason="관리자 이동 취소"}
  const update=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='allowance_ledger' AND value_json=?").bind(JSON.stringify(ledger),me.id,me.family_id,state.value_json).run();
  if(update.meta?.changes===1)return json({ok:true,ledger});
 }
 return json({error:"동시 변경 충돌"},409);
}
if(url.pathname==="/api/allowance/minus-transfer/review"&&req.method==="POST"){
 if(!me.is_admin)return json({error:"부모 관리자만 승인할 수 있습니다."},403);
 const b=await body(req);
 if(typeof b.child!=="string"||typeof b.id!=="string"||!["approve","reject"].includes(b.action))return json({error:"요청 형식 오류"},400);
 const child=await env.DB.prepare("SELECT id FROM members WHERE family_id=? AND name=?").bind(me.family_id,b.child).first();
 if(!child)return json({error:"가족 구성원을 찾을 수 없습니다."},404);
 for(let attempt=0;attempt<5;attempt++){
  const state=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='allowance_ledger'").bind(me.family_id).first();
  if(!state)return json({error:"용돈 원장을 찾을 수 없습니다."},404);
  let ledger;try{ledger=JSON.parse(state.value_json)}catch{return json({error:"원장 데이터 오류"},500)}
  const rows=Array.isArray(ledger[b.child])?ledger[b.child]:[],tx=rows.find(x=>x.id===b.id);
  if(!tx)return json({error:"요청을 찾을 수 없습니다."},404);
  if(tx.type!=="minus_transfer")return json({error:"이동 요청이 아닙니다."},400);
  if(tx.status!=="pending")return json({error:"이미 처리된 요청입니다."},409);
  const amount=tx.amount,destination=tx.destination;
  if(!Number.isSafeInteger(amount)||amount<=0||!["free","card"].includes(destination))return json({error:"이동 금액 또는 목적지 오류"},400);
  const net=destination==="free"?Math.floor(amount/2):amount,fee=amount-net;
  if(tx.net!==net||tx.fee!==fee)return json({error:"요청 수수료 검증 실패. 요청을 다시 확인해주세요."},409);
  if(b.action==="approve"){
   const limits=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='allowance_limits'").bind(me.family_id).first();
   let parsed={};try{parsed=JSON.parse(limits?.value_json||"{}")}catch{return json({error:"마이너스 한도 데이터 오류"},500)}
   const limit=Number(parsed[b.child]||0);
   if(!Number.isSafeInteger(limit)||limit<0)return json({error:"마이너스 한도 오류"},409);
   const approved=rows.filter(x=>x.status==="approved"||(!x.status&&["income","expense"].includes(x.type)));
   const used=approved.filter(x=>x.wallet==="minus").reduce((n,x)=>n+(x.type==="expense"?Number(x.amount||0):x.type==="income"?-Number(x.amount||0):0),0);
   if(amount>Math.max(0,limit-Math.max(0,used)))return json({error:"마이너스 가용 한도가 부족합니다."},409);
   const stamp=new Date().toISOString(),settlementId=id(),base={date:tx.date,status:"approved",requestedBy:tx.requestedBy,approvedBy:me.name,approvedAt:stamp,createdAt:stamp,settlementId,transferRequestId:tx.id};
   rows.push({...base,id:settlementId+":debit",type:"expense",wallet:"minus",amount,debtOrigin:destination,title:"마이너스 이동 출금"});
   rows.push({...base,id:settlementId+":credit",type:"income",wallet:destination,amount:net,title:"마이너스 이동 입금"});
   tx.status="approved";tx.approvedBy=me.name;tx.approvedAt=stamp;tx.settlementId=settlementId;
  }else{tx.status="rejected";tx.rejectedBy=me.name;tx.rejectedAt=new Date().toISOString()}
  ledger[b.child]=rows;
  const updated=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='allowance_ledger' AND value_json=?").bind(JSON.stringify(ledger),me.id,me.family_id,state.value_json).run();
  if(updated.meta?.changes===1)return json({ok:true,ledger});
 }
 return json({error:"동시 변경 충돌. 다시 시도해주세요."},409);
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
   for(const x of approved.filter(x=>x.wallet==="minus"&&x.repaymentDebtId)){repaid.set(x.repaymentDebtId,(repaid.get(x.repaymentDebtId)||0)+(x.type==="income"?Number(x.amount||0):x.type==="expense"?-Number(x.amount||0):0))}
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
if(url.pathname==="/api/chores/late-completion"&&req.method==="POST"){
 if(!me.is_admin)return json({error:"관리자 전용"},403);
 const b=await body(req),reason=String(b.reason||"").trim(),memo=String(b.memo||"").trim();
 if(typeof b.name!=="string"||typeof b.id!=="string"||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(b.date||"")||b.date>=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())||reason.length<2||reason.length>500||memo.length>500)return json({error:"지난 날짜 및 인정 사유를 확인해주세요."},400);
 const member=await env.DB.prepare("SELECT id FROM members WHERE family_id=? AND name=? AND is_admin=0").bind(me.family_id,b.name).first();if(!member)return json({error:"자녀 계정이 아닙니다."},403);
 const state=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='chores'").bind(me.family_id).first();if(!state)return json({error:"할 일 데이터 없음"},404);
 let chores;try{chores=JSON.parse(state.value_json)}catch{return json({error:"할 일 데이터 오류"},500)}
 const rows=chores[b.name];if(!Array.isArray(rows))return json({error:"할 일 없음"},404);
 const item=rows.find(x=>x.id===b.id);if(!item||item.active===false||item.startDate&&b.date<item.startDate||item.endDate&&b.date>item.endDate||item.repeat==="none"&&item.date!==b.date)return json({error:"해당 날짜의 할 일이 아닙니다."},409);
 const weekday=new Date(b.date+"T12:00:00Z").getUTCDay();if(item.repeat==="weekday"&&(weekday===0||weekday===6)||item.repeat==="weekend"&&weekday!==0&&weekday!==6||item.repeat==="days"&&(!Array.isArray(item.days)||!item.days.includes(weekday)))return json({error:"해당 날짜에 배정되지 않은 할 일입니다."},409);
 if(item.memoEnabled&&!memo)return json({error:"완료 메모가 필수입니다."},400);
 const prev=item.dayRecords?.[b.date];if(prev&&["done","exempt_requested","exempt_approved"].includes(prev.state))return json({error:"이미 처리된 할 일입니다."},409);
 const at=new Date().toISOString();item.dayRecords={...(item.dayRecords||{}),[b.date]:{state:"done",memo,lateApproved:true,lateReason:reason,reviewedBy:me.name,reviewedAt:at,submittedBy:me.name,submittedAt:at,previousState:prev?.state||"not_done"}};
 const result=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='chores' AND value_json=?").bind(JSON.stringify(chores),me.id,me.family_id,state.value_json).run();if(result.meta?.changes!==1)return json({error:"동시 수정 충돌"},409);
 return json({ok:true,note:"완료 인정 기록만 저장되었습니다. 보상금은 자동 지급되지 않습니다."});
}
if(url.pathname==="/api/chores/history/correct"&&req.method==="POST"){
 if(!me.is_admin)return json({error:"관리자 전용"},403);
 const b=await body(req),reason=String(b.reason||"").trim(),date=String(b.date||"");
 if(typeof b.name!=="string"||typeof b.id!=="string"||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)||date>=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())||reason.length<2||reason.length>500||b.state!=="exempt_approved")return json({error:"수정 입력 오류"},400);
 const member=await env.DB.prepare("SELECT id FROM members WHERE family_id=? AND name=? AND is_admin=0").bind(me.family_id,b.name).first();
 if(!member)return json({error:"자녀 계정이 아닙니다."},403);
 const key=b.name+"|"+date;
 const saved=await Promise.all(["chores","chore_daily_requests","allowance_ledger"].map(k=>env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key=?").bind(me.family_id,k).first()));
 if(saved.some(x=>!x))return json({error:"기록 없음"},409);
 const [chores,requests,ledger]=saved.map(x=>JSON.parse(x.value_json));
 const item=chores[b.name]?.find(x=>x.id===b.id),previous=item?.dayRecords?.[date];
 if(!item||previous?.state!=="done")return json({error:"완료 처리된 할 일만 면제로 정정할 수 있습니다."},409);
 if(requests[key]&&requests[key].status!=="pending")return json({error:"이미 승인·거절된 보상요청이 있습니다. 지급 정정 절차를 이용하세요."},409);
 const rows=ledger[b.name]||[],paymentKey="daily_chore|"+key;
 if(rows.some(x=>x.id===paymentKey||x.di?.dailyKey===paymentKey||x.status==="approved"&&x.type==="income"&&x.wallet==="free"&&x.date===date&&/할.?일|보상|수동/.test(String(x.title||""))))return json({error:"지급 내역이 있어 정정을 차단했습니다."},409);
 const at=new Date().toISOString();
 item.dayRecords[date]={...previous,state:"exempt_approved",lateExempt:true,reason,reviewedBy:me.name,reviewedAt:at,correction:{from:"done",to:"exempt_approved",reason,actor:me.name,at}};
 const reqRow=requests[key];
 if(reqRow){const target=reqRow.items?.find(x=>x.id===b.id);if(target){target.state="exempt_approved";target.reward=0;target.reason=reason}reqRow.amount=(reqRow.items||[]).reduce((n,x)=>n+Number(x.reward||0),0);reqRow.corrections=[...(reqRow.corrections||[]),{id:b.id,from:"done",to:"exempt_approved",reason,actor:me.name,at}]}
 const nextChores=JSON.stringify(chores),nextRequests=JSON.stringify(requests);
 const ops=[env.DB.prepare("UPDATE family_state SET value_json=? WHERE family_id=? AND state_key='chores' AND value_json=? AND EXISTS(SELECT 1 FROM family_state WHERE family_id=? AND state_key='chore_daily_requests' AND value_json=?) AND EXISTS(SELECT 1 FROM family_state WHERE family_id=? AND state_key='allowance_ledger' AND value_json=?)").bind(nextChores,me.family_id,saved[0].value_json,me.family_id,saved[1].value_json,me.family_id,saved[2].value_json)];
 if(reqRow)ops.push(env.DB.prepare("UPDATE family_state SET value_json=? WHERE family_id=? AND state_key='chore_daily_requests' AND value_json=? AND EXISTS(SELECT 1 FROM family_state WHERE family_id=? AND state_key='chores' AND value_json=?)").bind(nextRequests,me.family_id,saved[1].value_json,me.family_id,nextChores));
 const guarded=ops.flatMap(op=>[op,env.DB.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE abs(-9223372036854775808) END")]);
 try{await env.DB.batch(guarded)}catch{return json({error:"동시 수정 충돌"},409)}
 return json({ok:true,amount:reqRow?.amount??null});
}
if(url.pathname==="/api/chores/late-exemption"&&req.method==="POST"){
 if(!me.is_admin)return json({error:"관리자 전용"},403);
 const b=await body(req),reason=String(b.reason||"").trim();
 if(typeof b.name!=="string"||typeof b.id!=="string"||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(b.date||"")||b.date>=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())||reason.length<2||reason.length>500)return json({error:"날짜 및 인정 사유를 확인해주세요."},400);
 const member=await env.DB.prepare("SELECT id FROM members WHERE family_id=? AND name=? AND is_admin=0").bind(me.family_id,b.name).first();
 if(!member)return json({error:"자녀 계정이 아닙니다."},403);
 for(let retry=0;retry<3;retry++){
  const row=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='chores'").bind(me.family_id).first();
  if(!row)return json({error:"할 일 데이터 없음"},404);
  let chores;try{chores=JSON.parse(row.value_json)}catch{return json({error:"할 일 데이터 오류"},500)}
  const item=chores[b.name]?.find(x=>x.id===b.id);
  if(!item||item.active===false||item.startDate&&b.date<item.startDate||item.endDate&&b.date>item.endDate||item.repeat==="none"&&item.date!==b.date)return json({error:"해당 날짜의 할 일이 아닙니다."},409);
  const weekday=new Date(b.date+"T12:00:00Z").getUTCDay();
  if(item.repeat==="weekday"&&(weekday===0||weekday===6)||item.repeat==="weekend"&&weekday!==0&&weekday!==6||item.repeat==="days"&&(!Array.isArray(item.days)||!item.days.includes(weekday)))return json({error:"해당 날짜에 배정되지 않은 할 일입니다."},409);
  const previous=item.dayRecords?.[b.date];
  if(previous&&["done","exempt_requested","exempt_approved"].includes(previous.state))return json({error:"이미 처리된 할 일입니다."},409);
  const at=new Date().toISOString();
  item.dayRecords={...(item.dayRecords||{}),[b.date]:{state:"exempt_approved",lateApproved:true,lateExempt:true,lateReason:reason,reason,reviewedBy:me.name,reviewedAt:at,previousState:previous?.state||"not_done"}};
  const result=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='chores' AND value_json=?").bind(JSON.stringify(chores),me.id,me.family_id,row.value_json).run();
  if(result.meta?.changes===1)return json({ok:true,note:"미수행 인정: 달성률 포함, 보상금 지급 없음"});
 }
 return json({error:"동시 변경 충돌. 다시 시도해주세요."},409);
}
if(url.pathname==="/api/chores/exemption/review"&&req.method==="POST"){
 if(!me.is_admin)return json({error:"관리자 전용"},403);
 const b=await body(req);if(typeof b.name!=="string"||typeof b.id!=="string"||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(b.date||"")||!["approve","reject"].includes(b.decision))return json({error:"입력 오류"},400);
 const state=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='chores'").bind(me.family_id).first();if(!state)return json({error:"할 일 데이터 없음"},409);
 const chores=JSON.parse(state.value_json),rows=chores[b.name];if(!Array.isArray(rows))return json({error:"할 일 없음"},404);
 const item=rows.find(x=>x.id===b.id);if(!item||item.dayRecords?.[b.date]?.state!=="exempt_requested")return json({error:"면제 요청 없음"},409);const member=await env.DB.prepare("SELECT id FROM members WHERE family_id=? AND name=? AND is_admin=0").bind(me.family_id,b.name).first();if(!member)return json({error:"자녀 계정이 아닙니다."},403);
 item.dayRecords[b.date]={...item.dayRecords[b.date],state:b.decision==="approve"?"exempt_approved":"exempt_rejected",reviewedBy:me.name,reviewedAt:new Date().toISOString()};
 const result=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='chores' AND value_json=?").bind(JSON.stringify(chores),me.id,me.family_id,state.value_json).run();if(result.meta?.changes!==1)return json({error:"동시 수정 충돌"},409);
 return json({ok:true,state:item.dayRecords[b.date].state});
}
if(url.pathname==="/api/chores/legacy/reverse"&&req.method==="POST"){
 if(!me.is_admin)return json({error:"관리자 전용"},403);
 const b=await body(req),reason=String(b.reason||"").trim();if(typeof b.name!=="string"||typeof b.id!=="string"||reason.length<2||reason.length>500)return json({error:"입력 오류"},400);
 const state=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='allowance_ledger'").bind(me.family_id).first();if(!state)return json({error:"원장 없음"},404);
 let ledger;try{ledger=JSON.parse(state.value_json)}catch{return json({error:"원장 오류"},500)}
 const rows=ledger[b.name];if(!Array.isArray(rows))return json({error:"거래 없음"},404);
 const original=rows.find(x=>x.id===b.id);if(!original||original.status!=="approved"||original.type!=="income"||original.wallet!=="free"||original.di?.action==="daily_chore_reward"||original.di?.action==="daily_chore_reward_reversal"||!/(할\s*일|chore)/i.test(String(original.title||"")+" "+String(original.di?.action||"")))return json({error:"과거 할 일 보상으로 확인되지 않은 거래입니다."},409);
 const amount=Number(original.amount);if(!Number.isSafeInteger(amount)||amount<=0)return json({error:"지급 금액 오류"},409);
 const reversalId="legacy_chore_reversal|"+b.id;if(rows.some(x=>x.id===reversalId||x.di?.reverses===b.id))return json({error:"이미 취소한 보상입니다."},409);
 const at=new Date().toISOString();rows.push({id:reversalId,date:at.slice(0,10),type:"expense",wallet:"free",amount,title:String(original.date||"")+" 과거 할 일 오지급 정정",status:"approved",requestedBy:me.name,approvedBy:me.name,createdAt:at,di:{action:"legacy_chore_reward_reversal",reverses:b.id,reason,originalAmount:amount}});
 const result=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='allowance_ledger' AND value_json=?").bind(JSON.stringify(ledger),me.id,me.family_id,state.value_json).run();if(result.meta?.changes!==1)return json({error:"동시 수정 충돌"},409);
 return json({ok:true,amount,reversalId});
}
if(url.pathname==="/api/chores/daily/reverse"&&req.method==="POST"){
 if(!me.is_admin)return json({error:"관리자 전용"},403);
 const b=await body(req),key=String(b.name||"")+"|"+String(b.date||""),reason=String(b.reason||"").trim();
 if(!b.name||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(b.date||"")||reason.length<2||reason.length>500)return json({error:"취소 사유(2~500자)를 입력하세요."},400);
 const saved=await Promise.all(["chore_daily_requests","allowance_ledger"].map(k=>env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key=?").bind(me.family_id,k).first()));
 if(saved.some(x=>!x))return json({error:"데이터 없음"},409);
 const requests=JSON.parse(saved[0].value_json),ledger=JSON.parse(saved[1].value_json),request=requests[key];
 if(!request||request.name!==b.name||request.date!==b.date||request.status!=="approved")return json({error:"취소 가능한 승인 건이 아닙니다."},409);
 const rows=ledger[b.name];if(!Array.isArray(rows))return json({error:"원본 지급 내역 없음"},409);
 const paymentKey="daily_chore|"+key,original=rows.find(x=>x.di?.action==="daily_chore_reward"&&x.di?.dailyKey===paymentKey&&x.status==="approved");
 if(!original||!Number.isSafeInteger(Number(original.amount))||Number(original.amount)<=0||Number(original.amount)!==Number(request.amount))return json({error:"원본 보상금 검증 실패"},409);
 const reversalKey="daily_chore_reversal|"+key;
 if(rows.some(x=>x.id===reversalKey||x.di?.reverses===paymentKey))return json({error:"이미 승인 취소 처리됨"},409);
 const at=new Date().toISOString();rows.push({id:reversalKey,date:at.slice(0,10),type:"expense",wallet:"free",amount:Number(original.amount),title:b.date+" 할 일 보상 승인 취소",status:"approved",requestedBy:me.name,approvedBy:me.name,createdAt:at,di:{action:"daily_chore_reward_reversal",reverses:paymentKey,dailyKey:reversalKey,reason}});
 requests[key]={...request,status:"reversed",reversedBy:me.name,reversedAt:at,reversalReason:reason,reversalId:reversalKey};
 const ops=[env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='chore_daily_requests' AND value_json=?").bind(JSON.stringify(requests),me.id,me.family_id,saved[0].value_json),env.DB.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE abs(-9223372036854775808) END"),env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='allowance_ledger' AND value_json=?").bind(JSON.stringify(ledger),me.id,me.family_id,saved[1].value_json),env.DB.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE abs(-9223372036854775808) END")];
 try{await env.DB.batch(ops)}catch{return json({error:"동시 수정 충돌: 변경 없이 종료했습니다."},409)}
 return json({ok:true,status:"reversed",amount:Number(original.amount),reversalId:reversalKey});
}
if(url.pathname==="/api/chores/daily/prepare-past"&&req.method==="POST"){
 if(!me.is_admin)return json({error:"관리자 전용"},403);
 const b=await body(req),name=String(b.name||""),date=String(b.date||""),key=name+"|"+date;
 if(!name||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)||date>=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()))return json({error:"지난 날짜만 처리할 수 있습니다."},400);
 const member=await env.DB.prepare("SELECT id FROM members WHERE family_id=? AND name=? AND is_admin=0").bind(me.family_id,name).first();
 if(!member)return json({error:"자녀 계정이 아닙니다."},403);
 const keys=["chore_daily_requests","chores","allowance_ledger"];
 const saved=await Promise.all(keys.map(k=>env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key=?").bind(me.family_id,k).first()));
 if(saved.some(x=>!x))return json({error:"보상 원장 또는 할 일 데이터가 없습니다."},409);
 let requests,chores,ledger;try{[requests,chores,ledger]=saved.map(x=>JSON.parse(x.value_json))}catch{return json({error:"데이터 형식 오류"},500)}
 if(requests[key])return json({error:"기존 요청 또는 승인 기록이 있습니다. 중복 요청은 생성하지 않습니다."},409);
 const paymentKey="daily_chore|"+key,rows=Array.isArray(ledger[name])?ledger[name]:[];
 if(rows.some(x=>x.id===paymentKey||x.di?.dailyKey===paymentKey||x.di?.reverses===paymentKey))return json({error:"기존 지급 또는 취소 기록이 있습니다."},409);
 if(rows.some(x=>x.status==="approved"&&x.type==="income"&&x.wallet==="free"&&x.date===date&&/할.?일|보상|수동/.test(String(x.title||""))))return json({error:"같은 날짜에 보상 지급 후보가 있습니다. 거래내역을 먼저 확인하세요."},409);
 const day=new Date(date+"T12:00:00Z").getUTCDay();
 const items=(Array.isArray(chores[name])?chores[name]:[]).filter(x=>x.active!==false&&(!x.startDate||x.startDate<=date)&&(!x.endDate||x.endDate>=date)&&(x.repeat==="daily"||x.repeat==="weekday"&&day>=1&&day<=5||x.repeat==="weekend"&&(day===0||day===6)||x.repeat==="days"&&Array.isArray(x.days)&&x.days.includes(day)||x.repeat==="none"&&x.date===date||!x.repeat&&x.date===date));
 if(!items.length||!items.every(x=>["done","exempt_approved"].includes(x.dayRecords?.[date]?.state)))return json({error:"모든 할 일이 완료 또는 면제 인정 상태여야 합니다."},409);
 const amount=items.reduce((n,x)=>n+(x.dayRecords?.[date]?.state==="exempt_approved"?0:(Number.isSafeInteger(Number(x.reward))&&Number(x.reward)>0?Number(x.reward):100)),0);
 if(!Number.isSafeInteger(amount)||amount<=0)return json({error:"지급할 보상금이 없습니다."},409);
 const at=new Date().toISOString();
 requests[key]={name,date,status:"pending",amount,items:items.map(x=>({id:x.id,title:x.title,reward:x.dayRecords?.[date]?.state==="exempt_approved"?0:(Number(x.reward)>0?Number(x.reward):100),state:x.dayRecords?.[date]?.state})),requestedAt:at,requestedBy:me.name,source:"past_admin_review",note:"부모가 과거 할 일을 인정한 후 보상 승인 요청을 별도 생성함"};
 const result=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='chore_daily_requests' AND value_json=? AND EXISTS(SELECT 1 FROM family_state WHERE family_id=? AND state_key='chores' AND value_json=?) AND EXISTS(SELECT 1 FROM family_state WHERE family_id=? AND state_key='allowance_ledger' AND value_json=?)").bind(JSON.stringify(requests),me.id,me.family_id,saved[0].value_json,me.family_id,saved[1].value_json,me.family_id,saved[2].value_json).run();
 if(result.meta?.changes!==1)return json({error:"동시 변경이 감지되었습니다. 다시 확인해주세요."},409);
 return json({ok:true,status:"pending",amount,note:"승인 요청만 생성했습니다. 용돈은 지급되지 않았습니다."});
}
if(url.pathname==="/api/chores/daily/review"&&req.method==="POST"){
 if(!me.is_admin)return json({error:"관리자 전용"},403);
 const b=await body(req),key=b.name+"|"+b.date;
 if(!b.name||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(b.date||"")||!["approve","reject"].includes(b.decision))return json({error:"입력 오류"},400);
 const keys=["chore_daily_requests","chores","allowance_ledger"];
 const saved=await Promise.all(keys.map(k=>env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key=?").bind(me.family_id,k).first()));
 if(saved.some(x=>!x))return json({error:"데이터 없음"},409);
 const [requests,chores,ledger]=saved.map(x=>JSON.parse(x.value_json)),request=requests[key];
 if(!request||request.status!=="pending"||request.name!==b.name||request.date!==b.date)return json({error:"대기 요청 없음"},409);const member=await env.DB.prepare("SELECT id FROM members WHERE family_id=? AND name=? AND is_admin=0").bind(me.family_id,b.name).first();if(!member)return json({error:"자녀 계정이 아닙니다."},403);
 const date=b.date,day=new Date(date+"T12:00:00Z").getUTCDay();
 const items=(Array.isArray(chores[b.name])?chores[b.name]:[]).filter(x=>x.active!==false&&(!x.startDate||x.startDate<=date)&&(!x.endDate||x.endDate>=date)&&(x.repeat==="daily"||x.repeat==="weekday"&&day>=1&&day<=5||x.repeat==="weekend"&&(day===0||day===6)||x.repeat==="days"&&Array.isArray(x.days)&&x.days.includes(day)||x.repeat==="none"&&x.date===date||!x.repeat&&x.date===date));
 const amount=items.reduce((n,x)=>n+(x.dayRecords?.[date]?.state==="exempt_approved"?0:(Number.isSafeInteger(Number(x.reward))&&Number(x.reward)>0?Number(x.reward):100)),0);
 if(b.decision==="approve"&&(!items.length||items.length!==request.items?.length||amount!==request.amount||!items.every(x=>["done","exempt_approved"].includes(x.dayRecords?.[date]?.state))))return json({error:"전체 완료 조건 미충족"},409);
 const adjusted=b.decision==="approve"&&b.adjustedAmount!==undefined;
 const payout=adjusted?Number(b.adjustedAmount):amount,reason=String(b.adjustReason||"").trim();
 if(adjusted&&(!Number.isSafeInteger(payout)||payout<0||payout>amount||(payout!==amount&&(reason.length<2||reason.length>500))))return json({error:"수정 금액 또는 사유가 올바르지 않습니다."},400);
 const paymentKey="daily_chore|"+key,rows=ledger[b.name]||[];
 if(rows.some(x=>x.di?.dailyKey===paymentKey))return json({error:"이미 지급됨"},409);
 if(b.decision==="approve"&&rows.some(x=>x.status==="approved"&&x.type==="income"&&x.wallet==="free"&&x.date===date&&/할.?일|보상|수동/.test(String(x.title||""))))return json({error:"같은 날짜의 수동 보상 지급 후보가 있습니다. 중복 지급 방지를 위해 승인을 차단했습니다."},409);
 if(b.decision==="approve"&&payout>0){rows.push({id:paymentKey,date,type:"income",wallet:"free",amount:payout,title:date+" 하루 할 일 전체 달성 보상",status:"approved",approvedBy:me.name,di:{action:"daily_chore_reward",dailyKey:paymentKey,originalAmount:amount,adjustReason:payout!==amount?reason:null}});ledger[b.name]=rows}
 requests[key]={...request,status:b.decision==="approve"?"approved":"rejected",reviewedBy:me.name,reviewedAt:new Date().toISOString(),originalAmount:amount,amount:b.decision==="approve"?payout:request.amount,adjustment:payout!==amount&&b.decision==="approve"?{from:amount,to:payout,reason,actor:me.name,at:new Date().toISOString()}:null};
 const nextRequests=JSON.stringify(requests),ops=[env.DB.prepare("UPDATE family_state SET value_json=? WHERE family_id=? AND state_key='chore_daily_requests' AND value_json=? AND EXISTS(SELECT 1 FROM family_state WHERE family_id=? AND state_key='allowance_ledger' AND value_json=?) AND EXISTS(SELECT 1 FROM family_state WHERE family_id=? AND state_key='chores' AND value_json=?)").bind(nextRequests,me.family_id,saved[0].value_json,me.family_id,saved[2].value_json,me.family_id,saved[1].value_json)];
 if(b.decision==="approve"&&payout>0)ops.push(env.DB.prepare("UPDATE family_state SET value_json=? WHERE family_id=? AND state_key='allowance_ledger' AND value_json=? AND EXISTS(SELECT 1 FROM family_state WHERE family_id=? AND state_key='chore_daily_requests' AND value_json=?)").bind(JSON.stringify(ledger),me.family_id,saved[2].value_json,me.family_id,nextRequests));
 const guarded=ops.flatMap(op=>[op,env.DB.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE abs(-9223372036854775808) END")]);try{await env.DB.batch(guarded)}catch{return json({error:"동시 변경 충돌: 지급 없이 종료했습니다."},409)}
 return json({ok:true,status:requests[key].status});
}
if(url.pathname==="/api/memories/interact"&&req.method==="POST"){
 const b=await body(req),memoryId=String(b.memoryId||""),photoIndex=b.photoIndex,action=String(b.action||"");
 if(!memoryId||!Number.isInteger(photoIndex)||photoIndex<0||!["comment","react","editComment","deleteComment"].includes(action))return json({error:"요청 형식 오류"},400);
 for(let retry=0;retry<4;retry++){
  const row=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='memories'").bind(me.family_id).first();
  if(!row)return json({error:"사진첩 없음"},404);
  let memories;try{memories=JSON.parse(row.value_json)}catch{return json({error:"사진첩 데이터 오류"},500)}
  const memory=memories.find(x=>x.id===memoryId);
  const photos=Array.isArray(memory?.photos)?memory.photos:(memory?.photoData?[memory.photoData]:[]);
  if(!memory||photoIndex>=photos.length)return json({error:"사진을 찾을 수 없습니다."},404);
  if(!memory.interactions||typeof memory.interactions!=="object")memory.interactions={};
  const key=String(photoIndex),item=memory.interactions[key]||{comments:[],reactions:{}};
  if(!Array.isArray(item.comments))item.comments=[];
  if(!item.reactions||typeof item.reactions!=="object")item.reactions={};
  if(!Array.isArray(item.audit))item.audit=[];
  if(action==="comment"){
   const value=String(b.text||"").trim();
   if(!value||value.length>500)return json({error:"댓글은 1~500자입니다."},400);
   const parentId=b.parentId?String(b.parentId):null;
   if(parentId&&!item.comments.some(c=>c.id===parentId))return json({error:"답글 대상 댓글을 찾을 수 없습니다."},404);
   item.comments.push({id:crypto.randomUUID(),parentId,authorId:me.id,author:me.name,text:value,createdAt:new Date().toISOString()});
  }else if(action==="editComment"){
   const comment=item.comments.find(x=>x.id===b.commentId);
   if(!comment)return json({error:"댓글 없음"},404);
   if(!me.is_admin&&comment.authorId!==me.id)return json({error:"권한 없음"},403);
   const value=String(b.text||"").trim();
   if(!value||value.length>500)return json({error:"댓글은 1~500자입니다."},400);
   if(value===comment.text)return json({ok:true,memories});
   item.audit.push({action:"edit",commentId:comment.id,actorId:me.id,actor:me.name,previousText:comment.text,newText:value,at:new Date().toISOString()});
   comment.text=value;comment.editedAt=new Date().toISOString();
  }else if(action==="react"){
   const emoji=String(b.emoji||"");
   if(!["❤️","😂","😍","👏","🥹"].includes(emoji))return json({error:"지원하지 않는 반응"},400);
   if(item.reactions[me.id]===emoji)delete item.reactions[me.id];else item.reactions[me.id]=emoji;
  }else{
   const index=item.comments.findIndex(x=>x.id===b.commentId);
   if(index<0)return json({error:"댓글 없음"},404);
   if(!me.is_admin&&item.comments[index].authorId!==me.id)return json({error:"권한 없음"},403);
   const removed=item.comments[index];
   item.audit.push({action:"delete",commentId:removed.id,actorId:me.id,actor:me.name,previousText:removed.text,at:new Date().toISOString()});
   item.comments.splice(index,1);
   for(const reply of item.comments)if(reply.parentId===removed.id)reply.parentId=null;
  }
  memory.interactions[key]=item;
  const updated=JSON.stringify(memories);
  const result=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=datetime('now') WHERE family_id=? AND state_key='memories' AND value_json=?").bind(updated,me.family_id,row.value_json).run();
  if(result.meta.changes===1)return json({ok:true,memories});
 }
 return json({error:"동시 수정 충돌. 다시 시도해주세요."},409);
}
if(url.pathname==="/api/memories/delete"&&req.method==="POST"){
 if(!me.is_admin)return json({error:"사진 삭제는 부모 관리자만 가능합니다."},403);
 const b=await body(req),id=String(b.id||""),photoIndex=b.photoIndex;
 if(!id||id.length>120||photoIndex!==undefined&&(!Number.isInteger(photoIndex)||photoIndex<0))return json({error:"삭제할 사진을 확인해주세요."},400);
 for(let attempt=0;attempt<3;attempt++){
 const row=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='memories'").bind(me.family_id).first();
 if(!row)return json({error:"사진첩이 없습니다."},404);
 let entries;try{entries=JSON.parse(row.value_json)}catch{return json({error:"사진첩 데이터 오류"},500)}
 if(!Array.isArray(entries))return json({error:"사진첩 데이터 오류"},500);
 const index=entries.findIndex(x=>x.id===id);if(index<0)return json({error:"기록을 찾을 수 없습니다."},404);
 if(photoIndex===undefined){entries.splice(index,1)}else{
 const entry=entries[index],photos=Array.isArray(entry.photos)?entry.photos.slice():(entry.photoData?[entry.photoData]:[]);
 if(photoIndex>=photos.length)return json({error:"사진을 찾을 수 없습니다."},404);
 photos.splice(photoIndex,1);entry.photos=photos;entry.photoData=photos[0]||"";entry.photoName=photos.length?entry.photoName:"";
 }
 const updated=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='memories' AND value_json=?").bind(JSON.stringify(entries),me.id,me.family_id,row.value_json).run();
 if(updated.meta?.changes===1)return json({ok:true,memories:entries});
 }
 return json({error:"다른 가족이 수정했습니다. 새로고침 후 다시 시도해주세요."},409);
}
if(url.pathname==="/api/state"&&req.method==="GET"){const rows=await env.DB.prepare("SELECT state_key,value_json,updated_at FROM family_state WHERE family_id=?").bind(me.family_id).all();const state={};for(const r of rows.results||[]){try{state[r.state_key]=JSON.parse(r.value_json)}catch{}}return json({state})}
if(url.pathname==="/api/state"&&req.method==="PUT"){const b=await body(req),allowed=new Set(["daily_schedules","family_schedules","monthly_memos","event","memories","member_albums","profile_photos","allowance_ledger","allowance_audit","allowance_limits","allowance_notices","savings_goals","chore_templates","chores","chore_daily_requests","household_ledger"]);if(!allowed.has(b.key))return json({error:"지원하지 않는 데이터 종류입니다."},400);if(['allowance_limits','allowance_audit'].includes(b.key)&&!me.is_admin)return json({error:'부모 관리자만 변경할 수 있습니다.'},403);if(b.key==="memories"&&!me.is_admin){
 const prior=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='memories'").bind(me.family_id).first();
 let old=[],next=[];try{old=JSON.parse(prior?.value_json||"[]");next=b.value}catch{return json({error:"사진첩 데이터 오류"},400)}
 if(!Array.isArray(old)||!Array.isArray(next))return json({error:"사진첩 데이터 오류"},400);
 for(let j=0;j<old.length;j++){const before=old[j],after=before.id?next.find(x=>x.id===before.id):next[j];if(!after)return json({error:"사진 삭제는 부모 관리자만 가능합니다."},403);
 const beforePhotos=Array.isArray(before.photos)?before.photos:(before.photoData?[before.photoData]:[]);
 const afterPhotos=Array.isArray(after.photos)?after.photos:(after.photoData?[after.photoData]:[]);
 if(beforePhotos.some(p=>!afterPhotos.includes(p)))return json({error:"사진 삭제는 부모 관리자만 가능합니다."},403);
 }
 }
if(b.key==="chores"&&!me.is_admin){const old=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='chores'").bind(me.family_id).first();let before={},next={};try{before=JSON.parse(old?.value_json||"{}");next=b.value||{}}catch{return json({error:"할 일 데이터 오류"},400)}for(const [name,rows] of Object.entries(next)){if(name!==me.name&&JSON.stringify(rows)!==JSON.stringify(before[name]))return json({error:"다른 가족 할 일 수정 불가"},403);if(name===me.name){const prior=before[name]||[];if(!Array.isArray(rows)||rows.length!==prior.length)return json({error:"할 일 설정은 관리자 전용"},403);if(prior.some(x=>!rows.some(y=>y.id===x.id)))return json({error:"설정 변경 불가"},403);for(const item of rows){const oldItem=prior.find(x=>x.id===item.id);if(!oldItem)return json({error:"할 일 설정은 관리자 전용"},403);for(const [date,record] of Object.entries(item.dayRecords||{})){const previous=oldItem.dayRecords?.[date];if(previous&&JSON.stringify(previous)!==JSON.stringify(record))return json({error:"제출한 할 일 기록은 변경할 수 없습니다."},403);if(!previous&&(!["done","exempt_requested"].includes(record.state)||record.submittedBy!==me.name))return json({error:"본인 완료 또는 면제 요청만 가능"},403)}const stripped={...item};delete stripped.dayRecords;const original={...oldItem};delete original.dayRecords;if(JSON.stringify(stripped)!==JSON.stringify(original))return json({error:"할 일 설정은 관리자 전용"},403)}}}}
if(b.key==="chore_daily_requests"&&!me.is_admin){const prior=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='chore_daily_requests'").bind(me.family_id).first();let before={},next={};try{before=JSON.parse(prior?.value_json||"{}");next=b.value||{}}catch{return json({error:"요청 데이터 오류"},400)}if(!next||typeof next!=="object"||Array.isArray(next))return json({error:"요청 데이터 오류"},400);for(const [key,old] of Object.entries(before)){if(JSON.stringify(next[key])!==JSON.stringify(old))return json({error:"기존 일일 승인요청은 변경할 수 없습니다."},403)}for(const [key,entry] of Object.entries(next)){if(!(key in before)&&(entry?.name!==me.name||entry?.status!=="pending"||key!==me.name+"|"+entry.date))return json({error:"본인 할 일 완료 요청만 제출할 수 있습니다."},403)}}if(b.key==="allowance_notices"&&!me.is_admin)return json({error:"공지사항은 부모 관리자만 수정할 수 있습니다."},403);if(b.key==="allowance_ledger"){if(typeof b.expectedJson!=="string")return json({error:"용돈 데이터의 동기화 기준이 없습니다. 새로고침 후 다시 시도해주세요."},409);const current=await env.DB.prepare("SELECT value_json FROM family_state WHERE family_id=? AND state_key='allowance_ledger'").bind(me.family_id).first();const oldJson=current?.value_json??"null";if(oldJson!==b.expectedJson)return json({error:"다른 기기에서 용돈 내역이 변경되었습니다. 최신 내역을 불러온 후 다시 시도해주세요."},409);let oldLedger,newLedger;try{oldLedger=JSON.parse(oldJson)||{};newLedger=b.value||{}}catch{return json({error:"원장 형식 오류"},400)}if(!newLedger||typeof newLedger!=="object"||Array.isArray(newLedger))return json({error:"원장 형식 오류"},400);for(const [child,rows] of Object.entries(newLedger)){if(!Array.isArray(rows))continue;const old=Array.isArray(oldLedger[child])?oldLedger[child]:[];if(rows.some(x=>["daily_chore_reward","chore_reward"].includes(x.di?.action)&&!old.some(y=>y.id===x.id)))return json({error:"일일 할 일 보상은 부모 승인 API에서만 지급할 수 있습니다."},409);if(rows.some(x=>(x.childTradeId||x.type==='split_payment'||x.splitPaymentId)&&!old.some(y=>y.id===x.id)))return json({error:'통합결제 생성은 전용 API로만 가능합니다.'},409)}for(const [child,rows] of Object.entries(oldLedger)){if(!Array.isArray(rows))continue;const next=Array.isArray(newLedger[child])?newLedger[child]:[];for(const tx of rows.filter(x=>x.type==='split_payment'||x.splitPaymentId)){const found=next.find(x=>x.id===tx.id);if(!found||JSON.stringify(found)!==JSON.stringify(tx))return json({error:'통합결제 변경은 전용 API로만 가능합니다.'},409)}}for(const [child,rows] of Object.entries(oldLedger)){if(!Array.isArray(rows))continue;const next=Array.isArray(newLedger[child])?newLedger[child]:[];for(const tx of rows.filter(x=>x.childTradeId||x.settlementId||x.repaymentRequestId||x.splitPaymentId||x.type==="split_payment")){const found=next.find(x=>x.id===tx.id);if(!found||JSON.stringify(found)!==JSON.stringify(tx))return json({error:"확정된 마이너스 정산 내역은 수정하거나 삭제할 수 없습니다."},409)}}const nextJson=JSON.stringify(newLedger);let result;if(current){result=await env.DB.prepare("UPDATE family_state SET value_json=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE family_id=? AND state_key='allowance_ledger' AND value_json=?").bind(nextJson,me.id,me.family_id,oldJson).run()}else{result=await env.DB.prepare("INSERT OR IGNORE INTO family_state(family_id,state_key,value_json,updated_at,updated_by) VALUES(?,?,?,CURRENT_TIMESTAMP,?)").bind(me.family_id,b.key,nextJson,me.id).run()}if(result.meta?.changes!==1)return json({error:"동시 수정 충돌. 다시 불러온 후 시도해주세요."},409);return json({ok:true,value:newLedger})}await env.DB.prepare(`INSERT INTO family_state(family_id,state_key,value_json,updated_at,updated_by) VALUES(?,?,?,CURRENT_TIMESTAMP,?) ON CONFLICT(family_id,state_key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP,updated_by=excluded.updated_by`).bind(me.family_id,b.key,JSON.stringify(b.value??null),me.id).run();return json({ok:true})}
return json({error:"Not found"},404)}};
const APP_ORIGINS=new Set(["https://gyeongjin-family-app.pages.dev","https://gyeongjin-family-app.muse-hooni.workers.dev"]);
export default {
 scheduled:handler.scheduled,
 async fetch(req,env){
  let response;try{response=await handler.fetch(req,env)}catch(e){console.error('API operation failed',e.message);response=json({error:'저장 충돌 또는 데이터 오류입니다. 최신 내역을 불러온 후 확인해주세요.'},409)}const headers=new Headers(response.headers),origin=req.headers.get("origin");
  if(APP_ORIGINS.has(origin))headers.set("access-control-allow-origin",origin);
  else headers.delete("access-control-allow-origin");
  return new Response(response.body,{status:response.status,headers});
 }
};

