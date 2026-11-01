const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const {fixture}=await import('./trade-test-fixture.mjs'),{walletFixtures}=await import('./wallet-balance-fixture.mjs'),h=await fixture(),limits={Alice:30000,Bob:60000,Cara:90000};
 h.sql.prepare("UPDATE family_state SET value_json=? WHERE state_key='allowance_ledger'").run(JSON.stringify(walletFixtures()));h.sql.prepare("UPDATE family_state SET value_json=? WHERE state_key='allowance_limits'").run(JSON.stringify(limits));
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(fs.readFileSync('index.html'))});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage({viewport:{width:360,height:800},serviceWorkers:'block'}),errors=[];let failState=false,holdState=false,releaseState,notifyHeld;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://gyeongjin-family-api.muse-hooni.workers.dev/**',async route=>{const req=route.request(),url=new URL(req.url()),path=url.pathname.replace(/^\/api/,'')+url.search,headers={'access-control-allow-origin':'*','access-control-allow-headers':'content-type,authorization','access-control-allow-methods':'GET,POST,PUT,OPTIONS'};
   if(req.method()==='OPTIONS'){await route.fulfill({status:204,headers});return}if(path==='/state'&&req.method()==='GET'){if(holdState){notifyHeld();await new Promise(r=>releaseState=r)}if(failState){await route.fulfill({status:503,json:{error:'connection failed'},headers});return}}
   const r=await h.call((req.headers().authorization||'Bearer p').slice(7),path,req.postData()?JSON.parse(req.postData()):undefined,req.method());await route.fulfill({status:r.status,json:r.data,headers})});
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>typeof family!=='undefined');
  const account=async actor=>page.evaluate(async actor=>{const names={a:'Alice',b:'Bob',c:'Cara',p:'Parent'};localStorage.setItem('gyeongjin_auth_token',actor);currentAccount={id:actor,name:names[actor],isAdmin:actor==='p'};localStorage.setItem('gyeongjin_current_member',names[actor]);family.members=Object.entries(names).map(([id,name])=>({name,role:id==='p'?'부모':'자녀'}));await pullFamilyState()},actor);
  const check=async k=>{for(const [w,value] of Object.entries({free:16000*k,card:4000*k,minus:24000*k}))assert.equal(await page.locator('#split_balance_'+w).innerText(),value.toLocaleString())};
  await account('p');
  for(const [i,name] of ['Alice','Bob','Cara'].entries()){
   const k=i+1;await page.evaluate(name=>{window.allowanceDetailView='card';allowanceChild(name,'card')},name);assert.ok((await page.locator('#main').innerText()).includes((4000*k).toLocaleString()+'원'));
   // Stale client cache must be refreshed rather than displayed as zero.
   await page.evaluate(name=>{localStorage.setItem('gyeongjin_allowance_ledger',JSON.stringify({[name]:[]}))},name);await page.evaluate(name=>splitPaymentForm(name),name);await check(k);
   // Update must stay tied to this form, not another selected-child storage value.
   await page.evaluate(()=>localStorage.setItem('gyeongjin_allowance_child','nonexistent'));await page.locator('#split_card').fill('1000');await check(k);await page.locator('#split_total').fill('1000');await page.locator('#split_title').fill('테스트 구매');assert.equal(await page.locator('#split_submit').isEnabled(),true);
   await page.locator('#split_submit').click();await page.locator('#split_submit').waitFor({state:'detached'});assert.equal(h.ledger()[name].filter(x=>x.type==='split_payment'&&x.status==='pending').length,1);assert.equal(await page.evaluate(()=>allowanceLedgerExpectedJson),JSON.stringify(h.ledger()));
  }
  // Every child gets their own snapshot; other children's books stay inaccessible.
  for(const [i,actor] of ['a','b','c'].entries()){await account(actor);await page.evaluate(name=>splitPaymentForm(name),['Alice','Bob','Cara'][i]);await check(i+1)}
  await account('a');await page.evaluate(()=>home());await page.evaluate(()=>splitPaymentForm('Bob'));assert.equal(await page.locator('#splitPaymentForm').count(),0);
  await page.evaluate(()=>{localStorage.setItem('gyeongjin_savings_goals',JSON.stringify({Alice:[{id:'goal',title:'test',targetAmount:99999,freeSaved:0,cardSaved:0}]}));window.saving=depositSavings('Alice','goal')});await page.getByRole('dialog').getByRole('button',{name:'💳 카드용돈 · 잔액 4,000원',exact:true}).waitFor();await page.getByRole('dialog').getByRole('button',{name:'취소',exact:true}).click();await page.evaluate(()=>saving);
  failState=true;await page.evaluate(()=>splitPaymentForm('Alice'));await page.getByText('서버 잔액을 확인하지 못했습니다. 다시 시도해주세요.',{exact:true}).waitFor();assert.equal(await page.locator('#split_balance_card').count(),0);failState=false;await page.getByRole('button',{name:'잔액 다시 확인',exact:true}).click();await page.locator('#split_balance_card').waitFor();await check(1);
  // A late state refresh cannot replace a page the user has already left.
  holdState=true;const held=new Promise(r=>notifyHeld=r);await page.evaluate(()=>{window.opening=splitPaymentForm('Alice')});await held;await page.evaluate(()=>home());holdState=false;releaseState();await page.evaluate(()=>opening);assert.equal(await page.locator('#splitPaymentForm').count(),0);
  for(const width of [320,360,768]){await page.setViewportSize({width,height:800});await page.evaluate(()=>splitPaymentForm('Alice'));await check(1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)}
  assert.deepEqual(errors,[]);console.log('PASS wallet balances browser: all three children x free/card/minus; request wrappers ignored; stale data refresh; bound child identity; split sync baseline; savings chooser; failed sync is not zero; navigation race; 320/360/768px');
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
