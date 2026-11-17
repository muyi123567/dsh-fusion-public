import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';

// Host actions are supplied from the installed rc3 UI, never a guessed registry.
const { WHALE_NATIVE_URL: url, WHALE_NATIVE_COOKIE: cookie, CHROMIUM_PATH: executablePath,
  WHALE_EVIDENCE_DIR: evidenceDir, WHALE_NATIVE_ADAPTER: adapterPath,
  WHALE_NATIVE_LOGIN_URL: loginUrl, WHALE_NATIVE_FIRSTPASS: firstpass } = process.env;
assert((url || loginUrl) && (cookie || loginUrl) && executablePath && evidenceDir && true,
  'Required: URL + cookie or LOGIN_URL; CHROMIUM_PATH; WHALE_EVIDENCE_DIR; optional ADAPTER (defaults to rc3 adapter)');
const origin = new URL(url || loginUrl);
const adapter = (await import(adapterPath ? pathToFileURL(path.resolve(adapterPath)).href : new URL('./whale-native-rc3-adapter.mjs', import.meta.url).href)).default;
for (const key of (firstpass === '1' ? [] : ['prepareEmptySession', 'openPanel', 'closePanel', 'composer', 'chat', 'panel']))
  assert.equal(typeof adapter[key], 'function', 'Missing rc3 adapter: ' + key);
