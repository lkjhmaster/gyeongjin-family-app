import assert from 'node:assert/strict';
const base='https://gyeongjin-family-api.muse-hooni.workers.dev';
const origins=['https://gyeongjin-family-app.pages.dev','https://gyeongjin-family-app.muse-hooni.workers.dev'];
async function check(){
 for(const origin of origins){
  const response=await fetch(base+'/api/health',{headers:{origin},signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('access-control-allow-origin'),origin);
  const data=await response.json();
  assert.equal(data.service,'gyeongjin-family-api');assert.equal(data.database,true);
  assert.ok(data.features.includes('minus-repayment-cancel'));
  assert.ok(data.features.includes('minus-repayment-aggregate'));
  assert.ok(data.features.includes('split-payment'),'deployed API must support split payment');
  assert.equal(data.childTradeSchema,true,'production lifecycle schema must be ready');assert.ok(data.features.includes('child-trade-lifecycle-v2'));assert.ok(data.features.includes('child-trade-split-goods'));assert.ok(data.features.includes('child-trade-seller-receipt'));assert.ok(data.features.includes('child-trade-child-inbox'));assert.ok(data.features.includes('child-trade-loan-approval'),'deployed API must support child loan approval');
  if(process.env.EXPECTED_RELEASE)assert.equal(data.release,process.env.EXPECTED_RELEASE);
  const preflight=await fetch(base+'/api/allowance/minus-repayment/cancel',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'},signal:AbortSignal.timeout(15000)});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
  assert.ok(preflight.headers.get('access-control-allow-methods').includes('POST'));
  console.log('PASS API revision, D1 read and cancellation preflight: '+origin);
 }
}
for(let attempt=0;attempt<5;attempt++){
 try{await check();break}catch(error){if(attempt===4)throw error;await new Promise(resolve=>setTimeout(resolve,3000))}
}

