import { chromium } from 'playwright-core';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
const e=process.env,out=e.WHALE_EVIDENCE_DIR;
if(!out) throw Error('WHALE_EVIDENCE_DIR required');
await mkdir(out,{recursive:true});
const r={synthetic:true,cases:[],gaps:[],failures:[],limits:['No real SSH/task/schedule execution proof; no performance acceptance.']};
let browser;
try {
 const m=e.WHALE_LIFE_MANIFEST?JSON.parse(await readFile(e.WHALE_LIFE_MANIFEST,'utf8')):null;
 if(!m) r.gaps.push('Reviewed manifest missing');
 else {
 if(m.synthetic!==true) throw Error('Explicit synthetic manifest required');
 const s={root:'.whale-habitat',scenario:'select[aria-label="情境演示"]',cue:'[data-cue-kind][data-entity-id]',pause:'role=button[name="暂停海域"]',resume:'role=button[name="继续海域"]',...JSON.parse(e.WHALE_LIFE_SELECTORS||'{}')};
 const url=new URL(e.WHALE_LIFE_URL||e.WHALE_HABITAT_URL);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password) throw Error('HTTP URL without credentials required');
 browser=await chromium.launch({executablePath:e.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 page.on('pageerror',err=>r.failures.push(err.message));
 await page.goto(url.href,{waitUntil:'domcontentloaded'});
 for(const name of ['startup','ssh-online','task-running','task-verifying','task-completed','subagent','schedule','stale','no-subagents','no-schedules']){
 const c=m.cases?.find(x=>x.name===name),a={name,status:'unverified'};r.cases.push(a);
 if(!c){r.gaps.push(name+': missing expectation');continue;}
 try {
 if(!c.steps?.length||!c.cueText) throw Error('Ordered steps and readable cueText required');
 for(const value of c.steps) {
 await page.locator(s.scenario).selectOption(value);
 await page.waitForFunction(v=>Array.from(document.querySelectorAll('[data-demo-state]')).some(n=>n.getAttribute('data-demo-state')?.startsWith(v+':event:')),value,{timeout:10000});
 }
 await page.locator(".wlp").getByText(c.cueText,{exact:false}).first().waitFor({state:'visible'});
 a.cues=await page.locator(s.cue).evaluateAll(ns=>ns.map(n=>({kind:n.dataset.cueKind,entityId:n.dataset.entityId,text:n.textContent})));
 if(c.expectedCue){
 if(!c.expectedCue.entityId||!a.cues.some(x=>x.kind===c.expectedCue.kind&&x.entityId===c.expectedCue.entityId&&x.text.includes(c.cueText))) throw Error('Cue kind/text/entity ID mismatch');
 }else if(!c.noNewCue) throw Error('Independent cue expectation required');
 for(const k of c.forbiddenKinds||[]) if(a.cues.some(x=>x.kind===k)) throw Error('Forbidden cue '+k);
 await page.waitForFunction(({selector,expected})=>{
 const raw=document.querySelector(selector)?.getAttribute("data-habitat-metrics");if(!raw)return false;
 const m=JSON.parse(raw);return Object.entries(expected).every(([k,v])=>m[k]===v);
 },{selector:s.root,expected:c.entityCounts||{}},{timeout:15000});
 const raw=await page.locator(s.root).getAttribute('data-habitat-metrics');a.metrics=raw?JSON.parse(raw):null;
 for(const [key,value] of Object.entries(c.entityCounts||{})){
 if(!a.metrics||!Object.hasOwn(a.metrics,key))r.gaps.push(name+': count unavailable '+key);
 else if(a.metrics[key]!==value)throw Error('Renderer count mismatch '+key);
 }
 if(['no-subagents','no-schedules'].includes(name)&&!Object.keys(c.entityCounts||{}).length)r.gaps.push(name+': zero entity count unverified');
 await page.locator(s.pause).click();
 try{await page.screenshot({path:join(out,name+'.png'),fullPage:true,timeout:20000});}
 finally{await page.locator(s.resume).click();}
 a.status=r.gaps.some(x=>x.startsWith(name+':'))?'unverified':'passed';
 }catch(err){a.status='failed';a.error=err.message;r.failures.push(name+': '+err.message);}
 }
 }
}catch(err){r.failures.push(err.message);}
finally{
 await browser?.close();
 r.status=r.failures.length?'failed':r.gaps.length?'incomplete':'passed';
 await writeFile(join(out,'life-result.json'),JSON.stringify(r,null,2));
 console.log(JSON.stringify(r));process.exitCode=r.status==='passed'?0:1;
}
