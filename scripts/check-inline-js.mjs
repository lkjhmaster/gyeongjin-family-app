import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync('index.html','utf8');
const blocks=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).filter(s=>s.trim());
if(!blocks.length)throw new Error('No inline JavaScript found');
blocks.forEach((code,i)=>new vm.Script(code,{filename:'index.html:inline-script-'+(i+1)}));
console.log('Inline JavaScript syntax OK ('+blocks.length+' block'+(blocks.length===1?'':'s')+')');
