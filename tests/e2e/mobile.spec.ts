import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startStandalone } from "dsh-fusion/standalone";

const chromePath = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
let browser: Browser;
let server: Awaited<ReturnType<typeof startStandalone>>;

beforeAll(async () => {
  server = await startStandalone({ port: 8792 });
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
});

afterAll(async () => {
  await browser.close();
  await server.app.close();
});

it("keeps the mobile workspace within the viewport", async () => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  await page.goto("http://127.0.0.1:8792/");
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));

  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewport);
  await mkdir(resolve("artifacts/qa"), { recursive: true });
  await page.screenshot({ path: resolve("artifacts/qa/mobile-390x844.png"), fullPage: true });

  await page.getByRole("button", { name: "打开导航" }).click();
  const navigation = page.getByRole("navigation", { name: "工作区" });
  await navigation.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Mission Control" }).click();
  await page.getByRole("heading", { name: "Mission Control" }).waitFor({ state: "visible" });

  await page.screenshot({ path: resolve("artifacts/qa/mobile-mission-control-390x844.png"), fullPage: true });
});
