import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, symlinkSync } from "node:fs";
import { chmod, mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  HuaweiSshProvider,
  buildHuaweiSshArguments,
  createHuaweiSshRunner,
  HUAWEI_JOB_REQUIRED_TOOLS,
} from "./huawei-ssh-provider.js";

const nodeOutput = [
  "HOST=hs-monitor-cn",
  "OS=Ubuntu 24.04.4 LTS",
  "ARCH=x86_64",
  "CPUS=2",
  "MEM=28.3",
  "DISK=18",
  "CPU=1",
  "SYSTEM=running",
  "FAILED=0",
  "LOAD=0.01 0.02 0.03",
].join("\n");

type FakeJobStatus = "STARTING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

interface FakeJob {
  status: FakeJobStatus;
  exitCode?: number;
  stdout: string;
  stderr: string;
}

const startedAt = "2026-10-21T01:02:03Z";
const finishedAt = "2026-10-21T01:02:04Z";
const bootId = "11111111-2222-3333-4444-555555555555";
const identityOutput = `BOOT_ID=${bootId}\nPID_STARTTIME=987654\nSESSION_ID=4242\nPROCESS_GROUP_ID=4242\n`;

function startOutput() {
  return {
    stdout: `STATUS=RUNNING\nPID=4242\nSTARTED_AT=${startedAt}\n${identityOutput}`,
    stderr: "",
    exitCode: 0,
  };
}

function inspectOutput(job: FakeJob) {
  return {
    stdout: [
      "EXISTS=1",
      `STATUS=${job.status}`,
      `EXIT=${job.exitCode === undefined ? "" : job.exitCode}`,
      "PID=4242",
      identityOutput.trimEnd(),
      `CURRENT_BOOT_ID=${bootId}`,
      "CURRENT_PID=4242",
      "CURRENT_PID_STARTTIME=987654",
      "CURRENT_SESSION_ID=4242",
      "CURRENT_PROCESS_GROUP_ID=4242",
      `STARTED_AT=${startedAt}`,
      `FINISHED_AT=${job.status === "RUNNING" || job.status === "STARTING" ? "" : finishedAt}`,
      `COMMAND_SHA256=${"a".repeat(64)}`,
      "IDEMPOTENCY_KEY=retry-key",
      `REQUEST_SHA256=${"b".repeat(64)}`,
      `STDOUT_SIZE=${Buffer.byteLength(job.stdout, "utf8")}`,
      `STDOUT=${Buffer.from(job.stdout, "utf8").toString("base64")}`,
      `STDERR_SIZE=${Buffer.byteLength(job.stderr, "utf8")}`,
      `STDERR=${Buffer.from(job.stderr, "utf8").toString("base64")}`,
    ].join("\n"),
    stderr: "",
    exitCode: 0,
  };
}

