import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";

const url = process.argv[2];
if (!url) throw new Error("Usage: node roomqa-browser.mjs <dsh-url>");

const artifactDir = process.env.DSH_SMOKE_OUTPUT_DIR ?? "artifacts/room-live";
await mkdir(artifactDir, { recursive: true });

const report = {
  url: url.replace(/([?&]token=)[^&]+/u, "$1[redacted]"),
  startedAt: new Date().toISOString(),
  checks: [],
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
  screenshots: [],
  sessionId: null,
  createdRoom: null,
  syntheticMentionVisible: false,
  closedRoom: false,
};

function record(name, ok, detail, evidence = undefined) {
  report.checks.push({ name, ok, detail, evidence });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  if (!ok) throw new Error(`${name}: ${detail}`);
}

async function screenshot(page, name) {
  const path = `${artifactDir}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  report.screenshots.push(path);
  return path;
}

async function dismissOnboarding(page) {
  for (const name of ["Continue", "Configure later"]) {
    const button = page.getByRole("button", { name, exact: true });
    if ((await button.count()) > 0) {
      await button.click();
      await page.waitForTimeout(250);
    }
  }
}

async function ensureWorkspace(page) {
  const chooser = page.getByRole("button", { name: "Choose workspace", exact: true });
  await chooser.waitFor({ state: "visible", timeout: 15_000 });
  const chooserText = (await chooser.innerText()).trim();
  if (chooserText !== "" && !chooserText.includes("Choose workspace")) return;

  await chooser.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const folder = dialog.getByRole("button", { name: "roomqa-workspace", exact: true });
  if ((await folder.count()) > 0) await folder.click();
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
  await page.waitForTimeout(1_500);
}

async function ensureMaterializedSession(page) {
  const composer = page.locator('[data-composer-input="true"]').last();
  const tabs = page.getByRole("tab");
  if ((await tabs.count()) === 0) {
    const existingSession = page.locator('[role="treeitem"][data-row-key^="session:"]').first();
    if ((await existingSession.count()) === 0) {
      await composer.click();
      await composer.pressSequentially(
        `/room create --name "Seed Room ${Date.now()}" --topic "Browser QA seed"`,
      );
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.waitForTimeout(1_500);
    }

    await composer.click();
    await composer.pressSequentially("materialize browser QA session");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.waitForTimeout(3_500);
  }

  await page.getByRole("tab", { name: "Room", exact: true }).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  const rowKey = await page
    .locator('[role="treeitem"][data-row-key^="session:"]')
    .first()
    .getAttribute("data-row-key");
  if (!rowKey?.startsWith("session:")) throw new Error("Could not resolve the selected DSH session id");
  return rowKey.slice("session:".length);
}

async function selectExistingSession(page) {
  if ((await page.getByRole("tab").count()) > 0) return;
  const openSidebar = page.getByRole("button", { name: "Open sidebar", exact: true });
  if ((await openSidebar.count()) > 0) await openSidebar.click();
  const row = page.locator('[role="treeitem"][data-row-key^="session:"]').last();
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await row.click();
  await page.getByRole("tab", { name: "Room", exact: true }).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  for (const label of ["Close sidebar", "Collapse sidebar"]) {
    const closeSidebar = page.getByRole("button", { name: label, exact: true });
    if ((await closeSidebar.count()) > 0) {
      await closeSidebar.click();
      break;
    }
  }
}

async function readSnapshot(page, sessionId) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/agent-team-room/api/session/${encodeURIComponent(id)}`, {
      headers: {
        accept: "application/json",
        "x-agent-team-room-client": "1",
      },
      credentials: "same-origin",
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }, sessionId);
}

async function waitForRoom(page, sessionId, roomName) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snapshot = await readSnapshot(page, sessionId);
    const room = snapshot.body?.rooms?.find((candidate) => candidate.name === roomName);
    if (room) return { snapshot, room };
    await page.waitForTimeout(300);
  }
  throw new Error(`Room ${roomName} did not appear in the snapshot`);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
});
const page = await context.newPage();

page.on("console", (message) => {
  if (message.type() === "error") report.consoleErrors.push(message.text());
});
page.on("pageerror", (error) => report.pageErrors.push(error.message));
page.on("requestfailed", (request) => {
  report.requestFailures.push({
    url: request.url(),
    error: request.failure()?.errorText ?? "unknown",
  });
});

