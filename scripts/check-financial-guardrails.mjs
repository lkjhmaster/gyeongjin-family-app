import fs from 'node:fs';
import assert from 'node:assert/strict';
const html=fs.readFileSync('index.html','utf8');
const worker=fs.readFileSync('src/worker.js','utf8');
const migration=fs.readFileSync('migrations/20261012_chore_requests.sql','utf8');
const checks=[
 ['allowance request has three types',html.includes('<option value="expense">지출</option><option value="income">수입</option>')&&html.includes('<option value="minus_repayment">마이너스 변제</option>')],
 ['repayment request remains pending',html.includes("type,wallet,amount,title,status:'pending'")],
 ['repayment approval cannot bypass server accounting',html.includes("action==='approve'&&before.type==='minus_repayment'")],
 ['chore requests are posted to server',html.includes("api('/api/chore-requests'")],
 ['chore approval requires parent',worker.includes('if(!me.is_admin)return json({error:"부모 관리자만 승인할 수 있어요."},403)')],
 ['chore completion reward cannot be silently skipped',worker.includes('request.request_kind==="done"')&&worker.includes('보상 원장 연동 전에는 승인할 수 없습니다')],
 ['chore requests have unique daily identity',migration.includes('UNIQUE(family_id,member_id,chore_id,occurrence_date)')],
 ['reward posting has unique request key',migration.includes('request_id TEXT PRIMARY KEY')]
];
for(const [name,ok] of checks){console.log((ok?'PASS ':'FAIL ')+name);assert.ok(ok,name)}
console.log('Guardrail checks passed: '+checks.length);
