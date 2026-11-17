import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import adapter from './whale-native-rc3-adapter.mjs';

const env = process.env;
for (const name of ['WHALE_NATIVE_LOGIN_URL', 'CHROMIUM_PATH', 'WHALE_EVIDENCE_DIR',
  'WHALE_QA_CWD', 'WHALE_PERF_MODULE', 'WHALE_PERF_SOURCE', 'WHALE_PERF_DIST', 'WHALE_PERF_PACKAGE',
  'WHALE_QA_DEMO_SNAPSHOT'])
  assert(env[name], 'Missing environment input: ' + name);
assert.equal(env.WHALE_QA_ISOLATED_PROFILE, '1');
await mkdir(env.WHALE_EVIDENCE_DIR, { recursive: true });
const { createNativeOceanPerformanceQA } = await import(pathToFileURL(path.resolve(env.WHALE_PERF_MODULE)).href);
const browser = await chromium.launch({ executablePath: env.CHROMIUM_PATH, headless: true,
  args: ['--disable-dev-shm-usage', ...(env.WHALE_QA_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] });
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 1024 } });
const p = await context.newPage();
p.setDefaultTimeout(12000);
const report = { mode: 'native-ocean-performance-only', modelOrTaskWriteAttempts: 0, pageErrors: 0, consoleErrors: 0 };
p.on('pageerror', () => report.pageErrors++);
p.on('console', message => { if (message.type() === 'error') report.consoleErrors++; });
await context.route('**/*', route => {
  const request = route.request();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && adapter.isModelOrTaskWrite(request)) {
    report.modelOrTaskWriteAttempts++;
    return route.abort('blockedbyclient');
  }
  return route.continue();
});
let stage = 'attach-before-navigation';
try {
  const perf = await createNativeOceanPerformanceQA(p, {
    sourceRoot: env.WHALE_PERF_SOURCE, distRoot: env.WHALE_PERF_DIST,
    packagePath: env.WHALE_PERF_PACKAGE, output: path.join(env.WHALE_EVIDENCE_DIR, 'performance'),
    fixturePath: env.WHALE_QA_DEMO_SNAPSHOT, reopenPanel: () => adapter.openPanel(p),
  });
  stage = 'native-login-and-empty-session';
  try {
    await p.goto(env.WHALE_NATIVE_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await p.waitForURL(u => !u.searchParams.has('token') && !u.hash.includes('token'), { timeout: 30000 });
  } catch { throw new Error('Native navigation failed; sensitive URL withheld'); }
  await adapter.prepareEmptySession(p);
  await adapter.openPanel(p);
  await adapter.panel(p).getByRole('button', { name: '任务', exact: true }).waitFor();
  report.realStateBefore = await adapter.assertRealEmptyState(p);
  stage = 'ocean-performance';
  const result = await perf.run({ panel: adapter.panel(p) });
  report.performance = { status: result.status, counts: result.counts,
    cases: result.cases.map(({ name, status, reason }) => ({ name, status, ...(reason ? { reason } : {}) })) };
  assert(!result.cases.some(item => item.status === 'failed'), 'Ocean browser assertion failed');
  assert(!result.artifacts.checks.some(item => item.status === 'failed'), 'Ocean source/artifact contract failed');
  stage = 'real-state-readback';
  report.realStateAfter = await adapter.assertRealEmptyState(p);
  assert.equal(report.modelOrTaskWriteAttempts, 0);
  assert.equal(report.pageErrors, 0);
  report.status = result.status;
} catch (error) {
  report.status = 'failed';
  report.failure = { stage, kind: error.name, message: 'Private error details withheld; inspect named case and screenshot' };
  await p.screenshot({ path: path.join(env.WHALE_EVIDENCE_DIR, 'runtime-failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(path.join(env.WHALE_EVIDENCE_DIR, 'runtime-report.json'), JSON.stringify(report, null, 2));
  console.log('OCEAN_RUNTIME', JSON.stringify(report));
  await context.close();
  await browser.close();
}
