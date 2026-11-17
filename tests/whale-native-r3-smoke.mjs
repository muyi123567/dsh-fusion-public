import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import adapter from './whale-native-rc3-adapter.mjs';

const env = process.env;
for (const key of ['WHALE_NATIVE_LOGIN_URL', 'CHROMIUM_PATH', 'WHALE_EVIDENCE_DIR',
  'WHALE_QA_CWD', 'WHALE_QA_DEMO_SNAPSHOT', 'WHALE_QA_DEMO_TASK'])
  assert(env[key], 'Missing environment input: ' + key);
assert.equal(env.WHALE_QA_ISOLATED_PROFILE, '1');
await mkdir(env.WHALE_EVIDENCE_DIR, { recursive: true });
const report = {
  mode: env.WHALE_QA_FOLLOWUP === '1' ? 'r3-followup' : 'r3-smoke',
  artifactSha256: env.WHALE_QA_ARTIFACT_SHA256 || 'not-supplied',
  checks: [], errors: [], modelOrTaskWriteAttempts: 0,
  pending: ['chat-history scrolling (empty Session)', 'native-tab unload', 'ocean lifecycle (separate performance acceptance)'],
};
const browser = await chromium.launch({
  executablePath: env.CHROMIUM_PATH, headless: true,
  args: ['--disable-dev-shm-usage', ...(env.WHALE_QA_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
});
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 1024 } });
const p = await context.newPage();
p.setDefaultTimeout(12000);
const host = () => p.locator('[data-sidebar-right-panel="push"][data-sidebar-right-open]');
const shot = name => p.screenshot({ path: path.join(env.WHALE_EVIDENCE_DIR, name + '.png') });
let stage = 'login';
p.on('pageerror', () => report.errors.push('unhandled-page-error; private message withheld'));
p.on('console', message => { if (message.type() === 'error') report.errors.push('console-error; private message withheld'); });
await context.route('**/*', route => {
  const request = route.request();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && adapter.isModelOrTaskWrite(request)) {
    report.modelOrTaskWriteAttempts++;
    return route.abort('blockedbyclient');
  }
  return route.continue();
});
try {
  try {
    await p.goto(env.WHALE_NATIVE_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await p.waitForURL(u => !u.searchParams.has('token') && !u.hash.includes('token'), { timeout: 30000 });
  } catch { throw new Error('Native login failed; sensitive navigation details withheld'); }
  stage = 'empty-native-session';
  await adapter.prepareEmptySession(p);
  await adapter.openPanel(p);
  await adapter.panel(p).getByRole('button', { name: '任务', exact: true }).waitFor();
  assert.equal(await p.locator('[data-dsh-fusion-overlay]').count(), 0);
  assert.equal(await p.locator('[role="dialog"]:visible').count(), 0);
  const chat = adapter.chat(p);
  assert(await chat.isVisible(), 'Actual rc3 conversation region must remain visible');
  assert(await chat.evaluate(e => !e.closest('[inert]')));
  assert.equal(await chat.getAttribute('data-conversation-session'), await host().getAttribute('data-sidebar-right-session'));
  report.checks.push('installed rc3 chat region visible, not inert, same Session as native rightbar');
  report.realStateBefore = await adapter.assertRealEmptyState(p);
  report.checks.push('native Session/workspace and footer launcher; real task-free state');
  const composer = adapter.composer(p);
  await composer.fill('QA unsent draft');
  assert(await composer.evaluate(e => !e.closest('[inert]')));
  assert.equal(await composer.innerText(), 'QA unsent draft');
  if (env.WHALE_QA_FOLLOWUP !== '1') {
    stage = 'native-widths';
    await shot('real-empty-1536');
    for (const width of [384, 420, 560]) {
      await adapter.resizePanel(p, width);
      await shot('native-width-' + width);
    }
    await p.setViewportSize({ width: 1280, height: 1024 });
    await shot('native-1280');
    report.checks.push('actual native divider resize: 384/420/560; 1536/1280 viewports');
  } else await adapter.resizePanel(p, 420);
  stage = 'native-settings-theme-and-content-font';
  report.themes = await adapter.verifyThemes(p);
  report.checks.push('actual native settings light/dark and conversation font control; original values restored');
  stage = 'fixture-local-navigation';
  report.details = await adapter.verifyDetails(p);
  // No old button-name count is used to claim Escape success.
  assert.equal(report.details.escapeDetailAbsent, true);
  assert.equal(report.details.escapeRowFocused, true);
  report.checks.push('DEMO task -> host/team -> task -> list; Escape detail absent and row focused; evidence link inspected without navigation');
  stage = 'close-reopen-draft';
  const tabId = await adapter.panel(p).getAttribute('data-sidebar-right-tab');
  await host().locator('[data-sidebar-right-toggle]').click();
  await host().waitFor({ state: 'hidden' });
  assert.equal(await composer.innerText(), 'QA unsent draft');
  await adapter.openPanel(p);
  assert.equal(await adapter.panel(p).getAttribute('data-sidebar-right-tab'), tabId);
  assert.equal(await composer.innerText(), 'QA unsent draft');
  await composer.focus();
  assert(await composer.evaluate(e => e === document.activeElement || e.contains(document.activeElement)));
  await composer.fill('');
  report.checks.push('close/reopen keeps Session/tab and unsent composer draft; input focus restored');
  stage = 'real-state-readback';
  report.realStateAfter = await adapter.assertRealEmptyState(p);
  assert.equal(report.modelOrTaskWriteAttempts, 0);
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = { stage, kind: error.name, message: 'Check failed; private error details withheld. Review failure screenshot.' };
  await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(path.join(env.WHALE_EVIDENCE_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log('REPORT', JSON.stringify(report));
  await context.close();
  await browser.close();
}
