import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright-core';
import adapter from './whale-native-rc3-adapter.mjs';

const env = process.env;
assert.equal(env.WHALE_QA_ISOLATED_PROFILE, '1');
const out = env.WHALE_EVIDENCE_DIR;
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: env.CHROMIUM_PATH, headless: true,
 args: ['--disable-dev-shm-usage', ...(env.WHALE_QA_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] });
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 1024 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const report = { artifactSha256: env.WHALE_QA_ARTIFACT_SHA256, input: 'explicit demo:true snapshot; real DSH host', writes: 0, pageErrors: 0, transport: [] };
const arrivals = [];
page.on('pageerror', () => report.pageErrors++);
page.on('response', response => {
 const name = ['client.js', 'client.workspace.js', 'client.native-ocean.js', 'client.ocean-scene.js']
  .find(name => decodeURIComponent(new URL(response.url()).pathname).endsWith('/' + name));
 if (!name || !response.ok()) return;
 arrivals.push((async () => {
  const actual = await response.body(), expected = await readFile(path.join(env.WHALE_QA_INSTALLED_DIST, name));
  await writeFile(path.join(out, 'served-' + name), actual);
  const prefixMatches = actual.subarray(0, expected.length).equals(expected);
  const tail = prefixMatches ? actual.subarray(expected.length) : Buffer.alloc(0);
  report.transport.push({ name, prefixMatches, servedSha256: createHash('sha256').update(actual).digest('hex'),
   packageSha256: createHash('sha256').update(expected).digest('hex'), suffixBytes: tail.length,
   suffixSyntax: tail.toString('utf8').replace(/(sourceMappingURL|sourceURL)=.*/g, '$1=[debug-map]') });
 })());
});
await context.route('**/*', route => {
 if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) && adapter.isModelOrTaskWrite(route.request())) {
  report.writes++; return route.abort();
 }
 return route.continue();
});
try {
 try {
  await page.goto(env.WHALE_NATIVE_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(url => !url.searchParams.has('token') && !url.hash.includes('token'));
 } catch { throw new Error('Native login failed; sensitive navigation withheld'); }
 await adapter.prepareEmptySession(page);
 await adapter.openPanel(page);
 await adapter.resizePanel(page, 420);
 const demo = JSON.parse(await readFile(env.WHALE_QA_DEMO_SNAPSHOT, 'utf8'));
 assert.equal(demo.demo, true);
 const origin = new URL(page.url()).origin;
 await page.route(url => url.origin === origin && url.pathname === '/plugins/dsh-fusion/state',
  route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(demo) }));
 const panel = adapter.panel(page);
 await panel.getByRole('button', { name: '刷新', exact: true }).click();
 await panel.getByText(demo.tasks[0].goal, { exact: true }).waitFor();
 await page.screenshot({ path: path.join(out, 'DEMO-native-tasks-420.png') });
 await panel.getByRole('button', { name: '海域', exact: true }).click();
 await page.waitForTimeout(2500);
 await page.screenshot({ path: path.join(out, 'DEMO-native-ocean-420.png') });
 assert.equal(await page.locator('[data-dsh-fusion-overlay]').count(), 0);
 assert(await adapter.chat(page).isVisible());
 assert.equal(report.writes, 0); assert.equal(report.pageErrors, 0);
 await Promise.all(arrivals);
 report.status = 'passed';
} finally {
 await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
 console.log('NATIVE_PREVIEW', JSON.stringify(report));
 await context.close(); await browser.close();
}
