import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startStandalone } from "dsh-fusion/standalone";

const chromePath = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
let browser: Browser;
let server: Awaited<ReturnType<typeof startStandalone>>;

beforeAll(async () => {
  server = await startStandalone({ port: 8791 });
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
});

afterAll(async () => {
  await browser.close();
  await server.app.close();
});

it("dispatches a task from the live task composer", async () => {
  const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } });
  await page.goto("http://127.0.0.1:8791/");
  await page.getByRole("button", { name: "多机任务", exact: true }).click();
  await page.getByRole("button", { name: "新建任务" }).click();
  await page.getByLabel("任务目标").fill("运行浏览器任务验收");
  await page.getByRole("button", { name: "派发", exact: true }).click();
  await page.getByText("任务已派发，证据返回后会更新任务记录").waitFor({ state: "visible" });
  await page.getByRole("main").getByText("运行浏览器任务验收", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("tab", { name: "列表" }).click();
  expect(await page.getByRole("main").getByRole("button", { name: "取消" }).count()).toBeGreaterThan(0);
  await mkdir(resolve("artifacts/qa"), { recursive: true });
  await page.screenshot({ path: resolve("artifacts/qa/desktop-1536x1024.png"), fullPage: true });
});
