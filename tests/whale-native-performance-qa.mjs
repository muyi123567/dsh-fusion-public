import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// E attaches before first navigation and runs after first panel open.
// This module never launches a browser, server, profile, build or model task.
const candidate = {
  revision: process.env.WHALE_PERF_EXPECTED_REVISION || '70914f229379a70559e39a07df4720720c518950',
  packageSha256: process.env.WHALE_PERF_EXPECTED_SHA256 || '440e65daf591f3346c9906410a1756a837b407f8a2281f50b4e06c69711fa0da',
};
const names = ['client.workspace.js', 'client.native-ocean.js', 'client.ocean-scene.js'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const chunkName = value => {
  try { return names.find(name => decodeURIComponent(new URL(value).pathname).endsWith('/' + name)); }
  catch { return undefined; }
};

function shortFailure(error) {
  const message = String(error?.safeReason || error?.message || error || 'unknown failure')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(?:https?|wss?|file):\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\b(token|cookie|authorization|secret|api[_-]?key)\s*[:=]\s*[^\s,;&"']+/gi, '$1=[redacted]')
    .slice(0, 700);
  return { code: String(error?.code || error?.name || 'Error').slice(0, 80), message };
}

/** Only exact candidate bytes plus non-executable debugger comments may compare equal. */
export function compareServedChunk(actual, expected) {
  if (!expected) return { mode: 'missing-candidate-bytes' };
  const candidateSha256 = sha(expected);
  if (actual.equals(expected)) return { mode: 'byte-identical', candidateSha256 };
  const prefixMatches = actual.length >= expected.length && actual.subarray(0, expected.length).equals(expected);
  if (prefixMatches) {
    const tail = actual.subarray(expected.length), text = tail.toString('utf8');
    const debugText = text.startsWith(';\r\n') ? text.slice(3) : text.startsWith(';\n') ? text.slice(2) : text;
    const lines = debugText.split(/\r?\n/);
    const onlyDebugMetadata = !/[\u2028\u2029]/.test(text) &&
      lines.every(line => /^[ \t]*(?:\/\/[#@][ \t]*(?:sourceURL|sourceMappingURL)=[^\r\n]*)?[ \t]*$/.test(line));
    if (onlyDebugMetadata) return { mode: 'candidate-plus-debug-metadata', candidateSha256,
      candidateBytes: expected.length, suffixBytes: tail.length, suffixSha256: sha(tail),
      comments: lines.filter(line => line.trim()).map(line => line.includes('sourceMappingURL=') ? 'sourceMappingURL' : 'sourceURL') };
  }
  let commonPrefixBytes = 0;
  while (commonPrefixBytes < Math.min(actual.length, expected.length) && actual[commonPrefixBytes] === expected[commonPrefixBytes]) commonPrefixBytes++;
  return { mode: 'executable-bytes-differ', candidateSha256, candidateBytes: expected.length,
    servedBytes: actual.length, commonPrefixBytes };
}

/** Observe real browser calls. Never supply a fake context or replace GL results. */
function installBrowserProbe() {
  if (window.__whaleNativePerf) return;
  const contexts = [], ids = new WeakMap();
  let attempts = 0;
  const scheduler = { rafScheduled: 0, rafFired: 0, timerScheduled: 0, timerFired: 0 };
  const pendingRaf = new Set(), pendingTimers = new Set();
  const scope = () => /client\.(?:native-ocean|ocean-scene)\.js|features\/whale\/(?:ambient|dive)/.test(new Error().stack || '');
  const get = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...args) {
    const owned = /^webgl2?$|^experimental-webgl$/.test(type) && this.classList.contains('whale-habitat__canvas');
    if (owned) attempts++;
    const gl = Reflect.apply(get, this, [type, ...args]);
    if (owned && gl && !ids.has(gl)) {
      const row = { id: contexts.length + 1, type, created: performance.now(), lost: false,
        draws: 0, submissions: 0, renderer: String(gl.getParameter(gl.RENDERER)), version: String(gl.getParameter(gl.VERSION)) };
      ids.set(gl, row); contexts.push(row);
      // Records retain no canvas/context reference and cannot keep a renderer alive.
      this.addEventListener('webglcontextlost', () => { row.lost = true; row.lostAt = performance.now(); });
    }
    return gl;
  };
  for (const prototype of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype].filter(Boolean)) {
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements',
      'clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi', 'blitFramebuffer', 'flush', 'finish']) {
      if (!Object.hasOwn(prototype, name) || typeof prototype[name] !== 'function') continue;
      const original = prototype[name];
      prototype[name] = function(...args) {
        const result = Reflect.apply(original, this, args);
        const row = ids.get(this);
        if (row) { row.submissions++; if (name.startsWith('draw')) row.draws++; }
        return result;
      };
    }
  }
  const raf = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
  window.requestAnimationFrame = function(callback) {
    if (!scope()) return Reflect.apply(raf, window, [callback]);
    scheduler.rafScheduled++;
    const id = Reflect.apply(raf, window, [time => { pendingRaf.delete(id); scheduler.rafFired++; callback(time); }]);
    pendingRaf.add(id); return id;
  };
  window.cancelAnimationFrame = function(id) { pendingRaf.delete(id); return Reflect.apply(cancel, window, [id]); };
  const timer = window.setTimeout, clear = window.clearTimeout;
  window.setTimeout = function(callback, delay, ...args) {
    if (typeof callback !== 'function' || !scope()) return Reflect.apply(timer, window, [callback, delay, ...args]);
    scheduler.timerScheduled++;
    const id = Reflect.apply(timer, window, [() => { pendingTimers.delete(id); scheduler.timerFired++; callback(...args); }, delay]);
    pendingTimers.add(id); return id;
  };
  window.clearTimeout = function(id) { pendingTimers.delete(id); return Reflect.apply(clear, window, [id]); };
  window.__whaleNativePerf = { sample: () => ({ at: performance.now(), visibility: document.visibilityState, attempts,
    contexts: contexts.map(row => ({ ...row })), scheduler: { ...scheduler, pendingRaf: pendingRaf.size, pendingTimers: pendingTimers.size } }) };
}

/** Source and artifact contracts are intentionally separate from browser results. */
export async function inspectNativeOceanArtifacts({ sourceRoot, distRoot, packagePath } = {}) {
  const root = resolve(sourceRoot || fileURLToPath(new URL('..', import.meta.url)));
  const dist = resolve(distRoot || join(root, 'packages/plugin/dist'));
  const checks = [], digests = {}, sourceDigests = {};
  let revision;
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { /* Extracted source has hashes, not a locally verified Git identity. */ }
  const record = async (name, layer, action) => {
    try { checks.push({ name, layer, status: 'passed', detail: await action() }); }
    catch (error) { checks.push({ name, layer, status: error.code === 'ENOENT' ? 'pending' : 'failed',
      reason: error.code === 'ENOENT' ? 'Required source/artifact absent' : String(error.message) }); }
  };
  await record('source lifecycle gates', 'source-contract', async () => {
    const read = async p => { const text = await readFile(join(root, p), 'utf8'); sourceDigests[p] = sha(text); return text; };
    const [panel, ocean, habitat, policy, scene] = await Promise.all([
      read('packages/client/src/features/native-panel/NativeWhalePanel.tsx'),
      read('packages/client/src/features/native-panel/NativeOcean.tsx'),
      read('packages/client/src/features/whale/ambient/WhaleHabitat.tsx'),
      read('packages/client/src/features/whale/ambient/policy.ts'),
      read('packages/client/src/features/whale/dive/scene.ts'),
    ]);
    assert.match(panel, /oceanVisited\s*&&/);
    assert.match(panel, /setOceanVisited\(true\)/);
    assert.match(panel, /visible=\{visible\s*&&\s*!selection\s*&&\s*tab==="ocean"\}/);
    assert.match(ocean, /visible\s*&&\s*hasSource\s*&&\s*pods\.length\s*>\s*0/);
    assert.match(policy, /quality === "still".*reducedMotion.*saveData/);
    assert(habitat.includes('if (policy.poster)') && habitat.includes('import("../dive/scene.js")'));
    assert(habitat.indexOf('if (policy.poster)') < habitat.indexOf('import("../dive/scene.js")'));
    for (const term of ['clearTimeout(timer)', 'resize.disconnect()', 'intersection?.disconnect()', 'scene?.dispose()']) assert(habitat.includes(term));
    assert.match(scene, /renderer\.dispose\(\);renderer\.forceContextLoss\(\)/);
    return { revision: revision || 'unverified-extracted-source', expectedCandidate: candidate.revision,
      note: 'Text guards only; not proof of effects, network, GPU reclamation or preference behavior.' };
  });
  for (const name of names) await record('compiled ' + name, 'artifact-contract', async () => {
    const bytes = await readFile(join(dist, name)), code = bytes.toString('utf8');
    digests[name] = sha(bytes);
    assert(code.includes('__ModuleLoader__.load('), 'Missing DSH module wrapper');
    if (name === 'client.workspace.js') {
      assert(bytes.length < 250000, 'Heavy workspace bundle');
      assert.match(code, /\.async\(["']\.\/client\.native-ocean\.js["']\)/);
      assert.doesNotMatch(code, /WebGLRenderer|data:model\/gltf/);
    } else if (name === 'client.native-ocean.js') {
      assert.match(code, /\.async\(["']\.\/client\.ocean-scene\.js["']\)/);
      assert.doesNotMatch(code, /WebGLRenderer|data:model\/gltf/);
    }
    return { bytes: bytes.length, sha256: digests[name] };
  });
  if (packagePath) await record('supplied candidate package SHA-256', 'artifact-contract', async () => {
    const packed = await readFile(packagePath), actual = sha(packed);
    assert.equal(actual, candidate.packageSha256, 'Package differs from supplied candidate');
    // Read standard npm tar members in memory; never extract into the installed profile.
    const tar = gunzipSync(packed, { maxOutputLength: 64 * 1024 * 1024 });
    const packagedChunks = {};
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) break;
      const text = (a, b) => header.subarray(a, b).toString('utf8').replace(/\0.*$/, '');
      const size = Number.parseInt(text(124, 136).trim() || '0', 8);
      assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'Invalid tar member size');
      const name = [text(345, 500), text(0, 100)].filter(Boolean).join('/');
      const chunk = names.find(chunk => name === 'package/dist/' + chunk || name === './package/dist/' + chunk);
      if (chunk && (header[156] === 0 || header[156] === 48)) {
        packagedChunks[chunk] = sha(tar.subarray(offset + 512, offset + 512 + size));
        assert.equal(digests[chunk], packagedChunks[chunk], 'Dist differs from packaged chunk: ' + chunk);
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    assert.equal(Object.keys(packagedChunks).length, names.length, 'Candidate package missing native chunks');
    return { sha256: actual, packagedChunks };
  });
  else checks.push({ name: 'supplied candidate package SHA-256', layer: 'artifact-contract', status: 'pending', reason: 'No packagePath supplied; dist hashes alone do not bind the supplied tarball' });
  return { candidate, revision: revision || null, sourceDigests, digests, checks };
}

/** Attach BEFORE navigation, run AFTER first native panel open, BEFORE ocean visit. */
export async function createNativeOceanPerformanceQA(page, options = {}) {
  assert(options.output, 'Dedicated evidence output directory required');
  const output = resolve(options.output);
  await mkdir(output, { recursive: true });
  const freshNavigation = page.url() === 'about:blank';
  await page.addInitScript(installBrowserProbe);
  const artifacts = await inspectNativeOceanArtifacts(options);
  const dist = resolve(options.distRoot || join(options.sourceRoot || fileURLToPath(new URL('..', import.meta.url)), 'packages/plugin/dist'));
  const candidateBytes = new Map();
  await Promise.all(names.map(async name => {
    try { candidateBytes.set(name, await readFile(join(dist, name))); } catch { /* Already recorded by artifact contract. */ }
  }));
  const report = { schema: 1, startedAt: new Date().toISOString(), candidate, freshNavigation,
    browser: page.context().browser()?.version() || 'unknown', artifacts, cases: [], pageErrors: 0,
    runtimeInput: 'original state endpoint',
    limits: ['Real WebGL submissions/context-lost events are browser evidence, not physical GPU utilization, energy or reclaimed VRAM.',
      'RAF/timer attribution uses compiled chunk stack names: zero callbacks without positive coverage is not proof.',
      'Uses UI visibility and habitat unmount; no forged document.hidden, fake GL context or product patch.'] };
  const network = [], pending = new Set();
  let phase = 'before-sea', actionStep = 'attach', ran = false;
  const failures = [];
  let sourceTeams = [], sourceDemo = false;
  const onRequest = request => {
    const name = chunkName(request.url());
    if (name) network.push({ name, event: 'request', phase, method: request.method() });
  };
  const onResponse = response => {
    if (new URL(response.url()).pathname === '/plugins/dsh-fusion/state' && response.ok()) {
      const stateRead = response.json().then(state => {
        sourceTeams = Array.isArray(state.agentTeams) ? state.agentTeams.map(t => ({ id: t.id, name: t.name })) : [];
        sourceDemo = state.demo === true;
      }, () => {});
      pending.add(stateRead); stateRead.finally(() => pending.delete(stateRead));
    }
    const name = chunkName(response.url());
    if (!name) return;
    const entry = { name, event: 'response', phase, status: response.status() }; network.push(entry);
    const task = response.body().then(async bytes => {
      entry.sha256 = sha(bytes); entry.bytes = bytes.length;
      entry.comparison = compareServedChunk(bytes, candidateBytes.get(name));
      // Private diagnostic artifact; no request URL, cookie or response headers are saved.
      entry.bodyFile = 'served-' + name;
      await writeFile(join(output, entry.bodyFile), bytes);
    }, () => { entry.bodyUnavailable = true; }).catch(error => { entry.evidenceError = shortFailure(error); });
    pending.add(task); task.finally(() => pending.delete(task));
  };
  const onError = () => { report.pageErrors++; };
  page.on('request', onRequest); page.on('response', onResponse); page.on('pageerror', onError);
  const save = () => writeFile(join(output, 'report.json'), JSON.stringify({ ...report, network }, null, 2) + '\n');
  const requireCheck = (condition, reason) => {
    if (!condition) { const error = new Error(reason); error.safeReason = reason; throw error; }
  };
  const pendingCase = reason => { const error = new Error(reason); error.pending = true; error.safeReason = reason; throw error; };
  const runCase = async (name, action) => {
    const entry = { name, layer: 'browser-runtime', input: report.runtimeInput }; report.cases.push(entry);
    actionStep = name;
    try { const detail = await action(entry); if (detail !== undefined) entry.detail = detail; entry.status = 'passed'; }
    catch (error) {
      entry.status = error.pending ? 'pending' : 'failed';
      entry.failure = shortFailure(error); entry.reason = entry.failure.message;
      entry.phase = phase; entry.step = actionStep;
      if (!error.pending) {
        const diagnostic = { name, phase, step: actionStep, ...entry.failure };
        try {
          diagnostic.sample = await page.evaluate(() => window.__whaleNativePerf?.sample());
          diagnostic.ui = await page.evaluate(() => {
            const visible = el => !!el && !el.closest('[hidden]') && !!el.getClientRects().length;
            const sea = document.querySelector('section[aria-label="团队海域"]');
            const host = document.querySelector('[data-sidebar-right-panel="push"][data-sidebar-right-open]');
            return { rightbarOpen: visible(host), oceanPresent: !!sea, oceanVisible: visible(sea),
              quality: sea?.querySelector('select[aria-label="海域质量"]')?.value,
              habitatStates: [...document.querySelectorAll('.whale-habitat')].map(el => ({
                state: el.dataset.habitatState, ready: el.dataset.ready, visible: visible(el) })) };
          });
        } catch { diagnostic.documentUnavailable = true; }
        failures.push(diagnostic);
        await writeFile(join(output, 'diagnostics.json'), JSON.stringify(failures, null, 2) + '\n');
      }
    }
    await save(); return entry;
  };
  const sample = () => page.evaluate(() => window.__whaleNativePerf?.sample());
  const totals = s => ({ draws: s.contexts.reduce((n, c) => n + c.draws, 0), submissions: s.contexts.reduce((n, c) => n + c.submissions, 0) });
  return { report, async run({ panel }) {
    assert(!ran, 'One run per fresh navigation'); ran = true;
    const ocean = panel.locator('section[aria-label="团队海域"]'), habitat = ocean.locator('.whale-habitat');
    const quality = ocean.getByRole('combobox', { name: '海域质量', exact: true });
    const tab = name => panel.getByRole('button', { name, exact: true });
    let routeMatch, handler, hasScene = false;
    const requireOceanVisible = async () => {
      if (!(await ocean.isVisible())) {
        const prior = report.cases.find(c => c.name === 'native rightbar hide stops submissions');
        if (prior?.status === 'failed') pendingCase('Blocked by failed native rightbar navigation; inspect its first diagnostic');
        requireCheck(false, 'Ocean unexpectedly unavailable without an earlier navigation failure');
      }
    };
    const advancing = async () => {
      await habitat.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => {
        const el = document.querySelector('section[aria-label="团队海域"] .whale-habitat');
        return el?.dataset.habitatState === 'running' && Number(el.dataset.habitatFrames) > 0;
      }, undefined, { timeout: 20000 });
      const a = await sample(); await sleep(1800); const b = await sample();
      requireCheck(totals(b).draws > totals(a).draws, 'Habitat telemetry advanced without observed real GL draw calls');
      const telemetry = await habitat.evaluate(el => ({ state: el.dataset.habitatState,
        quality: el.dataset.habitatQuality, frames: Number(el.dataset.habitatFrames),
        elapsed: Number(el.dataset.habitatElapsed), metrics: el.dataset.habitatMetrics }));
      return { before: a, after: b, telemetry };
    };
    const stopped = async ({ expectRelease = false } = {}) => {
      await sleep(700); const a = await sample(); await sleep(1800); const b = await sample();
      requireCheck(totals(a).submissions === totals(b).submissions, 'Real whale GL submissions continued after stop');
      requireCheck(a.scheduler.rafFired === b.scheduler.rafFired, 'Attributed whale RAF continued after stop');
      requireCheck(a.scheduler.timerFired === b.scheduler.timerFired, 'Attributed whale timer continued after stop');
      if (expectRelease) requireCheck(b.contexts.every(c => c.lost), 'Unmounted whale context has no observed context-lost event');
      return { before: a, after: b, schedulerCoverage: b.scheduler.rafScheduled + b.scheduler.timerScheduled > 0,
        rafEvidence: b.scheduler.rafScheduled > 0 ? 'attributed callback window observed' : 'no positive RAF baseline; not proven',
        timeoutEvidence: b.scheduler.timerScheduled > 0 ? 'attributed callback window observed' : 'no positive timeout baseline; not proven', hardwareGpu: 'not measured' };
    };
    try {
      await runCase('default tasks/hosts/teams never request ocean or Three chunks', async () => {
        if (!freshNavigation) pendingCase('Probe attached after navigation; initial requests were not observed');
        requireCheck(!!(await sample()), 'Init probe missing from this document');
        if (!network.some(e => e.name === 'client.workspace.js')) pendingCase('Actual workspace request was not captured on this navigation');
        for (const name of ['任务', '主机', '团队', '任务']) { await tab(name).click(); await sleep(400); }
        await sleep(1000);
        requireCheck(!network.some(e => e.name !== 'client.workspace.js'), 'Ocean/scene requested before explicit ocean tab');
        const s = await sample();
        requireCheck(s.attempts === 0 && s.contexts.length === 0, 'WebGL requested before explicit ocean tab');
        return { sample: s, requestedChunks: network.filter(e => e.event === 'request').map(e => e.name) };
      });
      if (options.fixturePath) {
        const fixture = JSON.parse(await readFile(options.fixturePath, 'utf8'));
        requireCheck(fixture.demo === true, 'Performance fixture must preserve demo:true');
        const origin = new URL(page.url()).origin;
        routeMatch = url => url.origin === origin && url.pathname === '/plugins/dsh-fusion/state';
        handler = route => route.request().method() === 'GET'
          ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) }) : route.fallback();
        await page.route(routeMatch, handler);
        report.runtimeInput = 'explicit synthetic DEMO state response; compiled product chunks unchanged';
        const response = page.waitForResponse(r => new URL(r.url()).pathname === '/plugins/dsh-fusion/state');
        await tab('刷新').click(); await response; await sleep(300);
      }
      phase = 'static-first-entry';
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await tab('海域').click(); await ocean.waitFor({ state: 'visible' });
      await runCase('first reduced-motion entry and explicit still create no WebGL', async () => {
        await page.waitForFunction(() => {
          const sea = document.querySelector('section[aria-label="团队海域"]');
          return sea?.querySelector('.whale-habitat') || /当前没有团队记录|尚未观测到来源/.test(sea?.textContent || '');
        });
        if (!(await habitat.count())) pendingCase('No observed teams; provide a labeled DEMO fixture for render lifecycle');
        await page.waitForFunction(() => document.querySelector('.whale-habitat')?.dataset.habitatState === 'still');
        await quality.selectOption('still'); await page.emulateMedia({ reducedMotion: 'no-preference' }); await sleep(1300);
        const s = await sample();
        requireCheck(s.attempts === 0 && s.contexts.length === 0, 'Static first entry attempted/created real WebGL');
        requireCheck(!network.some(e => e.name === 'client.ocean-scene.js'), 'Static first entry requested scene/Three chunk');
        requireCheck(await habitat.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), 'Static poster did not decode');
        await page.screenshot({ path: join(output, 'performance-static.png') });
        return { sample: s, quality: await quality.inputValue() };
      });
      phase = 'dynamic';
      await runCase('balanced mode advances real WebGL draws', async () => {
        if (!(await habitat.count())) pendingCase('No team scene available');
        await page.emulateMedia({ reducedMotion: 'no-preference' }); await quality.selectOption('balanced');
        try { const detail = await advancing(); hasScene = true; return detail; }
        catch (error) {
          const s = await sample();
          if (s.attempts > 0 && s.contexts.length === 0) pendingCase('Browser failed actual WebGL creation; dynamic/GPU checks pending');
          throw error;
        }
      });
      if (hasScene) {
        await runCase('pause stops actual submissions', async () => {
          await ocean.getByRole('button', { name: '暂停', exact: true }).click();
          let detail;
          try { detail = await stopped(); }
          finally { await ocean.getByRole('button', { name: '继续', exact: true }).click(); }
          await advancing(); return detail;
        });
        await runCase('task tab unmounts habitat and releases real context', async () => {
          phase = 'scene-unmount'; await tab('任务').click();
          requireCheck(await habitat.count() === 0, 'Hidden ocean retained habitat canvas');
          const detail = await stopped({ expectRelease: true });
          await tab('海域').click(); await advancing(); return detail;
        });
        await runCase('native rightbar hide stops submissions', async entry => {
          phase = 'native-hidden';
          if (typeof options.reopenPanel !== 'function') pendingCase('Runner must supply its verified reopenPanel callback before native-close testing');
          const host = page.locator('[data-sidebar-right-panel="push"][data-sidebar-right-open]');
          actionStep = 'native.close';
          await host.locator('[data-sidebar-right-toggle]').click(); await host.waitFor({ state: 'hidden' });
          let stopFailure;
          try {
            actionStep = 'native.measure-hidden-stop-and-release';
            entry.detail = { stop: await stopped({ expectRelease: true }) };
          } catch (error) {
            stopFailure = error; entry.stopFailure = shortFailure(error);
          } finally {
            actionStep = 'native.reopen-via-verified-adapter';
            await options.reopenPanel();
          }
          if (stopFailure) { actionStep = 'native.measure-hidden-stop-and-release'; throw stopFailure; }
          // rc3 keepMounted:false unloads the panel: reopening intentionally starts at tasks.
          actionStep = 'native.reopen-default-task';
          await tab('任务').waitFor({ state: 'visible' });
          requireCheck(await tab('任务').getAttribute('aria-pressed') === 'true', 'Native panel reopen did not start at the default tasks view');
          requireCheck(await habitat.count() === 0, 'Reopened default tasks view unexpectedly created a sea canvas');
          entry.detail = { ...entry.detail, reopenedAt: 'task', externalReopenPreferences: 'not required' };
          actionStep = 'native.explicit-ocean-reentry';
          await tab('海域').click(); await ocean.waitFor({ state: 'visible' });
          entry.detail.reentered = await advancing();
          return entry.detail;
        });
        await runCase('dynamic to still releases context without creating another', async () => {
          phase = 'static-after-dynamic'; await requireOceanVisible(); const before = await sample(); await quality.selectOption('still');
          const detail = await stopped({ expectRelease: true });
          requireCheck((await sample()).contexts.length === before.contexts.length, 'Still transition created another GL context'); return detail;
        });
      } else {
        for (const name of ['pause stop', 'habitat unmount/context release', 'native hidden stop', 'dynamic-to-still release'])
          report.cases.push({ name, layer: 'browser-runtime', status: 'pending', reason: 'No positive real draw baseline; zero counters cannot prove stopping' });
      }
      phase = 'preferences';
      await runCase('preferences survive task-tab return', async () => {
        await requireOceanVisible();
        // Pause while still before selecting a dynamic preference: do not resume an unsupported renderer.
        const pause = ocean.getByRole('button', { name: '暂停', exact: true });
        if (await pause.isVisible()) await pause.click();
        await quality.selectOption('eco'); await ocean.getByRole('button', { name: '海面', exact: true }).click();
        const next = ocean.getByRole('button', { name: '下一组团队', exact: true });
        if (await next.isEnabled()) await next.click();
        const teams = () => ocean.getByRole('button', { name: /^查看团队详情：/ }).evaluateAll(es => es.map(e => e.getAttribute('aria-label')));
        const before = await teams();
        await tab('任务').click(); await tab('海域').click();
        requireCheck(await quality.inputValue() === 'eco', 'Return reset quality');
        requireCheck(await ocean.getByRole('button', { name: '海面', exact: true }).getAttribute('aria-pressed') === 'true', 'Return reset surface view');
        requireCheck(await ocean.getByRole('button', { name: '继续', exact: true }).isVisible(), 'Return resumed paused ocean');
        requireCheck(JSON.stringify(await teams()) === JSON.stringify(before), 'Return reset team page');
        await page.screenshot({ path: join(output, 'performance-paused-return.png') });
        return { quality: 'eco', view: 'surface', playing: false, teamCount: before.length,
          paginationBeyondFirstPage: await ocean.getByRole('button', { name: '上一组团队', exact: true }).isEnabled() };
      });
      await runCase('real team detail/back preserves preferences and identity', async () => {
        const team = ocean.getByRole('button', { name: /^查看团队详情：/ }).first();
        if (!(await team.count()) || !(await team.isEnabled())) pendingCase('No selectable real team; DEMO buttons intentionally disabled, never falsify demo flag');
        const label = await team.getAttribute('aria-label');
        const matching = sourceTeams.filter(t => label === '查看团队详情：' + t.name);
        if (sourceDemo || matching.length !== 1) pendingCase('No unique observed real team ID for this visible team name');
        const expectedId = matching[0].id; await team.click();
        await panel.getByRole('button', { name: '返回海域', exact: true }).waitFor({ state: 'visible' });
        requireCheck(await habitat.count() === 0, 'Team detail retained scene canvas');
        requireCheck(await panel.locator('section[aria-label="团队详情"] > code').first().innerText() === expectedId,
          'Ocean team opened a different observed team ID');
        const detail = hasScene ? await stopped({ expectRelease: true }) : { lifecycle: 'pending: no draw baseline' };
        await panel.getByRole('button', { name: '返回海域', exact: true }).click();
        requireCheck(await quality.inputValue() === 'eco', 'Team-detail return reset quality');
        requireCheck(await ocean.getByRole('button', { name: '继续', exact: true }).isVisible(), 'Team-detail return resumed animation');
        requireCheck(await ocean.getByRole('button', { name: '海面', exact: true }).getAttribute('aria-pressed') === 'true', 'Team-detail return reset view');
        requireCheck(await ocean.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed') === 'true', 'Team identity lost after return'); return { ...detail, selectedTeamIdSha256: sha(expectedId) };
      });
      await runCase('served compiled chunks match candidate bytes', async () => {
        await Promise.allSettled([...pending]); const matched = [];
        for (const name of names) {
          const expected = artifacts.digests[name], responses = network.filter(e => e.event === 'response' && e.name === name);
          if (!expected || !responses.length) pendingCase('Candidate file or actual response absent for ' + name);
          requireCheck(responses.every(e => e.status === 200 && ['byte-identical', 'candidate-plus-debug-metadata'].includes(e.comparison?.mode)),
            'Served executable chunk differs from candidate: ' + name + '; inspect private served body and comparison');
          matched.push({ name, candidateSha256: expected, responses: responses.map(e => ({
            servedSha256: e.sha256, bytes: e.bytes, comparison: e.comparison, bodyFile: e.bodyFile })) });
        }
        return matched;
      });
      report.cases.push({ name: 'physical GPU utilization, energy and VRAM reclamation', layer: 'hardware', status: 'pending',
        reason: 'No OS/GPU profiler data; GL draws and context-lost events do not measure these.' });
      report.cases.push({ name: 'full native tab removal and real OS backgrounding', layer: 'browser-runtime', status: 'pending',
        reason: 'Only native rightbar hide and habitat unmount exercised; no guessed close-tab API or forged document.hidden.' });
      requireCheck(report.pageErrors === 0, 'Unhandled page errors during performance run');
    } catch (error) {
      report.cases.push({ name: 'runner completion', layer: 'browser-runtime', status: 'failed',
        reason: shortFailure(error).message, phase, step: actionStep, failure: shortFailure(error) });
    } finally {
      if (routeMatch) await page.unroute(routeMatch, handler).catch(() => {});
      if (!page.isClosed()) {
        await tab('任务').click().catch(() => {});
        if (routeMatch) await tab('刷新').click().catch(() => {});
        await page.emulateMedia({ reducedMotion: 'no-preference' }).catch(() => {});
      }
      await Promise.allSettled([...pending]);
      page.off('request', onRequest); page.off('response', onResponse); page.off('pageerror', onError);
      report.finishedAt = new Date().toISOString();
      const all = [...artifacts.checks, ...report.cases];
      report.status = all.some(c => c.status === 'failed') ? 'failed' : all.some(c => c.status === 'pending') ? 'incomplete' : 'passed';
      report.counts = Object.fromEntries(['passed', 'failed', 'pending'].map(s => [s, all.filter(c => c.status === s).length]));
      await save();
    }
    return report;
  } };
}

// Optional cloud-only contracts. Runtime is inserted into E's existing rc3 smoke.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv[2], '--artifacts', 'Use exported createNativeOceanPerformanceQA(page, options) in E real rc3 run');
  const output = process.env.WHALE_PERF_OUTPUT; assert(output, 'WHALE_PERF_OUTPUT required');
  await mkdir(output, { recursive: true });
  const report = await inspectNativeOceanArtifacts({ sourceRoot: process.env.WHALE_PERF_SOURCE,
    distRoot: process.env.WHALE_PERF_DIST, packagePath: process.env.WHALE_PERF_PACKAGE });
  await writeFile(join(output, 'artifact-contract.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ layer: 'source/artifact-contract-only',
    counts: Object.fromEntries(['passed', 'failed', 'pending'].map(s => [s, report.checks.filter(c => c.status === s).length])) }));
  process.exitCode = report.checks.some(c => c.status === 'failed') ? 1 : report.checks.some(c => c.status === 'pending') ? 2 : 0;
}
