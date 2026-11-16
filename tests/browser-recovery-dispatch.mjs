import { chromium } from "playwright-core";

const url = process.argv[2];
const suppliedKey = process.argv[3];
if (!url) throw new Error("Usage: node tests/browser-recovery-dispatch.mjs <dsh-url> [idempotency-key]");

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
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

  const result = await page.evaluate(async ({ suppliedKey }) => {
    const stateResponse = await fetch("/plugins/dsh-fusion/state", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const state = await stateResponse.json();
    const node = state.nodes?.find((candidate) =>
      String(candidate.providerId ?? "").startsWith("instabox")
    );
    if (node === undefined) throw new Error("Instabox node not configured");
    const idempotencyKey = suppliedKey?.trim() || `fusion-recovery-${Date.now()}`;
    const goal = `restart recovery ${Date.now()}`;
    const response = await fetch("/plugins/dsh-fusion/tasks", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        goal,
        command: "sleep 20; printf 'restart-recovered\\n'; hostname",
        nodeIds: [node.id],
      }),
    });
    return {
      status: response.status,
      body: await response.json(),
      idempotencyKey,
    };
  }, { suppliedKey });
  if ((result.status !== 200 && result.status !== 202) || typeof result.body?.id !== "string") {
    throw new Error(`Dispatch failed: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  }
  if (!/^INSTABOX-[0-9a-f]{32}$/u.test(result.body.id)) {
    throw new Error(`Provider did not return a deterministic id: ${result.body.id}`);
  }
  console.log(JSON.stringify({
    taskId: result.body.id,
    status: result.body.status,
    goal: result.body.goal,
    nodeIds: result.body.targetNodeIds,
    idempotencyKey: result.idempotencyKey,
  }));
} finally {
  await browser.close();
}