describe("HuaweiSshProvider", () => {
  it("probes execution prerequisites without starting jobs and shares startup tools", async () => {
    const run = vi.fn(async (_command: string) => ({ stdout: ["FUSION_EXEC_PROBE=1", `CHECK_COUNT=${HUAWEI_JOB_REQUIRED_TOOLS.length + 2}`, ...HUAWEI_JOB_REQUIRED_TOOLS.map((tool) => `CHECK_tool_${tool}=1`), "CHECK_proc=1", "CHECK_job_root=1", "FUSION_EXEC_PROBE_END=1"].join("\n"), stderr: "", exitCode: 0 }));
    const provider = new HuaweiSshProvider({ host: "fixture", keyPath: "unused", nodeId: "probe-node", run });
    const observation = await provider.probeExecCapability();
    expect(observation).toMatchObject({ nodeId: "probe-node", providerId: "huawei-ssh", state: "supported" });
    expect(run).toHaveBeenCalledTimes(1);
    const command = run.mock.calls[0]?.[0];
    expect(command).not.toContain("HUAWEI_JOB_START");
    expect(command).not.toContain("mkdir -p");
    for (const tool of HUAWEI_JOB_REQUIRED_TOOLS) expect(command).toContain(`CHECK_tool_${tool}=`);
  });
  it.each(["reject", "exit", "malformed"])("returns sanitized unknown on probe %s", async (mode) => {
    const provider = new HuaweiSshProvider({ host: "fixture", keyPath: "unused", run: async () => {
      if (mode === "reject") throw new Error("private-path private-command");
      return { stdout: mode === "exit" ? "" : "private-path", stderr: "private-command", exitCode: mode === "exit" ? 255 : 0 };
    } });
    const result = await provider.probeExecCapability();
    expect(result.state).toBe("unknown");
    expect(JSON.stringify(result)).not.toMatch(/private-path|private-command/);
  });
  it("requires every startup tool and reports explicit missing prerequisites", async () => {
    const output = (missing: string) => ["FUSION_EXEC_PROBE=1", `CHECK_COUNT=${HUAWEI_JOB_REQUIRED_TOOLS.length + 2}`, ...HUAWEI_JOB_REQUIRED_TOOLS.map((tool) => `CHECK_tool_${tool}=${tool === missing ? 0 : 1}`), "CHECK_proc=1", "CHECK_job_root=1", "FUSION_EXEC_PROBE_END=1"].join("\n");
    const provider = new HuaweiSshProvider({ host: "fixture", keyPath: "unused", run: async () => ({ stdout: output("flock"), stderr: "", exitCode: 0 }) });
    await expect(provider.probeExecCapability()).resolves.toMatchObject({ state: "unsupported", reasonCodes: ["EXEC_TOOL_MISSING"] });
    const incomplete = new HuaweiSshProvider({ host: "fixture", keyPath: "unused", run: async () => ({ stdout: "FUSION_EXEC_PROBE=1\nCHECK_COUNT=3\nCHECK_tool_flock=1\nCHECK_proc=1\nCHECK_job_root=1\nFUSION_EXEC_PROBE_END=1", stderr: "", exitCode: 0 }) });
    await expect(incomplete.probeExecCapability()).resolves.toMatchObject({ state: "unknown", checks: [] });
  });
  it("bounds a nonsettling capability runner", async () => {
    const provider = new HuaweiSshProvider({ host: "fixture", keyPath: "unused", timeoutMs: 5, run: () => new Promise(() => {}) });
    await expect(provider.probeExecCapability()).resolves.toMatchObject({ state: "unknown", reasonCodes: ["EXEC_PROBE_FAILED"] });
  });
  it("pins a supplied known_hosts file and disables global host keys", () => {
    const args = buildHuaweiSshArguments({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      knownHostsPath: "C:\\keys\\huawei_known_hosts",
    }, "uname -a");

    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("UserKnownHostsFile=C:\\keys\\huawei_known_hosts");
    expect(args).toContain("GlobalKnownHostsFile=/dev/null");
    expect(args).toContain("UpdateHostKeys=no");
  });
  it("runs provider scripts in a non-login bash so logout hooks cannot rewrite status", () => {
    const args = buildHuaweiSshArguments({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
    }, "set -eu\nprintf 'result\\n'\nexit 0");

    expect(args.at(-1)).toContain("exec bash -c ");
    expect(args.at(-1)).toContain("set -eu");
    expect(args.at(-1)).toContain("exit 0");
    expect(args.at(-1)).not.toContain("bash -lc");
  });
  it.each([0, 1])("preserves a multiline provider script exit status of %i", async (exitCode) => {
    const root = await mkdtemp(join(tmpdir(), "fusion-ssh-runner-"));
    const fakeSsh = join(root, "ssh");
    await writeFile(fakeSsh, "#!/bin/sh\nfor remote_command do :; done\nexec /bin/sh -c \"$remote_command\"\n");
    await chmod(fakeSsh, 0o700);
    try {
      const runner = createHuaweiSshRunner({ host: "fixture", keyPath: "unused", sshPath: fakeSsh });
      const result = await runner([
        "set -eu",
        "if true; then",
        "  printf 'result\\n'",
        `  exit ${exitCode}`,
        "fi",
      ].join("\n"));

      expect(result.exitCode).toBe(exitCode);
      expect(result.stdout).toBe("result\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("uses a deterministic task id and persists dispatch idempotency metadata", async () => {
    let startCommand = "";
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      nodeId: "huawei-test",
      run: async (commandArg) => {
        startCommand = commandArg;
        return commandArg.includes("HUAWEI_JOB_START")
          ? startOutput()
          : { stdout: "", stderr: "unexpected command", exitCode: 255 };
      },
    });

    const task = await provider.dispatch({
      goal: "crash safe",
      nodeIds: ["huawei-test"],
      command: "uname -a",
      idempotencyKey: "retry-key",
      taskId: "HUAWEI-crash-safe",
      dispatchFingerprint: "b".repeat(64),
    });

    expect(task.id).toBe("HUAWEI-crash-safe");
    expect(task.idempotencyKey).toBe("retry-key");
    expect(task.dispatchFingerprint).toBe("b".repeat(64));
    expect(startCommand).toContain("task_id='HUAWEI-crash-safe'");
    expect(startCommand).toContain("idempotency_key=");
    expect(startCommand).toContain("request_sha256=");
  });

  it("keeps accept-new as the compatible default when known_hosts is omitted", () => {
    const args = buildHuaweiSshArguments({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
    }, "uname -a");

    expect(args).toContain("StrictHostKeyChecking=accept-new");
    expect(args.some((arg) => arg.startsWith("UserKnownHostsFile="))).toBe(false);
  });

  it("maps a successful SSH probe to an online Huawei node", async () => {
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      nodeId: "huawei-test",
      name: "Huawei Test",
      run: async () => ({ stdout: nodeOutput, stderr: "", exitCode: 0 }),
    });

    await expect(provider.health()).resolves.toMatchObject({ state: "connected" });
    await expect(provider.listNodes()).resolves.toEqual([
      expect.objectContaining({
        id: "huawei-test",
        externalId: "root@example-huawei",
        providerId: "huawei-ssh",
        platform: "linux",
        status: "online",
        transports: ["ssh"],
        cpuPercent: 1,
        memoryPercent: 28.3,
      }),
    ]);
  });

  it("parses noisy key-value output and keeps a degraded-system host online", async () => {
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      nodeId: "huawei-test",
      run: async () => ({
        stdout: [
          "SSH banner without a separator",
          " HOST = hs-monitor-cn",
          "OS=Ubuntu 24.04 = LTS",
          "ARCH = x86_64",
          "MEM=28.3",
          "CPU=101",
          "SYSTEM=degraded",
          "FAILED=2",
          "LOAD=0.01 0.02 0.03",
        ].join("\r\n"),
        stderr: "",
        exitCode: 0,
      }),
    });

    const [node] = await provider.listNodes();

    expect(node).toMatchObject({
      id: "huawei-test",
      status: "online",
      systemdState: "degraded",
      failedUnits: 2,
      memoryPercent: 28.3,
    });
    expect(node?.cpuPercent).toBeUndefined();
  });

  it("keeps a reachable node online when systemd reports unrelated failed units", async () => {
    const provider = new HuaweiSshProvider({
      host: "root@192.0.2.10",
      keyPath: "C:\\keys\\huawei",
      nodeId: "huawei-hs-monitor-cn",
      name: "华为云 hs-monitor-cn",
      run: async () => ({
        stdout: [
          "HOST=hs-monitor-cn",
          "OS=Ubuntu 24.04.4 LTS",
          "ARCH=x86_64",
          "CPUS=2",
          "MEM=27.4",
          "DISK=18",
          "CPU=3",
          "SYSTEM=degraded",
          "FAILED=2",
          "LOAD=0.01 0.02 0.03",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      }),
    });

    const [node] = await provider.listNodes();

    expect(node).toMatchObject({
      id: "huawei-hs-monitor-cn",
      status: "online",
      systemdState: "degraded",
      failedUnits: 2,
    });
    await expect(provider.health()).resolves.toMatchObject({ state: "connected" });
    expect(node?.capabilities).not.toContain("degraded");
    expect(node?.capabilities).not.toContain("systemd");
  });

  it("maps a running systemd host to an online node", async () => {
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      nodeId: "huawei-test",
      run: async () => ({ stdout: nodeOutput, stderr: "", exitCode: 0 }),
    });

    const [node] = await provider.listNodes();

    expect(node).toMatchObject({
      status: "online",
      systemdState: "running",
      failedUnits: 0,
    });
  });

  it.each(["starting", "stopping", "offline", "maintenance"])(
    "marks a node as degraded when systemd reports %s",
    async (systemdState) => {
      const provider = new HuaweiSshProvider({
        host: "root@example-huawei",
        keyPath: "C:\\keys\\huawei",
        nodeId: "huawei-test",
        run: async () => ({
          stdout: nodeOutput
            .replace("SYSTEM=running", `SYSTEM=${systemdState}`),
          stderr: "",
          exitCode: 0,
        }),
      });

      const [node] = await provider.listNodes();

      expect(node).toMatchObject({
        status: "degraded",
        systemdState,
      });
    },
  );

  it.each([
    { label: "empty systemd state", systemdLine: "SYSTEM=" },
    { label: "unknown systemd state", systemdLine: "SYSTEM=unknown" },
  ])("keeps a node online with $label on a reachable host", async ({
    systemdLine,
  }) => {
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      nodeId: "huawei-test",
      run: async () => ({
        stdout: nodeOutput.replace("SYSTEM=running", systemdLine),
        stderr: "",
        exitCode: 0,
      }),
    });

    const [node] = await provider.listNodes();

    expect(node?.status).toBe("online");
    expect(node?.systemdState).toBe(systemdLine.slice("SYSTEM=".length));
    await expect(provider.health()).resolves.toMatchObject({ state: "connected" });
  });

  it("still fails closed when the probe omits the systemd state", async () => {
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      run: async () => ({
        stdout: nodeOutput
          .split("\n")
          .filter((line) => !line.startsWith("SYSTEM="))
          .join("\n"),
        stderr: "",
        exitCode: 0,
      }),
    });

    await expect(provider.listNodes()).rejects.toThrow(
      "HUAWEI_PROBE_INCOMPLETE:SYSTEM",
    );
    await expect(provider.health()).resolves.toMatchObject({ state: "offline" });
  });

  it("fails closed when the remote probe is incomplete", async () => {
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      run: async () => ({ stdout: "CPU=1\nMEM=12", stderr: "", exitCode: 0 }),
    });

    await expect(provider.listNodes()).rejects.toThrow("HUAWEI_PROBE_INCOMPLETE");
    await expect(provider.health()).resolves.toMatchObject({ state: "offline" });
  });

  it("reports offline and preserves SSH failure details", async () => {
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      run: async () => ({ stdout: "", stderr: "permission denied", exitCode: 255 }),
    });

    await expect(provider.health()).resolves.toMatchObject({
      state: "offline",
      message: expect.stringContaining("permission denied"),
    });
    await expect(provider.listNodes()).rejects.toThrow("permission denied");
  });

  it.each([
    {
      expectedCode: "HUAWEI_SSH_HOST_KEY_CHANGED",
      expectedKind: "host-key-changed",
      stderr: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!",
    },
    {
      expectedCode: "HUAWEI_SSH_HOST_KEY_UNVERIFIED",
      expectedKind: "host-key-unverified",
      stderr: "Host key verification failed.",
    },
    {
      expectedCode: "HUAWEI_SSH_AUTHENTICATION_FAILED",
      expectedKind: "authentication-failed",
      stderr: "Permission denied (publickey).",
    },
    {
      expectedCode: "HUAWEI_SSH_UNREACHABLE",
      expectedKind: "unreachable",
      stderr: "ssh: connect to host example-huawei port 22: Connection timed out",
    },
  ])("classifies SSH failures as $expectedCode", async ({
    expectedCode,
    expectedKind,
    stderr,
  }) => {
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      run: async () => ({ stdout: "", stderr, exitCode: 255 }),
    });

    await expect(provider.listNodes()).rejects.toMatchObject({
      name: "HuaweiSshError",
      code: expectedCode,
      kind: expectedKind,
    });
    await expect(provider.health()).resolves.toMatchObject({
      state: "offline",
      message: expect.stringContaining(expectedCode),
    });
  });

  it("keeps remote command permission errors separate from SSH authentication", async () => {
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      run: async () => ({
        stdout: "",
        stderr: "/srv/project: permission denied",
        exitCode: 2,
      }),
    });

    await expect(provider.listNodes()).rejects.toThrow("HUAWEI_SSH_COMMAND_FAILED");
    await expect(provider.listNodes()).rejects.not.toThrow(
      "HUAWEI_SSH_AUTHENTICATION_FAILED",
    );
  });

  it("returns doctor command evidence with stdout and stderr", async () => {
    const commands: string[] = [];
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      nodeId: "huawei-test",
      run: async (command) => {
        commands.push(command);
        if (command.includes("uname -a")) {
          return {
            stdout: "Linux hs-monitor-cn 6.8.0",
            stderr: "warning: unit probe failed",
            exitCode: 0,
          };
        }
        return { stdout: nodeOutput, stderr: "", exitCode: 0 };
      },
    });

    const report = await provider.doctor();

    expect(commands).toHaveLength(2);
    expect(report.node.id).toBe("huawei-test");
    expect(report.evidence).toContainEqual({
      kind: "command",
      label: "huawei-doctor",
      value: expect.stringContaining("Linux hs-monitor-cn 6.8.0"),
    });
    expect(report.evidence[0]?.value).toContain("warning: unit probe failed");
  });

  it("rejects doctor when the remote SSH command fails", async () => {
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      run: async (command) => command.includes("uname -a")
        ? { stdout: "", stderr: "doctor transport failed", exitCode: 255 }
        : { stdout: nodeOutput, stderr: "", exitCode: 0 },
    });

    await expect(provider.doctor()).rejects.toThrow("doctor transport failed");
  });

  it("starts a quoted background job and immediately returns running", async () => {
    let startCommand = "";
    const command = "printf '%s\\n' 'quoted'; printf \"double\"";
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      nodeId: "huawei-test",
      run: async (commandArg) => {
        startCommand = commandArg;
        return commandArg.includes("HUAWEI_JOB_START")
          ? startOutput()
          : { stdout: "", stderr: "unexpected command", exitCode: 255 };
      },
    });

    const task = await provider.dispatch({
      goal: "verify huawei kernel",
      nodeIds: ["huawei-test"],
      command,
    });

    expect(task).toMatchObject({
      goal: "verify huawei kernel",
      targetNodeIds: ["huawei-test"],
      status: "running",
    });
    expect(task.id).toMatch(/^HUAWEI-[0-9a-f-]{36}$/i);
    expect(task.evidence[0]).toMatchObject({
      kind: "summary",
      value: expect.stringContaining("status=running"),
    });
    expect(startCommand).toContain("# HUAWEI_JOB_START");
    expect(startCommand).toContain("nohup setsid");
    expect(startCommand).not.toContain(command);
    expect(startCommand).toContain(Buffer.from(command, "utf8").toString("base64"));
    expect(task.evidence[0]?.value).toContain(`bootId=${bootId}`);
    expect(task.evidence[0]?.value).toContain("pidStarttime=987654");
  });

  it("rejects a start acknowledgement without a provable process identity", async () => {
    const provider = new HuaweiSshProvider({ host: "fake", keyPath: "fake", run: async () => ({
      stdout: `STATUS=RUNNING\nPID=4242\nSTARTED_AT=${startedAt}\n`, stderr: "", exitCode: 0,
    }) });
    await expect(provider.dispatch({ goal: "legacy ack", nodeIds: ["huawei-hs-monitor-cn"], command: "true" })).rejects.toThrow("HUAWEI_TASK_START_INVALID");
  });

  it("inspects a running job and a completed terminal state after provider restart", async () => {
    const job: FakeJob = { status: "RUNNING", stdout: "", stderr: "" };
    const first = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      nodeId: "huawei-test",
      run: async () => startOutput(),
    });
    const task = await first.dispatch({
      goal: "recover remote task",
      nodeIds: ["huawei-test"],
      command: "uname -r",
    });

    const second = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      nodeId: "huawei-test",
      run: async (command) => {
        expect(command).toContain("HUAWEI_JOB_INSPECT");
        return inspectOutput(job);
      },
    });

    await expect(second.inspect(task.id)).resolves.toMatchObject({
      id: task.id,
      status: "running",
      progress: expect.any(Number),
    });

    job.status = "COMPLETED";
    job.exitCode = 0;
    job.stdout = "kernel-ok";
    job.stderr = "warning: test mode";

    await expect(second.inspect(task.id)).resolves.toMatchObject({
      id: task.id,
      status: "completed",
      progress: 100,
      evidence: expect.arrayContaining([
        expect.objectContaining({
          kind: "summary",
          value: expect.stringContaining("exit=0"),
        }),
        expect.objectContaining({
          kind: "command",
          value: "kernel-ok",
        }),
        expect.objectContaining({
          kind: "log",
          value: "warning: test mode",
        }),
      ]),
    });
  });

  it("maps a failed remote exit to failed task evidence", async () => {
    const job: FakeJob = {
      status: "FAILED",
      exitCode: 2,
      stdout: "partial output",
      stderr: "command failed",
    };
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      nodeId: "huawei-test",
      run: async () => inspectOutput(job),
    });

    const task = await provider.inspect("HUAWEI-11111111-1111-4111-8111-111111111111");

    expect(task).toMatchObject({
      status: "failed",
      progress: 0,
      error: expect.stringContaining("HUAWEI_TASK_FAILED:exit=2"),
    });
    expect(task.error).toContain("command failed");
    expect(task.evidence).toContainEqual(expect.objectContaining({
      kind: "command",
      value: "partial output",
    }));
  });

  it("normalizes whitespace-only stdout and stderr to the project empty marker", async () => {
    const job: FakeJob = {
      status: "COMPLETED",
      exitCode: 0,
      stdout: "\n",
      stderr: "   ",
    };
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      nodeId: "huawei-test",
      run: async () => inspectOutput(job),
    });

    const task = await provider.inspect(
      "HUAWEI-11111111-1111-4111-8111-111111111111",
    );

    expect(task.evidence).toContainEqual(expect.objectContaining({
      kind: "command",
      value: "(empty)",
    }));
    expect(task.evidence).toContainEqual(expect.objectContaining({
      kind: "log",
      value: "(empty)",
    }));
  });

  it("cancels the remote process group and marks the job cancelled", async () => {
    const job: FakeJob = { status: "RUNNING", stdout: "started", stderr: "" };
    let cancelCommand = "";
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      nodeId: "huawei-test",
      run: async (command) => {
        if (command.includes("HUAWEI_JOB_START")) return startOutput();
        if (command.includes("HUAWEI_JOB_CANCEL")) {
          cancelCommand = command;
          job.status = "CANCELLED";
          job.exitCode = 130;
          return {
            stdout: "CANCELLED=1\nPREVIOUS_STATUS=RUNNING\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return inspectOutput(job);
      },
    });
    const task = await provider.dispatch({
      goal: "cancel remote task",
      nodeIds: ["huawei-test"],
      command: "sleep 60",
    });

    await provider.cancel(task.id);

    expect(cancelCommand).toContain("HUAWEI_JOB_CANCEL");
    expect(cancelCommand).toContain("cancel.requested");
    expect(cancelCommand).toContain('kill -TERM -- "-$pid"');
    expect(cancelCommand).toContain('kill -KILL -- "-$pid"');
    await expect(provider.inspect(task.id)).resolves.toMatchObject({
      id: task.id,
      status: "cancelled",
    });
  });

  it("rejects unsafe task ids before invoking SSH", async () => {
    const run = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      run,
    });

    await expect(provider.inspect("../HUAWEI-secret")).rejects.toThrow(
      "HUAWEI_TASK_ID_INVALID",
    );
    await expect(provider.cancel("HUAWEI-ok/../../etc")).rejects.toThrow(
      "HUAWEI_TASK_ID_INVALID",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("does not rewrite a completed task as cancelled", async () => {
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      nodeId: "huawei-test",
      run: async (command) => {
        if (command.includes("HUAWEI_JOB_START")) return startOutput();
        if (command.includes("HUAWEI_JOB_CANCEL")) {
          return {
            stdout: "CANCELLED=0\nSTATUS=COMPLETED\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return inspectOutput({
          status: "COMPLETED",
          stdout: "",
          stderr: "",
          exitCode: 0,
        });
      },
    });
    const task = await provider.dispatch({
      goal: "completed task",
      nodeIds: ["huawei-test"],
      command: "true",
    });

    await expect(provider.cancel(task.id)).rejects.toThrow(
      "HUAWEI_TASK_ALREADY_TERMINAL:COMPLETED",
    );
  });

  it("preserves classified SSH errors during task inspection", async () => {
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      run: async () => ({
        stdout: "",
        stderr: "Permission denied (publickey).",
        exitCode: 255,
      }),
    });

    await expect(
      provider.inspect("HUAWEI-11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({
      name: "HuaweiSshError",
      code: "HUAWEI_SSH_AUTHENTICATION_FAILED",
      kind: "authentication-failed",
    });
  });

  it("caps stdout and stderr evidence at the configured byte limit", async () => {
    const job: FakeJob = {
      status: "COMPLETED",
      exitCode: 0,
      stdout: "x".repeat(100),
      stderr: "y".repeat(90),
    };
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      outputLimitBytes: 64,
      run: async () => inspectOutput(job),
    });

    const task = await provider.inspect(
      "HUAWEI-11111111-1111-4111-8111-111111111111",
    );
    const stdout = task.evidence.find((item) => item.label.endsWith(":stdout"));
    const stderr = task.evidence.find((item) => item.label.endsWith(":stderr"));

    expect(Buffer.byteLength(stdout?.value ?? "", "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(stderr?.value ?? "", "utf8")).toBeLessThanOrEqual(64);
    expect(stdout?.value).toContain("[truncated]");
    expect(stderr?.value).toContain("[truncated]");
  });

  it("refuses dispatch to a different node", async () => {
    const provider = new HuaweiSshProvider({
      host: "root@example-huawei",
      keyPath: "C:\\keys\\huawei",
      nodeId: "huawei-test",
      run: async () => ({ stdout: nodeOutput, stderr: "", exitCode: 0 }),
    });

    await expect(provider.dispatch({
      goal: "wrong target",
      nodeIds: ["other-node"],
      command: "uname -a",
    })).rejects.toThrow("HUAWEI_NODE_NOT_TARGETED:other-node");
  });

});

