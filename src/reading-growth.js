const MAX_TITLE=100,MAX_AUTHOR=60,MAX_ANSWER=2000,MAX_ESSAY=10000,MAX_FEEDBACK=2000,MAX_QUESTIONS=5;
const KINDS=["book","performance","exhibition"];
const FORMATS={performance:["pansori","changgeuk","gugak","gugak_orch","opera","musical","orchestra","choir","play","dance","other"],exhibition:["art","photo","sculpture","museum","science","movie","other"]};
const PHOTO_REF=/^photo:[0-9a-f-]{36}$/;
const PROMPT_ID=/^[a-z0-9_]{1,30}$/;
// Grades advance every January 1 (Korea time), by the family's choice. The calendar year is therefore the "school year".
export const schoolYearOf=(now=new Date())=>new Date(now.getTime()+9*3600*1000).getUTCFullYear();
export const currentGrade=(grade,setYear,now=new Date())=>Math.min(12,Math.max(1,grade+schoolYearOf(now)-setYear));
const text=(v,max)=>typeof v==="string"?v.trim().slice(0,max):"";
const noTable=e=>/no such table/i.test(e?.message||"");
const unavailable=json=>json({error:"독서성장 저장소를 준비 중입니다. 잠시 후 다시 시도해주세요."},503);
async function logEvent(env,newId,bookId,actorId,action){
 try{await env.DB.prepare("INSERT INTO reading_events(id,book_id,actor_id,action) VALUES(?,?,?,?)").bind(newId(),bookId,actorId,action).run()}catch(e){console.warn("reading event not recorded",action,e&&e.message)}
}
async function buildTimeline(env,book){
 const all=async(sql,...a)=>{try{return (await env.DB.prepare(sql).bind(...a).all()).results||[]}catch(e){if(noTable(e))return[];throw e}};
 const names=new Map((await all("SELECT id,name FROM members WHERE family_id=?",book.family_id)).map(m=>[m.id,m.name])),who=id=>names.get(id)||"";
 const out=[{at:book.created_at,actor:who(book.created_by||book.child_id),action:"created"}];
 for(const a of await all("SELECT prompt_id,version,created_at FROM reading_answers WHERE book_id=?",book.id))out.push({at:a.created_at,actor:who(book.child_id),action:a.version>1?"answer_edited":"answer_saved",promptId:a.prompt_id,version:a.version});
 for(const e of await all("SELECT version,kind,created_at,created_by FROM reading_essays WHERE book_id=?",book.id))out.push({at:e.created_at,actor:who(e.created_by||book.child_id),action:e.kind==="final"?"finalized":"essay_saved",version:e.version,essayKind:e.kind});
 for(const f of await all("SELECT essay_version,parent_id,created_at FROM reading_feedback WHERE book_id=?",book.id))out.push({at:f.created_at,actor:who(f.parent_id),action:"feedback",version:f.essay_version});
 for(const v of await all("SELECT actor_id,action,created_at FROM reading_events WHERE book_id=?",book.id))out.push({at:v.created_at,actor:who(v.actor_id),action:v.action==="submit"?"submitted":"revision_requested"});
 const rank={created:0,answer_saved:1,answer_edited:1,essay_saved:2,submitted:3,feedback:4,revision_requested:5,finalized:6};
 return out.sort((a,b)=>String(a.at).localeCompare(String(b.at))||rank[a.action]-rank[b.action]);
}
async function ownCover(env,me,cover){
 if(typeof cover!=="string"||!PHOTO_REF.test(cover))return false;
 return !!await env.DB.prepare("SELECT id FROM memory_photos WHERE id=? AND family_id=?").bind(cover.slice(6),me.family_id).first();
}
async function loadBook(env,me,bookId){
 const book=await env.DB.prepare("SELECT * FROM reading_books WHERE id=? AND family_id=?").bind(String(bookId||""),me.family_id).first();
 if(!book)return null;
 if(!me.is_admin&&book.child_id!==me.id)return null;
 return book;
}
async function nextVersion(run){
 for(let attempt=0;attempt<4;attempt++){try{return await run()}catch(e){if(!/UNIQUE|constraint/i.test(e?.message||""))throw e}}
 throw new Error("version conflict");
}
export async function readingGrowth(req,env,me,json,url,newId,readBody){
 const path=url.pathname;
 if(!path.startsWith("/api/reading/"))return null;
 try{
  if(path==="/api/reading/levels"&&req.method==="GET"){
   if(!me.is_admin){const row=await env.DB.prepare("SELECT grade,school_year FROM reading_levels WHERE member_id=?").bind(me.id).first();return json({ok:true,me:row?currentGrade(row.grade,row.school_year):null})}
   const rows=(await env.DB.prepare("SELECT m.id,m.name,l.grade,l.school_year FROM members m LEFT JOIN reading_levels l ON l.member_id=m.id WHERE m.family_id=? AND m.role='child' ORDER BY m.name").bind(me.family_id).all()).results||[];
   return json({ok:true,me:null,children:rows.map(r=>({id:r.id,name:r.name,grade:r.grade==null?null:currentGrade(r.grade,r.school_year)}))});
  }
  if(path==="/api/reading/levels"&&req.method==="POST"){
   if(!me.is_admin)return json({error:"부모 관리자만 학년을 정할 수 있습니다."},403);
   const b=await readBody(req),grade=Number(b.grade);
   if(!Number.isInteger(grade)||grade<1||grade>12)return json({error:"학년을 확인해주세요."},400);
   const child=await env.DB.prepare("SELECT id FROM members WHERE id=? AND family_id=? AND role='child'").bind(String(b.childId||""),me.family_id).first();
   if(!child)return json({error:"자녀를 찾을 수 없습니다."},404);
   await env.DB.prepare("INSERT INTO reading_levels(member_id,grade,school_year,updated_by) VALUES(?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET grade=excluded.grade,school_year=excluded.school_year,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP").bind(child.id,grade,schoolYearOf(),me.id).run();
   return json({ok:true,grade});
  }
  if(path==="/api/reading/books"&&req.method==="GET"){
   const rows=me.is_admin
    ?(await env.DB.prepare("SELECT b.id,b.child_id,m.name child_name,b.title,b.author,b.status,b.created_at,b.updated_at,COALESCE(k.kind,'book') kind,d.format,d.cover,(SELECT a.answer FROM reading_answers a WHERE a.book_id=b.id AND a.prompt_id='kw1' ORDER BY a.version DESC LIMIT 1) keywords FROM reading_books b JOIN members m ON m.id=b.child_id LEFT JOIN reading_book_kinds k ON k.book_id=b.id LEFT JOIN reading_book_details d ON d.book_id=b.id WHERE b.family_id=? ORDER BY b.updated_at DESC LIMIT 200").bind(me.family_id).all()).results
    :(await env.DB.prepare("SELECT b.id,b.child_id,m.name child_name,b.title,b.author,b.status,b.created_at,b.updated_at,COALESCE(k.kind,'book') kind,d.format,d.cover,(SELECT a.answer FROM reading_answers a WHERE a.book_id=b.id AND a.prompt_id='kw1' ORDER BY a.version DESC LIMIT 1) keywords FROM reading_books b JOIN members m ON m.id=b.child_id LEFT JOIN reading_book_kinds k ON k.book_id=b.id LEFT JOIN reading_book_details d ON d.book_id=b.id WHERE b.family_id=? AND b.child_id=? ORDER BY b.updated_at DESC LIMIT 200").bind(me.family_id,me.id).all()).results;
   return json({ok:true,books:rows||[]});
  }
  if(path==="/api/reading/books"&&req.method==="POST"){
   const b=await readBody(req),title=text(b.title,MAX_TITLE),author=text(b.author,MAX_AUTHOR);
   if(!title)return json({error:"책 제목을 입력해주세요."},400);
   let childId=me.id;
   if(me.is_admin&&b.childId){const child=await env.DB.prepare("SELECT id FROM members WHERE id=? AND family_id=? AND role='child'").bind(String(b.childId),me.family_id).first();if(!child)return json({error:"자녀를 찾을 수 없습니다."},404);childId=child.id}
   else if(me.role!=="child")return json({error:"자녀를 선택해주세요."},400);
   const kind=b.kind===undefined?"book":b.kind;
   if(!KINDS.includes(kind))return json({error:"종류를 확인해주세요."},400);
   const format=b.format==null||b.format===""?null:b.format;
   if(format!==null&&!(FORMATS[kind]||[]).includes(format))return json({error:"형식을 확인해주세요."},400);
   const cover=b.cover==null||b.cover===""?null:b.cover;
   if(cover!==null&&!await ownCover(env,me,cover))return json({error:"표지 사진을 확인해주세요."},400);
   const bookId=newId();
   await env.DB.prepare("INSERT INTO reading_books(id,family_id,child_id,title,author,created_by) VALUES(?,?,?,?,?,?)").bind(bookId,me.family_id,childId,title,author,me.id).run();
   try{
    if(kind!=="book")await env.DB.prepare("INSERT INTO reading_book_kinds(book_id,kind) VALUES(?,?)").bind(bookId,kind).run();
    if(format!==null||cover!==null)await env.DB.prepare("INSERT INTO reading_book_details(book_id,format,cover) VALUES(?,?,?)").bind(bookId,format,cover).run();
   }catch(e){await env.DB.prepare("DELETE FROM reading_books WHERE id=?").bind(bookId).run();throw e}
   return json({ok:true,id:bookId,kind,format,cover},201);
  }
  if(path==="/api/reading/book"&&req.method==="GET"){
   const book=await loadBook(env,me,url.searchParams.get("id"));
   if(!book)return json({error:"책을 찾을 수 없습니다."},404);
   const answers=(await env.DB.prepare("SELECT a.prompt_id,a.version,a.answer,a.created_at FROM reading_answers a WHERE a.book_id=? AND a.version=(SELECT MAX(version) FROM reading_answers x WHERE x.book_id=a.book_id AND x.prompt_id=a.prompt_id) ORDER BY a.created_at").bind(book.id).all()).results||[];
   const essays=(await env.DB.prepare("SELECT version,kind,body,created_at FROM reading_essays WHERE book_id=? ORDER BY version").bind(book.id).all()).results||[];
   const feedback=((await env.DB.prepare("SELECT id,essay_version,parent_id,praise,improve,questions_json,created_at FROM reading_feedback WHERE book_id=? ORDER BY created_at").bind(book.id).all()).results||[]).map(f=>{let questions=[];try{questions=JSON.parse(f.questions_json)}catch{}return {id:f.id,essayVersion:f.essay_version,parentId:f.parent_id,praise:f.praise,improve:f.improve,questions,createdAt:f.created_at}});
   const kindRow=await env.DB.prepare("SELECT kind FROM reading_book_kinds WHERE book_id=?").bind(book.id).first(),detail=await env.DB.prepare("SELECT format,cover FROM reading_book_details WHERE book_id=?").bind(book.id).first();
   return json({ok:true,book:{id:book.id,childId:book.child_id,title:book.title,author:book.author,status:book.status,kind:kindRow?kindRow.kind:"book",format:detail?detail.format:null,cover:detail?detail.cover:null},answers,essays,feedback,timeline:await buildTimeline(env,book)});
  }
  if(path==="/api/reading/cover"&&req.method==="POST"){
   const b=await readBody(req),book=await loadBook(env,me,b.bookId);
   if(!book||book.child_id!==me.id)return json({error:"기록을 찾을 수 없습니다."},404);
   if(!await ownCover(env,me,b.cover))return json({error:"표지 사진을 확인해주세요."},400);
   await env.DB.prepare("INSERT INTO reading_book_details(book_id,cover) VALUES(?,?) ON CONFLICT(book_id) DO UPDATE SET cover=excluded.cover").bind(book.id,b.cover).run();
   return json({ok:true});
  }
  if(path==="/api/reading/answers"&&req.method==="POST"){
   const b=await readBody(req),promptId=String(b.promptId||""),answer=text(b.answer,MAX_ANSWER);
   if(!PROMPT_ID.test(promptId)||!answer)return json({error:"질문과 답을 확인해주세요."},400);
   const book=await loadBook(env,me,b.bookId);
   if(!book||book.child_id!==me.id)return json({error:"책을 찾을 수 없습니다."},404);
   if(book.status==="done")return json({error:"완료된 책은 수정할 수 없습니다."},409);
   const last=await env.DB.prepare("SELECT version,answer FROM reading_answers WHERE book_id=? AND prompt_id=? ORDER BY version DESC LIMIT 1").bind(book.id,promptId).first();
   if(last&&last.answer===answer)return json({ok:true,version:last.version,unchanged:true});
   const version=await nextVersion(async()=>{await env.DB.prepare("INSERT INTO reading_answers(id,book_id,prompt_id,version,answer) VALUES(?,?,?,COALESCE((SELECT MAX(version) FROM reading_answers WHERE book_id=? AND prompt_id=?),0)+1,?)").bind(newId(),book.id,promptId,book.id,promptId,answer).run();return (await env.DB.prepare("SELECT MAX(version) v FROM reading_answers WHERE book_id=? AND prompt_id=?").bind(book.id,promptId).first()).v});
   await env.DB.prepare("UPDATE reading_books SET updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(book.id).run();
   return json({ok:true,version},201);
  }
  if(path==="/api/reading/essays"&&req.method==="POST"){
   const b=await readBody(req),body=text(b.body,MAX_ESSAY);
   if(!body)return json({error:"독후감 내용을 입력해주세요."},400);
   const book=await loadBook(env,me,b.bookId);
   if(!book||book.child_id!==me.id)return json({error:"책을 찾을 수 없습니다."},404);
   if(book.status==="review"||book.status==="done")return json({error:"검토 중이거나 완료된 독후감은 수정할 수 없습니다."},409);
   const last=await env.DB.prepare("SELECT version,body FROM reading_essays WHERE book_id=? ORDER BY version DESC LIMIT 1").bind(book.id).first();
   if(last&&last.body===body)return json({ok:true,version:last.version,unchanged:true});
   const kind=last?"revision":"draft";
   const version=await nextVersion(async()=>{await env.DB.prepare("INSERT INTO reading_essays(id,book_id,version,kind,body,created_by) VALUES(?,?,COALESCE((SELECT MAX(version) FROM reading_essays WHERE book_id=?),0)+1,?,?,?)").bind(newId(),book.id,book.id,kind,body,me.id).run();return (await env.DB.prepare("SELECT MAX(version) v FROM reading_essays WHERE book_id=?").bind(book.id).first()).v});
   await env.DB.prepare("UPDATE reading_books SET status='writing',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(book.id).run();
   return json({ok:true,version,kind},201);
  }
  if(path==="/api/reading/submit"&&req.method==="POST"){
   const b=await readBody(req),book=await loadBook(env,me,b.bookId);
   if(!book||book.child_id!==me.id)return json({error:"책을 찾을 수 없습니다."},404);
   if(book.status!=="writing")return json({error:"작성 중인 독후감만 제출할 수 있습니다."},409);
   const essay=await env.DB.prepare("SELECT version FROM reading_essays WHERE book_id=? ORDER BY version DESC LIMIT 1").bind(book.id).first();
   if(!essay)return json({error:"독후감을 먼저 저장해주세요."},400);
   await env.DB.prepare("UPDATE reading_books SET status='review',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='writing'").bind(book.id).run();
   await logEvent(env,newId,book.id,me.id,"submit");
   return json({ok:true,version:essay.version});
  }
  if(path==="/api/reading/feedback"&&req.method==="POST"){
   if(!me.is_admin)return json({error:"부모 관리자만 피드백을 남길 수 있습니다."},403);
   const b=await readBody(req),book=await loadBook(env,me,b.bookId);
   if(!book)return json({error:"책을 찾을 수 없습니다."},404);
   if(book.status!=="review")return json({error:"검토 중인 독후감에만 피드백을 남길 수 있습니다."},409);
   const questions=(Array.isArray(b.questions)?b.questions:[]).map(q=>text(q,300)).filter(Boolean).slice(0,MAX_QUESTIONS);
   const praise=text(b.praise,MAX_FEEDBACK),improve=text(b.improve,MAX_FEEDBACK);
   if(!praise&&!improve&&!questions.length)return json({error:"피드백 내용을 입력해주세요."},400);
   const essay=await env.DB.prepare("SELECT version FROM reading_essays WHERE book_id=? ORDER BY version DESC LIMIT 1").bind(book.id).first();
   await env.DB.prepare("INSERT INTO reading_feedback(id,book_id,essay_version,parent_id,praise,improve,questions_json) VALUES(?,?,?,?,?,?,?)").bind(newId(),book.id,essay.version,me.id,praise,improve,JSON.stringify(questions)).run();
   const next=b.requestRevision===true?"writing":book.status;
   await env.DB.prepare("UPDATE reading_books SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(next,book.id).run();
   if(b.requestRevision===true)await logEvent(env,newId,book.id,me.id,"revision_requested");
   return json({ok:true,status:next},201);
  }
  if(path==="/api/reading/finalize"&&req.method==="POST"){
   if(!me.is_admin)return json({error:"부모 관리자만 완료할 수 있습니다."},403);
   const b=await readBody(req),book=await loadBook(env,me,b.bookId);
   if(!book)return json({error:"책을 찾을 수 없습니다."},404);
   if(book.status!=="review")return json({error:"검토 중인 독후감만 완료할 수 있습니다."},409);
   const essay=await env.DB.prepare("SELECT body FROM reading_essays WHERE book_id=? ORDER BY version DESC LIMIT 1").bind(book.id).first();
   if(!essay)return json({error:"독후감이 없습니다."},400);
   const version=await nextVersion(async()=>{await env.DB.prepare("INSERT INTO reading_essays(id,book_id,version,kind,body,created_by) VALUES(?,?,COALESCE((SELECT MAX(version) FROM reading_essays WHERE book_id=?),0)+1,'final',?,?)").bind(newId(),book.id,book.id,essay.body,me.id).run();return (await env.DB.prepare("SELECT MAX(version) v FROM reading_essays WHERE book_id=?").bind(book.id).first()).v});
   await env.DB.prepare("UPDATE reading_books SET status='done',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(book.id).run();
   return json({ok:true,version});
  }
 }catch(e){
  if(noTable(e))return unavailable(json);
  console.error("reading growth failed",e?.message);
  return json({error:"독서성장 요청을 처리하지 못했습니다."},500);
 }
 return null;
}
