import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
import adapter from './whale-native-rc3-adapter.mjs';
import { verifyInstalledNativeArtifacts } from './whale-native-artifact-binding.mjs';

const env = process.env;
for (const key of ['WHALE_NATIVE_LOGIN_URL', 'CHROMIUM_PATH', 'WHALE_EVIDENCE_DIR',
  'WHALE_QA_CWD', 'WHALE_QA_TGZ', 'WHALE_QA_ARTIFACT_SHA256', 'WHALE_QA_INSTALLED_DIST',
  'WHALE_QA_EXTENSION_FIXTURE', 'WHALE_QA_DEMO_SNAPSHOT'])
  assert(env[key], 'Missing QA input: ' + key);
assert.equal(env.WHALE_QA_ISOLATED_PROFILE, '1');
await mkdir(env.WHALE_EVIDENCE_DIR, { recursive: true });
const artifactBinding = await verifyInstalledNativeArtifacts({ packagePath: env.WHALE_QA_TGZ,
  installedDist: env.WHALE_QA_INSTALLED_DIST, expectedSha256: env.WHALE_QA_ARTIFACT_SHA256 });
const actualSha256 = artifactBinding.artifactSha256;
const report = { mode: 'candidate-source-and-public-extension', artifactSha256: actualSha256, artifactBinding,
  checks: [], modelOrTaskWriteAttempts: 0, pageErrors: 0, consoleErrors: 0,
  scope: 'Real nodes source notice and candidate hash; reuses prior R3 settings/navigation/width acceptance' };
