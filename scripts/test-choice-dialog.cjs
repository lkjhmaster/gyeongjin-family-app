const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
const html=fs.readFileSync('index.html','utf8'),server=http.createServer((req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:360,height:800},serviceWorkers:'block'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',()=>{throw Error('Unexpected native dialog')});
 await page.route('https://**',r=>r.abort());await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>typeof family!=='undefined');
 await page.evaluate(()=>{
 currentAccount={id:'a',name:'아이',isAdmin:true};family.members=[{name:'아이',role:'자녀'},{name:'부모',role:'부모'}];
 window.calls=[];window.promptAnswers=[];window.promptTexts=[];
 window.prompt=(text)=>{promptTexts.push(text);return promptAnswers.shift()??null};window.confirm=()=>true;
 pushFamilyStateKey=async()=>true;addAllowanceAudit=async()=>{};allowanceChild=()=>{};householdLedger=()=>{};choreTemplatePicker=()=>{};
 api=async(path,options)=>{calls.push({path,body:options?.body?JSON.parse(options.body):null});if(path==='/api/state')return {state:{allowance_ledger:{아이:allowanceStore()['아이']}}};if(path==='/api/child-trades/participants')return {participants:[]};if(path==='/api/recurring-expenses'&&!options)return {items:[{id:'r',title:'보험',amount:100,billing_day:1,kind:'insurance'}]};return {ledger:allowanceStore()}};
 });
 const click=async text=>{await page.getByRole('dialog').waitFor();await page.getByRole('dialog').getByRole('button',{name:text,exact:true}).click()};
 await page.evaluate(()=>{window.choiceResult='waiting';chooseOption('선택 테스트',[{value:false,label:'사용 안 함'},{value:'card',label:'카드'}]).then(x=>choiceResult=x)});await click('사용 안 함');assert.equal(await page.evaluate(()=>choiceResult),false);
 await page.evaluate(()=>{chooseOption('키보드 취소',walletChoices()).then(x=>choiceResult=x)});await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>choiceResult),null);
 const seed=async(free=5070,card=27733)=>page.evaluate(({free,card})=>{localStorage.setItem('gyeongjin_savings_goals',JSON.stringify({'아이':[{id:'g',title:'목표',targetAmount:100000,freeSaved:free,cardSaved:card}]}));localStorage.setItem('gyeongjin_allowance_ledger',JSON.stringify({'아이':[{id:'fund',wallet:'free',type:'income',status:'approved',amount:10000}]}));promptTexts.length=0;promptAnswers.length=0},{free,card});
 await seed();const before=await page.evaluate(()=>localStorage.getItem('gyeongjin_allowance_ledger'));
 await page.evaluate(()=>{window.job=withdrawSavings('아이','g')});await click('취소');await page.evaluate(()=>job);assert.equal(await page.evaluate(()=>localStorage.getItem('gyeongjin_allowance_ledger')),before);assert.equal(await page.evaluate(()=>promptTexts.length),0);
 await page.evaluate(()=>{promptAnswers.push('1000');window.job=withdrawSavings('아이','g')});await click('💳 카드출처 · 27,733원');await page.evaluate(()=>job);assert.equal(await page.evaluate(()=>allowanceStore()['아이'].at(-1).wallet),'card');assert.equal(await page.evaluate(()=>savingsGoalStore()['아이'][0].cardSaved),26733);
 await seed(0,27733);await page.evaluate(()=>{window.job=withdrawSavings('아이','g')});assert.equal(await page.getByRole('button',{name:'💵 자유출처 · 0원',exact:true}).isDisabled(),true);await click('취소');await page.evaluate(()=>job);
 await seed();await page.evaluate(()=>{promptAnswers.push('500');window.job=depositSavings('아이','g')});await click('💵 자유용돈 · 잔액 10,000원');await page.evaluate(()=>job);assert.equal(await page.evaluate(()=>savingsGoalStore()['아이'][0].freeSaved),5570);
 await page.evaluate(()=>{window.job=classifyMinusDebt('아이','debt')});await click('💳 카드용돈');await page.evaluate(()=>job);assert.equal(await page.evaluate(()=>calls.at(-1).body.origin),'card');
 await page.evaluate(()=>{document.querySelector('#main').innerHTML='<input id="allowanceDate" value="2026-10-28"><input id="allowanceType" value="expense"><input id="allowanceAmount" value="1200"><input id="allowanceTitle" value="간식">';window.job=saveAllowance('아이','minus')});await click('💵 자유용돈');await page.evaluate(()=>job);assert.equal(await page.evaluate(()=>allowanceStore()['아이'].at(-1).debtOrigin),'free');
 await page.evaluate(()=>{localStorage.setItem('gyeongjin_allowance_ledger',JSON.stringify({'아이':[{id:'debt',status:'approved',wallet:'minus',type:'expense',amount:3000,debtOrigin:'free',title:'간식',date:'2026-10-28'}]}));window.job=chooseTradeDebt({payee_id:'a'})});await click('2026-10-28 · 간식 · 자유용돈 · 잔여 3,000원');assert.equal(await page.evaluate(()=>job),'debt');
 await page.evaluate(()=>{promptAnswers.push('새 용돈','1000','5');window.job=editRecurring('r')});await click('용돈');await click('아이');await page.evaluate(()=>job);assert.deepEqual(await page.evaluate(()=>calls.at(-1).body),{id:'r',kind:'allowance',title:'새 용돈',amount:1000,billingDay:5,allowanceMemberName:'아이',allowanceWallet:'card'});
 for(const width of [320,360,768]){await page.setViewportSize({width,height:640});await page.evaluate(()=>{chooseOption('변제할 마이너스 사용 건',Array.from({length:30},(_,i)=>({value:String(i),label:'2026-10-28 · 아주 긴 거래 내용과 자유용돈 · 잔여 123,456원'})))});const rect=await page.getByRole('dialog').boundingBox();assert.ok(rect.x>=0&&rect.width<=width);assert.ok(rect.y>=0&&rect.height<=640);await click('취소')}
 assert.deepEqual(errors,[]);console.log('PASS choices, cancellation, false values, savings deposit/withdrawal, disabled balances, minus origin/repayment, self trade debt, recurring child selection, scroll layout at 320/360/768px; no page errors');
}finally{await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exit(1)});
