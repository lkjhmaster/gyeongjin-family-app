import fs from 'node:fs';
import assert from 'node:assert/strict';
const html=fs.readFileSync('index.html','utf8');
const sw=fs.readFileSync('sw.js','utf8');
const checks=[
 ['expense option',html.includes('<option value="expense">지출</option>')],
 ['income option',html.includes('<option value="income">수입</option>')],
 ['repayment option',html.includes('<option value="minus_repayment">마이너스 변제</option>')],
 ['repayment option limited to non-minus wallets',html.includes("!isMinus?'<option value=\\\"minus_repayment")||html.includes("!isMinus?'<option value=\"minus_repayment")],
 ['repayment saved pending',html.includes("type,wallet,amount,title,status:'pending'")],
 ['unsafe repayment approval blocked',html.includes("action==='approve'&&before.type==='minus_repayment'")],
 ['service worker network-first HTML',sw.includes('cache: "no-store"')],
];
for(const [name,ok] of checks){console.log((ok?'PASS ':'FAIL ')+name);assert.ok(ok,name)}
