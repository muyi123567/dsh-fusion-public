import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const url = process.argv[2];
if (!url) throw new Error("Usage: node tests/browser-second-account-live.mjs <dsh-url>");

const outputDir = process.env.DSH_SMOKE_OUTPUT_DIR ?? "artifacts/second-account-live";
await mkdir(outputDir, { recursive: true });

const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  http: [],
  pageErrors: [],
  consoleErrors: [],
  node: null,
  completedTask: null,
  cancelledTask: null,
};

function record(name, ok, detail, evidence = undefined) {
  report.checks.push({ name, ok, detail, evidence });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  if (!ok) throw new Error(`${name}: ${detail}`);
}

async function dismissOnboarding(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const skipButton = page.getByRole("button", { name: "稍后配置", exact: true });
    if (await skipButton.count() > 0 && await skipButton.first().isVisible()) {
      await skipButton.first().evaluate((element) => {
        if (element instanceof HTMLElement) element.click();
      });
      await page.waitForTimeout(500);
    }
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
      if (await button.count() > 0 && await button.first().isVisible()) {
        await button.first().click();
        await page.waitForTimeout(200);
      }
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
}

async function request(page, path, init = {}) {
  const result = await page.evaluate(async ({ path, init }) => {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let body;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }, { path, init });
  report.http.push({ method: init.method ?? "GET", path, status: result.status });
  return result;
}

