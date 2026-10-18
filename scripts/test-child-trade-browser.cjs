const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const {fixture}=await import('./trade-test-fixture.mjs');const h=await fixture();
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(fs.readFileSync('index.html'))});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
 try{
  const context=await browser.newContext({viewport:{width:1100,height:850},serviceWorkers:'block'}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept(d.type()==='prompt'?'test reason':undefined));
  await page.route('https://gyeongjin-family-api.muse-hooni.workers.dev/**',async route=>{
   const r=route.request(),actor=(r.headers().authorization||'Bearer a').slice(7),path=new URL(r.url()).pathname.replace(/^\/api/,'')+new URL(r.url()).search;
   const headers={'access-control-allow-origin':'*','access-control-allow-headers':'content-type,authorization','access-control-allow-methods':'GET,POST,PUT,OPTIONS'};
   if(r.method()==='OPTIONS'){await route.fulfill({status:204,headers});return}
   const response=await h.call(actor,path,r.postData()?JSON.parse(r.postData()):undefined,r.method());await route.fulfill({status:response.status,json:response.data,headers});
  });
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>typeof childTradePreview==='function');
  const account=async id=>page.evaluate(async id=>{const names={a:'Alice',b:'Bob',c:'Cara',p:'Parent'};sessionStorage.setItem('gyeongjin_auth_token',id);currentAccount={id,name:names[id],isAdmin:id==='p',role:id==='p'?'parent':'child'};localStorage.setItem('gyeongjin_current_member',names[id]);family.members=Object.entries(names).map(([k,name])=>({name,role:k==='p'?'부모':'자녀'}));await pullFamilyState();},id);
  const click=async(name,text)=>{await page.getByRole('button',{name,exact:true}).click();if(text)await page.getByText(text,{exact:true}).waitFor()};
  const detail=async(actor,id)=>{await account(actor);await page.evaluate(id=>childTradeDetail(id),id)};
  await account('a');await page.evaluate(()=>childTradePreview('Alice'));await click('대여·물품 거래 신청');await page.locator('#tradePerson').waitFor();
  await page.locator('#tradePerson').selectOption('b');await page.locator('#tradeSource').selectOption('card');await page.locator('#tradeDestination').selectOption('free');await page.locator('#tradeGross').fill('1000');await page.locator('#tradeTitle').fill('<img src=x onerror="alert(1)">');
  await click('금액 확인 후 신청');await page.getByRole('heading',{name:'거래 상세',exact:true}).waitFor();assert.equal(await page.locator('img[src="x"]').count(),0);
  const loanId=h.sql.prepare("SELECT id FROM child_trade_transactions WHERE kind='loan'").get().id;
  await detail('b',loanId);await click('조건 확인·동의','부모 승인 대기');assert.equal(await page.getByRole('button',{name:'승인·송금',exact:true}).count(),0);
  await account('p');await page.evaluate(()=>approvalCenter());await click('조건 확인·승인');await click('승인·송금','상환 중');assert.equal(h.sql.prepare('SELECT outstanding_amount n FROM child_trade_loans').get().n,500);
  await detail('a',loanId);await click('일부·전액 상환 신청');await page.locator('#tradeGross').fill('400');await page.locator('#tradeSource').selectOption('card');await page.locator('#tradeDestination').selectOption('free');await click('금액 확인 후 신청');await page.getByRole('heading',{name:'거래 상세',exact:true}).waitFor();
  const repay=h.sql.prepare("SELECT id FROM child_trade_transactions WHERE kind='repayment'").get().id;await detail('b',repay);await click('조건 확인·동의','부모 승인 대기');await detail('p',repay);await click('승인·송금','완료');assert.equal(h.sql.prepare('SELECT outstanding_amount n FROM child_trade_loans').get().n,300);
  const goods=await h.create('goods',{gross:1000,destinationWallet:'card'});await h.approve(goods);await detail('a',goods);await click('물품 전달·수령 확인','전달 확인 중');await detail('b',goods);await click('물품 전달·수령 확인','완료');assert.equal(h.row(goods).status,'settled');
  await page.screenshot({path:'child-trades-desktop.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
  console.log('PASS browser: quote, request, mutual consent, unified parent approval, repayment, dual delivery, escaping, no desktop overflow or script errors');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1});
