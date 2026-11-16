import {
  HuaweiSshProvider,
  createHuaweiSshRunner,
} from "../packages/host/dist/providers/huawei-ssh-provider.js";
import { RemoteNodeConfigService } from "../packages/host/dist/config/remote-node-config.js";

const host = process.env.FUSION_HUAWEI_HOST?.trim();
const keyPath = process.env.FUSION_HUAWEI_KEY?.trim();
const knownHostsPath = process.env.FUSION_HUAWEI_KNOWN_HOSTS?.trim();
const nodeId = process.env.FUSION_HUAWEI_NODE_ID?.trim() || "huawei-test";
const nodeName = process.env.FUSION_HUAWEI_NAME?.trim() || "Huawei test node";
const configPath = process.env.FUSION_HUAWEI_CONFIG_PATH?.trim() || undefined;
const backupPath = process.env.FUSION_HUAWEI_CONFIG_BACKUP?.trim() || undefined;
const applyConfig = process.env.FUSION_HUAWEI_CONFIG_APPLY === "1";
const jobRoot = process.env.FUSION_HUAWEI_JOB_ROOT?.trim() || undefined;
const parsedOutputLimit = Number.parseInt(
  process.env.FUSION_HUAWEI_OUTPUT_LIMIT_BYTES ?? "",
  10,
);
const outputLimitBytes = Number.isInteger(parsedOutputLimit) && parsedOutputLimit > 0
  ? parsedOutputLimit
  : undefined;
const parsedPollIntervalMs = Number.parseInt(
  process.env.FUSION_HUAWEI_POLL_INTERVAL_MS ?? "500",
  10,
);
const parsedTaskTimeoutMs = Number.parseInt(
  process.env.FUSION_HUAWEI_TASK_TIMEOUT_MS ?? "30000",
  10,
);
const pollIntervalMs = Number.isInteger(parsedPollIntervalMs) && parsedPollIntervalMs > 0
  ? parsedPollIntervalMs
  : 500;
const taskTimeoutMs = Number.isInteger(parsedTaskTimeoutMs) && parsedTaskTimeoutMs > 0
  ? parsedTaskTimeoutMs
  : 30_000;
if (!host || !keyPath || !knownHostsPath) {
  throw new Error("FUSION_HUAWEI_HOST, FUSION_HUAWEI_KEY, and FUSION_HUAWEI_KNOWN_HOSTS are required");
}
const runner = createHuaweiSshRunner({
  host,
  keyPath,
  knownHostsPath,
});

const provider = new HuaweiSshProvider({
  host,
  keyPath,
  knownHostsPath,
  nodeId,
  name: nodeName,
  ...(jobRoot === undefined ? {} : { jobRoot }),
  ...(outputLimitBytes === undefined ? {} : { outputLimitBytes }),
  run: runner,
});

try {
  if (applyConfig && configPath === undefined) {
    throw new Error("FUSION_HUAWEI_CONFIG_PATH is required when apply is enabled");
  }

  const health = await provider.health();
  const nodes = await provider.listNodes();
  const doctor = await provider.doctor();
  const task = await provider.dispatch({
    goal: "verify Huawei remote execution",
    nodeIds: [nodeId],
    command: "hostname; uname -r; systemctl is-system-running || true",
  });
  const pollStartedAt = Date.now();
  let taskState = task;
  let inspectAttempts = 0;
  while (
    taskState.status === "running"
    && Date.now() - pollStartedAt < taskTimeoutMs
  ) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    taskState = await provider.inspect(task.id);
    inspectAttempts += 1;
  }
  const remoteConfig = configPath === undefined
    ? { state: "skipped" }
    : await (async () => {
        const service = new RemoteNodeConfigService({
          configPath,
          run: runner,
          ...(backupPath === undefined ? {} : { backupPath }),
        });
        const input = {
          nodeId: process.env.FUSION_HUAWEI_CONFIG_NODE_ID?.trim() || nodeId,
          displayName: process.env.FUSION_HUAWEI_CONFIG_DISPLAY_NAME?.trim()
            || nodeName,
          dshVersion: process.env.FUSION_HUAWEI_CONFIG_DSH_VERSION?.trim() || "0.2.0-rc.2",
          workspaceRoot: process.env.FUSION_HUAWEI_CONFIG_WORKSPACE?.trim() || "/srv/projects",
          capabilities: ["linux", "ssh", "hindsight", "config"],
        };
        const configDoctor = await service.doctor(input);
        const applyResult = applyConfig ? await service.apply(input) : undefined;
        return {
          doctor: configDoctor,
          ...(applyResult === undefined ? {} : { apply: applyResult }),
        };
      })();

  console.log(JSON.stringify({
    hostKeyPolicy: "pinned-known-hosts",
    health,
    node: nodes[0],
    doctorEvidenceLength: doctor.evidence[0]?.value.length ?? 0,
    task: {
      id: task.id,
      initialStatus: task.status,
      finalStatus: taskState.status,
      inspectAttempts,
      error: taskState.error,
      evidence: taskState.evidence.map((item) => ({
        kind: item.kind,
        label: item.label,
        value: item.value.slice(0, 300),
      })),
    },
    remoteConfig,
  }));

  const configApplyFailed = applyConfig && (
    !("apply" in remoteConfig)
    || (remoteConfig.apply?.applied !== true && remoteConfig.apply?.doctor.state !== "current")
  );
  const configDoctorFailed = configPath !== undefined
    && ("doctor" in remoteConfig)
    && ["unreachable", "doctor-failed"].includes(remoteConfig.doctor.state);
  if (
    health.state !== "connected"
    || task.status !== "running"
    || taskState.status !== "completed"
    || configDoctorFailed
    || configApplyFailed
  ) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
