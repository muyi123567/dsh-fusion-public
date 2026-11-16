import { InstaboxProvider } from "../packages/host/dist/providers/instabox-provider.js";

const apiKey = process.env.INSTABOX_API_KEY?.trim();
const machineName = process.env.FUSION_INSTABOX_MACHINE?.trim();

if (!apiKey) throw new Error("INSTABOX_API_KEY is required");
if (!machineName) throw new Error("FUSION_INSTABOX_MACHINE is required");

const nodeId = process.env.FUSION_INSTABOX_NODE_ID?.trim()
  || `instabox-${machineName.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-")}`;
const options = {
  apiKey,
  machineName,
  nodeId,
  timeoutMs: 30_000,
};
const provider = new InstaboxProvider(options);
const apiBaseUrl = (process.env.INSTABOX_API_BASE_URL?.trim() || "https://api.instabox.sh")
  .replace(/\/+$/u, "");

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function execOnMachine(machineId, command) {
  const response = await fetch(
    `${apiBaseUrl}/v1/machines/${encodeURIComponent(machineId)}/exec`,
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        cmd: command,
        timeoutSeconds: 30,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Instabox smoke exec failed: ${response.status}: ${text.slice(0, 256)}`);
  }
  const result = JSON.parse(text);
  if (result.exitCode !== 0) {
    throw new Error(`Instabox smoke exec exited ${result.exitCode}: ${String(result.stderr).slice(0, 256)}`);
  }
  return result;
}

async function inspectUntilTerminal(providerInstance, taskId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let task = await providerInstance.inspect(taskId);
  while (task.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    task = await providerInstance.inspect(taskId);
  }
  return task;
}

function summaryValue(task, label) {
  return task.evidence.find((item) => item.label === label)?.value ?? "";
}

function summaryField(task, field) {
  const value = summaryValue(task, `${task.id}:summary`);
  const match = value.match(new RegExp(`^${field}=(.+)$`, "mu"));
  return match?.[1];
}

async function readJobProcessIdentity(machineId, pid) {
  const result = await execOnMachine(machineId, [
    "set -eu",
    `pid=${pid}`,
    "boot_id=$(cat -- /proc/sys/kernel/random/boot_id)",
    'starttime=$(awk \'{print $22}\' "/proc/$pid/stat")',
    'session_id=$(ps -o sid= -p "$pid" | tr -d "[:space:]")',
    "printf 'BOOT_ID=%s\\n' \"$boot_id\"",
    "printf 'STARTTIME=%s\\n' \"$starttime\"",
    "printf 'SESSION_ID=%s\\n' \"$session_id\"",
  ].join("\n"));
  const values = Object.fromEntries(
    result.stdout.split(/\r?\n/u).flatMap((line) => {
      const separator = line.indexOf("=");
      return separator <= 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
    }),
  );
  if (!values.BOOT_ID || !values.STARTTIME || !values.SESSION_ID) {
    throw new Error("could not read the running job process identity");
  }
  return values;
}

async function installStateLock(machineId, jobDir, owner) {
  const createdAt = Math.floor(Date.now() / 1_000) - 60;
  await execOnMachine(machineId, [
    "set -eu",
    `job_dir=${shellQuote(jobDir)}`,
    'mkdir -p -- "$job_dir/.state.lock"',
    `printf '%s\\n' '${createdAt}' > "$job_dir/.state.lock/created_at"`,
    `printf '%s\\n' ${shellQuote(owner.bootId)} > "$job_dir/.state.lock/lock_owner_boot_id"`,
    `printf '%s\\n' '${owner.pid}' > "$job_dir/.state.lock/lock_owner_pid"`,
    `printf '%s\\n' ${shellQuote(owner.starttime)} > "$job_dir/.state.lock/lock_owner_starttime"`,
    `printf '%s\\n' ${shellQuote(owner.sessionId)} > "$job_dir/.state.lock/lock_owner_session_id"`,
    `printf '%s\\n' ${shellQuote("smoke-owner-token")} > "$job_dir/.state.lock/token"`,
  ].join("\n"));
}

async function removeStateLock(machineId, jobDir) {
  await execOnMachine(machineId, [
    "set -eu",
    `job_dir=${shellQuote(jobDir)}`,
    'rm -rf -- "$job_dir/.state.lock"',
  ].join("\n"));
}

const task = await provider.dispatch({
  goal: "Instabox cancel smoke",
  nodeIds: [nodeId],
  command: "sleep 30; echo should-not-run",
});

if (task.status !== "running") {
  throw new Error(`expected running after dispatch, received ${task.status}`);
}

const [node] = await provider.listNodes();
if (node === undefined) throw new Error("Instabox node was not reported");
const summary = task.evidence.find((item) => item.kind === "summary");
const jobDirMatch = summary?.value.match(/^jobDir=(.+)$/mu);
if (jobDirMatch?.[1] === undefined) {
  throw new Error("dispatch summary did not include jobDir");
}
const jobDir = jobDirMatch[1];
const jobPid = Number(summaryField(task, "pid"));
if (!Number.isInteger(jobPid) || jobPid <= 1) {
  throw new Error("dispatch summary did not include a valid PID");
}

const recoveredProvider = new InstaboxProvider(options);
await new Promise((resolve) => setTimeout(resolve, 1_000));
const before = await recoveredProvider.inspect(task.id);
if (before.status !== "running") {
  throw new Error(`expected running before cancel, received ${before.status}`);
}

const liveIdentity = await readJobProcessIdentity(node.externalId, jobPid);
await installStateLock(node.externalId, jobDir, {
  bootId: liveIdentity.BOOT_ID,
  pid: jobPid,
  starttime: liveIdentity.STARTTIME,
  sessionId: liveIdentity.SESSION_ID,
});
let liveLockError = "";
try {
  await recoveredProvider.cancel(task.id);
} catch (error) {
  liveLockError = error instanceof Error ? error.message : String(error);
}
const afterLiveLock = await recoveredProvider.inspect(task.id);
await removeStateLock(node.externalId, jobDir);

await installStateLock(node.externalId, jobDir, {
  bootId: "00000000-0000-0000-0000-000000000000",
  pid: 999999,
  starttime: "1",
  sessionId: "999999",
});
await recoveredProvider.cancel(task.id);
await new Promise((resolve) => setTimeout(resolve, 750));
const after = await recoveredProvider.inspect(task.id);
await recoveredProvider.cancel(task.id);

const completedTask = await recoveredProvider.dispatch({
  goal: "Instabox completed-cancel smoke",
  nodeIds: [nodeId],
  command: "true",
});
const completed = await inspectUntilTerminal(recoveredProvider, completedTask.id);
let terminalError = "";
try {
  await recoveredProvider.cancel(completedTask.id);
} catch (error) {
  terminalError = error instanceof Error ? error.message : String(error);
}

const result = {
  id: task.id,
  dispatched: task.status,
  beforeCancel: before.status,
  liveLock: {
    error: liveLockError,
    statusAfterRejectedCancel: afterLiveLock.status,
  },
  afterCancel: after.status,
  staleLockRecovered: after.status === "cancelled",
  evidenceKinds: after.evidence.map((item) => item.kind),
  statusEvidence: after.evidence.find((item) => item.kind === "summary")?.value,
  completed: {
    id: completedTask.id,
    status: completed.status,
    cancelError: terminalError,
  },
};
console.log(JSON.stringify(result));

if (
  !liveLockError.includes("INSTABOX_JOB_LOCK_TIMEOUT")
  || afterLiveLock.status !== "running"
  || after.status !== "cancelled"
  || completed.status !== "completed"
  || terminalError !== "INSTABOX_TASK_ALREADY_TERMINAL:COMPLETED"
) {
  process.exitCode = 1;
}
