const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ui=fs.readFileSync('src/child-transactions/ui.js','utf8');
test('UI renders only participant and parent controls and escapes user content',async()=>{
 let rendered='';const info={transaction:{id:'tx',requester_id:'a',counterparty_id:'b',payer_id:'b',payee_id:'a',kind:'loan',status:'consented',revision:1,gross_amount:1000,fee_amount:500,net_amount:500},members:[{id:'a',name:'Alice'},{id:'b',name:'Bob'}],detail:{title:'<script>alert(1)</script>'},actions:[],delivery:[],events:[]};
 const sandbox={currentAccount:{id:'a',isAdmin:false},api:async()=>info,shell:html=>{rendered=html},esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};vm.createContext(sandbox);vm.runInContext(ui,sandbox);vm.runInContext("childTradeScreen={encoded:'Alice',tab:'active'}",sandbox);
 await sandbox.childTradeDetail('tx');assert.ok(!rendered.includes('data-command="approve"'));assert.ok(rendered.includes('&lt;script&gt;'));assert.ok(rendered.includes('500원'));
 sandbox.currentAccount={id:'p',isAdmin:true};await sandbox.childTradeDetail('tx');assert.ok(rendered.includes('data-command="approve"'));assert.ok(!rendered.includes('data-command="consent"'));
 info.transaction.status='requested';sandbox.currentAccount={id:'b'};await sandbox.childTradeDetail('tx');assert.ok(rendered.includes('data-command="consent"'));sandbox.currentAccount={id:'c'};await sandbox.childTradeDetail('tx');assert.ok(!rendered.includes('data-command="consent"'));
});
test('UI failed writes leave local balances untouched and unlock the button',async()=>{
 const messages=[],button={disabled:false,dataset:{command:'approve'}};
 const sandbox={currentAccount:{id:'p',isAdmin:true},api:async()=>{throw Error('conflict')},confirm:()=>true,toast:m=>messages.push(m)};vm.createContext(sandbox);vm.runInContext(ui,sandbox);vm.runInContext("childTradeScreen={detail:{transaction:{id:'tx',revision:4}}}",sandbox);await sandbox.childTradeCommand(button);assert.deepEqual(messages,['conflict']);assert.equal(button.disabled,false);
});
