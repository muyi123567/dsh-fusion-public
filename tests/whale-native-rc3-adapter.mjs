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
const row = (p, title) => panel(p).getByRole('button').filter({ has: p.getByText(title, { exact: true }) });
const screenshot = (p, name) => p.screenshot({ path: path.join(process.env.WHALE_EVIDENCE_DIR, name + '.png') });

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
  assert.equal(process.env.WHALE_QA_ISOLATED_PROFILE, '1', 'Explicit isolated QA profile required');
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
  await composer(p).waitFor({ state: 'visible' });
  assert.equal((await composer(p).inputValue().catch(() => composer(p).innerText())).trim(), '',
    'Expected a dedicated empty draft');
}
async function resizePanel(p, width) {
  const grip = p.locator('[data-side="rightbar"]');
  const box = await grip.boundingBox();
  assert(box, 'rc3 native rightbar resize handle missing');
  const y = box.y + Math.min(80, box.height / 2);
  await p.mouse.move(box.x + box.width / 2, y);
  await p.mouse.down();
  await p.mouse.move(p.viewportSize().width - width, y, { steps: 12 });
  await p.mouse.up();
  await p.waitForFunction(w => {
    const el = document.querySelector('[data-sidebar-right-panel="push"][data-sidebar-right-open]');
    return el && Math.abs(el.getBoundingClientRect().width - w) < 3;
  }, width);
}
async function assertRealEmptyState(p) {
  const state = await p.evaluate(async () => {
    const response = await fetch('/plugins/dsh-fusion/state', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('State read failed');
    const data = await response.json();
    return { demo: data.demo === true, tasks: Array.isArray(data.tasks) ? data.tasks.length : null,
      nodes: Array.isArray(data.nodes) ? data.nodes.length : null };
  });
  assert.equal(state.demo, false, 'Expected real state');
  assert.equal(state.tasks, 0, 'Isolated real state must remain task-free');
  return state;
}
async function verifyThemeTokens(p) {
  const original = await p.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'));
  await mkdir(process.env.WHALE_EVIDENCE_DIR, { recursive: true });
  try {
    const colors = [];
    for (const dark of [false, true]) {
      await p.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark);
      colors.push(await panel(p).evaluate(el => getComputedStyle(el).color));
      await screenshot(p, 'native-body-theme-fixture-' + (dark ? 'dark' : 'light'));
    }
    assert.notEqual(colors[0], colors[1]);
    return { method: 'native-body-theme-fixture', settingsUi: 'unverified', fontScaling: 'unverified' };
  } finally {
    await p.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), original);
  }
}
async function verifyThemes(p) {
  // Names and settings marker come from the installed rc3 native UI contract.
  const settings = p.locator('[data-shortcut-modal="settings"][role="dialog"]');
  const labels = ['浅色', '深色', '跟随系统'];
  const open = async () => {
    const direct = p.getByRole('button', { name: '设置', exact: true });
    if (await direct.isVisible().catch(() => false)) await direct.click();
    else {
      // Actual rc3 AccountMenu owns settings.launcher; the footer text is 更多.
      await p.getByRole('button', { name: '账号菜单', exact: true }).click();
      await p.getByRole('menuitem', { name: '设置', exact: true }).click();
    }
    await settings.waitFor({ state: 'visible' });
    await settings.getByRole('button', { name: '通用设置', exact: true }).click();
    await settings.getByRole('button', { name: '浅色', exact: true }).waitFor();
  };
  const close = async () => {
    await settings.getByRole('button', { name: '关闭', exact: true }).click();
    await settings.waitFor({ state: 'hidden' });
  };
  const contentSize = () => p.evaluate(() => parseInt(getComputedStyle(document.body).getPropertyValue('--dsh-content-font-size'), 10));
  const textSizes = async () => ({
    panel: await panel(p).getByRole('button', { name: '任务', exact: true }).evaluate(e => getComputedStyle(e).fontSize),
    composer: await composer(p).evaluate(e => getComputedStyle(e).fontSize),
  });
  let original;
  let originalSize;
  const originalDark = await p.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'));
  const samples = [];
  let font;
  try {
    await open();
    for (const label of labels)
      if (await settings.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed') === 'true') original = label;
    assert(original, 'No selected native theme preference');
    originalSize = await contentSize();
    assert(Number.isFinite(originalSize), 'Native content font token missing');
    await close();
    for (const label of ['浅色', '深色']) {
      await open();
      await settings.getByRole('button', { name: label, exact: true }).click();
      await p.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, label === '深色');
      assert.equal(await settings.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'), 'true');
      await screenshot(p, 'native-settings-' + (label === '深色' ? 'dark' : 'light') + '-dialog');
      await close();
      const color = await panel(p).evaluate(e => ({ color: getComputedStyle(e).color, background: getComputedStyle(e).backgroundColor }));
      samples.push({ mode: label === '深色' ? 'dark' : 'light', ...color });
      await screenshot(p, 'native-settings-' + (label === '深色' ? 'dark' : 'light'));
      await open();
      assert.equal(await settings.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'), 'true',
        'Native setting did not survive reopening settings');
      await close();
    }
    assert.notEqual(samples[0].color, samples[1].color, 'Native theme did not reach plugin text');
    const before = await textSizes();
    assert.equal(before.panel, '14px', 'Native panel density must be 14px');
    await open();
    await settings.getByText('仅影响会话内容的字号', { exact: true }).waitFor();
    const increase = originalSize < 22;
    await settings.getByRole('button', { name: increase ? '增大字号' : '减小字号', exact: true }).click();
    const changed = originalSize + (increase ? 1 : -1);
    await p.waitForFunction(n => parseInt(getComputedStyle(document.body).getPropertyValue('--dsh-content-font-size'), 10) === n, changed);
    await close();
    const after = await textSizes();
    assert.equal(after.panel, '14px', 'Conversation-only size preference must preserve native chrome density');
    await screenshot(p, 'native-settings-content-font-size');
    font = { scope: 'native setting explicitly affects conversation content only',
      original: originalSize, changed, before, after, nativeChrome: '14px' };
    return { method: 'native-settings', samples, font, restoration: 'native controls in finally',
      persistence: 'selection verified after closing and reopening settings; restart not tested' };
  } finally {
    if (original !== undefined) {
      if (!await settings.isVisible()) await open();
      if (originalSize !== undefined) {
        let current = await contentSize();
        for (let i = 0; i < 12 && current !== originalSize; i++) {
          await settings.getByRole('button', { name: current > originalSize ? '减小字号' : '增大字号', exact: true }).click();
          await p.waitForFunction(n => parseInt(getComputedStyle(document.body).getPropertyValue('--dsh-content-font-size'), 10) === n,
            current + (current > originalSize ? -1 : 1));
          current = await contentSize();
        }
        assert.equal(current, originalSize, 'Restore original native content font setting');
      }
      await settings.getByRole('button', { name: original, exact: true }).click();
      await close();
      await p.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, originalDark);
    } else if (await settings.isVisible()) await close();
  }
}
async function verifyDetails(p) {
  assert(process.env.WHALE_QA_DEMO_SNAPSHOT && process.env.WHALE_QA_DEMO_TASK, 'Explicit DEMO fixture and task required');
  const payload = JSON.parse(await readFile(process.env.WHALE_QA_DEMO_SNAPSHOT, 'utf8'));
  assert.equal(payload.demo, true, 'Fixture must explicitly identify DEMO data');
  const task = payload.tasks.find(t => t.goal === process.env.WHALE_QA_DEMO_TASK);
  assert(task, 'Named DEMO task not found');
  const target = payload.nodes.find(n => task.targetNodeIds.includes(n.id));
  const team = payload.agentTeams.find(t => t.taskIds.includes(task.id));
  assert(target && team, 'DEMO task needs host/team relationships');
  const origin = new URL(p.url()).origin;
  const routeMatch = u => u.origin === origin && u.pathname === '/plugins/dsh-fusion/state';
  const handler = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  await p.route(routeMatch, handler);
  try {
    await panel(p).getByRole('button', { name: '刷新', exact: true }).click();
    await row(p, task.goal).waitFor();
    if (process.env.WHALE_QA_FOLLOWUP !== '1') {
      for (const width of [384, 420]) {
        await resizePanel(p, width);
        await screenshot(p, 'DEMO-width-' + width);
      }
    }
    await row(p, task.goal).click();
    const details = panel(p).getByRole('region', { name: '任务详情', exact: true });
    await details.waitFor();
    assert.equal(await details.locator('code').first().innerText(), task.id);
    await details.getByRole('button', { name: target.name, exact: true }).click();
    const hostDetails = panel(p).getByRole('region', { name: '主机详情', exact: true });
    await hostDetails.waitFor();
    assert.equal(await hostDetails.locator('code').first().innerText(), target.id);
    await screenshot(p, 'DEMO-task-host');
    await hostDetails.getByRole('button', { name: '返回任务详情', exact: true }).click();
    await details.waitFor();
    assert.equal(await details.locator('code').first().innerText(), task.id);
    await details.getByRole('button', { name: team.name, exact: true }).click();
    const teamDetails = panel(p).getByRole('region', { name: '团队详情', exact: true });
    await teamDetails.waitFor();
    assert.equal(await teamDetails.locator('code').first().innerText(), team.id);
    await teamDetails.getByRole('button', { name: '返回任务详情', exact: true }).click();
    await details.waitFor();
    await screenshot(p, 'DEMO-details');
    await p.keyboard.press('Escape');
    await details.waitFor({ state: 'hidden' });
    await row(p, task.goal).waitFor();
    assert(await row(p, task.goal).evaluate(e => e === document.activeElement),
      'Escape must remove detail region and restore selected task row focus');
    const evidenceTask = payload.tasks.find(t => t.evidence?.some(e => e.kind === 'artifact'));
    assert(evidenceTask, 'DEMO evidence task missing');
    await row(p, evidenceTask.goal).click();
    await details.waitFor();
    for (const evidence of evidenceTask.evidence) {
      await details.getByText(evidence.value, { exact: true }).waitFor();
      if (/^https?:/.test(evidence.value)) {
        const link = details.getByRole('link', { name: evidence.value, exact: true });
        assert.equal(await link.getAttribute('href'), evidence.value);
        assert.equal(await link.getAttribute('target'), '_blank');
      }
    }
    await screenshot(p, 'DEMO-evidence');
    await details.getByRole('button', { name: '返回任务列表', exact: true }).click();
    await details.waitFor({ state: 'hidden' });
    assert(await row(p, evidenceTask.goal).evaluate(e => e === document.activeElement));
    return { fixture: 'explicit demo:true; only same-origin exact state pathname intercepted',
      taskHostBack: true, taskTeamBack: true, escapeDetailAbsent: true, escapeRowFocused: true,
      evidenceVisible: true, evidenceLinksFollowed: false, listBackRowFocused: true };
  } finally {
    await p.unroute(routeMatch, handler);
    await panel(p).getByRole('button', { name: '刷新', exact: true }).click();
  }
}

export default {
  prepareEmptySession, openPanel, composer, panel, resizePanel, assertRealEmptyState,
  verifyThemeTokens, verifyThemes, verifyDetails,
  // Installed rc3 ConversationContent.tsx, including the empty-session hero phase.
  chat: p => process.env.WHALE_QA_CHAT ? p.locator(process.env.WHALE_QA_CHAT)
    : p.locator('[data-conversation-region="chat"]:visible').filter({ has: composer(p) }),
  closePanel: async p => {
    const before = await composer(p).inputValue().catch(() => composer(p).innerText());
    await host(p).locator('[data-sidebar-right-toggle]').click();
    await panel(p).waitFor({ state: 'hidden' });
    await openPanel(p);
    assert.equal(await composer(p).inputValue().catch(() => composer(p).innerText()), before);
    await host(p).locator('[data-sidebar-right-toggle]').click();
  },
  isModelOrTaskWrite: request => /\/(?:models?|chat|completions?|responses|messages|tasks?|dispatch|execute)(?:\/|$)/i
    .test(new URL(request.url()).pathname),
};
