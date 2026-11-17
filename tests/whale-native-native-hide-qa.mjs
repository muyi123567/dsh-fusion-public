import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import adapter from './whale-native-rc3-adapter.mjs';

const env = process.env;
assert.equal(env.WHALE_QA_ISOLATED_PROFILE, '1');
for (const key of ['CHROMIUM_PATH', 'WHALE_NATIVE_LOGIN_URL', 'WHALE_EVIDENCE_DIR',
  'WHALE_PERF_MODULE', 'WHALE_PERF_SOURCE', 'WHALE_PERF_DIST', 'WHALE_PERF_PACKAGE', 'WHALE_QA_DEMO_SNAPSHOT'])
  assert(env[key], 'Missing QA input: ' + key);
await mkdir(env.WHALE_EVIDENCE_DIR, { recursive: true });
const { createNativeOceanPerformanceQA } = await import(pathToFileURL(path.resolve(env.WHALE_PERF_MODULE)).href);
const browser = await chromium.launch({ executablePath: env.CHROMIUM_PATH, headless: true,
  args: ['--disable-dev-shm-usage', ...(env.WHALE_QA_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] });
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 1024 } });
const p = await context.newPage();
p.setDefaultTimeout(12000);
const report = { mode: 'targeted-native-hide-observation', modelOrTaskWriteAttempts: 0, pageErrors: 0,
  note: 'Independent native actions; D performance assertions are unchanged. State reset is an observation, not a retention pass.' };
