import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/worker.js';
export async function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec(fs.readFileSync('schema.sql','utf8'));
 for(const p of ['0001_additive_schema.sql','0002_atomic_lifecycle.sql','0003_split_funding.sql'])sql.exec(fs.readFileSync('migrations/child-trades/'+p,'utf8'));
 sql.prepare('INSERT INTO families(id,name) VALUES(?,?)').run('f','family');
 for(const [id,name,role] of [['a','Alice','child'],['b','Bob','child'],['c','Cara','child'],['p','Parent','parent']]){
  sql.prepare('INSERT INTO members(id,family_id,name,role,is_admin,password_hash,password_salt) VALUES(?,?,?,?,?,?,?)').run(id,'f',name,role,role==='parent'?1:0,'hash','salt');
  const token=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id))).toString('hex');sql.prepare("INSERT INTO sessions(token_hash,member_id,expires_at) VALUES(?,?,datetime('now','+1 day'))").run(token,id);
 }
 const ledger={Alice:[{id:'fund-a',type:'income',wallet:'card',amount:20000,status:'approved'},{id:'free-a',type:'income',wallet:'free',amount:10000,status:'approved'}],Bob:[{id:'fund-b',type:'income',wallet:'card',amount:20000,status:'approved'},{id:'free-b',type:'income',wallet:'free',amount:10000,status:'approved'}],Cara:[{id:'fund-c',type:'income',wallet:'card',amount:20000,status:'approved'}]};
 sql.prepare('INSERT INTO family_state(family_id,state_key,value_json) VALUES(?,?,?)').run('f','allowance_ledger',JSON.stringify(ledger));
 sql.prepare('INSERT INTO family_state(family_id,state_key,value_json) VALUES(?,?,?)').run('f','allowance_limits',JSON.stringify({Alice:5000,Bob:5000,Cara:5000}));
 let beforeBatch=null,failAt=-1;
 const execute=(query,args)=>{const r=sql.prepare(query).run(...args);return {meta:{changes:Number(r.changes)}}};
 const DB={prepare(query){return {query,args:[],bind(...args){this.args=args;return this},async first(){return sql.prepare(query).get(...this.args)||null},async all(){return {results:sql.prepare(query).all(...this.args)}},async run(){return execute(query,this.args)}}},async batch(stmts){if(beforeBatch){const fn=beforeBatch;beforeBatch=null;fn(sql)}sql.exec('BEGIN');try{const results=stmts.map((s,i)=>{if(i===failAt)throw Error('injected failure');return execute(s.query,s.args)});sql.exec('COMMIT');return results}catch(e){sql.exec('ROLLBACK');throw e}}};
 const call=async(actor,path,data,method=data?'POST':'GET')=>{const r=await worker.fetch(new Request('https://api.test/api'+path,{method,headers:{authorization:'Bearer '+actor,'content-type':'application/json'},...(data?{body:JSON.stringify(data)}:{})}),{DB,RELEASE_SHA:'test'});return {status:r.status,data:await r.json()}};
 const row=id=>sql.prepare('SELECT * FROM child_trade_transactions WHERE id=?').get(id);
 const mutate=async(actor,path,id,data={})=>call(actor,path,{transactionId:id,revision:row(id).revision,...data});
 const create=async(kind='loan',extra={})=>{const r=await call('a','/child-trades',{kind,counterpartyId:'b',gross:1000,sourceWallet:kind==='loan'||kind==='repayment'?'card':'card',destinationWallet:kind==='loan'||kind==='repayment'||extra.allocations?.minus>0?'card':'free',dueDate:kind==='loan'?'2099-12-31':undefined,operationKey:crypto.randomUUID(),...extra});assert.equal(r.status,201,JSON.stringify(r));return r.data.id};
 const approve=async id=>{assert.equal((await mutate('b','/child-trades/decision',id,{decision:'consent'})).status,200);const r=await mutate('p','/child-trades/approval/approve',id);assert.equal(r.status,200,JSON.stringify(r));};
 const action=async(id,kind,extra={})=>{let r=await mutate('a','/child-trades/action/request',id,{kind,...extra});assert.equal(r.status,201===r.status?201:200,JSON.stringify(r));const actionId=r.data.actionId;assert.ok(actionId,JSON.stringify(r));r=await mutate('b','/child-trades/action/decision',id,{actionId,decision:'consent'});assert.equal(r.status,200,JSON.stringify(r));return mutate('p','/child-trades/action/decision',id,{actionId,decision:'approve'})};
 return {env:{DB},sql,call,row,mutate,create,approve,action,ledger:()=>JSON.parse(sql.prepare("SELECT value_json FROM family_state WHERE state_key='allowance_ledger'").get().value_json),race(fn){beforeBatch=fn},fail(i){failAt=i}};
}
