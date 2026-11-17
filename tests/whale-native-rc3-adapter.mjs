import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
let session;
let tabId;
const host = p => p.locator('[data-sidebar-right-panel="push"][data-sidebar-right-open]');
const composer = p => process.env.WHALE_QA_COMPOSER
  ? p.locator(process.env.WHALE_QA_COMPOSER)
  : p.locator('[role="textbox"][contenteditable="true"]:visible').last();
const panel = p => tabId
  ? host(p).locator('div[data-sidebar-right-tab]').filter({ visible: true }).and(p.locator('[data-sidebar-right-tab="' + tabId + '"]'))
  : host(p).locator('div[data-sidebar-right-tab]:visible').last();
async function openPanel(p) {
  await p.getByRole('button', { name: process.env.WHALE_NATIVE_OPEN_BUTTON || '打开鲸面板', exact: true }).last().click();
  await host(p).waitFor({ state: 'visible' });
  const id = await host(p).getAttribute('data-sidebar-right-session');
  assert(id, 'Native panel has no session');
  if (session) assert.equal(id, session, 'Reopened panel changed Session');
  session = id;
  await panel(p).waitFor({ state: 'visible' });
  tabId = await panel(p).getAttribute('data-sidebar-right-tab');
}
async function prepareEmptySession(p) {
  assert(process.env.WHALE_QA_ISOLATED_PROFILE === '1', 'Explicit isolated QA profile required');
  // rc3 first paint can precede its two onboarding presentations.
  for (let i = 0; i < 5; i++) {
    await p.waitForTimeout(700);
    const welcome = p.getByRole('button', { name: '继续', exact: true });
    if (await welcome.isVisible().catch(() => false)) await welcome.click();
    const onboarding = p.getByText('开始使用', { exact: true });
    if (await onboarding.isVisible().catch(() => false))
      await p.getByRole('button', { name: '关闭', exact: true }).click();
  }
  await p.getByRole('button', { name: '新建会话', exact: true }).last().click();
  if (await p.locator('[role="textbox"][contenteditable="true"]').count() === 0) {
    assert(process.env.WHALE_QA_CWD, 'Accessible QA cwd required');
    await p.getByRole('button', { name: '选择工作区', exact: true }).click();
    await p.getByRole('button', { name: '编辑路径', exact: true }).click();
    const directory = p.getByRole('textbox', { name: '编辑路径', exact: true });
    await directory.fill(process.env.WHALE_QA_CWD);
    await directory.press('Enter');
    await p.getByRole('button', { name: '打开', exact: true }).click();
  }
  // Runner must use a real accessible cwd. No session service/API is fabricated here.
  await composer(p).waitFor({ state: 'visible' });
  const text = await composer(p).inputValue().catch(() => composer(p).innerText());
  assert.equal(text.trim(), '', 'Expected a dedicated empty draft');
}
async function resizePanel(p, width) {
  const grip = p.locator('[data-side="rightbar"]');
  const box = await grip.boundingBox();
  assert(box, 'rc3 native rightbar resize handle missing');
  await p.mouse.move(box.x + box.width / 2, box.y + Math.min(80, box.height / 2));
  await p.mouse.down();
  await p.mouse.move(p.viewportSize().width - width, box.y + Math.min(80, box.height / 2), { steps: 12 });
  await p.mouse.up();
  await p.waitForFunction(w => {
    const el = document.querySelector('[data-sidebar-right-panel="push"][data-sidebar-right-open]');
    return el && Math.abs(el.getBoundingClientRect().width - w) < 3;
  }, width);
}
async function verifyThemeTokens(p) {
  // Explicit native-body-theme-fixture; never claims settings persistence.
  const original = await p.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'));
  const dir = process.env.WHALE_EVIDENCE_DIR;
  await mkdir(dir, { recursive: true });
  try {
    const colors = [];
    for (const dark of [false, true]) {
      await p.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark);
      await p.waitForTimeout(200);
      colors.push(await panel(p).evaluate(el => getComputedStyle(el).color));
      await p.screenshot({ path: path.join(dir, 'native-body-theme-fixture-' + (dark ? 'dark' : 'light') + '.png') });
    }
    assert.notEqual(colors[0], colors[1], 'Native theme fixture did not change panel text color');
  } finally {
    await p.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), original);
  }
}
const adapter = {
  prepareEmptySession, openPanel, composer, panel, resizePanel, verifyThemeTokens,
  chat: p => process.env.WHALE_QA_CHAT ? p.locator(process.env.WHALE_QA_CHAT) : (() => { throw new Error('Chat region not verified on rc3: supply WHALE_QA_CHAT from actual DOM'); })(),
  closePanel: async p => {
    const before = await composer(p).inputValue().catch(() => composer(p).innerText());
    await host(p).locator('[data-sidebar-right-toggle]').click();
    await panel(p).waitFor({ state: 'hidden' });
    await openPanel(p);
    assert.equal(await composer(p).inputValue().catch(() => composer(p).innerText()), before);
    await host(p).locator('[data-sidebar-right-toggle]').click();
  },
  isModelOrTaskWrite: request => /\/((?:model|chat|completion|task)s?)(\/|$)/i.test(new URL(request.url()).pathname),
};
// Fixture is opt-in and supplied against the integrated candidate schema.
// Only the exact same-origin state pathname is intercepted; all data is labeled DEMO.
if (process.env.WHALE_QA_DEMO_SNAPSHOT) {
  adapter.verifyDetails = async p => {
    const payload = JSON.parse(await readFile(process.env.WHALE_QA_DEMO_SNAPSHOT, 'utf8'));
    const routeMatch = u => u.origin === new URL(p.url()).origin && u.pathname === '/plugins/dsh-fusion/state';
    const handler = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    await p.route(routeMatch, handler);
    try {
      await panel(p).getByRole('button', { name: '刷新', exact: true }).click();
      await panel(p).getByText(/DEMO/).first().waitFor({ state: 'visible' });
      await p.screenshot({ path: path.join(process.env.WHALE_EVIDENCE_DIR, 'DEMO-snapshot.png') });
      for (const label of ['任务', '主机', '团队']) {
        await panel(p).getByRole('button', { name: label, exact: true }).click();
        await panel(p).getByText(/DEMO/).first().waitFor({ state: 'visible' });
      }
      // Candidate row and evidence names are explicit fixture inputs, never guessed.
      assert(process.env.WHALE_QA_DEMO_TASK, 'Provide exact DEMO task title');
      await panel(p).getByRole('button', { name: '任务', exact: true }).click();
      await panel(p).getByText(process.env.WHALE_QA_DEMO_TASK, { exact: true }).click();
      await panel(p).getByRole('button', { name: /返回/ }).waitFor({ state: 'visible' });
      await p.keyboard.press('Escape');
      await panel(p).getByText(process.env.WHALE_QA_DEMO_TASK, { exact: true }).waitFor({ state: 'visible' });
    } finally {
      await p.unroute(routeMatch, handler);
      await panel(p).getByRole('button', { name: '刷新', exact: true }).click();
    }
  };
}
export default adapter;
