/**
 * Instabox only. No server/dependency setup, model calls, or application writes.
 * See docs/design/2026-11-16-whale-review-checklist.md for the DOM contract.
 */
import { chromium } from "playwright-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname, platform } from "node:os";
import { join } from "node:path";

const machine = process.env.WHALE_TEST_MACHINE_ID;
if (platform() !== "linux" || !machine) {
  throw new Error("Run only on authorized Instabox; set WHALE_TEST_MACHINE_ID after verifying the machine identity.");
}
const base = new URL(process.env.WHALE_BASE_URL ?? "http://127.0.0.1:4173");
const localUrl = (url) => {
  if (!["http:", "https:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password) throw new Error("Use a loopback Instabox preview URL without credentials.");
  return url;
};
localUrl(base);
const contract = JSON.parse(process.env.WHALE_CONTRACT_FILE
  ? await readFile(process.env.WHALE_CONTRACT_FILE, "utf8")
  : process.env.WHALE_CONTRACT_JSON ?? "{}");
const designs = ["atlas", "bridge", "current"];
const viewports = [
  { name: "desktop", width: 1536, height: 1024 },
  { name: "narrow", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const output = join("/tmp/whale-design-review", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = {
  schemaVersion: 1, startedAt: new Date().toISOString(),
  environment: { machine, hostname: hostname(), baseUrl: base.href, node: process.version,
    browser: null, executable: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium" },
  output, cases: [], host: null, failures: [], gaps: [],
  limits: [
    "Geometry and computed styles are heuristics; contrast, occlusion, meaningful callbacks and model truth require review.",
    "A state change proves observable UI behavior, not remote task execution.",
    "Machine environment marker is an operator assertion, not remote identity attestation.",
  ],
};
const save = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const failure = (item, code, detail) => item.failures.push({ code, detail });
const gap = (item, detail) => item.gaps.push(detail);
const urlFor = (design) => {
  const url = new URL(base);
  url.pathname = "/design-gallery.html";
  url.searchParams.set("whaleDesign", design);
  url.searchParams.set("whaleGallery", "1");
  return url.href;
};
function attach(page, item) {
  page.on("console", (message) => item.console.push({ type: message.type(), text: message.text(), location: message.location() }));
  page.on("pageerror", (error) => item.pageErrors.push(error.message));
  page.on("requestfailed", (request) => item.requestFailures.push({
    method: request.method(), url: request.url(), error: request.failure()?.errorText,
  }));
  page.on("response", (response) => {
    if (response.status() >= 400) item.httpErrors.push({ url: response.url(), status: response.status() });
  });
}
async function contextFor(browser, viewport, item, host = false) {
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "no-preference",
    locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block",
  });
  // Click contracts must be local selections or navigation. Never submit work.
  await context.route("**/*", async (route) => {
    const request=route.request();
    const path=new URL(request.url()).pathname;
    const hostBootstrapRpc=new Set([
      "/api/settings/describe","/api/settings/mutate","/api/credentials/describe","/api/dynamicCordisRunner/syncInspectManifest",
      "/api/dynamicCordisRunner/inventory","/api/session/modelCatalog","/api/web/listProviders",
      "/api/llm/listProviders","/api/llm/listConfigurableProviders",
      "/api/agentPresets/list","/api/permissionPresets/catalog",
      // Native preview notice acknowledgement and default workspace affect only this disposable profile.
      "/api/workspace/initializeDefault",
    ]);
    const readRpc=host && request.method()==="POST" && (hostBootstrapRpc.has(path) || /\/(?:session\/(?:list|projections|page)|models\/list|settings\/(?:get|list)|config\/get)\/?$/u.test(path));
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && !readRpc) {
      item.blockedWrites.push({ method: route.request().method(), url: route.request().url() });
      await route.abort("blockedbyclient");
    } else await route.continue();
  });
  return context;
}
async function settle(page) {
  await page.evaluate(async () => {
    await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2500))]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
async function unique(page, selector) {
  const locator = page.locator(selector);
  await locator.first().waitFor({ state: "visible", timeout: 15_000 });
  if (await locator.count() !== 1) throw new Error("Selector must match exactly one element: " + selector);
  return locator;
}
async function inspect(page, rootSelector) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    const visible = (el) => {
      const rect = el.getBoundingClientRect(), css = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && css.display !== "none" && css.visibility === "visible"
        && Number(css.opacity) !== 0 && !el.closest("[hidden], [inert], [aria-hidden='true']");
    };
    const identity = (el) => ({
      tag: el.tagName.toLowerCase(), id: el.id, classes: el.getAttribute("class"),
      testId: el.getAttribute("data-testid"), text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 160),
      label: el.getAttribute("aria-label"), role: el.getAttribute("role"),
    });
    const controls = [...root.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [tabindex]")].filter(visible).map((el) => {
      const rect = el.getBoundingClientRect(), css = getComputedStyle(el);
      const labelledBy = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      return { ...identity(el), width: rect.width, height: rect.height, tabIndex: el.tabIndex,
        fontSize: css.fontSize, disabled: el.matches(":disabled") || el.getAttribute("aria-disabled") === "true",
        hasName: Boolean(el.getAttribute("aria-label")?.trim() || labelledBy.trim()
          || el.labels?.length || (el.textContent ?? "").trim()
          || el.querySelector("img[alt], svg title") || el.getAttribute("title")),
        pressed: el.getAttribute("aria-pressed"), selected: el.getAttribute("aria-selected"),
        current: el.getAttribute("aria-current"), expanded: el.getAttribute("aria-expanded") };
    });
    const texts = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node, scanned = 0;
    while ((node = walker.nextNode()) && scanned++ < 30000) {
      const el = node.parentElement;
      if (!node.textContent.trim() || !el || el.closest("script, style, [aria-hidden=true]") || !visible(el)) continue;
      const css = getComputedStyle(el);
      texts.push({ ...identity(el), text: node.textContent.trim().slice(0, 160),
        pixels: parseFloat(css.fontSize), color: css.color, background: css.backgroundColor, lineHeight: css.lineHeight });
    }
    const elements = [root, ...root.querySelectorAll("*")].filter(visible);
    const overflow = elements.filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.left < -1 || rect.right > innerWidth + 1;
    }).slice(0, 100).map((el) => {
      const rect = el.getBoundingClientRect();
      let parent = el.parentElement, scrollContainer = null;
      while (parent) {
        if (["auto", "scroll"].includes(getComputedStyle(parent).overflowX)) {
          scrollContainer = identity(parent); break;
        }
        parent = parent.parentElement;
      }
      return { ...identity(el), left: rect.left, right: rect.right, scrollContainer };
    });
    const animations = elements.flatMap((el) => ["", "::before", "::after"].map((pseudo) => {
      const css = getComputedStyle(el, pseudo || null);
      const seconds = (value) => value.split(",").map((part) => parseFloat(part) * (part.trim().endsWith("ms") ? .001 : 1));
      const animationLong = css.animationName !== "none" && seconds(css.animationDuration).some((n) => n > .02);
      const transitionLong = seconds(css.transitionDuration).some((n) => n > .02);
      return animationLong || transitionLong || css.scrollBehavior === "smooth"
        ? { ...identity(el), pseudo, animation: css.animationName, duration: css.animationDuration,
          transition: css.transitionDuration, iterations: css.animationIterationCount, scrollBehavior: css.scrollBehavior }
        : null;
    }).filter(Boolean)).slice(0, 100);
    const rootCss = getComputedStyle(root);
    return {
      title: document.title, url: location.href, rootText: root.innerText?.slice(0, 16000) ?? root.textContent?.slice(0, 16000),
      rootFont: parseFloat(rootCss.fontSize),
      geometry: { viewport: innerWidth, document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth, rootClient: root.clientWidth, rootScroll: root.scrollWidth },
      controls, textCount: texts.length, smallText: texts.filter((t) => t.pixels < 12),
      bodySizeReview: texts.filter((t) => t.pixels >= 12 && t.pixels < 13).slice(0, 100),
      textScanTruncated: scanned >= 30000, overflow, motion: animations,
      frameworkOverlay: Boolean(document.querySelector("vite-error-overlay, nextjs-portal [data-nextjs-dialog]")),
    };
  }, rootSelector);
}
async function keyboardReview(page, root, directory) {
  await root.evaluate((el) => {
    const old = el.getAttribute("tabindex");
    el.setAttribute("tabindex", "-1"); el.focus();
    if (old === null) el.removeAttribute("tabindex"); else el.setAttribute("tabindex", old);
  });
  const samples = [];
  for (let index = 0; index < 24; index++) {
    await page.keyboard.press("Tab");
    const sample = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { body: true };
      const css = getComputedStyle(el), rect = el.getBoundingClientRect();
      const transparent = (c) => c === "transparent" || /rgba?\([^)]*[,/]\s*0(?:\.0+)?\s*\)$/.test(c);
      const outline = parseFloat(css.outlineWidth) > 0 && !["none", "hidden"].includes(css.outlineStyle) && !transparent(css.outlineColor);
      return { tag: el.tagName, label: el.getAttribute("aria-label"), text: el.textContent?.trim().slice(0, 120),
        insideCandidate: Boolean(el.closest("[data-whale-review-root]")), focusVisible: el.matches(":focus-visible"),
        indicatorCandidate: outline || css.boxShadow !== "none",
        outline: css.outline, shadow: css.boxShadow, inert: Boolean(el.closest("[inert], [aria-hidden=true]")),
        inViewport: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth };
    });
    samples.push(sample);
    if (index === 0) await page.screenshot({ path: join(directory, "keyboard-first.png") });
  }
  return samples;
}
async function observation(page, expected) {
  const locator = page.locator(expected.selector);
  const count = await locator.count();
  if (!count) return { count: 0, visible: false };
  if (count > 1 && expected.count === undefined) throw new Error("Ambiguous expected selector: " + expected.selector);
  const first = locator.first();
  return {
    count, visible: await first.isVisible(),
    ...(expected.text !== undefined || expected.includesText !== undefined ? { text: (await first.innerText()).trim().replace(/\s+/g, " ") } : {}),
    ...(expected.value !== undefined ? { value: await first.inputValue() } : {}),
    ...(expected.attribute !== undefined ? { attribute: await first.getAttribute(expected.attribute) } : {}),
  };
}
function matches(actual, expected) {
  if (expected.count !== undefined && actual.count !== expected.count) return false;
  if (expected.visible !== undefined && actual.visible !== expected.visible) return false;
  if (expected.text !== undefined && actual.text !== expected.text) return false;
  if (expected.includesText !== undefined && !actual.text?.includes(expected.includesText)) return false;
  if (expected.value !== undefined && actual.value !== expected.value) return false;
  if (expected.attribute !== undefined && actual.attribute !== expected.equals) return false;
  return true;
}
async function interactions(page, item, settings, directory) {
  const cases = settings.interactions ?? [];
  if (!cases.length) gap(item, "No worker-confirmed interaction contracts; search/team selection/callbacks NOT VERIFIED.");
  item.interactions = [];
  for (const [index, step] of cases.entries()) {
    const evidence = { name: step.name, action: step.action, selector: step.selector, status: "failed" };
    item.interactions.push(evidence);
    try {
      if (!step.name || !step.selector || !step.expect?.selector
        || !["visible", "count", "text", "includesText", "value", "attribute"].some((key) => key in step.expect)
        || (step.expect.attribute && !("equals" in step.expect))) throw new Error("Every action needs a concrete target and observable expected state.");
      // Each case starts from the same demo. Steps within a flow must be separate contracts with self-contained setup.
      await page.goto(item.url, { waitUntil: "domcontentloaded" });
      await unique(page, settings.root);
      if (settings.ready) await unique(page, settings.ready);
      await settle(page);
      evidence.before = await observation(page, step.expect);
      const target = await unique(page, step.selector);
      if (step.action === "click") await target.click();
      else if (step.action === "fill" && typeof step.value === "string") await target.fill(step.value);
      else if (step.action === "select" && typeof step.value === "string") await target.selectOption(step.value);
      else if (step.action === "press" && ["Enter", " ", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Escape", "Home", "End"].includes(step.value)) await target.press(step.value);
      else throw new Error("Unsupported action/value; use click, fill, select, or a navigation key.");
      const deadline = Date.now() + 5000;
      do {
        evidence.after = await observation(page, step.expect);
        if (matches(evidence.after, step.expect) && JSON.stringify(evidence.before) !== JSON.stringify(evidence.after)) break;
        await page.waitForTimeout(100);
      } while (Date.now() < deadline);
      evidence.status = matches(evidence.after, step.expect)
        && JSON.stringify(evidence.before) !== JSON.stringify(evidence.after) ? "passed" : "failed";
      if (evidence.status !== "passed") failure(item, "interaction-no-expected-change", evidence);
      await page.screenshot({ path: join(directory, "interaction-" + index + ".png"), fullPage: true });
    } catch (error) {
      evidence.error = error.message; failure(item, "interaction-error", evidence);
    }
  }
}
const newItem = (details) => ({ ...details, failures: [], gaps: [], console: [], pageErrors: [], httpErrors: [], requestFailures: [], blockedWrites: [] });
function health(item) {
  if (item.pageErrors.length) failure(item, "pageerror", item.pageErrors);
  const errors = item.console.filter((entry) => entry.type === "error");
  if (errors.length) failure(item, "console-error", errors);
  if (item.httpErrors.length) failure(item, "http-error", item.httpErrors);
  if (item.blockedWrites.length) failure(item, "unexpected-application-write", item.blockedWrites);
  const requests = item.requestFailures.filter((r) => r.error !== "net::ERR_ABORTED");
  if (requests.length) failure(item, "network-error", requests);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
async function runCase(browser, design, viewport) {
  const item = newItem({ design, viewport, url: urlFor(design) });
  report.cases.push(item);
  const names = { atlas: "鲸群航图", bridge: "深海舰桥", current: "洋流矩阵" };
  const alternate = design === "atlas" ? "bridge" : "atlas";
  const defaultSettings = {
    root: 'section[data-whale-design="' + design + '"]',
    demoMarker: 'section[data-whale-design="' + design + '"] .whale-panel-source > span:first-child',
    interactions: [
      { name: "已连接的合法空海域", action: "click",
        selector: 'label:has-text("空海域") input[type="checkbox"]',
        expect: { selector: design==="atlas"?".wha-task-link":design==="bridge"?".wb-task-row":".wc-task", count: 0 } },
      { name: "连接中断保留上次观测", action: "click",
        selector: 'label:has-text("连接中断") input[type="checkbox"]',
        expect: { selector: ".whale-panel-source > span:nth-child(2)", includesText: "连接中断" } },
      { name: "方案导航切换真实面板", action: "click",
        selector: 'nav[aria-label="设计方案"] button:has-text("' + names[alternate] + '")',
        expect: { selector: 'section[data-whale-design="' + alternate + '"]', visible: true } },
    ],
  };
  const supplied = contract[design] ?? {};
  const settings = { ...defaultSettings, ...supplied,
    interactions: [...defaultSettings.interactions, ...(supplied.interactions ?? [])] };
  const directory = join(output, design, viewport.name);
  await mkdir(directory, { recursive: true });
  const context = await contextFor(browser, { width: viewport.width, height: viewport.height }, item);
  const page = await context.newPage();
  attach(page, item);
  try {
    const response = await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    item.navigationStatus = response?.status();
    const rootSelector = settings.root;
    const root = await unique(page, rootSelector);
    if (settings.ready) await unique(page, settings.ready);
    const activeNav = page.getByRole("navigation", { name: "设计方案", exact: true })
      .getByRole("button", { name: new RegExp(names[design]) });
    if (await activeNav.count() !== 1 || await activeNav.getAttribute("aria-pressed") !== "true") {
      failure(item, "candidate-navigation-mismatch", design);
    }
    const renderedDesign = await root.getAttribute("data-whale-design");
    if (renderedDesign !== design) failure(item, "candidate-root-mismatch", renderedDesign);
    if (!(supplied.interactions?.length)) gap(item, "Worker-confirmed search/team/task/host callback contracts pending; gallery toggles alone do not prove candidate buttons.");

    await settle(page);
    await page.screenshot({ path: join(directory, "viewport.png") });
    await page.screenshot({ path: join(directory, "full-page.png"), fullPage: true });
    item.normal = await inspect(page, rootSelector);
    if (!item.normal.rootText?.trim()) failure(item, "blank-root", rootSelector);
    if (item.normal.frameworkOverlay) failure(item, "framework-error-overlay", true);
    if (item.normal.geometry.document > viewport.width + 1 || item.normal.geometry.body > viewport.width + 1) failure(item, "horizontal-page-overflow", item.normal.geometry);
    if (item.normal.overflow.length) gap(item, "Review overflow list for clipped content vs intentional horizontal scrollers; hidden overflow can mask layout defects.");
    if (item.normal.rootFont < 13) failure(item, "body-font-below-13px", item.normal.rootFont);
    if (item.normal.smallText.length) failure(item, "text-below-12px", item.normal.smallText);
    const smallControls = item.normal.controls.filter((c) => c.width < 39.5 || c.height < 39.5);
    if (smallControls.length) failure(item, "target-below-40px", smallControls);
    const unnamed = item.normal.controls.filter((c) => !c.hasName);
    if (unnamed.length) failure(item, "control-name-missing", unnamed);
    if (!item.normal.controls.length) failure(item, "no-candidate-controls", rootSelector);
    if (settings.demoMarker) {
      await unique(page, settings.demoMarker);
      item.demoMarker = await page.locator(settings.demoMarker).innerText();
      if (!/demo|演示|示例/i.test(item.demoMarker)) failure(item, "demo-marker-not-explicit", item.demoMarker);
    } else gap(item, "Demo marker selector missing; query parameters alone do not prove demo rendering.");
    if (settings.modelEvidence) {
      const modelText = await page.locator(settings.modelEvidence).textContent({ timeout: 5000 });
      const model = JSON.parse(modelText);
      if (model.demo !== true) failure(item, "model-not-demo", model.demo);
      item.modelHash = createHash("sha256").update(JSON.stringify(canonical(model))).digest("hex");
    } else gap(item, "Same-model identity requires fixture/source review or a worker-confirmed serialized-model selector.");
    // Temporary QA marker only; removed before interaction and reduced-motion inspections.
    const oldMarker = await root.getAttribute("data-whale-review-root");
    await root.evaluate((el) => el.setAttribute("data-whale-review-root", ""));
    try { item.keyboard = await keyboardReview(page, root, directory); }
    finally {
      await root.evaluate((el, value) => {
        if (value === null) el.removeAttribute("data-whale-review-root"); else el.setAttribute("data-whale-review-root", value);
      }, oldMarker);
    }
    const badFocus = item.keyboard.filter((s) => !s.body && (s.inert || !s.inViewport || (!s.focusVisible || !s.indicatorCandidate)));
    if (badFocus.length) failure(item, "keyboard-focus-risk", badFocus);
    if (!item.keyboard.some((s) => s.insideCandidate)) gap(item, "No candidate control reached within 24 Tab presses.");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await settle(page);
    item.reduced = await inspect(page, rootSelector);
    item.reducedMotionMatches = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (!item.reducedMotionMatches || item.reduced.motion.length) failure(item, "reduced-motion-risk", item.reduced.motion);
    await page.screenshot({ path: join(directory, "reduced-motion.png"), fullPage: true });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await interactions(page, item, settings, directory);
  } catch (error) {
    failure(item, "case-error", error.stack ?? error.message);
    await page.screenshot({ path: join(directory, "failure.png"), fullPage: true }).catch(() => {});
  } finally {
    health(item);
    await save(join(directory, "evidence.json"), item);
    await context.close();
  }
}
async function hostSnapshot(page) {
  return page.evaluate(() => {
    const properties = ["color", "background-color", "font-family", "font-size", "line-height", "box-sizing", "margin",
      "overflow-x", "color-scheme", "scrollbar-color", "scrollbar-width", "outline", "animation-duration", "transition-duration"];
    return [...document.querySelectorAll("html, body, #root, [data-whale-review-sentinel], [data-whale-review-sentinel] *")].map((el) => {
      const css = getComputedStyle(el);
      const tokens = [...css].filter((name) => name.startsWith("--fusion-") || name.startsWith("--whale-"));
      return { tag: el.tagName, id: el.id, values: Object.fromEntries([...properties, ...tokens].map((name) => [name, css.getPropertyValue(name)])) };
    });
  });
}
async function auditStyles(page, scopes) {
  return page.evaluate((prefixes) => {
    const unsafe = [], inaccessible = [], keyframes = [];
    function split(selector) {
      const parts = []; let start = 0, depth = 0, quote = "";
      for (let i = 0; i < selector.length; i++) {
        const c = selector[i];
        if (quote) { if (c === quote && selector[i - 1] !== "\\") quote = ""; continue; }
        if (c === "'" || c === '"') quote = c;
        else if (c === "(" || c === "[") depth++;
        else if (c === ")" || c === "]") depth--;
        else if (c === "," && depth === 0) { parts.push(selector.slice(start, i).trim()); start = i + 1; }
      }
      parts.push(selector.slice(start).trim()); return parts;
    }
    function walk(rules) {
      for (const rule of rules) {
        if (rule.type === CSSRule.KEYFRAMES_RULE) { keyframes.push(rule.name); continue; }
        if (rule.selectorText && split(rule.selectorText).some((selector) => !prefixes.some((p) =>
          (p.endsWith("-") && selector.startsWith(p) && /^[a-zA-Z0-9_]/.test(selector.slice(p.length))) || selector === p || selector.startsWith(p + " ") || selector.startsWith(p + ":")
          || selector.startsWith(p + "[") || selector.startsWith(p + ".") || selector.startsWith(p + ">")))) {
          unsafe.push(rule.selectorText);
        }
        if (rule.cssRules) walk(rule.cssRules);
      }
    }
    for (const sheet of document.styleSheets) {
      if (!sheet.ownerNode?.matches?.("style[data-plugin='dsh-fusion']")) continue;
      try { walk(sheet.cssRules); } catch { inaccessible.push(sheet.href ?? "inline"); }
    }
    return { unsafe, inaccessible, keyframes,
      pluginSheets: [...document.styleSheets].filter((s) => s.ownerNode?.matches?.("style[data-plugin='dsh-fusion']")).length };
  }, scopes);
}
async function hostReview(browser) {
  if (!process.env.WHALE_HOST_URL) {
    report.host = { status: "not-run", gaps: ["WHALE_HOST_URL missing; standalone gallery cannot prove DSH host style isolation or nested modal behavior."] };
    report.gaps.push("Production-shell isolation and overlay focus NOT VERIFIED."); return;
  }
  const url = localUrl(new URL(process.env.WHALE_HOST_URL)).href;
  const item = newItem({ url, status: "running" }); report.host = item;
  const directory = join(output, "host");
  await mkdir(directory, { recursive: true });
  const context = await contextFor(browser, { width: 1536, height: 1024 }, item, true);
  const page = await context.newPage(); attach(page, item);
  if (process.env.WHALE_TEST_AUTH_COOKIE) {
    const cookies=process.env.WHALE_TEST_AUTH_COOKIE.split(";").map(value=>value.trim()).filter(Boolean).map(value=>{
      const at=value.indexOf("=");
      if(at<1) throw new Error("Invalid in-memory test cookie");
      return {name:value.slice(0,at),value:value.slice(at+1),url};
    });
    await context.addCookies(cookies);
  }
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    item.initialUi = (await page.locator("body").innerText()).slice(0,2500);
    await page.screenshot({path:join(directory,"host-initial.png")});
    // Fresh native profiles may show a dismissible workspace/onboarding surface.
    await page.keyboard.press("Escape");
    await settle(page);
    const launcher = await unique(page, contract.host?.launcher ?? "button[aria-label='打开鲸插件']");
    await page.evaluate(() => {
      const sentinel = document.createElement("section");
      sentinel.setAttribute("data-whale-review-sentinel", "");
      sentinel.style.cssText = "position:fixed;left:-10000px;top:0;pointer-events:none";
      sentinel.innerHTML = "<h2>Host title</h2><p>Host body <small>metadata</small></p><button type='button'>Host button</button><input aria-label='Host input'>";
      document.body.appendChild(sentinel);
    });
    await settle(page);
    item.before = await hostSnapshot(page);
    const betaNotice=page.getByText("预览版说明",{exact:true});
    try {
      await betaNotice.waitFor({state:"visible",timeout:8000});
      const acknowledge=page.getByRole("button",{name:"继续",exact:true});
      if(await acknowledge.count()===1) {await acknowledge.click();item.nativePreviewNoticeAcknowledged=true;}
    } catch {}
    const gettingStarted=page.getByText("开始使用",{exact:true});
    try {
      await gettingStarted.waitFor({state:"visible",timeout:2500});
      await page.keyboard.press("Escape");
      await settle(page);
      item.nativeModelOnboardingDismissed=!(await gettingStarted.isVisible());
    } catch {}
    await launcher.focus(); await launcher.click();
    const overlay = await unique(page, "[data-dsh-fusion-overlay]");
    await overlay.locator(".fusion-shell").waitFor({ state: "visible", timeout: 20_000 });
    await settle(page);
    item.open = await hostSnapshot(page);
    const scopes = ["[data-dsh-fusion-overlay]", ".fusion-", ".whale-", ...(contract.host?.styleScopes ?? [])];
    item.styles = await auditStyles(page, scopes);
    if (!item.styles.pluginSheets) gap(item, "No recognized plugin style tag; CSS scoping requires bundle inspection.");
    if (item.styles.unsafe.length) failure(item, "unscoped-plugin-selectors", item.styles.unsafe);
    if (JSON.stringify(item.before) !== JSON.stringify(item.open)) failure(item, "host-styles-changed-on-open", { before: item.before, open: item.open });
    // Computed global tokens may change without repainting an individual host control.
    item.modal = await overlay.evaluate((el) => ({ role: el.getAttribute("role"), modal: el.getAttribute("aria-modal"),
      focusInside: el.contains(document.activeElement) }));
    if (item.modal.role !== "dialog" || item.modal.modal !== "true" || !item.modal.focusInside) failure(item, "overlay-modal-focus", item.modal);
    item.keyboard = [];
    for (const key of ["Shift+Tab", ...Array(30).fill("Tab")]) {
      await page.keyboard.press(key);
      item.keyboard.push(await overlay.evaluate((el) => el.contains(document.activeElement)));
    }
    if (item.keyboard.some((inside) => !inside)) failure(item, "overlay-focus-escaped", item.keyboard);
    await page.screenshot({ path: join(directory, "overlay-open.png"), fullPage: true });
    await page.setViewportSize({width:390,height:844});
    await settle(page);
    item.mobileScroll = await page.locator(".fusion-main").evaluate((el)=>{
      el.scrollTop=el.scrollHeight;
      return {height:el.clientHeight,total:el.scrollHeight,top:el.scrollTop,atBottom:el.scrollTop+el.clientHeight>=el.scrollHeight-2};
    });
    if (!item.mobileScroll.atBottom || item.mobileScroll.height>844) failure(item,"mobile-workspace-scroll",item.mobileScroll);
    await page.locator(".fusion-main").evaluate(el=>{el.scrollTop=0;});
    await page.locator("button[aria-label='打开导航']").click();
    await unique(page,".fusion-sidebar.is-mobile-open");
    await page.keyboard.press("Escape");
    await settle(page);
    item.mobileEscape = {workspaceRetained:await overlay.isVisible(),sidebarClosed:await page.locator(".fusion-sidebar.is-mobile-open").count()===0};
    if (!item.mobileEscape.workspaceRetained || !item.mobileEscape.sidebarClosed) failure(item,"nested-mobile-escape",item.mobileEscape);
    await page.screenshot({path:join(directory,"overlay-mobile.png"),fullPage:true});
    await page.setViewportSize({width:1536,height:1024});
    await settle(page);
    await unique(page, contract.host?.close ?? "button[aria-label='关闭鲸插件']").then((close) => close.click());
    await overlay.waitFor({ state: "detached" }); await settle(page);
    item.closed = await hostSnapshot(page);
    item.focusRestored = await launcher.evaluate((el) => el === document.activeElement);
    if (!item.focusRestored) failure(item, "overlay-focus-not-restored", false);
    if (JSON.stringify(item.before) !== JSON.stringify(item.closed)) failure(item, "host-styles-changed-after-close", { before: item.before, closed: item.closed });
    await page.screenshot({ path: join(directory, "overlay-closed.png"), fullPage: true });
    gap(item, "Mobile sidebar Escape/scroll verified; full drawer and every breakpoint remain separate workflow coverage.");
    item.status = "captured";
  } catch (error) { failure(item, "host-case-error", error.stack ?? error.message); }
  finally {
    health(item); await save(join(directory, "evidence.json"), item); await context.close();
  }
}
let browser;
try {
  browser = await chromium.launch({
    executablePath: report.environment.executable, headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  report.environment.browser = browser.version();
  if (process.env.WHALE_HOST_ONLY !== "1") for (const design of designs) for (const viewport of viewports) await runCase(browser, design, viewport);
  for (const viewport of viewports) {
    const cases = report.cases.filter((item) => item.viewport.name === viewport.name);
    if (cases.length && cases.every((item) => item.modelHash) && new Set(cases.map((item) => item.modelHash)).size !== 1) {
      report.failures.push({ code: "different-demo-models", viewport: viewport.name, hashes: cases.map((item) => ({ design: item.design, hash: item.modelHash })) });
    }
  }
  await hostReview(browser);
} catch (error) { report.failures.push({ code: "runner-error", detail: error.stack ?? error.message }); }
finally {
  await browser?.close().catch((error) => report.failures.push({ code: "browser-close", detail: error.message }));
  report.finishedAt = new Date().toISOString();
  const items = [...report.cases, ...(report.host?.failures ? [report.host] : [])];
  const failures = report.failures.length + items.reduce((sum, item) => sum + item.failures.length, 0);
  const gaps = report.gaps.length + items.reduce((sum, item) => sum + item.gaps.length, 0);
  report.summary = { failures, gaps, cases: report.cases.length,
    status: failures ? "failed" : gaps ? "incomplete" : "automated-checks-passed",
    visualReview: "pending", truthfulnessReview: "pending" };
  await save(join(output, "report.json"), report);
  const rows = report.cases.map((item) => "| " + item.design + " | " + item.viewport.name + " | " + item.failures.length + " | " + item.gaps.length + " |");
  await writeFile(join(output, "summary.md"), [
    "# Whale design review", "", "Status: " + report.summary.status,
    "", "| Candidate | Viewport | Failures | Gaps |", "| --- | --- | ---: | ---: |", ...rows,
    "", "Visual/model truth review remains manual. report.json contains full evidence and limits.", "",
  ].join("\n"));
  console.log(JSON.stringify({ ...report.summary, output }));
  process.exitCode = failures ? 1 : gaps ? 2 : 0;
}
