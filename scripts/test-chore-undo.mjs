import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './trade-test-fixture.mjs';
const kst=new Date(Date.now()+9*3600*1000),today=kst.toISOString().slice(0,10);
const put=(f,k,v)=>f.sql.prepare('INSERT OR REPLACE INTO family_state(family_id,state_key,value_json) VALUES(?,?,?)').run('f',k,JSON.stringify(v));
const get=(f,k)=>{const r=f.sql.prepare('SELECT value_json FROM family_state WHERE family_id=? AND state_key=?').get('f',k);return r?JSON.parse(r.value_json):null};
const seed=async(rec={state:'done',submittedAt:'x'},req)=>{const f=await fixture();put(f,'chores',{Alice:[{id:'c1',title:'설거지',dayRecords:{[today]:rec}},{id:'c2',title:'청소',dayRecords:{[today]:{state:'done'}}}],Bob:[{id:'c9',title:'x',dayRecords:{[today]:{state:'done'}}}]});if(req)put(f,'chore_daily_requests',{['Alice|'+today]:req});return f};
test('child undoes own done check with pending request; audit written',async()=>{
 const f=await seed(undefined,{status:'pending',amount:200});
 const r=await f.call('a','/chores/day/undo',{id:'c1',date:today});
 assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.withdrawnRequest,true);
 assert.equal(get(f,'chores').Alice[0].dayRecords[today],undefined);
 assert.ok(get(f,'chores').Alice[1].dayRecords[today]);
 assert.deepEqual(get(f,'chore_daily_requests'),{});
 const au=get(f,'allowance_audit');assert.equal(au.length,1);assert.equal(au[0].child,'Alice');assert.equal(au[0].actorId,'a');
});
test('undo without request works and keeps others',async()=>{
 const f=await seed();const r=await f.call('a','/chores/day/undo',{id:'c1',date:today});
 assert.equal(r.status,200);assert.equal(r.data.withdrawnRequest,false);
});
test('blocked after parent decision or review',async()=>{
 for(const st of ['approved','rejected','reversed']){const f=await seed(undefined,{status:st});assert.equal((await f.call('a','/chores/day/undo',{id:'c1',date:today})).status,409);assert.ok(get(f,'chores').Alice[0].dayRecords[today])}
 const f=await seed({state:'done',reviewedBy:'Parent'});assert.equal((await f.call('a','/chores/day/undo',{id:'c1',date:today})).status,409);
 const g=await seed({state:'exempt_approved'});assert.equal((await g.call('a','/chores/day/undo',{id:'c1',date:today})).status,409);
});
test('other child, admin, old date, missing record rejected',async()=>{
 const f=await seed();
 assert.equal((await f.call('b','/chores/day/undo',{id:'c1',date:today})).status,404);
 assert.equal((await f.call('p','/chores/day/undo',{id:'c1',date:today})).status,403);
 assert.equal((await f.call('a','/chores/day/undo',{id:'c1',date:'2020-01-01'})).status,400);
 assert.equal((await f.call('a','/chores/day/undo',{id:'nope',date:today})).status,404);
 assert.ok(get(f,'chores').Alice[0].dayRecords[today]);
});
test('concurrent parent approval aborts the undo atomically',async()=>{
 const f=await seed(undefined,{status:'pending',amount:200});
 f.race(sql=>sql.prepare("UPDATE family_state SET value_json=? WHERE state_key='chore_daily_requests'").run(JSON.stringify({['Alice|'+today]:{status:'approved',amount:200}})));
 const r=await f.call('a','/chores/day/undo',{id:'c1',date:today});
 assert.equal(r.status,409);assert.ok(get(f,'chores').Alice[0].dayRecords[today]);assert.equal(get(f,'chore_daily_requests')['Alice|'+today].status,'approved');
});
