import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const env = process.env;
const selectors = {
 root: '.whale-habitat', quality: '[aria-label="海域画质"]',
 pause: 'role=button[name="暂停海域"]', resume: 'role=button[name="继续海域"]',
 poster: 'img.whale-habitat__poster',
 task: 'button[aria-label^="打开任务"][data-task-id]',
 tasksTab: 'role=button[name=/^任务(?:\\s|$)/]',
 team: 'select[aria-label="筛选团队"]',
 deep: 'role=button[name=/深海遨游/]', surface: 'role=button[name=/海面呼吸/]',
 preview: 'select[aria-label="预览状态"]',
 detail: 'dialog[aria-label="预览详情"]',
 ...JSON.parse(env.WHALE_QA_SELECTORS ?? '{}'),
};
const output = env.WHALE_EVIDENCE_DIR;
if (!output) throw new Error('WHALE_EVIDENCE_DIR required');
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), cases: [], failures: [], gaps: [],
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
   const advancing = async () => { await root.scrollIntoViewIfNeeded(); await ready(); await wait(500); const a=await sample(); await wait(2200); const b=await sample();
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
    await page.locator(selectors.tasksTab).click();
    const team=page.locator(selectors.team);
    const teamId=await team.locator('option').evaluateAll(options=>options.find(o=>o.value)?.value);
    check(Boolean(teamId),'Fixture must contain a selectable team');
    await team.selectOption(teamId);
    check(await team.inputValue()===teamId,'Team selection identity mismatch');
    const task=page.locator(selectors.task).first();
    await task.waitFor({state:'visible'});
    const id=await task.getAttribute('data-task-id');
    check(Boolean(id),'Fixture task needs data-task-id');
    const teamTaskIds=JSON.parse(env.WHALE_QA_TEAM_TASK_IDS ?? '{}')[teamId];
    if(Array.isArray(teamTaskIds)) {
     const shown=await page.locator(selectors.task).evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-task-id')));
     check(shown.length>0 && shown.every(taskId=>teamTaskIds.includes(taskId)),'Displayed task IDs do not belong to selected fixture team');
    } else report.gaps.push('Independent fixture team/task identity map missing: '+teamId);
    await task.click();
    const detail=page.locator(selectors.detail);
    await detail.waitFor({state:'visible'});
    check(await detail.getAttribute('data-task-id')===id,'Wrong fixture task details opened');
    entry.taskInteraction={teamId,source:'synthetic-public-fixture',taskId:id,assertion:'detail identity only; no remote execution'};
    await page.screenshot({path:join(output,viewport.width+'-task.png'),fullPage:true});
    await page.keyboard.press('Escape');
    await detail.waitFor({state:'hidden'});
    await root.scrollIntoViewIfNeeded();
    entry.views=[];
    for(const view of ['deep','surface']) {
     const before=await sample();
     await page.locator(selectors[view]).click();
     await root.scrollIntoViewIfNeeded(); await advancing();
     const after=await sample();
     check(after.elapsed>=before.elapsed,'Scene switch reset elapsed');
     check(await root.locator('canvas').count()===1,'Scene switch must retain one Canvas');
     await page.locator(selectors.tasksTab).click();
     check(await team.inputValue()===teamId,'Scene switch lost selected team ID');
     const ids=await page.locator(selectors.task).evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-task-id')));
     check(ids.includes(id),'Selected team task lost across scene switch');
     await root.scrollIntoViewIfNeeded(); await advancing();
     await page.screenshot({path:join(output,viewport.width+'-'+view+'.png'),fullPage:true});
     entry.views.push({view,teamId,taskIds:ids});
    }
    // Renderer metrics must come from actual implementation, never a synthetic counter.
    const metricAttrs=JSON.parse(env.WHALE_QA_METRIC_ATTRS ?? '{}');
    if(metricAttrs.whales && metricAttrs.renderers) {
     const metrics=await root.evaluate((el,attrs)=>Object.fromEntries(
      Object.entries(attrs).map(([key,attr])=>[key,el.getAttribute(attr)])),metricAttrs);
     check(metrics.whales!==null && metrics.renderers!==null,'Missing renderer metrics');
     check(Number(metrics.whales)===3,'Three-team fixture must render three whales (maximum 3)');
     check(Number(metrics.renderers)===1,'Expected exactly one WebGLRenderer');
     entry.rendererMetrics=metrics;
    } else report.gaps.push('Renderer/whale metrics attributes pending parent integration: '+viewport.width);
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
     await root.scrollIntoViewIfNeeded(); await advancing();
     const start=Date.now(); let previous=await sample(); let lastProgress=Date.now(); const initial=previous;
     while(Date.now()-start<duration*1000) {
      await wait(2200); const current=await sample();
      check(current.frames>=previous.frames,'Long run frame reset');
      check(current.elapsed>=previous.elapsed,'Elapsed reset (including 36-second boundary)');
      if(current.frames>previous.frames) lastProgress=Date.now();
      check(Date.now()-lastProgress<10000,'No frame progress for 10 seconds');
      const seconds=current.elapsed-previous.elapsed;
      check(current.frames-previous.frames<=Math.ceil(24*seconds)+2,'Exceeded 24fps budget per reported elapsed');
      check(current.elapsed-initial.elapsed<=(Date.now()-start)/1000+1,'Elapsed advanced faster than visible runtime');
      previous=current;
     }
     entry.durationMs=Date.now()-start;
     await page.screenshot({path:join(output,'long-run.png')});
    }
    await page.locator(selectors.quality).selectOption('still');
    entry.previewStates=[];
    for(const state of ['empty','stale','unobserved']) {
     const requests=[];
     const track=request=>{if(['fetch','xhr','websocket'].includes(request.resourceType()))requests.push(request.url());};
     page.on('request',track);
     try {
      await page.locator(selectors.preview).selectOption(state); await wait(500);
      check(await page.locator(selectors.preview).inputValue()===state,'Preview state not applied');
      await page.locator(selectors.tasksTab).click();
      const text=await page.locator('.wlp').innerText();
      check(state==='empty'?/没有任务|尚无团队|安静海域|连接/.test(text):state==='stale'?/陈旧|上次观测/.test(text):/未观测/.test(text),'Missing preview state explanation');
      if(state==='empty') check(await page.locator(selectors.task).count()===0,'Empty state contains tasks');
      check(requests.length===0,'Preview state caused web data requests');
      await page.screenshot({path:join(output,viewport.width+'-'+state+'.png'),fullPage:true});
      entry.previewStates.push({state,requests});
     } finally {page.off('request',track);}
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
 report.status=report.failures.length?'failed':report.gaps.length?'incomplete':'passed';
 await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({status:report.status,failures:report.failures,output}));
 process.exitCode=report.failures.length||report.gaps.length?1:0;
}