// Execute generated scripts locally; all process observations and signals are fake.
// This catches unsafe script branches rather than merely asserting script text.
describe("Huawei detached job script identity", () => {
  const taskId = "HUAWEI-identity-test";
  const execute = promisify(execFile);
  async function scenario(options: {
    action: "inspect" | "cancel";
    status?: FakeJobStatus;
    legacy?: boolean;
    currentBoot?: string;
    currentStarttime?: string;
    currentSession?: string;
    vanished?: boolean;
    termSurvives?: boolean;
    reuseAfterTerm?: boolean;
    completedBeforeLock?: boolean;
    signalDenied?: boolean;
    reuseBeforeTerm?: boolean;
    probeDenied?: boolean;
    leaderExitsAfterTerm?: boolean;
    groupLingersAfterKill?: boolean;
  }) {
    const root = await mkdtemp(join(tmpdir(), "fusion-huawei-"));
    const jobDir = join(root, taskId);
    await mkdir(jobDir);
    const status = options.status ?? "RUNNING";
    const files: Record<string, string> = {
      status, pid: "4242", started_at: startedAt, stdout: "successful evidence", stderr: "",
      ...(status === "COMPLETED" ? { exit: "0", finished_at: finishedAt } : {}),
      ...(options.legacy ? {} : {
        boot_id: bootId, pid_starttime: "987654", session_id: "4242", process_group_id: "4242",
      }),
    };
    await Promise.all(Object.entries(files).map(([name, value]) => writeFile(join(jobDir, name), value)));
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const logPath = root.replaceAll("\\", "/") + "/signals";
    // /proc stat fields 3..22: state, ppid, pgrp, session, then 15 fields and starttime.
    const stat = (start: string) => `4242 (worker ) unusual name) S 1 4242 ${options.currentSession ?? "4242"} ${Array(15).fill("0").join(" ")} ${start}`;
    const prelude = [
      "signalled=0", "gone=0", "leader_gone=0",
      "cat() {",
      "  case \"${@: -1}\" in",
      `    /proc/sys/kernel/random/boot_id) printf '%s\\n' ${quote(options.currentBoot ?? bootId)} ;;`,
      "    /proc/4242/stat)",
      `      if [ "$gone" = 1 ] || [ "$leader_gone" = 1 ] || [ ${options.vanished ? "1" : "0"} = 1 ]; then return 1; fi`,
      `      if [ "$signalled" = 1 ] && [ ${options.reuseAfterTerm ? "1" : "0"} = 1 ]; then printf '%s\\n' ${quote(stat("111111"))};`,
      `      else printf '%s\\n' ${quote(stat(options.currentStarttime ?? "987654"))}; fi ;;`,
      '    *) command cat "$@" ;;', "  esac", "}",
      "kill() {",
      `  if [ "$1" = "-0" ]; then [ ${options.probeDenied ? "1" : "0"} = 0 ] && [ "$gone" = 0 ]; return; fi`,
      `  printf '%s\\n' "$1" >> ${quote(logPath)}`,
      `  if [ ${options.signalDenied ? "1" : "0"} = 1 ]; then return 1; fi`,
      "  signalled=1",
      `  if [ ${options.groupLingersAfterKill ? "1" : "0"} = 1 ] && [ "$1" = "-KILL" ]; then leader_gone=1; return 0; fi`,
      `  if [ ${options.leaderExitsAfterTerm ? "1" : "0"} = 1 ] && [ "$1" = "-TERM" ]; then leader_gone=1; return 0; fi`,
      `  if [ ${options.termSurvives || options.reuseAfterTerm ? "0" : "1"} = 1 ] || [ "$1" = "-KILL" ]; then gone=1; fi`,
      "}",
      "sleep() { :; }",
      options.reuseBeforeTerm ? 'sync() { signalled=1; }' : "sync() { :; }",
      "ps() { printf '4242\\n'; }",
      // Git Bash has no flock; emulate uncontended locking, never a remote command.
      options.completedBeforeLock
        ? 'flock() { printf COMPLETED > "$job_dir/status"; printf 0 > "$job_dir/exit"; }'
        : "flock() { :; }",
    ].join("\n");
    let stdout = "";
    const provider = new HuaweiSshProvider({
      host: "fake", keyPath: "fake", jobRoot: root.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`),
      run: async (script) => {
        const result = await execute(process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash", ["-c", `${prelude}\n${script}`], { timeout: 10_000 });
        stdout = result.stdout;
        return { stdout, stderr: result.stderr, exitCode: 0 };
      },
    });
    try {
      let error: unknown;
      let task;
      try {
        if (options.action === "inspect") task = await provider.inspect(taskId);
        else await provider.cancel(taskId);
      } catch (caught) { error = caught; }
      const signals = await readFile(join(root, "signals"), "utf8").catch(() => "");
      return { task, error, signals, stdout, status: await readFile(join(jobDir, "status"), "utf8") };
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  it.each([
    { name: "worker reboot", currentBoot: "aaaaaaaa-2222-3333-4444-555555555555", reason: "boot_id_mismatch" },
    { name: "PID reuse", currentStarttime: "123456", reason: "pid_starttime_mismatch" },
    { name: "session mismatch", currentSession: "9999", reason: "session_mismatch" },
    { name: "vanished worker", vanished: true, reason: "process_missing" },
    { name: "legacy identity", legacy: true, reason: "identity_missing" },
  ])("reports $name as failed and refuses to signal", async ({ reason, name: _name, ...options }) => {
    const inspected = await scenario({ action: "inspect", ...options });
    expect(inspected.error).toBeUndefined();
    expect(inspected.task).toMatchObject({ status: "failed", error: `HUAWEI_TASK_LOST:${reason}` });
    const cancelled = await scenario({ action: "cancel", ...options });
    expect(cancelled.error).toBeInstanceOf(Error);
    expect((cancelled.error as Error).message).toContain(`HUAWEI_TASK_LOST:${reason}`);
    expect(cancelled.signals).toBe("");
  }, 15_000);

  it("reads matching identities including proc comm spaces and parentheses", async () => {
    const result = await scenario({ action: "inspect" });
    expect(result.error).toBeUndefined();
    expect(result.task?.status).toBe("running");
  });

  it("preserves completed evidence even after reboot and refuses cancellation", async () => {
    const result = await scenario({ action: "inspect", status: "COMPLETED", currentBoot: "new-boot", legacy: true });
    expect(result.task?.status).toBe("completed");
    expect(result.task?.evidence).toContainEqual(expect.objectContaining({ value: "successful evidence" }));
    const cancel = await scenario({ action: "cancel", status: "COMPLETED" });
    expect((cancel.error as Error).message).toContain("HUAWEI_TASK_ALREADY_TERMINAL:COMPLETED");
    expect(cancel.signals).toBe("");
    expect(cancel.status.trim()).toBe("COMPLETED");
  });

  it("confirms genuine cancellation and keeps repeated cancellation idempotent", async () => {
    const result = await scenario({ action: "cancel" });
    expect(result.error).toBeUndefined();
    expect(result.status.trim()).toBe("CANCELLED");
    expect(result.signals).toBe("-TERM\n");
    const repeated = await scenario({ action: "cancel", status: "CANCELLED", vanished: true });
    expect(repeated.error).toBeUndefined();
    expect(repeated.signals).toBe("");
  });

  it("revalidates identity before escalation and rejects unconfirmed cancellation", async () => {
    const result = await scenario({ action: "cancel", reuseAfterTerm: true });
    expect(result.signals).toBe("-TERM\n");
    expect((result.error as Error).message).toContain("HUAWEI_TASK_LOST:pid_starttime_mismatch");
    expect(result.status.trim()).not.toBe("CANCELLED");
  });

  it("escalates only a still-matching worker within the bounded wait", async () => {
    const result = await scenario({ action: "cancel", termSurvives: true });
    expect(result.error).toBeUndefined();
    expect(result.signals).toBe("-TERM\n-KILL\n");
    expect(result.status.trim()).toBe("CANCELLED");
  });

  it("never blindly KILLs a group whose unprotected leader exited before a TERM-ignoring child", async () => {
    const result = await scenario({ action: "cancel", leaderExitsAfterTerm: true });
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain("HUAWEI_TASK_LOST:process_missing");
    expect(result.signals).toBe("-TERM\n");
    expect(result.status.trim()).not.toBe("CANCELLED");
  });

  it("does not equate successful KILL with disappearance of lingering group members", async () => {
    const result = await scenario({ action: "cancel", termSurvives: true, groupLingersAfterKill: true });
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain("HUAWEI_TASK_CANCEL_FAILED:CANCELLATION_UNCONFIRMED");
    expect(result.signals).toBe("-TERM\n-KILL\n");
    expect(result.status.trim()).toBe("RUNNING");
  });

  it("does not overwrite a completion published while cancellation was awaiting the lock", async () => {
    const result = await scenario({ action: "cancel", completedBeforeLock: true });
    expect((result.error as Error).message).toContain("HUAWEI_TASK_ALREADY_TERMINAL:COMPLETED");
    expect(result.status.trim()).toBe("COMPLETED");
    expect(result.signals).toBe("");
  });

  it("does not claim cancellation when neither signal stopped the group", async () => {
    const result = await scenario({ action: "cancel", signalDenied: true });
    expect((result.error as Error).message).toContain("HUAWEI_TASK_CANCEL_FAILED:CANCELLATION_UNCONFIRMED");
    expect(result.status.trim()).toBe("RUNNING");
  });

  it("does not mistake a permission-denied process probe for a stopped group", async () => {
    const result = await scenario({ action: "cancel", signalDenied: true, probeDenied: true });
    expect(result.status.trim()).toBe("RUNNING");
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain("HUAWEI_TASK_CANCEL_FAILED:CANCELLATION_UNCONFIRMED");
  });

  it("revalidates identity after persisting cancellation intent before TERM", async () => {
    const result = await scenario({ action: "cancel", reuseBeforeTerm: true, reuseAfterTerm: true });
    expect((result.error as Error).message).toContain("HUAWEI_TASK_LOST:pid_starttime_mismatch");
    expect(result.signals).toBe("");
  });

  async function workerScenario(options: { pendingCancel?: boolean; cancelWinsLock?: boolean; supervisorTerm?: boolean; childDefaultTerm?: boolean; loginLogoutFailureExitCode?: 0 | 1 } = {}) {
    const root = await mkdtemp(join(tmpdir(), "fusion-huawei-worker-"));
    const jobDir = root.replaceAll("\\", "/");
    let startScript = "";
    const provider = new HuaweiSshProvider({ host: "fake", keyPath: "fake", run: async (script) => {
      startScript = script;
      return startOutput();
    } });
    const command = options.loginLogoutFailureExitCode === undefined
      ? "true"
      : `printf 'result evidence'; exit ${options.loginLogoutFailureExitCode}`;
    await provider.dispatch({ goal: "identity fixture", nodeIds: ["huawei-hs-monitor-cn"], command });
    const worker = startScript.split("<<'HUAWEI_JOB_WORKER' &\n")[1]?.split("\nHUAWEI_JOB_WORKER\n")[0];
    if (!worker) throw new Error("Missing worker script");
    const prefix = worker.slice(0, worker.indexOf("limit_stream() {"));
    const finalization = worker.slice(worker.indexOf('exec 9>"$job_dir/state.lock"'));
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    let shellPrelude = "";
    if (options.loginLogoutFailureExitCode !== undefined) {
      const fakeBin = join(root, "bin");
      const fakeHome = join(root, "home");
      await mkdir(fakeBin);
      await mkdir(fakeHome);
      await writeFile(join(fakeHome, ".bash_logout"), "exit 1\n");
      await writeFile(join(fakeBin, "bash"), [
        "#!/bin/sh",
        'if [ "${1:-}" = "-lc" ]; then',
        "  /bin/bash \"$@\"",
        '  if [ -f "$HOME/.bash_logout" ]; then . "$HOME/.bash_logout"; fi',
        '  exit "$?"',
        "fi",
        'exec /bin/bash "$@"',
        "",
      ].join("\n"));
      await chmod(join(fakeBin, "bash"), 0o700);
      shellPrelude = `HOME=${quote(fakeHome)}\nPATH=${quote(fakeBin)}:$PATH`;
    }
    const prelude = [
      "sync() { :; }",
      options.cancelWinsLock
        ? 'flock() { printf CANCELLED > "$job_dir/status"; printf 130 > "$job_dir/exit"; }'
        : "flock() { :; }",
      "cat() {",
      '  case "${@: -1}" in',
      `    /proc/sys/kernel/random/boot_id) printf '%s\\n' '${bootId}' ;;`,
      `    /proc/*/stat) printf '%s (worker ) special name) S 1 %s %s ${Array(15).fill("0").join(" ")} 987654\\n' "$$" "$$" "$$" ;;`,
      '    *) command cat "$@" ;;', "  esac", "}",
    ].join("\n");
    try {
      await writeFile(join(root, "status"), "STARTING");
      const commandB64 = Buffer.from(command).toString("base64");
      if (options.loginLogoutFailureExitCode !== undefined) {
        const script = `${shellPrelude}\n${prelude}\nexec 3<<<'${commandB64}'\n${worker}`;
        await execute(process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash", ["-c", script, "worker-test", jobDir, "65536"], { timeout: 10_000 });
      } else {
      if (options.pendingCancel) await writeFile(join(root, "cancel.requested"), "1");
      const childProbe = options.childDefaultTerm
        ? `bash -c 'kill -TERM "$$"; exit 0'\nchild_exit=$?\nif [ "$child_exit" -eq 0 ]; then exit 124; fi`
        : "";
      const script = `${prelude}\nexec 3<<<'${commandB64}'\n${prefix}\n${options.supervisorTerm ? 'kill -TERM "$$"' : ''}\n${childProbe}\nprintf 'result evidence' > "$job_dir/stdout.part"\nexit_code=0\n${finalization}`;
      await execute(process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash", ["-c", script, "worker-test", jobDir, "65536"], { timeout: 10_000 });
      }
      const files = await Promise.all(["pid", "boot_id", "pid_starttime", "session_id", "process_group_id", "status", "exit", "stdout", "output.complete"].map(async (file) => [file, await readFile(join(root, file), "utf8").catch(() => "")]));
      return Object.fromEntries(files) as Record<string, string>;
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  it("persists worker boot, starttime and session identity before successful terminal evidence", async () => {
    const files = await workerScenario();
    expect(files.boot_id?.trim()).toBe(bootId);
    expect(files.pid_starttime?.trim()).toBe("987654");
    expect(files.pid?.trim()).toMatch(/^[1-9][0-9]+$/);
    expect(files.session_id?.trim()).toBe(files.pid?.trim());
    expect(files.process_group_id?.trim()).toBe(files.pid?.trim());
    expect(files.status?.trim()).toBe("COMPLETED");
    expect(files.stdout).toBe("result evidence");
  });

  it("keeps the published supervisor alive on TERM as an identity anchor for child-group cleanup", async () => {
    const files = await workerScenario({ supervisorTerm: true });
    expect(files.status?.trim()).toBe("COMPLETED");
    expect(files.stdout).toBe("result evidence");
  });

  it("keeps default TERM handling in execed commands instead of inheriting SIG_IGN", async () => {
    const files = await workerScenario({ childDefaultTerm: true });
    expect(files.status?.trim()).toBe("COMPLETED");
    expect(files.stdout).toBe("result evidence");
  });

  it.each([0, 1] as const)("keeps worker exit code %i when a login-shell logout hook would fail", async (exitCode) => {
    const command = `printf 'result evidence'; exit ${exitCode}`;
    const files = await workerScenario({ loginLogoutFailureExitCode: exitCode });
    expect(files.status?.trim()).toBe(exitCode === 0 ? "COMPLETED" : "FAILED");
    expect(files.exit?.trim()).toBe(String(exitCode));
    expect(files.stdout).toBe("result evidence");
    expect(files["output.complete"]?.trim()).toBe(createHash("sha256").update(command).digest("hex"));
  });

  it("does not overwrite a confirmed cancellation when the worker resumes finalization", async () => {
    const files = await workerScenario({ cancelWinsLock: true });
    expect(files.status?.trim()).toBe("CANCELLED");
    expect(files.exit?.trim()).toBe("130");
  });

  it("preserves successful completion after an unconfirmed cancel request", async () => {
    const files = await workerScenario({ pendingCancel: true });
    expect(files.status?.trim()).toBe("COMPLETED");
    expect(files.exit?.trim()).toBe("0");
    expect(files.stdout).toBe("result evidence");
  });
});

// Real local execution with genuine flock and /proc: Huawei's inspect
// holds a shared state lock while the worker publishes terminal status
// under the exclusive lock, so a completing job must never flap to lost.
describe("Huawei inspect completion race (real local execution)", () => {
  it.skipIf(process.platform === "win32")(
    "treats a job directory without a committed status as not found and publishes the manifest first",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "fusion-huawei-uncommitted-"));
      const execute = promisify(execFile);
      let startCommand = "";
      const run = async (script: string) => {
        if (script.includes("# HUAWEI_JOB_START")) startCommand = script;
        try {
          const { stdout, stderr } = await execute("bash", ["-c", script], {
            timeout: 30_000,
            maxBuffer: 16 * 1024 * 1024,
          });
          return { stdout, stderr, exitCode: 0 };
        } catch (error) {
          const failure = error as { code?: unknown; stdout?: string; stderr?: string };
          return {
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? "",
            exitCode: typeof failure.code === "number" ? failure.code : 1,
          };
        }
      };
      const provider = new HuaweiSshProvider({
        host: "fake",
        keyPath: "unused",
        nodeId: "huawei-test-node",
        jobRoot: root,
        run,
      });
      const taskId = "HUAWEI-uncommitted";
      try {
        await mkdir(join(root, taskId), { recursive: true });
        await writeFile(join(root, taskId, "command.sha256"), `${"a".repeat(64)}\n`);
        await writeFile(join(root, taskId, "idempotency.key"), "retry-key\n");
        await expect(provider.inspect(taskId))
          .rejects.toThrow(`HUAWEI_TASK_NOT_FOUND:${taskId}`);
        const dispatched = await provider.dispatch({
          goal: "retry after start crash",
          nodeIds: ["huawei-test-node"],
          command: "echo recovered",
          taskId,
          idempotencyKey: "retry-key",
          dispatchFingerprint: "fingerprint-1",
        });
        expect(dispatched.status).toBe("running");
        expect(startCommand.indexOf("idempotency.key"))
          .toBeLessThan(startCommand.indexOf('status" STARTING'));
        expect(startCommand.indexOf("request.sha256"))
          .toBeLessThan(startCommand.indexOf('status" STARTING'));
        // Let the retried job settle before cleanup: removing the job
        // root while its worker is still writing races the recursive
        // delete (ENOTEMPTY), which made this test intermittent.
        let settled = dispatched;
        for (let attempt = 0; attempt < 100 && settled.status === "running"; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          settled = await provider.inspect(taskId);
        }
        expect(settled.status).toBe("completed");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "never reports a completing job as lost while polling inspect",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "fusion-huawei-race-"));
      const execute = promisify(execFile);
      const run = async (script: string) => {
        try {
          const { stdout, stderr } = await execute("bash", ["-c", script], {
            timeout: 30_000,
            maxBuffer: 16 * 1024 * 1024,
          });
          return { stdout, stderr, exitCode: 0 };
        } catch (error) {
          const failure = error as { code?: unknown; stdout?: string; stderr?: string };
          return {
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? "",
            exitCode: typeof failure.code === "number" ? failure.code : 1,
          };
        }
      };
      const provider = new HuaweiSshProvider({
        host: "fake",
        keyPath: "unused",
        nodeId: "huawei-test-node",
        jobRoot: root,
        run,
      });
      try {
        const dispatched = await provider.dispatch({
          goal: "race probe",
          nodeIds: ["huawei-test-node"],
          command: "sleep 2; echo done",
        });
        const seen: string[] = [];
        let task = dispatched;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          task = await provider.inspect(dispatched.id);
          seen.push(task.status);
          if (task.status !== "running") break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(seen).not.toContain("failed");
        expect(task.status).toBe("completed");
        expect(task.error).toBeUndefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "records the true output total so inspect reports real truncation",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "fusion-huawei-total-"));
      const execute = promisify(execFile);
      const run = async (script: string) => {
        try {
          const { stdout, stderr } = await execute("bash", ["-c", script], {
            timeout: 30_000,
            maxBuffer: 16 * 1024 * 1024,
          });
          return { stdout, stderr, exitCode: 0 };
        } catch (error) {
          const failure = error as { code?: unknown; stdout?: string; stderr?: string };
          return {
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? "",
            exitCode: typeof failure.code === "number" ? failure.code : 1,
          };
        }
      };
      const limit = 64;
      const producedStdoutBytes = 5_000;
      const provider = new HuaweiSshProvider({
        host: "fake",
        keyPath: "unused",
        nodeId: "huawei-test-node",
        jobRoot: root,
        outputLimitBytes: limit,
        run,
      });
      try {
        const dispatched = await provider.dispatch({
          goal: "noisy job",
          nodeIds: ["huawei-test-node"],
          command: `head -c ${producedStdoutBytes} /dev/zero | tr '\\0' 'a'; echo DONE`,
        });
        let task = dispatched;
        for (let attempt = 0; attempt < 200 && task.status === "running"; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          task = await provider.inspect(dispatched.id);
        }
        expect(
          task.status,
          `summary evidence: ${task.evidence.find((item) => item.kind === "summary")?.value ?? "none"}`,
        ).toBe("completed");
        const jobDir = join(root, dispatched.id);
        // The stored output stays within the configured budget...
        const stored = await readFile(join(jobDir, "stdout"));
        expect(stored.byteLength).toBeLessThanOrEqual(limit);
        // ...but the true produced size is recorded next to it, so
        // truncation is recoverable instead of being inferred from
        // the already-truncated file.
        const total = await readFile(join(jobDir, "stdout.total"), "utf8");
        expect(total.trim()).toBe(String(producedStdoutBytes + "DONE\n".length));
        const summary = task.evidence.find((item) => item.kind === "summary");
        expect(summary?.value).toContain("stdoutTruncated=true");
        const stdoutEvidence = task.evidence.find((item) => item.label.endsWith(":stdout"));
        expect(stdoutEvidence?.value).toContain("[truncated]");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("Huawei cancel-time output totals (real local execution)", () => {
  // Cancellation kills the stream limiters mid-flight. The
  // produced-byte totals (*.total) are the only truncation
  // evidence that survives, so they must be maintained
  // continuously and atomically — on the python3 path and on
  // the no-python3 fallback alike — not written only at EOF.
  const limit = 1_000;
  const producedStdout = 5_000;
  const producedStderr = 3_000;

  function localRunner(pathEnv: string) {
    const execute = promisify(execFile);
    return async (script: string) => {
      try {
        const { stdout, stderr } = await execute("/bin/bash", ["-c", script], {
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, PATH: pathEnv },
        });
        return { stdout, stderr, exitCode: 0 };
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        return {
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
          exitCode: typeof failure.code === "number" ? failure.code : 1,
        };
      }
    };
  }

  async function pythonlessPath(): Promise<string> {
    const shim = await mkdtemp(join(tmpdir(), "fusion-huawei-nopython-"));
    for (const dir of ["/usr/bin", "/bin"]) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith("python")) continue;
        try {
          symlinkSync(join(dir, entry.name), join(shim, entry.name));
        } catch {
          // Duplicate or dangling entry: the tool set only
          // needs the standard utilities to resolve.
        }
      }
    }
    return shim;
  }

  async function cancelScenario(pathEnv: string) {
    const root = await mkdtemp(join(tmpdir(), "fusion-huawei-cancel-total-"));
    const provider = new HuaweiSshProvider({
      host: "fake",
      keyPath: "unused",
      nodeId: "huawei-test-node",
      jobRoot: root,
      outputLimitBytes: limit,
      run: localRunner(pathEnv),
    });
    try {
      const dispatched = await provider.dispatch({
        goal: "noisy then hold",
        nodeIds: ["huawei-test-node"],
        command: `head -c ${producedStdout} /dev/zero | tr '\\0' 'a'; head -c ${producedStderr} /dev/zero | tr '\\0' 'e' 1>&2; sleep 60`,
      });
      const jobDir = join(root, dispatched.id);
      // Wait until the produced bytes have flowed through the
      // limiters (the producer then blocks in sleep with the
      // pipes drained, so the totals can be complete).
      const readTotal = async (name: string) => {
        try {
          return (await readFile(join(jobDir, name), "utf8")).trim();
        } catch {
          return "";
        }
      };
      for (
        let attempt = 0;
        attempt < 100
        && ((await readTotal("stdout.total")) !== String(producedStdout)
          || (await readTotal("stderr.total")) !== String(producedStderr));
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await provider.cancel(dispatched.id);
      const task = await provider.inspect(dispatched.id);
      expect(task.status).toBe("cancelled");
      // The totals survived the kill, complete and parseable.
      expect(await readTotal("stdout.total")).toBe(String(producedStdout));
      expect(await readTotal("stderr.total")).toBe(String(producedStderr));
      const stored = await readFile(join(jobDir, "stdout"));
      expect(stored.byteLength).toBeLessThanOrEqual(limit);
      const summary = task.evidence.find((item) => item.kind === "summary");
      expect(summary?.value).toContain("stdoutTruncated=true");
      expect(summary?.value).toContain("stderrTruncated=true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it.skipIf(process.platform === "win32")(
    "keeps true totals when a job is cancelled mid-hold (python3 path)",
    async () => {
      await cancelScenario(process.env.PATH ?? "/usr/bin:/bin");
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "keeps true totals when a job is cancelled mid-hold (no-python3 fallback)",
    async () => {
      const shim = await pythonlessPath();
      try {
        await cancelScenario(shim);
      } finally {
        await rm(shim, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "records true totals at normal EOF on the no-python3 fallback",
    async () => {
      const shim = await pythonlessPath();
      const root = await mkdtemp(join(tmpdir(), "fusion-huawei-eof-total-"));
      const provider = new HuaweiSshProvider({
        host: "fake",
        keyPath: "unused",
        nodeId: "huawei-test-node",
        jobRoot: root,
        outputLimitBytes: limit,
        run: localRunner(shim),
      });
      try {
        const dispatched = await provider.dispatch({
          goal: "noisy then exit",
          nodeIds: ["huawei-test-node"],
          command: `head -c ${producedStdout} /dev/zero | tr '\\0' 'a'; head -c ${producedStderr} /dev/zero | tr '\\0' 'e' 1>&2`,
        });
        let task = dispatched;
        for (let attempt = 0; attempt < 200 && task.status === "running"; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          task = await provider.inspect(dispatched.id);
        }
        expect(task.status).toBe("completed");
        const jobDir = join(root, dispatched.id);
        expect((await readFile(join(jobDir, "stdout.total"), "utf8")).trim())
          .toBe(String(producedStdout));
        expect((await readFile(join(jobDir, "stderr.total"), "utf8")).trim())
          .toBe(String(producedStderr));
        const summary = task.evidence.find((item) => item.kind === "summary");
        expect(summary?.value).toContain("stdoutTruncated=true");
        expect(summary?.value).toContain("stderrTruncated=true");
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(shim, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "isolates a material-aware execution workspace and hashes bounded file bytes",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "fusion-huawei-material-workspace-"));
      const provider = new HuaweiSshProvider({
        host: "fake",
        keyPath: "unused",
        nodeId: "huawei-test-node",
        jobRoot: root,
        run: localRunner(process.env.PATH ?? "/usr/bin:/bin"),
      });
      const files = {
        "src/revision.txt": "code bytes",
        "inputs/test.json": "{\"case\":1}",
        "runtime/identity.json": "runtime bytes",
        "config/checks.json": "check bytes",
        "dist/result.bin": "artifact bytes",
      };
      const command = `mkdir -p src inputs runtime config dist; printf 'code bytes' > src/revision.txt; printf '{"case":1}' > inputs/test.json; printf 'runtime bytes' > runtime/identity.json; printf 'check bytes' > config/checks.json; printf 'artifact bytes' > dist/result.bin; printf '%s|%s' "$FUSION_ATTEMPT_ID" "$FUSION_DSH_SOURCE_REVISION"`;
      const executionWorkspace = { id: "attempt-material-1", sourceRevision: "3", sourceDigest: "a".repeat(64) };
      const paths = Object.keys(files);
      try {
        const dispatched = await provider.dispatch({
          goal: "material contract fixture",
          nodeIds: ["huawei-test-node"],
          command,
          idempotencyKey: "material-attempt-1",
          dispatchFingerprint: "b".repeat(64),
          executionWorkspace,
        });
        let task = dispatched;
        for (let attempt = 0; attempt < 100 && task.status === "running"; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          task = await provider.inspect(dispatched.id);
        }
        expect(task.status).toBe("completed");
        const observed = await provider.readExecutionMaterialFiles(dispatched.id, executionWorkspace.id, paths);
        expect(observed?.workspaceId).toBe(executionWorkspace.id);
        expect(observed?.workspacePath).toBe(`${root}/${dispatched.id}/workspace`);
        expect(observed?.sourceRevision).toBe(executionWorkspace.sourceRevision);
        expect(observed?.sourceDigest).toBe(executionWorkspace.sourceDigest);
        expect(observed?.files.map(({ path, digest, bytes }) => ({ path, digest, bytes }))).toEqual(
          Object.entries(files).map(([path, content]) => ({
            path,
            digest: createHash("sha256").update(content).digest("hex"),
            bytes: Buffer.byteLength(content),
          })),
        );

        const spoofedProvider = new HuaweiSshProvider({
          host: "fake",
          keyPath: "unused",
          nodeId: "huawei-test-node",
          jobRoot: root,
          run: async (script) => {
            const result = await localRunner(process.env.PATH ?? "/usr/bin:/bin")(script);
            if (script.includes("HUAWEI_EXECUTION_MATERIAL_READ")) {
              return {
                ...result,
                stdout: result.stdout.replace(
                  `WORKSPACE_PATH=${root}/${dispatched.id}/workspace`,
                  `WORKSPACE_PATH=${root}/other-attempt/workspace`,
                ),
              };
            }
            return result;
          },
        });
        await expect(spoofedProvider.readExecutionMaterialFiles(dispatched.id, executionWorkspace.id, paths))
          .resolves.toBeUndefined();

        const workspace = observed!.workspacePath;
        const outside = join(root, "outside.txt");
        await writeFile(outside, "outside bytes");
        await rm(join(workspace, "src/revision.txt"));
        symlinkSync(outside, join(workspace, "src/revision.txt"));
        await expect(provider.readExecutionMaterialFiles(dispatched.id, executionWorkspace.id, paths))
          .resolves.toBeUndefined();
        await expect(provider.readExecutionMaterialFiles(dispatched.id, executionWorkspace.id, ["../outside.txt"]))
          .resolves.toBeUndefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
