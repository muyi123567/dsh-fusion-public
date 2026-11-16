import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? process.env.DSH_SMOKE_URL;
if (!url) throw new Error("Usage: node tests/browser-clean-install.mjs <url>");

const outputDir = process.env.DSH_SMOKE_OUTPUT_DIR ?? "artifacts/clean-install";
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1536, height: 1024 }, locale: "en-US" });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1_000);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let dismissed = false;
    for (const name of [
      "Continue",
      "Configure later",
      "Got it",
      "Close",
      "继续",
      "稍后配置",
      "知道了",
      "关闭",
    ]) {
      const button = page.getByRole("button", { name, exact: true });
      if (await button.count() > 0 && await button.isVisible()) {
        await button.click();
        dismissed = true;
        await page.waitForTimeout(200);
      }
    }
    if (!dismissed) await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }

  const fusion = page.getByRole("button", { name: "打开 DSH Fusion", exact: true });
  await fusion.waitFor({ state: "visible", timeout: 30_000 });
  const stateResponse = page.waitForResponse((response) =>
    response.url().includes("/plugins/dsh-fusion/state") && response.status() === 200,
    { timeout: 60_000 },
  );
  await fusion.click();
  const overlay = page.locator("[data-dsh-fusion-overlay]");
  await overlay.waitFor({ state: "visible", timeout: 20_000 });
  await stateResponse;
  const setupPrompt = page.getByRole("button", { name: /^打开开箱检查/u });
  await setupPrompt.waitFor({ state: "visible", timeout: 20_000 });
  await setupPrompt.click();
  await page.getByRole("heading", { name: "开箱检查", exact: true }).waitFor({
    state: "visible",
    timeout: 20_000,
  });
  await page.getByText("DSH Fusion", { exact: false }).first().waitFor({
    state: "visible",
    timeout: 20_000,
  });
  await page.screenshot({ path: `${outputDir}/desktop.png`, fullPage: true });

  const desktop = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    text: document.body.innerText.slice(0, 8_000),
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outputDir}/mobile.png`, fullPage: true });
  const mobile = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));

  const result = {
    clickedFusion: true,
    overlayVisible: true,
    setupWorkspaceVisible: true,
    desktopNoHorizontalOverflow: desktop.scrollWidth <= desktop.innerWidth,
    mobileNoHorizontalOverflow: mobile.scrollWidth <= mobile.innerWidth,
    pageErrors,
    consoleErrors,
    desktopScreenshot: `${outputDir}/desktop.png`,
    mobileScreenshot: `${outputDir}/mobile.png`,
  };
  console.log(JSON.stringify(result, null, 2));
  if (
    pageErrors.length > 0
    || consoleErrors.length > 0
    || !result.desktopNoHorizontalOverflow
    || !result.mobileNoHorizontalOverflow
  ) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