try {
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  record("DSH page response", response?.ok() === true, `HTTP ${response?.status() ?? "none"}`);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(1_500);
  await dismissOnboarding(page);
  await ensureWorkspace(page);

  const bodyText = await page.locator("body").innerText({ timeout: 10_000 });
  record("DSH shell rendered", bodyText.trim().length > 20, bodyText.trim().slice(0, 160));
  await screenshot(page, "01-dsh-loaded");

  report.sessionId = await ensureMaterializedSession(page);
  record("Session materialized", report.sessionId.startsWith("session-"), report.sessionId);

  const roomButtons = page.locator('button[aria-label="Open Rooms"]:visible');
  record("Room native entries mounted", (await roomButtons.count()) > 0, `${await roomButtons.count()} visible triggers`);

  const snapshot = await readSnapshot(page, report.sessionId);
  record(
    "Read-only Room snapshot",
    snapshot.status === 200 && Array.isArray(snapshot.body?.rooms),
    `HTTP ${snapshot.status}; rooms=${snapshot.body?.rooms?.length ?? "missing"}`,
  );

  await page.getByRole("tab", { name: "Room", exact: true }).click();
  const roomView = page.locator("[data-room-conversation-view]");
  await roomView.waitFor({ state: "visible", timeout: 15_000 });
  record(
    "Native Room conversation view",
    (await roomView.getAttribute("aria-label")) === "Room conversation",
    "Room tab renders the embedded conversation workspace",
  );
  await screenshot(page, "02-room-conversation-view");

  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  const enabledRoomButton = page
    .locator('button[aria-label="Open Rooms"]:not([disabled]):visible')
    .first();
  await enabledRoomButton.waitFor({ state: "visible", timeout: 10_000 });
  await enabledRoomButton.click();
  const modal = page.getByRole("dialog").filter({ hasText: "Your Rooms" }).first();
  await modal.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(500);
  record("Rooms native Modal", await modal.isVisible(), "Native Rooms dialog is visible");
  await screenshot(page, "03-room-modal");

  const roomName = `Instabox QA ${Date.now()}`;
  const roomTopic = "Synthetic browser QA room";
  await modal.getByRole("button", { name: "New", exact: true }).click();
  await modal.getByLabel("Room name").fill(roomName);
  await modal.getByLabel("Room topic").fill(roomTopic);
  await modal.getByRole("button", { name: "Create Room", exact: true }).click();

  const created = await waitForRoom(page, report.sessionId, roomName);
  report.createdRoom = created.room;
  record(
    "Create Room through native UI",
    created.room.topic === roomTopic && created.room.status === "open",
    `${created.room.name}; id=${created.room.id}`,
  );
  await modal.getByRole("heading", { name: roomName, exact: true }).waitFor({ state: "visible" });
  await screenshot(page, "04-room-created");

  await modal.getByRole("button", { name: "Attach Session", exact: true }).click();
  const invitePanel = modal.locator("[data-room-invite]");
  await invitePanel.waitFor({ state: "visible" });
  const inviteText = await invitePanel.innerText();
  record(
    "Attach provider seam",
    inviteText.includes("Existing continuable child Sessions")
      && inviteText.includes("No unattached child Session is available."),
    inviteText.replace(/\s+/g, " ").slice(0, 240),
  );
  await screenshot(page, "05-attach-panel");

  await modal.getByRole("button", { name: "Attach Session", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  const syntheticSnapshot = {
    rooms: [{
      id: "synthetic-room",
      name: "Synthetic Release Room",
      topic: "Mention QA",
      leaderSessionId: report.sessionId,
      status: "open",
      members: [
        {
          memberId: "leader-member",
          kind: "leader",
          name: "Leader",
          connection: {
            providerId: "dsh-session",
            protocol: "dsh.session/v1",
            sessionId: report.sessionId,
          },
          status: "leader",
        },
        {
          memberId: "member-mira-123456",
          kind: "member",
          name: "Mira",
          connection: {
            providerId: "dsh-session",
            protocol: "dsh.session/v1",
            sessionId: "child-synthetic",
          },
          status: "idle",
        },
      ],
      activity: [],
      conversation: {
        messages: [],
        unavailableMemberIds: [],
        hiddenMixedReplyCount: 0,
      },
    }],
  };

  const snapshotRoute = /\/agent-team-room\/api\/session\//;
  await page.route(snapshotRoute, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(syntheticSnapshot),
    });
  });

  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  const composer = page.locator('[data-composer-input="true"]:visible').last();
  await composer.waitFor({ state: "visible", timeout: 10_000 });
  await composer.click();
  await composer.pressSequentially("@");
  await page.waitForTimeout(1_500);
  const mentionText = await page.locator("body").innerText();
  report.syntheticMentionVisible =
    mentionText.includes("Room members")
    && mentionText.includes("Mira")
    && mentionText.includes("Synthetic Release Room");
  record(
    "Native @ member source",
    report.syntheticMentionVisible,
    mentionText.includes("Mira")
      ? "Room members source and synthetic member are visible"
      : "Room member candidate did not render",
  );
  await screenshot(page, "06-mention-menu");
  await page.keyboard.press("Escape");
  await page.unroute(snapshotRoute);

  await enabledRoomButton.click();
  await modal.waitFor({ state: "visible" });
  await modal.getByRole("heading", { name: roomName, exact: true }).waitFor({ state: "visible" });
  await modal.getByRole("button", { name: "Close Room", exact: true }).click();
  const risk = page.getByRole("dialog").filter({ hasText: "Close this Room?" }).last();
  await risk.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(500);
  record(
    "Close Room risk confirmation",
    await risk.isVisible(),
    "Acknowledgment gate appears before destructive action",
  );
  await screenshot(page, "07-close-risk");
  await risk
    .getByRole("checkbox", { name: "I understand this Room will be closed.", exact: true })
    .check();
  await risk.getByRole("button", { name: "Close Room", exact: true }).click();
  const closeDeadline = Date.now() + 15_000;
  while (Date.now() < closeDeadline) {
    const current = await readSnapshot(page, report.sessionId);
    const room = current.body?.rooms?.find((candidate) => candidate.id === report.createdRoom.id);
    if (room?.status === "closed") {
      report.closedRoom = true;
      break;
    }
    await page.waitForTimeout(300);
  }
  record("Close Room completes", report.closedRoom, `${report.createdRoom.name} is closed`);
  await page.keyboard.press("Escape");

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "en-US",
  });
  const mobilePage = await mobile.newPage();
  mobilePage.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(`mobile: ${message.text()}`);
  });
  mobilePage.on("pageerror", (error) => report.pageErrors.push(`mobile: ${error.message}`));
  await mobilePage.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await mobilePage.waitForTimeout(1_500);
  await dismissOnboarding(mobilePage);
  await ensureWorkspace(mobilePage);
  await selectExistingSession(mobilePage);
  await mobilePage.getByRole("tab", { name: "Room", exact: true }).click();
  const mobileRoomView = mobilePage.locator("[data-room-conversation-view]");
  await mobileRoomView.waitFor({ state: "visible", timeout: 15_000 });
  const mobileViewOverflow = await mobilePage.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  record(
    "Mobile Room conversation width",
    mobileViewOverflow.scrollWidth <= mobileViewOverflow.clientWidth + 1,
    `${mobileViewOverflow.scrollWidth}/${mobileViewOverflow.clientWidth}`,
  );
  await screenshot(mobilePage, "08-mobile-room-view");

  const mobileButtons = mobilePage.locator(
    'button[aria-label="Open Rooms"]:not([disabled]):visible',
  );
  await mobileButtons.first().waitFor({ state: "visible", timeout: 10_000 });
  record("Mobile Room entry", (await mobileButtons.count()) > 0, "Room trigger is visible at 390px");
  await mobileButtons.first().click();
  await mobilePage.getByRole("dialog").filter({ hasText: "Your Rooms" }).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await mobilePage.waitForTimeout(500);
  const overflow = await mobilePage.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  record(
    "Mobile layout width",
    overflow.scrollWidth <= overflow.clientWidth + 1,
    `${overflow.scrollWidth}/${overflow.clientWidth}`,
  );
  await screenshot(mobilePage, "09-mobile-room-modal");
  await mobile.close();

  record(
    "No uncaught page errors",
    report.pageErrors.length === 0,
    report.pageErrors.length === 0 ? "0 page errors" : report.pageErrors.join(" | "),
  );
  record(
    "No console errors",
    report.consoleErrors.length === 0,
    report.consoleErrors.length === 0 ? "0 console errors" : report.consoleErrors.join(" | "),
  );
} catch (error) {
  report.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  try {
    await screenshot(page, "99-failure");
    report.failureDom = (await page.locator("body").innerText()).slice(0, 12_000);
  } catch {
    // Preserve the original failure.
  }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(`${artifactDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
