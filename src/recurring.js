// The monthly run claim and every affected ledger commit together. A stale
// snapshot aborts the whole D1 batch so retries cannot lose or double-post money.
export async function processRecurringAtomic(env){
 const DB=env.DB,q=(sql,...args)=>DB.prepare(sql).bind(...args);
 const date=new Date(Date.now()+32400000).toISOString().slice(0,10),period=date.slice(0,7),day=Number(date.slice(8)),[year,month]=period.split('-').map(Number),last=new Date(Date.UTC(year,month,0)).getUTCDate();
 const recurring=(await q('SELECT * FROM recurring_expenses WHERE active=1').all()).results||[];
 for(const r of recurring){
  if(day!==Math.min(Number(r.billing_day),last))continue;
  for(let attempt=0;attempt<5;attempt++){
   if(await q('SELECT 1 AS found FROM recurring_expense_runs WHERE recurring_id=? AND period=?',r.id,period).first())break;
   const states=(await q("SELECT state_key,value_json FROM family_state WHERE family_id=? AND state_key IN ('household_ledger','allowance_ledger','allowance_audit') ORDER BY state_key",r.family_id).all()).results||[],map=Object.fromEntries(states.map(s=>[s.state_key,JSON.parse(s.value_json)])),now=new Date().toISOString();
   const household=map.household_ledger||[];household.push({id:crypto.randomUUID(),date,type:'fixed',amount:Number(r.amount),fixedKind:r.kind,title:r.title,createdBy:'시스템',createdAt:now,recurringId:r.id,period});
   const values={household_ledger:household};
   if(r.kind==='allowance'&&r.allowance_member_name){
    const ledger=map.allowance_ledger||{},rows=ledger[r.allowance_member_name]||[];
    const tx={id:crypto.randomUUID(),date,type:'income',wallet:'card',amount:Number(r.amount),title:r.title,status:'approved',requestedBy:'시스템',approvedBy:'시스템',createdAt:now,approvedAt:now,recurringId:r.id,period};
    ledger[r.allowance_member_name]=[...rows,tx];values.allowance_ledger=ledger;
    values.allowance_audit=[{id:crypto.randomUUID(),action:'고정지출 자동 용돈',child:r.allowance_member_name,actor:'시스템',at:now,before:null,after:tx},...(map.allowance_audit||[])];
   }
   const guard=crypto.randomUUID(),predicate="(SELECT json_group_array(json_object('state_key',state_key,'value_json',value_json)) FROM (SELECT state_key,value_json FROM family_state WHERE family_id=? AND state_key IN ('household_ledger','allowance_ledger','allowance_audit') ORDER BY state_key))=?";
   try{await DB.batch([
    q('INSERT INTO child_trade_guards(id,valid) SELECT ?,CASE WHEN '+predicate+' THEN 1 ELSE 0 END',guard,r.family_id,JSON.stringify(states)),
    q('INSERT INTO recurring_expense_runs(recurring_id,period) VALUES(?,?)',r.id,period),
    ...Object.entries(values).map(([key,value])=>q('INSERT INTO family_state(family_id,state_key,value_json) VALUES(?,?,?) ON CONFLICT(family_id,state_key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP',r.family_id,key,JSON.stringify(value))),
    q('DELETE FROM child_trade_guards WHERE id=?',guard)
   ]);break}catch(e){if(attempt===4)throw e;}
  }
 }
}
