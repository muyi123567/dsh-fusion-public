import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const env = process.env;
const selectors = {
 root: '.whale-habitat', quality: '[aria-label="海域画质"]',
 pause: 'role=button[name="暂停海域"]', resume: 'role=button[name="继续海域"]',
 poster: 'img.whale-habitat__poster',
 task: 'button[aria-label^="打开任务"][data-task-id]',
 detail: 'dialog[aria-label="预览详情"]',
 ...JSON.parse(env.WHALE_QA_SELECTORS ?? '{}'),
};
const output = env.WHALE_EVIDENCE_DIR;
if (!output) throw new Error('WHALE_EVIDENCE_DIR required');
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), cases: [], failures: [],
 limits: ['Software WebGL frame rates do not prove physical GPU performance or energy consumption.',
 'DOM telemetry and screenshots require visual review; task interaction does not prove remote execution.',
 'Hidden simulation overrides visibilityState; real OS backgrounding remains a manual check.'] };
let browser;
const check = (value, message) => { if (!value) throw new Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(name, action) {
 const entry = { name, samples: [] }; report.cases.push(entry);
 try { await action(entry); entry.status = report.failures.includes(name) ? 'failed' : 'passed'; }
 catch (error) { entry.status = 'failed'; entry.error = error.message; report.failures.push(name); }
 await writeFile(join(output,'result.json'),JSON.stringify({...report,status:'running'},null,2)+'\n');
 console.log(JSON.stringify({case:name,status:entry.status,error:entry.error}));
}
try {
 const url = new URL(env.WHALE_HABITAT_URL);
 check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'HTTP URL without credentials required');
 report.target = url.origin + url.pathname;
 const duration = Number(env.WHALE_QA_DURATION_SECONDS ?? 90);
 check(Number.isFinite(duration) && duration >= 90, 'Duration must be at least 90 seconds');
 browser = await chromium.launch({ executablePath: env.CHROMIUM_PATH ?? '/usr/bin/chromium',
 headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
 report.browser = browser.version();
 for (const viewport of [{width:1536,height:960},{width:1280,height:720},{width:390,height:844}]) {
  await run('viewport-' + viewport.width, async entry => {
   const context = await browser.newContext({ viewport, reducedMotion:'no-preference' });
   const page = await context.newPage();
   const errors = [];
   page.on('pageerror', error => errors.push(error.message));
   page.on('console', message => { if(message.type()==='error') errors.push(message.text()); });
   const root = page.locator(selectors.root);
   const sample = async () => {
    const s = await root.evaluate(el => ({
     frames:Number(el.dataset.habitatFrames), elapsed:Number(el.dataset.habitatElapsed),
     state:el.dataset.habitatState, quality:el.dataset.habitatQuality,
    }));
    check(Number.isFinite(s.frames) && Number.isFinite(s.elapsed), 'Missing finite data-habitat-frames/data-habitat-elapsed');
    entry.samples.push({at:Date.now(),...s}); return s;
   };
   const ready = async () => page.waitForFunction(selector => {
    const el=document.querySelector(selector);
    return el?.dataset.habitatState==='running' && Number(el.dataset.habitatFrames)>0;
   }, selectors.root, {timeout:30000});
   const advancing = async () => { await ready(); const a=await sample(); await wait(2200); const b=await sample();
    check(b.frames>a.frames && b.elapsed>a.elapsed, 'Render frames/time did not advance'); };
   const stopped = async () => { await wait(1200); const a=await sample(); await wait(2200);
    const b=await sample(); check(b.frames===a.frames && b.elapsed===a.elapsed,'Rendering continued while stopped'); };
   try {
    await page.goto(url.href, {waitUntil:'domcontentloaded'});
    await root.waitFor({state:'visible'});
    check(await root.count()===1,'Habitat root must be unique');
    await page.locator(selectors.quality).selectOption('balanced');
    await advancing();
    check(await root.locator('canvas').count()===1,'Expected single Canvas');
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Horizontal overflow');
    await page.screenshot({path:join(output,viewport.width+'-running.png'),fullPage:true});
    for(const quality of ['eco','auto','balanced']) {
     await page.locator(selectors.quality).selectOption(quality);
     await page.waitForFunction(({s,q})=>{
      const actual=document.querySelector(s)?.dataset.habitatQuality;
      return q==='auto' ? ['balanced','eco'].includes(actual) : actual===q;
     },{s:selectors.root,q:quality});
     check(await page.locator(selectors.quality).inputValue()===quality,'Quality selection not retained');
     await advancing();
    }
    await page.locator(selectors.pause).click(); await stopped();
    await page.screenshot({path:join(output,viewport.width+'-paused.png')});
    await page.locator(selectors.resume).click(); await advancing();
    const task=page.locator(selectors.task).first();
    await task.waitFor({state:'visible'});
    const id=await task.getAttribute('data-task-id');
    check(Boolean(id),'Fixture task needs data-task-id');
    await task.click();
    const detail=page.locator(selectors.detail);
    await detail.waitFor({state:'visible'});
    check(await detail.getAttribute('data-task-id')===id,'Wrong fixture task details opened');
    entry.taskInteraction={source:'synthetic-public-fixture',taskId:id,assertion:'detail identity only; no remote execution'};
    await page.screenshot({path:join(output,viewport.width+'-task.png'),fullPage:true});
    await page.keyboard.press('Escape');
    await detail.waitFor({state:'hidden'});
    await root.scrollIntoViewIfNeeded();
    await page.locator(selectors.quality).selectOption('still'); await stopped();
    await page.locator(selectors.poster).waitFor({state:'visible'});
    await page.screenshot({path:join(output,viewport.width+'-still.png')});
    await page.locator(selectors.quality).selectOption('balanced'); await advancing();
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});
     Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
    check(await page.evaluate(()=>document.hidden),'Hidden simulation failed');
    await stopped();
    await page.evaluate(()=>{delete document.visibilityState;delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
    await advancing();
    const oldStyle=await root.getAttribute('style');
    try {
     await root.evaluate(el=>{el.style.position='fixed';el.style.top='-20000px';el.style.bottom='auto';});
     await stopped();
    } finally { await root.evaluate((el,style)=>{if(style===null)el.removeAttribute('style');else el.setAttribute('style',style);},oldStyle); }
    await root.scrollIntoViewIfNeeded(); await advancing();
    if(viewport.width===1536) {
     const start=Date.now(); let previous=await sample();
     while(Date.now()-start<duration*1000) {
      await wait(1000); const current=await sample();
      check(current.frames>previous.frames,'Long run frame stall/reset');
      check(current.elapsed>previous.elapsed,'Elapsed reset/stall (including 36-second boundary)');
      previous=current;
     }
     entry.durationMs=Date.now()-start;
     await page.screenshot({path:join(output,'long-run.png')});
    }
    check(errors.length===0,'Page/console errors: '+errors.join('; '));
   } finally {
    entry.pageErrors=errors;
    if(errors.length && !report.failures.includes(entry.name)) { entry.status='failed'; report.failures.push(entry.name); }
    await context.close();
   }
  });
 }
 await run('reduced-motion-and-cold-still', async entry=>{
  for(const mode of ['reduced','still']) {
   const context=await browser.newContext({viewport:{width:1280,height:720}, reducedMotion:mode==='reduced'?'reduce':'no-preference'});
   const staticUrl=new URL(url);
   if(mode==='still') staticUrl.searchParams.set('quality','still');
   // Observe WebGL creation before application scripts, without replacing their result.
   await context.addInitScript(()=>{
    window.__whaleQaWebglContexts=0;
    const original=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(type,...args){
     const result=original.call(this,type,...args);
     if(/^webgl2?$|^experimental-webgl$/.test(type) && result) window.__whaleQaWebglContexts++;
     return result;
    };
   });
   const page=await context.newPage(); const assets=[]; const errors=[];
   page.on('request',request=>{if(/\.(glb|gltf|ktx2?)(\?|$)|(?:habitat|ambient).*scene|scene.*(?:habitat|ambient)/i.test(request.url()))assets.push(request.url());});
   page.on('pageerror',e=>errors.push(e.message));
   page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
   try {
    await page.goto(staticUrl.href,{waitUntil:'domcontentloaded'});
    const root=page.locator(selectors.root); await root.waitFor({state:'visible'});
    await page.locator(selectors.poster).waitFor({state:'visible'});
    await wait(2500);
    const staticState=await root.evaluate(el=>({
     frames:Number(el.dataset.habitatFrames), contexts:window.__whaleQaWebglContexts
    }));
    check(staticState.frames===0,'Static entry rendered frames');
    check(staticState.contexts===0,'Static entry created WebGL context');
    entry[mode]={staticState};
    check(assets.length===0,'Static entry requested 3D assets');
    check(errors.length===0,'Static entry page errors');
    await page.screenshot({path:join(output,mode+'.png'),fullPage:true});
    entry[mode]={...entry[mode],assets,errors};
   } finally { await context.close(); }
  }
 });
} catch(error) { report.failures.push(error.message); }
finally {
 await browser?.close().catch(error=>report.failures.push(error.message));
 report.finishedAt=new Date().toISOString();
 report.status=report.failures.length?'failed':'passed';
 await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({status:report.status,failures:report.failures,output}));
 process.exitCode=report.failures.length?1:0;
}