const browser = await chromium.launch({ executablePath: env.CHROMIUM_PATH, headless: true,
  args: ['--disable-dev-shm-usage', ...(env.WHALE_QA_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] });
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 1024 } });
const p = await context.newPage();
p.setDefaultTimeout(12000);
p.on('pageerror', () => report.pageErrors++);
p.on('console', message => { if (message.type() === 'error') report.consoleErrors++; });
await context.route('**/*', route => {
  const request = route.request();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && adapter.isModelOrTaskWrite(request)) {
    report.modelOrTaskWriteAttempts++; return route.abort('blockedbyclient');
  }
  return route.continue();
});
let stage = 'native-login';
let extension, routeMatch, routeHandler;
try {
  try {
    await p.goto(env.WHALE_NATIVE_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await p.waitForURL(u => !u.searchParams.has('token') && !u.hash.includes('token'), { timeout: 30000 });
  } catch { throw new Error('Sensitive navigation details withheld'); }
  await adapter.prepareEmptySession(p);
  const { installNativeExtensionFixture } = await import(pathToFileURL(path.resolve(env.WHALE_QA_EXTENSION_FIXTURE)).href);
  extension = await installNativeExtensionFixture(p);
  await adapter.openPanel(p);
  await p.waitForFunction(() => window.__DSH_FUSION_TASK_VIEWS__?.ready === true);
  report.publicReady = await p.evaluate(() => {
    const api = window.__DSH_FUSION_TASK_VIEWS__;
    return { ready: api.ready, version: api.version, api: api.api, register: api.has('register'), list: api.has('list') };
  });
  assert.equal(report.publicReady.ready, true); assert.equal(report.publicReady.api.major, 1);
  assert.equal(report.publicReady.register, true); assert.equal(report.publicReady.list, true);
  stage = 'real-source-condition';
  report.realSource = await p.evaluate(async () => {
    const response = await fetch('/plugins/dsh-fusion/state', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Real source read failed');
    const data = await response.json();
    return { demo: data.demo === true, nodesSource: data.sources?.nodes ?? null,
      nodes: Array.isArray(data.nodes) ? data.nodes.length : null,
      tasks: Array.isArray(data.tasks) ? data.tasks.length : null };
  });
  assert.equal(report.realSource.demo, false);
  assert.equal(report.realSource.nodesSource, 'unavailable', 'Real unavailable-source precondition was not observed');
  assert.equal(report.realSource.nodes, 0);
  assert.equal(report.realSource.tasks, 0);
  stage = 'native-source-notice';
  await adapter.panel(p).getByRole('button', { name: '主机', exact: true }).click();
  // Exact copy comes from B's collectionNotice + empty-row contract, not a guessed host label.
  const message = env.WHALE_QA_SOURCE_MESSAGE || '主机来源不可用，暂不能确认当前记录。';
  await adapter.panel(p).getByText(message, { exact: true }).waitFor();
  assert.equal(await adapter.panel(p).getByText('当前来源暂无记录。', { exact: true }).isVisible(), false,
    'Unavailable nodes source must not be described as a legal empty collection');
  await adapter.resizePanel(p, 420);
  assert.equal(await p.locator('[data-dsh-fusion-overlay]').count(), 0);
  assert.equal(await p.locator('[role="dialog"]:visible').count(), 0);
  const chat = adapter.chat(p), composer = adapter.composer(p);
  assert(await chat.isVisible() && await composer.isVisible());
  assert(await chat.evaluate(e => !e.closest('[inert]')));
  await p.screenshot({ path: path.join(env.WHALE_EVIDENCE_DIR, 'native-source-unavailable.png') });
  report.checks.push('real sources.nodes=unavailable and nodes=[]; precise unavailable notice replaces legal-empty text');
  report.checks.push('native push sidebar at 420px; original chat/composer remain visible without overlay');
  stage = 'public-extension-minimal-fixture';
  const demo = JSON.parse(await readFile(env.WHALE_QA_DEMO_SNAPSHOT, 'utf8'));
  assert.equal(demo.demo, true);
  const origin = new URL(p.url()).origin;
  routeMatch = u => u.origin === origin && u.pathname === '/plugins/dsh-fusion/state';
  routeHandler = route => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(demo) }) : route.fallback();
  await p.route(routeMatch, routeHandler);
  await adapter.panel(p).getByRole('button', { name: '任务', exact: true }).click();
  await adapter.panel(p).getByRole('button', { name: '刷新', exact: true }).click();
  await adapter.panel(p).getByText(demo.tasks[0].goal, { exact: true }).waitFor();
  await adapter.panel(p).getByRole('combobox', { name: '任务视图', exact: true })
    .selectOption('whale-native-extension-qa-fixture');
  await p.waitForFunction(() => !!window.__WHALE_NATIVE_EXTENSION_QA__?.observation);
  const observed = await extension.inspect();
  assert(observed.readiness.every(Boolean));
  assert(observed.staleErrors.every(error => error === null));
  assert.deepEqual([...observed.observation.taskIds].sort(), demo.tasks.map(t => t.id).sort());
  assert.deepEqual([...observed.observation.nodeIds].sort(), demo.nodes.map(n => n.id).sort());
  assert.deepEqual([...observed.observation.topologyTaskIds].sort(), demo.tasks.map(t => t.id).sort());
  assert.equal(observed.observation.dispatchAvailable, false);
  assert.equal(observed.observation.cancelAvailable, false);
  assert((await adapter.panel(p).innerText()).includes('QA FIXTURE · collection'));
  report.extension = { input: 'explicit demo:true; only same-origin exact state GET intercepted',
    generations: observed.generations, taskCount: observed.observation.taskIds.length,
    nodeCount: observed.observation.nodeIds.length, topologyVersion: observed.observation.topologyVersion,
    dispatchAvailable: false, cancelAvailable: false, readiness: observed.readiness };
  await p.screenshot({ path: path.join(env.WHALE_EVIDENCE_DIR, 'DEMO-public-extension-fixture.png') });
  report.checks.push('public global ready and API major 1; provided fixture registers/renders DEMO tasks/nodes/topology with write callbacks absent');
  await adapter.panel(p).getByRole('combobox', { name: '任务视图', exact: true }).selectOption('');
  await extension.dispose(); extension = undefined;
  if (env.WHALE_QA_PUBLIC_PREVIEW === '1') {
    stage = 'explicit-demo-public-preview';
    await adapter.panel(p).getByRole('combobox', { name: '任务视图', exact: true }).waitFor({ state: 'hidden' });
    await adapter.panel(p).getByText(demo.tasks[0].goal, { exact: true }).waitFor();
    await adapter.resizePanel(p, 420);
    await p.screenshot({ path: path.join(env.WHALE_EVIDENCE_DIR, 'DEMO-final-420-tasks.png') });
    await adapter.panel(p).getByRole('button', { name: '海域', exact: true }).click();
    const ocean = adapter.panel(p).getByRole('region', { name: '团队海域', exact: true });
    await ocean.getByRole('combobox', { name: '海域质量', exact: true }).selectOption('balanced');
    await p.waitForFunction(() => {
      const el = document.querySelector('section[aria-label="团队海域"] .whale-habitat');
      return el?.dataset.habitatState === 'running' && Number(el.dataset.habitatFrames) > 0;
    }, undefined, { timeout: 20000 });
    await p.screenshot({ path: path.join(env.WHALE_EVIDENCE_DIR, 'DEMO-final-420-ocean.png') });
    report.previewArtifacts = { input: 'explicit demo:true; QA extension disposed before screenshots',
      panelWidth: 420, fullHostViewport: '1536x1024', files: ['DEMO-final-420-tasks.png', 'DEMO-final-420-ocean.png'] };
    await adapter.panel(p).getByRole('button', { name: '任务', exact: true }).click();
  }
  await p.unroute(routeMatch, routeHandler); routeMatch = undefined;
  await adapter.panel(p).getByRole('button', { name: '刷新', exact: true }).click();
  report.realStateAfter = await adapter.assertRealEmptyState(p);
  assert.equal(report.modelOrTaskWriteAttempts, 0); assert.equal(report.pageErrors, 0);
  assert.equal(report.consoleErrors, 0);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { stage, kind: error.name, message: 'Private browser details withheld' };
  await p.screenshot({ path: path.join(env.WHALE_EVIDENCE_DIR, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (routeMatch) await p.unroute(routeMatch, routeHandler).catch(() => {});
  if (extension) await extension.dispose().catch(() => {});
  await writeFile(path.join(env.WHALE_EVIDENCE_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log('SOURCE_STATUS', JSON.stringify(report));
  await context.close(); await browser.close();
}
