import { InstaboxProvider } from "../packages/host/dist/providers/instabox-provider.js";

const apiKey = process.env.INSTABOX_API_KEY?.trim();
const machineName = process.env.FUSION_INSTABOX_MACHINE?.trim();

if (!apiKey) throw new Error("INSTABOX_API_KEY is required");
if (!machineName) throw new Error("FUSION_INSTABOX_MACHINE is required");

const options = {
  apiKey,
  machineName,
  nodeId: process.env.FUSION_INSTABOX_NODE_ID?.trim() || undefined,
  timeoutMs: 60_000,
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

let health = await provider.health();
for (let attempt = 0; health.state !== "connected" && attempt < 3; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  health = await provider.health();
}
const nodes = await provider.listNodes();
const node = nodes[0];
if (node === undefined) throw new Error("Instabox node was not reported");

const symlinkStamp = Date.now();
const symlinkTarget = `/tmp/instabox-smoke-target-${symlinkStamp}`;
const symlinkParent = `/tmp/instabox-smoke-link-${symlinkStamp}`;
let parentSymlinkError = "";
await execOnMachine(node.externalId, [
  "set -eu",
  `target=${shellQuote(symlinkTarget)}`,
  `link=${shellQuote(symlinkParent)}`,
  'mkdir -p -- "$target"',
  'ln -s -- "$target" "$link"',
].join("\n"));
try {
  const symlinkProvider = new InstaboxProvider({
    ...options,
    jobRoot: `${symlinkParent}/nested/jobs`,
  });
  await symlinkProvider.dispatch({
    goal: "reject parent symlink",
    nodeIds: [node.id],
    command: "true",
  });
} catch (error) {
  parentSymlinkError = error instanceof Error ? error.message : String(error);
} finally {
  await execOnMachine(node.externalId, [
    "set -eu",
    `target=${shellQuote(symlinkTarget)}`,
    `link=${shellQuote(symlinkParent)}`,
    'rm -rf -- "$link" "$target"',
  ].join("\n"));
}

const doctor = await provider.doctor();
const marker = `instabox-smoke-${Date.now()}`;
const dispatched = await provider.dispatch({
  goal: "verify recoverable Instabox remote jobs",
  nodeIds: [node.id],
  command: [
    `printf '%s\\n' '${marker}-stdout'`,
    "sleep 1",
  ].join("\n"),
});

if (dispatched.status !== "running") {
  throw new Error(`Instabox dispatch was not running: ${dispatched.status}`);
}

const recoveredProvider = new InstaboxProvider(options);
const deadline = Date.now() + 60_000;
let task = await recoveredProvider.inspect(dispatched.id);
while (task.status === "running" && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  task = await recoveredProvider.inspect(dispatched.id);
}

const summary = task.evidence.find((item) => item.kind === "summary");
const stdout = task.evidence.find((item) => item.kind === "command");
const stderr = task.evidence.find((item) => item.kind === "log");
const evidenceOk = (
  summary?.value.includes("exit=0") === true
  && stdout?.value.includes(`${marker}-stdout`) === true
  && stderr?.value === "(empty)"
);

console.log(JSON.stringify({
  health: health.state,
  node: {
    id: node.id,
    status: node.status,
  },
  doctorEvidenceLength: doctor.evidence[0]?.value.length ?? 0,
  parentSymlinkRejected: parentSymlinkError.includes(
    `INSTABOX_JOB_START_FAILED:INSTABOX_JOB_PATH_SYMLINK:${symlinkParent}`,
  ),
  parentSymlinkError,
  dispatched: {
    id: dispatched.id,
    status: dispatched.status,
    expectedEvidence: dispatched.expectedEvidence,
  },
  recovered: {
    id: task.id,
    status: task.status,
    evidenceKinds: task.evidence.map((item) => item.kind),
    stdout: stdout?.value,
    stderr: stderr?.value,
    evidenceOk,
  },
}));

if (
  health.state !== "connected"
  || node.status !== "online"
  || !parentSymlinkError.includes(
    `INSTABOX_JOB_START_FAILED:INSTABOX_JOB_PATH_SYMLINK:${symlinkParent}`,
  )
  || task.status !== "completed"
  || !evidenceOk
) {
  process.exitCode = 1;
}
