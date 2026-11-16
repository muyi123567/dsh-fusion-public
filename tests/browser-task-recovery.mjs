import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const url = process.argv[2];
const taskId = process.argv[3];
if (!url || !taskId) {
  throw new Error("Usage: node tests/browser-task-recovery.mjs <dsh-url> <task-id>");
}

const outputDir = process.env.DSH_SMOKE_OUTPUT_DIR ?? "artifacts/task-recovery";
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const report = {
  taskId,
  startedAt: new Date().toISOString(),
  pageErrors: [],
  consoleErrors: [],
  checks: [],
};

function record(name, ok, detail, evidence = undefined) {
  report.checks.push({ name, ok, detail, evidence });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  if (!ok) throw new Error(`${name}: ${detail}`);
}

let page;
try {
  page = await browser.newPage({ viewport: { width: 1536, height: 1024 }, locale: "zh-CN" });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  record("DSH page response", response?.status() === 200, `HTTP ${response?.status()}`);
  await page.waitForTimeout(1_000);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    for (const name of ["Continue", "Configure later", "Got it", "Close", "继续", "稍后配置", "知道了", "关闭"]) {
      const button = page.getByRole("button", { name, exact: true });
      if (await button.count() > 0 && await button.first().isVisible()) {
        await button.first().click();
        await page.waitForTimeout(200);
      }
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }

  const fusion = page.getByRole("button", { name: "打开 DSH Fusion", exact: true });
  await fusion.waitFor({ state: "visible", timeout: 30_000 });
  await fusion.click();
  await page.locator("[data-dsh-fusion-overlay]").waitFor({ state: "visible", timeout: 20_000 });

  const state = await page.evaluate(async () => {
    const response = await fetch("/plugins/dsh-fusion/state", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    return { status: response.status, body: await response.json() };
  });
  const snapshotTask = state.body.tasks?.find((task) => task.id === taskId);
  record(
    "Task recovered in snapshot after DSH restart",
    state.status === 200 && snapshotTask !== undefined,
    snapshotTask === undefined
      ? "Task missing from snapshot"
      : `status=${snapshotTask.status} evidence=${snapshotTask.evidence?.length ?? 0}`,
    snapshotTask,
  );

  let inspected;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    inspected = await page.evaluate(async ({ taskId }) => {
      const response = await fetch(
        `/plugins/dsh-fusion/tasks/status?taskId=${encodeURIComponent(taskId)}`,
        {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        },
      );
      return { status: response.status, body: await response.json() };
    }, { taskId });
    if (
      inspected.status === 200
      && ["completed", "failed", "cancelled"].includes(inspected.body?.status)
    ) {
      break;
    }
    await page.waitForTimeout(1_000);
  }
  record(
    "Task inspect route survives DSH restart",
    inspected.status === 200
      && inspected.body?.id === taskId
      && inspected.body?.status === "completed",
    `HTTP ${inspected.status} status=${inspected.body?.status ?? "unknown"}`,
    inspected.body,
  );
  const recoveredEvidence = (inspected.body?.evidence ?? [])
    .map((item) => String(item.value ?? ""))
    .join("\n");
  record(
    "Recovered task retains completion evidence",
    recoveredEvidence.includes("restart-recovered")
      && recoveredEvidence.includes("remoteStatus=COMPLETED"),
    recoveredEvidence.replaceAll("\n", " | ").slice(0, 500),
    inspected.body,
  );

  await page.getByRole("button", { name: "多机任务", exact: true }).click();
  await page.getByRole("heading", { name: "多机任务", exact: true }).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await page.getByRole("button", {
    name: new RegExp(`查看任务 ${taskId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"),
  }).waitFor({ state: "visible", timeout: 30_000 });
  await page.screenshot({ path: `${outputDir}/recovered.png`, fullPage: true });

  record(
    "No uncaught page errors",
    report.pageErrors.length === 0,
    `${report.pageErrors.length} page errors`,
  );
  const unexpectedConsoleErrors = report.consoleErrors.filter(
    (message) => !message.includes("status of 404 (Not Found)"),
  );
  record(
    "No unexpected console errors",
    unexpectedConsoleErrors.length === 0,
    `${unexpectedConsoleErrors.length} unexpected console errors`,
    report.consoleErrors,
  );
} catch (error) {
  report.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  if (page !== undefined) {
    try {
      await page.screenshot({ path: `${outputDir}/failure.png`, fullPage: true });
      report.failureDom = (await page.locator("body").innerText()).slice(0, 12_000);
    } catch {
      // Preserve the original failure.
    }
  }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(`${outputDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
