import { chromium } from "playwright-core";

const url = process.argv[2] ?? process.env.DSH_SMOKE_URL;
const screenshotPath = process.argv[3] ?? "artifacts/dsh-fusion-smoke.png";
const mobileScreenshotPath = process.env.DSH_SMOKE_MOBILE_SCREENSHOT
  ?? "artifacts/dsh-fusion-mobile.png";
if (!url) throw new Error("Usage: node tests/browser-smoke.mjs <url> [screenshot]");

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1_500);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const continueButton = page.getByRole("button", { name: "继续", exact: true });
    if (await continueButton.count() > 0 && await continueButton.isVisible()) {
      await continueButton.click();
      await page.waitForTimeout(300);
      continue;
    }
    const laterButton = page.getByRole("button", { name: "稍后配置", exact: true });
    if (await laterButton.count() > 0 && await laterButton.isVisible()) {
      await laterButton.click();
      await page.waitForTimeout(300);
      continue;
    }
    await page.waitForTimeout(500);
  }
  const fusionButton = page.getByRole("button", { name: "打开 DSH Fusion", exact: true });
  await fusionButton.waitFor({ state: "visible", timeout: 30_000 });
  const stateResponse = page.waitForResponse((response) =>
    response.url().includes("/plugins/dsh-fusion/state") && response.status() === 200,
    { timeout: 60_000 },
  );
  await fusionButton.evaluate((element) => element.click());
  await page.locator("[data-dsh-fusion-overlay]").waitFor({ state: "visible", timeout: 20_000 });
  await stateResponse;
  const overlay = page.locator("[data-dsh-fusion-overlay]");
  await overlay.getByText("华为云 hs-monitor-cn", { exact: true }).first().waitFor({
    state: "visible",
    timeout: 60_000,
  });
  await overlay.getByText("dsh-fusion-plugin-test-20261021", { exact: true }).first().waitFor({
    state: "visible",
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "多机任务" }).click();
  await page.getByRole("button", { name: "新建任务" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "新建任务" }).click();
  await page.getByLabel("任务目标").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "会话房间" }).click();
  await page.getByRole("heading", { name: "会话房间" }).waitFor({ state: "visible" });

  await page.screenshot({ path: screenshotPath, fullPage: true });

  const result = await page.evaluate(() => ({
    title: document.title,
    bodyText: document.body.innerText.slice(0, 4000),
    bodyTextLength: document.body.innerText.length,
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    fusionOverlay: Boolean(document.querySelector("[data-dsh-fusion-overlay]")),
    hasHuaweiNode: /hs-monitor-cn/.test(document.body.innerText),
    hasInstaboxNode: /dsh-fusion-plugin-test-20261021/.test(document.body.innerText),
  }));
  const knownExternalSlotId = process.env.DSH_KNOWN_EXTERNAL_SLOT_ID;
  const knownExternalConsoleErrors = knownExternalSlotId === undefined
    ? []
    : consoleErrors.filter((message) =>
        message.includes("Minified React error #130")
        || message.includes("slot entry crashed in 'sidebar.footer.action'")
      );
  const actionableConsoleErrors = consoleErrors.filter((message) =>
    !knownExternalConsoleErrors.includes(message)
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: mobileScreenshotPath, fullPage: true });
  const mobile = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));

  console.log(JSON.stringify({
    ...result,
    hasFusion: /Fusion|DSH Fusion/.test(result.bodyText),
    hasFleet: /节点|多机任务|配置与版本/.test(result.bodyText),
    clickedFusion: true,
    fusionOverlay: result.fusionOverlay,
    noHorizontalOverflow: result.scrollWidth <= result.innerWidth,
    mobileNoHorizontalOverflow: mobile.scrollWidth <= mobile.innerWidth,
    hasHuaweiNode: result.hasHuaweiNode,
    hasInstaboxNode: result.hasInstaboxNode,
    pageErrors,
    consoleErrors: actionableConsoleErrors,
    knownExternalConsoleErrors,
    screenshotPath,
    mobileScreenshotPath,
  }));

  if (
    !result.bodyText ||
    pageErrors.length > 0 ||
    actionableConsoleErrors.length > 0 ||
    !result.fusionOverlay ||
    result.scrollWidth > result.innerWidth ||
    mobile.scrollWidth > mobile.innerWidth ||
    !result.hasHuaweiNode ||
    !result.hasInstaboxNode
  ) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
