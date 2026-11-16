import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const requireFromPlugin = createRequire(
  new URL("../packages/plugin/package.json", import.meta.url),
);
const WebSocket = requireFromPlugin("ws");

const baseUrl = process.env.PTY_BASE_URL;
const cookie = process.env.PTY_COOKIE;
const nodeId = process.env.PTY_NODE_ID ?? "huawei-hs-monitor-cn";
if (!baseUrl || !cookie) {
  throw new Error("PTY_BASE_URL and PTY_COOKIE are required");
}

const origin = new URL(baseUrl).origin;
const sshProcessesBefore = process.platform === "win32"
  ? Number(execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "@(Get-Process -Name ssh,ssh2 -ErrorAction SilentlyContinue).Count",
    ], { encoding: "utf8" }).trim()) || 0
  : 0;
const headers = {
  cookie,
  origin,
};

const create = await fetch(new URL("/plugins/dsh-fusion/pty/create", baseUrl), {
  method: "POST",
  headers: {
    ...headers,
    "content-type": "application/json",
  },
  body: JSON.stringify({ nodeId, cols: 100, rows: 30 }),
});
const created = await create.json();
if (
  !create.ok
  || typeof created.terminalId !== "string"
  || typeof created.terminalToken !== "string"
) {
  throw new Error(`create failed: ${create.status} ${created.error ?? "UNKNOWN"}`);
}

const socketUrl = new URL("/plugins/dsh-fusion/pty/ws", baseUrl);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";

const socket = new WebSocket(socketUrl, {
  headers: {
    ...headers,
  },
});

const chunks = [];
const waiters = [];
let closed = false;
let connected = false;

const sendInput = (value) => {
  socket.send(JSON.stringify({
    type: "input",
    data: Buffer.from(value, "utf8").toString("base64"),
  }));
};

const waitForText = (needle, timeoutMs = 12_000) => new Promise((resolve, reject) => {
  const existing = Buffer.concat(chunks).toString("utf8");
  if (existing.includes(needle)) {
    resolve(existing);
    return;
  }
  const timer = setTimeout(() => {
    const index = waiters.findIndex((entry) => entry.resolve === done);
    if (index >= 0) waiters.splice(index, 1);
    reject(new Error(`timeout waiting for ${needle}`));
  }, timeoutMs);
  const done = (value) => {
    clearTimeout(timer);
    resolve(value);
  };
  waiters.push({ needle, resolve: done, reject });
});

const notify = (text) => {
  for (const waiter of [...waiters]) {
    if (text.includes(waiter.needle)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(text);
    }
  }
};

socket.on("message", (data) => {
  const message = JSON.parse(data.toString());
  if (message.type === "state" && message.state === "connected") {
    connected = true;
  }
  if (message.type === "snapshot" || message.type === "output") {
    const buffer = Buffer.from(message.data, "base64");
    chunks.push(buffer);
    notify(Buffer.concat(chunks).toString("utf8"));
  }
});
socket.on("close", () => {
  closed = true;
});
socket.on("error", (error) => {
  for (const waiter of waiters.splice(0)) waiter.reject(error);
});

await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
socket.send(JSON.stringify({
  type: "auth",
  terminalId: created.terminalId,
  terminalToken: created.terminalToken,
}));
await new Promise((resolve, reject) => {
  const started = Date.now();
  const timer = setInterval(() => {
    if (connected) {
      clearInterval(timer);
      resolve();
    } else if (Date.now() - started > 5_000) {
      clearInterval(timer);
      reject(new Error("timeout waiting for PTY authentication"));
    }
  }, 25);
});
await new Promise((resolve) => setTimeout(resolve, 200));
const promptDeadline = Date.now() + 3_000;
while (!/[#$>]\s*$/.test(Buffer.concat(chunks).toString("utf8"))) {
  if (Date.now() > promptDeadline) {
    throw new Error("timeout waiting for shell prompt");
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}

sendInput("printf '__PTY_TTY__'; tty; printf '__PTY_HOST__'; hostname\n");
await waitForText("__PTY_HOST__hs-monitor-cn");
sendInput("printf '__PTY_RESIZE_REQUEST__'; stty rows 40 cols 120\n");
await new Promise((resolve) => setTimeout(resolve, 300));
socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
sendInput("printf '__PTY_RESIZED__'; stty size\n");
await waitForText("__PTY_RESIZED__");

sendInput("sleep 30\n");
await new Promise((resolve) => setTimeout(resolve, 400));
sendInput("\u0003printf '__PTY_INTERRUPT__'; echo alive\n");
await waitForText("__PTY_INTERRUPT__alive");

const output = Buffer.concat(chunks).toString("utf8");
if (process.env.PTY_DEBUG_FILE) {
  writeFileSync(process.env.PTY_DEBUG_FILE, output, "utf8");
}
const resizeWindow = output.match(/__PTY_RESIZED__(\d+)\s+(\d+)/);
const evidence = {
  created: true,
  authenticated: connected,
  prompt: true,
  tty: /__PTY_TTY__\/dev\/pts\/\d+/.test(output),
  hostname: /__PTY_HOST__[^\r\n']+/.test(output),
  resized: resizeWindow?.[1] === "40" && resizeWindow?.[2] === "120",
  interrupted: output.includes("__PTY_INTERRUPT__alive"),
  bytes: Buffer.concat(chunks).length,
};

socket.send(JSON.stringify({
  type: "close",
  terminalToken: created.terminalToken,
}));
await new Promise((resolve) => {
  if (closed) {
    resolve();
    return;
  }
  socket.once("close", resolve);
  setTimeout(resolve, 2_000);
});

if (process.platform === "win32") {
  const residual = Number(execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "@(Get-Process -Name ssh,ssh2 -ErrorAction SilentlyContinue).Count",
  ], { encoding: "utf8" }).trim()) || 0;
  evidence.residualSshProcesses = Math.max(0, residual - sshProcessesBefore);
}

console.log(JSON.stringify(evidence));
const failed = (
  !evidence.authenticated
  || !evidence.tty
  || !evidence.hostname
  || !evidence.resized
  || !evidence.interrupted
  || (evidence.residualSshProcesses ?? 0) > 0
);
process.exit(failed ? 1 : 0);