async function pollTask(page, taskId, terminalStatuses, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await request(
      page,
      `/plugins/dsh-fusion/tasks/status?taskId=${encodeURIComponent(taskId)}`,
    );
    if (latest.status === 200 && terminalStatuses.includes(latest.body?.status)) {
      return latest.body;
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`Task ${taskId} did not reach ${terminalStatuses.join("/")}: ${JSON.stringify(latest)}`);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

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
  await dismissOnboarding(page);

  const fusion = page.getByRole("button", { name: "打开 DSH Fusion", exact: true });
  await fusion.waitFor({ state: "visible", timeout: 30_000 });
  await fusion.click();
  await page.locator("[data-dsh-fusion-overlay]").waitFor({
    state: "visible",
    timeout: 20_000,
  });

  let snapshot;
  let node;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    snapshot = await request(page, "/plugins/dsh-fusion/state");
    if (snapshot.status !== 200) throw new Error(`State route returned HTTP ${snapshot.status}`);
    node = snapshot.body.nodes?.find((candidate) =>
      String(candidate.providerId ?? "").startsWith("instabox")
      || String(candidate.id ?? "").includes("instabox")
    );
    if (node !== undefined && node.status === "online") break;
    await page.waitForTimeout(1_000);
  }
  record(
    "Instabox node online",
    node !== undefined && node.status === "online",
    node === undefined
      ? "No Instabox node in snapshot"
      : `${node.name ?? node.id} provider=${node.providerId ?? "unknown"} status=${node.status}`,
    node,
  );
  report.node = node;

  const doctorReport = await request(page, "/plugins/dsh-fusion/doctor");
  record(
    "Combined doctor route",
    [200, 503].includes(doctorReport.status)
      && ["ok", "degraded", "failed"].includes(doctorReport.body?.status),
    `HTTP ${doctorReport.status} status=${doctorReport.body?.status ?? "unknown"}`,
    doctorReport.body,
  );

  const doctor = await request(page, "/plugins/dsh-fusion/node-doctor?nodeId=" + encodeURIComponent(node.id));
  record(
    "Node doctor route",
    doctor.status === 200 && doctor.body?.status !== "failed",
    `HTTP ${doctor.status} status=${doctor.body?.status ?? "unknown"}`,
    doctor.body,
  );

  const agentTeamsState = await request(page, "/plugins/dsh-agent-teams/state");
  record(
    "AgentTeams state route",
    agentTeamsState.status === 200
      && agentTeamsState.body !== null
      && typeof agentTeamsState.body === "object",
    `HTTP ${agentTeamsState.status}`,
    agentTeamsState.body,
  );

  const agentBusState = await request(page, "/plugins/dsh-agent-bus/state");
  record(
    "AgentBus state route",
    agentBusState.status === 200
      && agentBusState.body !== null
      && typeof agentBusState.body === "object",
    `HTTP ${agentBusState.status}`,
    agentBusState.body,
  );

  const sse = await page.evaluate(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch("/plugins/dsh-fusion/events", {
        credentials: "same-origin",
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      const first = reader === undefined ? undefined : await reader.read();
      controller.abort();
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        firstChunk: first?.value === undefined
          ? ""
          : new TextDecoder().decode(first.value),
      };
    } finally {
      clearTimeout(timeout);
    }
  });
  record(
    "SSE event stream connected",
    sse.status === 200
      && String(sse.contentType).includes("text/event-stream")
      && sse.firstChunk.includes(": connected"),
    `HTTP ${sse.status} ${sse.contentType} first=${JSON.stringify(sse.firstChunk)}`,
    sse,
  );

  const invalid = await request(page, "/plugins/dsh-fusion/tasks", {
    method: "POST",
    body: JSON.stringify({
      goal: "invalid node rejection",
      command: "true",
      nodeIds: ["unknown-node-for-live-contract"],
    }),
  });
  record(
    "Unknown node is rejected",
    invalid.status === 400,
    `HTTP ${invalid.status}: ${JSON.stringify(invalid.body)}`,
  );

  const idempotencyKey = `fusion-live-${Date.now()}`;
  const idempotencyInput = {
    goal: `live idempotent dispatch ${idempotencyKey}`,
    command: "printf 'fusion-idempotent-live\\n'; sleep 1; hostname; uname -s",
    nodeIds: [node.id],
  };
  const firstIdempotent = await request(page, "/plugins/dsh-fusion/tasks", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(idempotencyInput),
  });
  const secondIdempotent = await request(page, "/plugins/dsh-fusion/tasks", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(idempotencyInput),
  });
  record(
    "Live idempotency key coalesces dispatch",
    [200, 202].includes(firstIdempotent.status)
      && [200, 202].includes(secondIdempotent.status)
      && firstIdempotent.body?.id === secondIdempotent.body?.id,
    `first=${firstIdempotent.status}/${firstIdempotent.body?.id ?? "missing"} second=${secondIdempotent.status}/${secondIdempotent.body?.id ?? "missing"}`,
    [firstIdempotent.body, secondIdempotent.body],
  );
  record(
    "Live provider task uses a deterministic id",
    typeof firstIdempotent.body?.id === "string"
      && /^INSTABOX-[0-9a-f]{32}$/u.test(firstIdempotent.body.id),
    `task=${firstIdempotent.body?.id ?? "missing"}`,
    firstIdempotent.body,
  );
  const reusedKey = await request(page, "/plugins/dsh-fusion/tasks", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ ...idempotencyInput, command: "true" }),
  });
  record(
    "Live idempotency key rejects a different payload",
    reusedKey.status === 400
      && reusedKey.body?.error === `FLEET_IDEMPOTENCY_KEY_REUSE:${idempotencyKey}`,
    `HTTP ${reusedKey.status}: ${JSON.stringify(reusedKey.body)}`,
  );

  const marker = `fusion-second-account-live-${Date.now()}`;
  const completedGoal = `second account live ${marker}`;
  const dispatch = await request(page, "/plugins/dsh-fusion/tasks", {
    method: "POST",
    body: JSON.stringify({
      goal: completedGoal,
      command: "printf 'fusion-second-live\\n'; hostname; uname -s; printf 'uid='; id -u; date -u +%Y-%m-%dT%H:%M:%SZ",
      nodeIds: [node.id],
    }),
  });
  record(
    "Live task dispatch accepted",
    dispatch.status === 202 || dispatch.status === 200,
    `HTTP ${dispatch.status} task=${dispatch.body?.id ?? "missing"}`,
    dispatch.body,
  );
  const completedTaskId = dispatch.body?.id;
  if (typeof completedTaskId !== "string") throw new Error("Dispatch response has no task id");

  const completedTask = await pollTask(page, completedTaskId, ["completed"]);
  const evidenceText = (completedTask.evidence ?? [])
    .map((item) => String(item.value ?? ""))
    .join("\n");
  record(
    "Live task completed with real evidence",
    evidenceText.includes("fusion-second-live")
      && evidenceText.includes("Linux")
      && /\buid=\d+\b/u.test(evidenceText),
    evidenceText.replaceAll("\n", " | ").slice(0, 500),
    completedTask,
  );
  report.completedTask = completedTask;

  const cancelMarker = `fusion-second-cancel-${Date.now()}`;
  const cancelGoal = `second account cancel ${cancelMarker}`;
  const cancelDispatch = await request(page, "/plugins/dsh-fusion/tasks", {
    method: "POST",
    body: JSON.stringify({
      goal: cancelGoal,
      command: `printf 'cancel-start\\n'; sleep 60; printf 'cancel-finished\\n'`,
      nodeIds: [node.id],
    }),
  });
  record(
    "Cancellation task dispatch accepted",
    cancelDispatch.status === 202 || cancelDispatch.status === 200,
    `HTTP ${cancelDispatch.status} task=${cancelDispatch.body?.id ?? "missing"}`,
    cancelDispatch.body,
  );
  const cancelTaskId = cancelDispatch.body?.id;
  if (typeof cancelTaskId !== "string") throw new Error("Cancel dispatch response has no task id");
  await page.waitForTimeout(2_000);

  const cancelResult = await request(page, "/plugins/dsh-fusion/tasks/cancel", {
    method: "POST",
    body: JSON.stringify({ taskId: cancelTaskId }),
  });
  record(
    "Live task cancellation accepted",
    cancelResult.status === 200 && cancelResult.body?.cancelled === true,
    `HTTP ${cancelResult.status}: ${JSON.stringify(cancelResult.body)}`,
    cancelResult.body,
  );
  const cancelledTask = await pollTask(page, cancelTaskId, ["cancelled"]);
  const cancelledEvidence = (cancelledTask.evidence ?? [])
    .map((item) => String(item.value ?? ""))
    .join("\n");
  record(
    "Live task ended cancelled without completion output",
    cancelledTask.status === "cancelled" && !cancelledEvidence.includes("cancel-finished"),
    `status=${cancelledTask.status} evidence=${cancelledEvidence.replaceAll("\n", " | ").slice(0, 300)}`,
    cancelledTask,
  );
  report.cancelledTask = cancelledTask;

  await page.getByRole("button", { name: "多机任务", exact: true }).click();
  await page.getByRole("heading", { name: "多机任务", exact: true }).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await page.getByRole("button", {
    name: new RegExp(`查看任务 ${completedTaskId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"),
  }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText(completedGoal, { exact: true }).first().waitFor({
    state: "visible",
    timeout: 20_000,
  });
  await page.getByRole("button", {
    name: new RegExp(`查看任务 ${completedTaskId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"),
  }).click();
  await page.getByRole("region", { name: "任务证据" }).waitFor({
    state: "visible",
    timeout: 20_000,
  });
  await page.getByText("fusion-second-live", { exact: false }).waitFor({
    state: "visible",
    timeout: 20_000,
  });
  const evidence = page.getByRole("region", { name: "任务证据" });
  await evidence.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outputDir}/desktop.png`, fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await evidence.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${outputDir}/mobile.png`, fullPage: true });
  const widths = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  record(
    "Mobile task evidence has no horizontal overflow",
    widths.scrollWidth <= widths.innerWidth,
    `${widths.scrollWidth}/${widths.innerWidth}`,
  );

  record(
    "No uncaught page errors",
    report.pageErrors.length === 0,
    `${report.pageErrors.length} page errors`,
  );
  const expectedNegativeTestError = "Failed to load resource: the server responded with a status of 400 (Bad Request)";
  const expectedDoctorError = "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
  const unexpectedConsoleErrors = report.consoleErrors.filter(
    (message) => message !== expectedNegativeTestError && message !== expectedDoctorError,
  );
  record(
    "No unexpected console errors",
    unexpectedConsoleErrors.length === 0,
    unexpectedConsoleErrors.length === 0
      ? "0 unexpected console errors"
      : unexpectedConsoleErrors.join(" | "),
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