await mkdir(evidenceDir, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true,
  args: ['--disable-dev-shm-usage', ...(process.env.WHALE_QA_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
});
const context = await browser.newContext({ viewport: { width: 1536, height: 1000 } });
if (cookie && !loginUrl) await context.addCookies(cookie.split(';').map(pair => {
  const i = pair.indexOf('=');
  assert(i > 0, 'Cookie must be a Cookie header, not Set-Cookie');
  return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), url: origin.origin };
}));
const page = await context.newPage();
const errors = [];
const checks = [];
let stateResponses = 0;
let blockedWrites = 0;
page.on('pageerror', () => errors.push('Unhandled page error (message withheld to protect session data)'));
page.on('response', response => {
  if (new URL(response.url()).pathname === '/plugins/dsh-fusion/state' && response.ok()) stateResponses++;
});
// The acceptance run never sends a model prompt or mutates task data.
await context.route('**/*', async route => {
  const request = route.request();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && adapter.isModelOrTaskWrite?.(request)) {
    blockedWrites++;
    return route.abort('blockedbyclient');
  }
  return route.continue();
});
const record = name => checks.push({ name, status: 'passed' });
const shellStyle = () => page.evaluate(() => ({
  body: ['backgroundColor', 'color', 'fontFamily', 'fontSize', 'overflow'].map(k => getComputedStyle(document.body)[k]),
  root: ['backgroundColor', 'color', 'fontFamily', 'fontSize'].map(k => getComputedStyle(document.documentElement)[k]),
}));
async function assertPush() {
  const host = page.locator('[data-sidebar-right-panel="push"][data-sidebar-right-open]');
  await host.waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-dsh-fusion-overlay]').count(), 0);
  assert.equal(await page.locator('[role=dialog]:visible').count(), 0);
  const panel = adapter.panel(page);
  await panel.waitFor({ state: 'visible' });
  assert(await panel.evaluate(el => !!el.closest('[data-sidebar-right-panel="push"]')));
  for (const locator of [adapter.composer(page), adapter.chat(page)]) {
    assert(await locator.isVisible());
    assert(await locator.evaluate(el => !el.closest('[inert]')));
  }
  const a = await host.boundingBox();
  const b = await adapter.composer(page).boundingBox();
  assert(a && b && b.x + b.width <= a.x + 2, 'Composer must remain outside push panel');
}
try {
  // Never expose the token-bearing navigation URL in a Playwright error.
  try {
    await page.goto(loginUrl || url, { waitUntil: 'domcontentloaded' });
    if (loginUrl) await page.waitForURL(current => {
      const initial = new URL(loginUrl);
      return current.href !== initial.href && current.origin === initial.origin &&
        !current.searchParams.has('token') && !current.hash.includes('token');
    }, { timeout: 30000 });
  } catch { throw new Error('Native login/navigation failed; sensitive URL withheld'); }
  if (firstpass === '1') {
    if (adapter.prepareEmptySession) await adapter.prepareEmptySession(page);
    else {
      const welcome = page.getByRole('button', { name: '继续', exact: true });
      if (await welcome.isVisible().catch(() => false)) await welcome.click();
      const create = page.getByRole('button', { name: '新建会话', exact: true }).last();
      await create.click();
      // Workspace selection is a real native UI action; supply its actual visible name.
      if (process.env.WHALE_NATIVE_WORKSPACE_NAME)
        await page.getByText(process.env.WHALE_NATIVE_WORKSPACE_NAME, { exact: true }).last().click();
    }
    if (adapter.openPanel) await adapter.openPanel(page);
    else await page.getByRole('button', {
      name: process.env.WHALE_NATIVE_OPEN_BUTTON || '鲸', exact: true,
    }).last().click();
    const host = page.locator('[data-sidebar-right-panel="push"][data-sidebar-right-open]');
    await host.waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-dsh-fusion-overlay]').count(), 0);
    assert.equal(await page.locator('[role="dialog"]:visible').count(), 0);
    for (const label of ['任务', '主机', '团队', '海域'])
      await host.getByText(label, { exact: true }).first().waitFor({ state: 'visible' });
    assert.deepEqual(errors, []);
    record('firstpass: native rc3 push rightbar contains whale navigation; no overlay/dialog');
    await page.screenshot({ path: path.join(evidenceDir, 'native-firstpass.png') });
  } else {
  // Adapter may click native preview welcome Continue and create/select an empty Session.
  await adapter.prepareEmptySession(page);
  const composer = adapter.composer(page);
  await composer.waitFor({ state: 'visible' });
  const baseline = await shellStyle();
  await adapter.openPanel(page);
  await assertPush();
  assert.deepEqual(await shellStyle(), baseline, 'Plugin polluted host body/root styles');
  record('real rc3 push slot; no overlay/dialog; composer/chat visible and not inert');
  assert(stateResponses > 0, 'No successful real /plugins/dsh-fusion/state response');
  if (adapter.assertRealEmptyState) {
    await adapter.assertRealEmptyState(page);
    record('real empty state');
  }
  const marker = 'whale-native-unsent-acceptance';
  await composer.fill(marker);
  assert.equal(await composer.inputValue().catch(() => composer.innerText()), marker);
  await page.screenshot({ path: path.join(evidenceDir, 'native-1536.png') });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await assertPush();
  await page.screenshot({ path: path.join(evidenceDir, 'native-1280.png') });
  record('1536 and 1280 desktop push mode');
  if (adapter.resizePanel) {
    for (const width of [384, 560]) {
      await adapter.resizePanel(page, width);
      const box = await adapter.panel(page).boundingBox();
      assert(box && Math.abs(box.width - width) <= 3, 'Native resize width mismatch');
      await assertPush();
      await page.screenshot({ path: path.join(evidenceDir, 'panel-' + width + '.png') });
    }
    record('native panel resize 384 and 560');
  }
  if (adapter.verifyDetails) {
    // Optional fixture adapter must route ONLY the state URL and identify all synthetic data.
    await adapter.verifyDetails(page, { statePath: '/plugins/dsh-fusion/state' });
    record('task/host/team/evidence/back/Escape (adapter assertions)');
  }
  if (adapter.verifyThemes) {
    await adapter.verifyThemes(page, { allowedModes: ['native-settings', 'native-body-theme-fixture'] });
    record('themes and font size (adapter assertions; label fixture evidence precisely)');
  }
  if (adapter.verifyOceanLifecycle) {
    await adapter.verifyOceanLifecycle(page);
    record('ocean lazy loading and hidden stop (adapter assertions)');
  }
  await adapter.closePanel(page);
  await adapter.panel(page).waitFor({ state: 'hidden' });
  assert.equal(await composer.inputValue().catch(() => composer.innerText()), marker);
  await composer.focus();
  assert(await composer.evaluate(el => el === document.activeElement || el.contains(document.activeElement)));
  await composer.fill('');
  record('close preserves unsent draft; composer regains focus');
  if (adapter.verifyUnload) {
    await adapter.verifyUnload(page);
    record('unload cleanup (adapter assertions)');
  }
  assert.equal(blockedWrites, 0, 'Unexpected model/task write attempted');
  assert.deepEqual(errors, []);
  }
} finally {
  await writeFile(path.join(evidenceDir, 'acceptance.json'), JSON.stringify({
    mode: firstpass === '1' ? 'firstpass' : 'full-smoke',
    checks, errors, stateResponses, blockedWrites,
    pending: ['assertRealEmptyState', 'resizePanel', 'verifyDetails', 'verifyThemes', 'verifyOceanLifecycle', 'verifyUnload']
      .filter(key => typeof adapter[key] !== 'function'),
    note: 'Screenshots may contain private host UI. Keep evidence private. No cookie, URL or network trace persisted.',
  }, null, 2));
  await context.close();
  await browser.close();
}
