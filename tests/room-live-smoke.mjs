import { createRequire } from "node:module";

const requireFromClient = createRequire(
  new URL("../packages/client/package.json", import.meta.url),
);
const { chromium } = requireFromClient("playwright-core");
const roomUrl = process.env.ROOM_URL;
if (!roomUrl) throw new Error("ROOM_URL is required");

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
});
const pageErrors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(roomUrl);
  await page.waitForTimeout(2_500);
  const later = page.getByRole("button", { name: "稍后配置" });
  if (await later.count()) await later.click();
  const newSession = page.getByRole("button", { name: /新会话/ });
  if (await newSession.count()) await newSession.click();
  await page.waitForTimeout(2_500);

  const editor = page.locator('[contenteditable="true"]').first();
  const runRoomCommand = async (args) => {
    await editor.click();
    await editor.pressSequentially("/room", { delay: 5 });
    await page.getByRole("option", { name: /^room/ }).click();
    await editor.pressSequentially(` ${args}`, { delay: 5 });
    const responsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/commands/execute"
    ));
    await page.getByRole("button", { name: "发送消息" }).click();
    const response = await responsePromise;
    const body = await response.json();
    if (!response.ok() || body.result?.ok !== true) {
      throw new Error(`ROOM_COMMAND_FAILED:${response.status()}:${JSON.stringify(body).slice(0, 500)}`);
    }
    const commandResult = body.result.value?.result;
    if (commandResult?.kind !== "success") {
      throw new Error(`ROOM_COMMAND_RESULT:${JSON.stringify(commandResult).slice(0, 500)}`);
    }
    return { value: JSON.parse(commandResult.text) };
  };

  const name = `Fusion Room Probe ${Date.now()}`;
  const created = await runRoomCommand(
    `create --name "${name}" --topic "live smoke"`,
  );
  const room = created.value.room;
  if (room === undefined || typeof room.id !== "string") {
    throw new Error(`ROOM_CREATE_SHAPE:${JSON.stringify(created.value).slice(0, 500)}`);
  }
  const sessionId = room.leaderSessionId;
  const nativeOpen = await page.evaluate(async (id) => {
    const response = await fetch(`/agent-team-room/api/session/${encodeURIComponent(id)}`);
    return { status: response.status, body: await response.json() };
  }, sessionId);
  const opened = nativeOpen.body.rooms?.find((candidate) => candidate.id === room.id);

  await runRoomCommand(`close "${room.id}" --interrupt false`);
  const nativeClosed = await page.evaluate(async (id) => {
    const response = await fetch(`/agent-team-room/api/session/${encodeURIComponent(id)}`);
    return { status: response.status, body: await response.json() };
  }, sessionId);
  const closed = nativeClosed.body.rooms?.find((candidate) => candidate.id === room.id);

  const result = {
    createCommand: "success",
    nativeOpen: nativeOpen.status === 200 && opened?.status === "open",
    nativeClosed: nativeClosed.status === 200 && closed?.status === "closed",
    pageErrors: pageErrors.length,
  };
  console.log(JSON.stringify(result));
  if (!result.nativeOpen || !result.nativeClosed || result.pageErrors > 0) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
