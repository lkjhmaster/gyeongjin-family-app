import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const base=process.env.APP_BASE||'https://gyeongjin-family-app.muse-hooni.workers.dev';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(let attempt=0;attempt<10;attempt++){
 try{
  for(const [route,file] of [['/','index.html'],['/sw.js','sw.js']]){
   const response=await fetch(base+route,{headers:{'cache-control':'no-cache'},signal:AbortSignal.timeout(15000)});
   assert.equal(response.status,200,route);
   const bytes=Buffer.from(await response.arrayBuffer());
   assert.equal(hash(bytes),hash(readFileSync(file)),file+' must match the checked-out release');
  }
  console.log('PASS deployed HTML and service worker exactly match this release: '+base);
  break;
 }catch(error){
  if(attempt===9)throw error;
  console.log('Waiting for deployment propagation: '+error.message);
  await new Promise(resolve=>setTimeout(resolve,3000));
 }
}