p.on('pageerror', () => report.pageErrors++);
await context.route('**/*', route => {
  const request = route.request();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && adapter.isModelOrTaskWrite(request)) {
    report.modelOrTaskWriteAttempts++; return route.abort('blockedbyclient');
  }
  return route.continue();
});
const chunks = [], pending = [];
const names = ['client.workspace.js', 'client.native-ocean.js', 'client.ocean-scene.js'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
p.on('response', response => {
  const name = names.find(name => new URL(response.url()).pathname.endsWith('/' + name));
  if (!name) return;
  pending.push((async () => {
    const served = await response.body(), packaged = await readFile(path.join(env.WHALE_PERF_DIST, name));
    chunks.push({ name, servedBytes: served.length, packageBytes: packaged.length,
      servedSha256: sha(served), packageSha256: sha(packaged),
      servedSourceMapTrailer: /\/\/# sourceMappingURL=[^\r\n]+\r?\n?$/.test(served.toString('utf8')),
      packageSourceMapTrailer: /\/\/# sourceMappingURL=[^\r\n]+\r?\n?$/.test(packaged.toString('utf8')) });
  })());
});
const host = () => p.locator('[data-sidebar-right-panel="push"][data-sidebar-right-open]');
const ocean = () => adapter.panel(p).getByRole('region', { name: '团队海域', exact: true });
const sample = () => p.evaluate(() => window.__whaleNativePerf.sample());
const submissions = value => value.contexts.reduce((n, c) => n + c.submissions, 0);
const shot = name => p.screenshot({ path: path.join(env.WHALE_EVIDENCE_DIR, name + '.png') });
let routeMatch, routeHandler, stage = 'probe-attach';
try {
  await createNativeOceanPerformanceQA(p, { sourceRoot: env.WHALE_PERF_SOURCE,
    distRoot: env.WHALE_PERF_DIST, packagePath: env.WHALE_PERF_PACKAGE,
    output: path.join(env.WHALE_EVIDENCE_DIR, 'probe-artifacts') });
  try {
    await p.goto(env.WHALE_NATIVE_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await p.waitForURL(u => !u.searchParams.has('token'), { timeout: 30000 });
  } catch { throw new Error('Navigation details withheld'); }
  await adapter.prepareEmptySession(p); await adapter.openPanel(p);
  report.realStateBefore = await adapter.assertRealEmptyState(p);
  const payload = JSON.parse(await readFile(env.WHALE_QA_DEMO_SNAPSHOT, 'utf8'));
  assert.equal(payload.demo, true);
  const origin = new URL(p.url()).origin;
  routeMatch = u => u.origin === origin && u.pathname === '/plugins/dsh-fusion/state';
  routeHandler = route => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }) : route.fallback();
  await p.route(routeMatch, routeHandler);
  await adapter.panel(p).getByRole('button', { name: '刷新', exact: true }).click();
  await adapter.panel(p).getByText(payload.tasks[0].goal, { exact: true }).waitFor();
  stage = 'positive-draw-baseline';
  await adapter.panel(p).getByRole('button', { name: '海域', exact: true }).click();
  await ocean().getByRole('combobox', { name: '海域质量', exact: true }).selectOption('balanced');
  await p.waitForFunction(() => window.__whaleNativePerf.sample().contexts.some(c => c.draws > 0), undefined, { timeout: 20000 });
  const before = await sample(); await p.waitForTimeout(600); const advancing = await sample();
  assert(submissions(advancing) > submissions(before), 'Real submissions baseline must advance');
  const tabId = await adapter.panel(p).getAttribute('data-sidebar-right-tab');
  const sessionId = await host().getAttribute('data-sidebar-right-session');
  stage = 'native-hide';
  await host().locator('[data-sidebar-right-toggle]').click();
  await host().waitFor({ state: 'hidden' });
  await p.waitForTimeout(700); const hiddenA = await sample();
  await p.waitForTimeout(1800); const hiddenB = await sample();
  report.hidden = { before: hiddenA, after: hiddenB,
    submissionsStopped: submissions(hiddenA) === submissions(hiddenB),
    timersStopped: hiddenA.scheduler.timerFired === hiddenB.scheduler.timerFired,
    allContextsLost: hiddenB.contexts.every(c => c.lost) };
  assert(report.hidden.submissionsStopped && report.hidden.timersStopped && report.hidden.allContextsLost);
  await shot('native-hidden');
  stage = 'native-reopen';
  await p.getByRole('button', { name: '打开右侧边栏', exact: true }).click();
  await host().waitFor();
  await adapter.panel(p).getByRole('button', { name: '任务', exact: true }).waitFor();
  assert.equal(await adapter.panel(p).getAttribute('data-sidebar-right-tab'), tabId);
  assert.equal(await host().getAttribute('data-sidebar-right-session'), sessionId);
  report.reopened = {
    sameNativeTabAndSession: true,
    tasksSelected: await adapter.panel(p).getByRole('button', { name: '任务', exact: true }).getAttribute('aria-pressed') === 'true',
    oceanRegionCount: await ocean().count(),
    oceanVisible: await ocean().isVisible().catch(() => false),
  };
  await shot('native-reopened-current-tab');
  await adapter.panel(p).getByRole('button', { name: '海域', exact: true }).click();
  report.reopened.oceanQualityAfterReentry = await ocean().getByRole('combobox', { name: '海域质量', exact: true }).inputValue();
  await shot('native-reopened-ocean-preferences');
  await ocean().getByRole('combobox', { name: '海域质量', exact: true }).selectOption('still');
  report.retention = report.reopened.tasksSelected || report.reopened.oceanQualityAfterReentry !== 'balanced'
    ? 'native collapse resets panel/ocean state; product limitation observed'
    : 'observed preference retained';
  stage = 'restore-real-source';
  await p.unroute(routeMatch, routeHandler); routeMatch = undefined;
  await adapter.panel(p).getByRole('button', { name: '任务', exact: true }).click();
  await adapter.panel(p).getByRole('button', { name: '刷新', exact: true }).click();
  report.realStateAfter = await adapter.assertRealEmptyState(p);
  assert.equal(report.modelOrTaskWriteAttempts, 0); assert.equal(report.pageErrors, 0);
  report.status = 'observations-complete';
} catch (error) {
  report.status = 'failed';
  report.failure = { stage, kind: error.name, message: 'Sensitive browser details withheld' };
  await shot('failure').catch(() => {}); process.exitCode = 1;
} finally {
  if (routeMatch) await p.unroute(routeMatch, routeHandler).catch(() => {});
  await Promise.allSettled(pending);
  report.chunkTransport = chunks;
  await writeFile(path.join(env.WHALE_EVIDENCE_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log('NATIVE_HIDE', JSON.stringify({ status: report.status, hidden: report.hidden && {
    submissionsStopped: report.hidden.submissionsStopped, timersStopped: report.hidden.timersStopped,
    allContextsLost: report.hidden.allContextsLost }, reopened: report.reopened, retention: report.retention,
    pageErrors: report.pageErrors, modelOrTaskWriteAttempts: report.modelOrTaskWriteAttempts, failure: report.failure, chunkTransport: chunks }));
  await context.close(); await browser.close();
}
