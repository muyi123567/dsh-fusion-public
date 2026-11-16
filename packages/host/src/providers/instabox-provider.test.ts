import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { InstaboxProvider } from "./instabox-provider.js";
import { execCapabilityProbeCommand } from "./exec-capability-probe.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FakeJobStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "LOST";

interface FakeJob {
  status: FakeJobStatus;
  exitCode?: number;
  stdout: string;
  stderr: string;
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  bootId?: string;
  pidStarttime?: string;
  currentBootId?: string;
  currentPid?: string;
  currentPidStarttime?: string;
  lostReason?: string;
}

const defaultStartedAt = "2026-10-22T01:02:03Z";
const defaultFinishedAt = "2026-10-22T01:02:04Z";
const defaultBootId = "11111111-2222-3333-4444-555555555555";
const defaultPidStarttime = "987654";
const fixtureExecTools = [
  "base64", "sha256sum", "sync", "date", "mkdir", "chmod", "cp", "mv", "rm",
  "sleep", "cat", "nohup", "setsid", "bash", "ps", "head", "wc", "tr", "awk", "dirname", "mkfifo",
];
function capabilityOutput(failedCheck?: string): string {
  const checks = [...fixtureExecTools.map(tool => `tool_${tool}`), "proc", "job_root"];
  return [
    "FUSION_EXEC_PROBE=1", `CHECK_COUNT=${checks.length}`,
    ...checks.map(id => `CHECK_${id}=${id === failedCheck ? 0 : 1}`),
    "FUSION_EXEC_PROBE_END=1",
  ].join("\n");
}

function taskIdFromStartCommand(command: string): string {
  const match = command.match(/^task_id='(INSTABOX-[A-Za-z0-9-]+)'$/mu);
  if (match?.[1] === undefined) throw new Error("test start command has no task id");
  return match[1];
}

function startOutput(
  taskId: string,
  pid = 4242,
  startedAt = defaultStartedAt,
) {
  return {
    exitCode: 0,
    stdout: [
      `TASK_ID=${taskId}`,
      "STATUS=RUNNING",
      `PID=${pid}`,
      `STARTED_AT=${startedAt}`,
      `BOOT_ID=${defaultBootId}`,
      `PID_STARTTIME=${defaultPidStarttime}`,
      "",
    ].join("\n"),
    stderr: "",
  };
}

function bytePrefix(value: string, limit: number): Buffer {
  return Buffer.from(value, "utf8").subarray(0, limit);
}

function inspectOutput(job: FakeJob, limit = 1_048_576) {
  const stdout = bytePrefix(job.stdout, limit);
  const stderr = bytePrefix(job.stderr, limit);
  const pid = job.pid ?? 4242;
  return {
    exitCode: 0,
    stdout: [
      "EXISTS=1",
      `STATUS=${job.status}`,
      `PID=${pid}`,
      `EXIT=${job.exitCode === undefined ? "" : job.exitCode}`,
      `STARTED_AT=${job.startedAt ?? defaultStartedAt}`,
      `FINISHED_AT=${job.status === "RUNNING" ? "" : job.finishedAt ?? defaultFinishedAt}`,
      `COMMAND_SHA256=${"a".repeat(64)}`,
      "IDEMPOTENCY_KEY=retry-key",
      `REQUEST_SHA256=${"b".repeat(64)}`,
      `BOOT_ID=${job.bootId ?? defaultBootId}`,
      `PID_STARTTIME=${job.pidStarttime ?? defaultPidStarttime}`,
      `CURRENT_BOOT_ID=${job.currentBootId ?? job.bootId ?? defaultBootId}`,
      `CURRENT_PID=${job.currentPid ?? String(pid)}`,
      `CURRENT_PID_STARTTIME=${job.currentPidStarttime ?? job.pidStarttime ?? defaultPidStarttime}`,
      `LOST_REASON=${job.lostReason ?? ""}`,
      `STDOUT_SIZE=${Buffer.byteLength(job.stdout, "utf8")}`,
      `STDOUT=${stdout.toString("base64")}`,
      `STDERR_SIZE=${Buffer.byteLength(job.stderr, "utf8")}`,
      `STDERR=${stderr.toString("base64")}`,
      "",
    ].join("\n"),
    stderr: "",
  };
}

function machineResponse() {
  return {
    id: "machine-1",
    name: "dsh-fusion-test",
    state: "running",
    runtime: { ready: true },
  };
}

describe("InstaboxProvider", () => {
  describe("probeExecCapability", () => {
    it.each([
      [undefined, "supported", []],
      ["tool_setsid", "unsupported", ["EXEC_TOOL_MISSING"]],
      ["proc", "unsupported", ["EXEC_PROC_UNAVAILABLE"]],
      ["job_root", "unsupported", ["EXEC_JOB_ROOT_UNWRITABLE"]],
    ] as const)("uses only the fixed diagnostic for prerequisite %s", async (failedCheck, state, reasons) => {
      const commands: string[] = [];
      const provider = new InstaboxProvider({
        apiKey: "fixture-key", machineName: "dsh-fusion-test", nodeId: "fixture-node",
        providerId: "instabox-fixture", jobRoot: "/fixture/jobs",
        fetch: async (url, init) => {
          if (String(url).endsWith("/exec")) {
            expect(String(url)).toContain("/v1/machines/machine-1/exec");
            commands.push(String(JSON.parse(String(init?.body)).cmd));
            return jsonResponse({ exitCode: 0, stdout: capabilityOutput(failedCheck), stderr: "" });
          }
          return jsonResponse(machineResponse());
        },
      });
      const dispatch = vi.spyOn(provider, "dispatch");
      const observation = await provider.probeExecCapability();
      expect(observation).toMatchObject({ nodeId: "fixture-node", providerId: "instabox-fixture", state, reasonCodes: reasons });
      expect(observation.source).toBe("exec-capability-probe/v1");
      expect(observation.checks).toHaveLength(fixtureExecTools.length + 2);
      expect(observation.expiresAt - observation.checkedAt).toBe(30_000);
      expect(commands).toEqual([execCapabilityProbeCommand("/fixture/jobs", fixtureExecTools)]);
      expect(commands[0]).not.toMatch(/INSTABOX_JOB_START|command_b64=|^\s*(?:mkdir|touch|chmod|nohup)\s/mu);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("does not accept a structurally complete probe that omits required job tools", async () => {
      const provider = new InstaboxProvider({
        apiKey: "fixture-key", machineName: "dsh-fusion-test",
        fetch: async url => String(url).endsWith("/exec")
          ? jsonResponse({ exitCode: 0, stderr: "", stdout: "FUSION_EXEC_PROBE=1\nCHECK_COUNT=3\nCHECK_tool_bash=1\nCHECK_proc=1\nCHECK_job_root=1\nFUSION_EXEC_PROBE_END=1" })
          : jsonResponse(machineResponse()),
      });
      expect(await provider.probeExecCapability()).toMatchObject({ state: "unknown", reasonCodes: ["EXEC_PROBE_INVALID"] });
    });

    it.each([
      ["unreachable API", () => { throw new Error("fixture-private-detail"); }],
      ["HTTP failure", () => jsonResponse({ error: "fixture-private-detail" }, 503)],
      ["invalid JSON", () => new Response("not-json")],
      ["invalid machine structure", () => jsonResponse({ state: "running" })],
      ["empty machine identity", () => jsonResponse({ ...machineResponse(), id: "" })],
      ["wrong machine identity", () => jsonResponse({ ...machineResponse(), name: "other-machine" })],
      ["stopped machine", () => jsonResponse({ ...machineResponse(), state: "stopped" })],
      ["runtime not ready", () => jsonResponse({ ...machineResponse(), runtime: { ready: false } })],
      ["running without runtime readiness", () => jsonResponse({ ...machineResponse(), runtime: undefined })],
    ] as const)("returns unknown without exec on %s", async (_name, response) => {
      const fetch = vi.fn(async (_url: string | URL | Request) => response());
      const provider = new InstaboxProvider({
        apiKey: "fixture-key",
        machineName: "dsh-fusion-test",
        nodeId: "fixture-node",
        providerId: "instabox-fixture",
        fetch,
      });
      const before = Date.now();
      const observation = await provider.probeExecCapability();
      expect(observation).toMatchObject({
        nodeId: "fixture-node", providerId: "instabox-fixture", state: "unknown",
      });
      expect(observation.checkedAt).toBeGreaterThanOrEqual(before);
      expect(observation.expiresAt - observation.checkedAt).toBe(30_000);
      expect(observation.reasonCodes.length).toBeGreaterThan(0);
      expect(JSON.stringify(observation)).not.toContain("fixture-private-detail");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]?.[0])).not.toContain("/exec");
    });

    it.each([
      ["exec API failure", () => jsonResponse({ error: "fixture-private-detail" }, 503)],
      ["exec timeout", () => { throw new Error("fixture-private-detail"); }],
      ["invalid exec structure", () => jsonResponse({ stdout: "" })],
      ["nonzero diagnostic exit", () => jsonResponse({ exitCode: 1, stdout: "", stderr: "fixture-private-detail" })],
      ["malformed diagnostic output", () => jsonResponse({ exitCode: 0, stdout: "garbage", stderr: "" })],
      ["empty diagnostic output", () => jsonResponse({ exitCode: 0, stdout: "", stderr: "" })],
    ] as const)("returns unknown on %s without starting a job", async (_name, response) => {
      const commands: string[] = [];
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/exec")) {
          commands.push(String(JSON.parse(String(init?.body)).cmd));
          return response();
        }
        return jsonResponse(machineResponse());
      });
      const provider = new InstaboxProvider({ apiKey: "fixture-key", machineName: "dsh-fusion-test", fetch });
      const dispatch = vi.spyOn(provider, "dispatch");
      const observation = await provider.probeExecCapability();
      expect(observation.state).toBe("unknown");
      expect(observation.reasonCodes.length).toBeGreaterThan(0);
      expect(JSON.stringify(observation)).not.toContain("fixture-private-detail");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(commands).toHaveLength(1);
      expect(commands[0]).not.toContain("INSTABOX_JOB_START");
      expect(commands[0]).not.toContain("command_b64=");
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it("rejects non-HTTPS API endpoints", () => {
    expect(() => new InstaboxProvider({
      apiKey: "key",
      machineName: "machine",
      apiBaseUrl: "http://api.instabox.sh",
      fetch: vi.fn(),
    })).toThrow("INSTABOX_HTTPS_REQUIRED");
  });
  it("uses a deterministic task id and persists dispatch idempotency metadata", async () => {
    let startCommand = "";
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          startCommand = String(JSON.parse(String(init?.body)).cmd);
          return jsonResponse(startOutput(taskIdFromStartCommand(startCommand)));
        }
        return jsonResponse(machineResponse());
      },
    });

    const task = await provider.dispatch({
      goal: "crash safe",
      nodeIds: ["node-instabox"],
      command: "uname -a",
      idempotencyKey: "retry-key",
      taskId: "INSTABOX-crash-safe",
      dispatchFingerprint: "b".repeat(64),
    });

    expect(task.id).toBe("INSTABOX-crash-safe");
    expect(task.idempotencyKey).toBe("retry-key");
    expect(task.dispatchFingerprint).toBe("b".repeat(64));
    expect(startCommand).toContain("task_id='INSTABOX-crash-safe'");
    expect(startCommand).toContain("idempotency_key=");
    expect(startCommand).toContain("request_sha256=");
  });

  it("lists a running machine as an online Fusion node", async () => {
    const requests: Array<{ url: string; apiKey: string | null }> = [];
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          apiKey: new Headers(init?.headers).get("x-api-key"),
        });
        return jsonResponse(machineResponse());
      },
    });

    const nodes = await provider.listNodes();
    const health = await provider.health();

    expect(nodes[0]).toMatchObject({
      id: "instabox-dsh-fusion-test",
      externalId: "machine-1",
      providerId: "instabox",
      status: "online",
      transports: ["dsh-fleet"],
    });
    expect(health.state).toBe("connected");
    expect(requests.every((request) => request.apiKey === "vault-key")).toBe(true);
    expect(requests.every((request) => !request.url.includes("vault-key"))).toBe(true);
  });

  it("starts a detached job from base64 and returns running summary evidence", async () => {
    let startCommand = "";
    const command = "printf '%s\\n' 'quoted'; printf \"double\"; echo $(id)";
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          startCommand = String(JSON.parse(String(init?.body)).cmd);
          return jsonResponse(startOutput(taskIdFromStartCommand(startCommand)));
        }
        return jsonResponse(machineResponse());
      },
    });

    const task = await provider.dispatch({
      goal: "check node",
      nodeIds: ["node-instabox"],
      command,
      requestedByBotId: "bot-1",
    });

    expect(task.id).toMatch(/^INSTABOX-[0-9a-f-]{36}$/i);
    expect(task).toMatchObject({
      goal: "check node",
      requestedByBotId: "bot-1",
      targetNodeIds: ["node-instabox"],
      transport: "dsh-fleet",
      status: "running",
      expectedEvidence: ["summary", "command", "log"],
      createdAt: defaultStartedAt,
    });
    expect(task.evidence).toContainEqual(expect.objectContaining({
      kind: "summary",
      label: `${task.id}:summary`,
      value: expect.stringContaining(`taskId=${task.id}`),
    }));
    expect(task.evidence[0]?.value).toContain("pid=4242");
    expect(task.evidence[0]?.value).toContain(`startedAt=${defaultStartedAt}`);
    expect(startCommand).toContain("# INSTABOX_JOB_START");
    expect(startCommand).toContain("/tmp/dsh-fusion-instabox-jobs/");
    expect(startCommand).toContain(task.id);
    expect(startCommand).toContain("nohup setsid");
    expect(startCommand).not.toContain(command);
    expect(startCommand).toContain(Buffer.from(command, "utf8").toString("base64"));
  });

  it("uses an injected job root without changing the task protocol", async () => {
    let startCommand = "";
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      jobRoot: "/tmp/custom-instabox-jobs",
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          startCommand = String(JSON.parse(String(init?.body)).cmd);
          return jsonResponse(startOutput(taskIdFromStartCommand(startCommand)));
        }
        return jsonResponse(machineResponse());
      },
    });

    const task = await provider.dispatch({
      goal: "custom root",
      nodeIds: ["node-instabox"],
      command: "true",
    });

    expect(startCommand).toContain(`/tmp/custom-instabox-jobs/${task.id}`);
  });

  it("recovers the generated task id after the start request times out", async () => {
    const job: FakeJob = {
      status: "RUNNING",
      stdout: "",
      stderr: "",
    };
    let taskId = "";
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url, init) => {
        if (!new URL(String(url)).pathname.endsWith("/exec")) {
          return jsonResponse(machineResponse());
        }
        const command = String(JSON.parse(String(init?.body)).cmd);
        if (command.includes("# INSTABOX_JOB_START")) {
          taskId = taskIdFromStartCommand(command);
          throw new Error("request timed out");
        }
        expect(command).toContain("# INSTABOX_JOB_INSPECT");
        return jsonResponse(inspectOutput(job));
      },
    });

    const task = await provider.dispatch({
      goal: "recover indeterminate start",
      nodeIds: ["node-instabox"],
      command: "uname -r",
      requestedByBotId: "bot-recover",
    });

    expect(task).toMatchObject({
      id: taskId,
      goal: "recover indeterminate start",
      requestedByBotId: "bot-recover",
      status: "running",
    });
  });

  it("reports an indeterminate start with the task id after a 429 and no remote job", async () => {
    let inspectAttempts = 0;
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url, init) => {
        if (!new URL(String(url)).pathname.endsWith("/exec")) {
          return jsonResponse(machineResponse());
        }
        const command = String(JSON.parse(String(init?.body)).cmd);
        if (command.includes("# INSTABOX_JOB_START")) {
          taskIdFromStartCommand(command);
          return jsonResponse({ error: "rate limited" }, 429);
        }
        inspectAttempts += 1;
        return jsonResponse({
          exitCode: 0,
          stdout: "EXISTS=0\n",
          stderr: "",
        });
      },
    });

    await expect(provider.dispatch({
      goal: "rate limited start",
      nodeIds: ["node-instabox"],
      command: "true",
    })).rejects.toThrow(
      /^INSTABOX_JOB_START_INDETERMINATE:INSTABOX-[0-9a-f-]+:INSTABOX_HTTP_429:/u,
    );
    expect(inspectAttempts).toBeGreaterThan(0);
  });

  it("inspects running and completed jobs after provider restart", async () => {
    const job: FakeJob = {
      status: "RUNNING",
      stdout: "",
      stderr: "",
    };
    const first = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          const command = String(JSON.parse(String(init?.body)).cmd);
          return jsonResponse(startOutput(taskIdFromStartCommand(command)));
        }
        return jsonResponse(machineResponse());
      },
    });
    const task = await first.dispatch({
      goal: "recover remote task",
      nodeIds: ["node-instabox"],
      command: "uname -r",
    });

    const second = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          const command = String(JSON.parse(String(init?.body)).cmd);
          expect(command).toContain("# INSTABOX_JOB_INSPECT");
          expect(command).toContain(task.id);
          return jsonResponse(inspectOutput(job));
        }
        return jsonResponse(machineResponse());
      },
    });

    await expect(second.inspect(task.id)).resolves.toMatchObject({
      id: task.id,
      status: "running",
      progress: 50,
      expectedEvidence: ["summary", "command", "log"],
    });

    job.status = "COMPLETED";
    job.exitCode = 0;
    job.stdout = "kernel-ok\n";
    job.stderr = "warning: test mode\n";

    const completed = await second.inspect(task.id);
    expect(completed).toMatchObject({
      id: task.id,
      status: "completed",
      progress: 100,
      createdAt: defaultStartedAt,
      updatedAt: defaultFinishedAt,
    });
    expect(completed.evidence).toContainEqual(expect.objectContaining({
      kind: "summary",
      value: expect.stringContaining("exit=0"),
    }));
    expect(completed.evidence).toContainEqual(expect.objectContaining({
      kind: "command",
      value: "kernel-ok\n",
    }));
    expect(completed.evidence).toContainEqual(expect.objectContaining({
      kind: "log",
      value: "warning: test mode\n",
    }));
  });

  it("uses the project empty marker when a successful command has no output", async () => {
    const job: FakeJob = {
      status: "COMPLETED",
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          return jsonResponse(inspectOutput(job));
        }
        return jsonResponse(machineResponse());
      },
    });

    const task = await provider.inspect(
      "INSTABOX-11111111-1111-4111-8111-111111111111",
    );

    expect(task.status).toBe("completed");
    expect(task.evidence).toContainEqual(expect.objectContaining({
      kind: "command",
      value: "(empty)",
    }));
    expect(task.evidence).toContainEqual(expect.objectContaining({
      kind: "log",
      value: "(empty)",
    }));
  });

  it("normalizes whitespace-only stdout and stderr to the project empty marker", async () => {
    const job: FakeJob = {
      status: "COMPLETED",
      exitCode: 0,
      stdout: "\n",
      stderr: "   ",
    };
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          return jsonResponse(inspectOutput(job));
        }
        return jsonResponse(machineResponse());
      },
    });

    const task = await provider.inspect(
      "INSTABOX-11111111-1111-4111-8111-111111111111",
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

  it.each([
    [
      "boot",
      { currentBootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      "boot_id_mismatch",
    ],
    [
      "PID",
      { currentPid: "999999" },
      "pid_mismatch",
    ],
    [
      "starttime",
      { currentPidStarttime: "123123" },
      "pid_starttime_mismatch",
    ],
  ] as const)("maps a running job with a changed %s identity to failed LOST", async (
    _identity,
    overrides,
    reason,
  ) => {
    const job: FakeJob = {
      status: "RUNNING",
      stdout: "",
      stderr: "",
      ...overrides,
    };
    let inspectCommand = "";
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          inspectCommand = String(JSON.parse(String(init?.body)).cmd);
          return jsonResponse(inspectOutput(job));
        }
        return jsonResponse(machineResponse());
      },
    });

    const task = await provider.inspect(
      "INSTABOX-11111111-1111-4111-8111-111111111111",
    );

    expect(task).toMatchObject({
      status: "failed",
      progress: 0,
      error: `INSTABOX_TASK_LOST:${reason}`,
    });
    expect(inspectCommand).toContain("/proc/sys/kernel/random/boot_id");
    expect(inspectCommand).toContain('/proc/$pid/stat');
    expect(inspectCommand).toContain("status=LOST");
  });

  it("maps a nonzero remote exit to failed task evidence", async () => {
    const job: FakeJob = {
      status: "FAILED",
      exitCode: 2,
      stdout: "partial output\n",
      stderr: "command failed\n",
    };
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) return jsonResponse(inspectOutput(job));
        return jsonResponse(machineResponse());
      },
    });

    const task = await provider.inspect("INSTABOX-11111111-1111-4111-8111-111111111111");

    expect(task).toMatchObject({
      status: "failed",
      progress: 0,
      error: expect.stringContaining("INSTABOX_TASK_FAILED:exit=2"),
    });
    expect(task.error).toContain("command failed");
    expect(task.evidence).toContainEqual(expect.objectContaining({
      kind: "command",
      value: "partial output\n",
    }));
  });

  it("cancels only the requested process group and reports cancelled after restart", async () => {
    const job: FakeJob = {
      status: "RUNNING",
      stdout: "started\n",
      stderr: "",
    };
    let startCommand = "";
    let cancelCommand = "";
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url, init) => {
        if (!new URL(String(url)).pathname.endsWith("/exec")) {
          return jsonResponse(machineResponse());
        }
        const command = String(JSON.parse(String(init?.body)).cmd);
        if (command.includes("# INSTABOX_JOB_START")) {
          startCommand = command;
          return jsonResponse(startOutput(taskIdFromStartCommand(command)));
        }
        if (command.includes("# INSTABOX_JOB_CANCEL")) {
          cancelCommand = command;
          if (job.status === "RUNNING") {
            job.status = "CANCELLED";
            job.exitCode = 130;
            job.finishedAt = defaultFinishedAt;
          }
          return jsonResponse({
            exitCode: 0,
            stdout: `EXISTS=1\nSTATUS=${job.status}\nCANCELLED=${job.status === "CANCELLED" ? "1" : "0"}\n`,
            stderr: "",
          });
        }
        return jsonResponse(inspectOutput(job));
      },
    });
    const task = await provider.dispatch({
      goal: "cancel remote task",
      nodeIds: ["node-instabox"],
      command: "sleep 60",
    });

    await provider.cancel(task.id);
    await expect(provider.cancel(task.id)).resolves.toBeUndefined();

    expect(startCommand).toContain("/proc/sys/kernel/random/boot_id");
    expect(startCommand).toContain('/proc/$$/stat');
    expect(cancelCommand).toContain("# INSTABOX_JOB_CANCEL");
    expect(cancelCommand).toContain(`/tmp/dsh-fusion-instabox-jobs/${task.id}`);
    expect(cancelCommand).toContain("current_boot_id");
    expect(cancelCommand).toContain("pid_starttime");
    expect(cancelCommand).toContain("STATUS=LOST");
    expect(cancelCommand).toContain('kill -TERM -- "-$pid"');
    expect(cancelCommand).toContain('kill -KILL -- "-$pid"');

    const cancelled = await new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) return jsonResponse(inspectOutput(job));
        return jsonResponse(machineResponse());
      },
    }).inspect(task.id);

    expect(cancelled).toMatchObject({
      id: task.id,
      status: "cancelled",
      progress: 100,
    });
  });

  it("rejects cancel when the remote job is already completed", async () => {
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          return jsonResponse({
            exitCode: 0,
            stdout: "EXISTS=1\nSTATUS=COMPLETED\nCANCELLED=0\n",
            stderr: "",
          });
        }
        return jsonResponse(machineResponse());
      },
    });

    await expect(provider.cancel(
      "INSTABOX-11111111-1111-4111-8111-111111111111",
    )).rejects.toThrow("INSTABOX_TASK_ALREADY_TERMINAL:COMPLETED");
  });

  it("rejects an unconfirmed cancellation instead of claiming the task stopped", async () => {
    const provider = new InstaboxProvider({
      apiKey: "test-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          return jsonResponse({
            exitCode: 0,
            stdout: "EXISTS=1\nSTATUS=RUNNING\nCANCELLED=0\nERROR=CANCELLATION_UNCONFIRMED\n",
            stderr: "",
          });
        }
        return jsonResponse(machineResponse());
      },
    });

    await expect(provider.cancel(
      "INSTABOX-11111111-1111-4111-8111-111111111111",
    )).rejects.toThrow("INSTABOX_TASK_CANCEL_FAILED:CANCELLATION_UNCONFIRMED");
  });

  it("does not kill a process group when the stored PID identity is stale", async () => {
    let cancelCommand = "";
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          cancelCommand = String(JSON.parse(String(init?.body)).cmd);
          return jsonResponse({
            exitCode: 0,
            stdout: [
              "EXISTS=1",
              "STATUS=LOST",
              "CANCELLED=0",
              "LOST_REASON=pid_starttime_mismatch",
              "",
            ].join("\n"),
            stderr: "",
          });
        }
        return jsonResponse(machineResponse());
      },
    });

    await expect(provider.cancel(
      "INSTABOX-11111111-1111-4111-8111-111111111111",
    )).rejects.toThrow("INSTABOX_TASK_ALREADY_TERMINAL:LOST");
    expect(cancelCommand).toContain("boot_id");
    expect(cancelCommand).toContain("pid_starttime");
    expect(cancelCommand).toContain("/proc/$pid/stat");
    expect(cancelCommand.indexOf("STATUS=LOST")).toBeLessThan(
      cancelCommand.indexOf('kill -TERM -- "-$pid"'),
    );
  });

  it("rejects unsafe task ids before invoking the API", async () => {
    const fetch = vi.fn(async () => jsonResponse(machineResponse()));
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      fetch,
    });

    await expect(provider.inspect("../INSTABOX-secret")).rejects.toThrow(
      "INSTABOX_TASK_ID_INVALID",
    );
    await expect(provider.cancel("INSTABOX-ok/../../etc")).rejects.toThrow(
      "INSTABOX_TASK_ID_INVALID",
    );
    await expect(provider.inspect("HUAWEI-11111111-1111-4111-8111-111111111111")).rejects.toThrow(
      "INSTABOX_TASK_ID_INVALID",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a missing job explicitly", async () => {
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          return jsonResponse({
            exitCode: 0,
            stdout: "EXISTS=0\n",
            stderr: "",
          });
        }
        return jsonResponse(machineResponse());
      },
    });

    await expect(provider.inspect(
      "INSTABOX-11111111-1111-4111-8111-111111111111",
    )).rejects.toThrow("INSTABOX_TASK_NOT_FOUND:INSTABOX-11111111-1111-4111-8111-111111111111");
  });

  it("caps stdout and stderr after decoding base64", async () => {
    const job: FakeJob = {
      status: "COMPLETED",
      exitCode: 0,
      stdout: "x".repeat(100),
      stderr: "y".repeat(90),
    };
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      outputLimitBytes: 64,
      fetch: async (url) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          return jsonResponse(inspectOutput(job, 64));
        }
        return jsonResponse(machineResponse());
      },
    });

    const task = await provider.inspect(
      "INSTABOX-11111111-1111-4111-8111-111111111111",
    );
    const summary = task.evidence.find((item) => item.kind === "summary");
    const stdout = task.evidence.find((item) => item.kind === "command");
    const stderr = task.evidence.find((item) => item.kind === "log");

    expect(Buffer.byteLength(stdout?.value ?? "", "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(stderr?.value ?? "", "utf8")).toBeLessThanOrEqual(64);
    expect(stdout?.value).toContain("[truncated]");
    expect(stderr?.value).toContain("[truncated]");
    expect(summary?.value).toContain("stdoutTruncated=true");
    expect(summary?.value).toContain("stderrTruncated=true");
  });

  it("embeds stale state-lock recovery in worker and cancel commands", async () => {
    let startCommand = "";
    let cancelCommand = "";
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url, init) => {
        if (!new URL(String(url)).pathname.endsWith("/exec")) {
          return jsonResponse(machineResponse());
        }
        const command = String(JSON.parse(String(init?.body)).cmd);
        if (command.includes("# INSTABOX_JOB_START")) {
          startCommand = command;
          return jsonResponse(startOutput(taskIdFromStartCommand(command)));
        }
        if (command.includes("# INSTABOX_JOB_CANCEL")) {
          cancelCommand = command;
          return jsonResponse({
            exitCode: 0,
            stdout: "EXISTS=1\nSTATUS=CANCELLED\nCANCELLED=1\n",
            stderr: "",
          });
        }
        throw new Error("unexpected command");
      },
    });
    const task = await provider.dispatch({
      goal: "stale lock protocol",
      nodeIds: ["node-instabox"],
      command: "sleep 30",
    });

    await provider.cancel(task.id);

    for (const command of [startCommand, cancelCommand]) {
      expect(command).toContain("STATE_LOCK_STALE_SECONDS=10");
      expect(command).toContain('"$lock_dir/created_at"');
      expect(command).toContain('"$lock_dir/lock_owner_boot_id"');
      expect(command).toContain('"$lock_dir/lock_owner_pid"');
      expect(command).toContain('"$lock_dir/lock_owner_starttime"');
      expect(command).toContain('"$lock_dir/lock_owner_session_id"');
      expect(command).toContain('"/proc/$owner_pid/stat"');
      expect(command).toContain("can_reclaim");
      expect(command).toContain('mv -- "$lock_dir" "$stale_dir"');
      expect(command).toContain('rm -rf -- "$stale_dir"');
      expect(command).toContain('"$lock_dir/token"');
    }
  });

  it("rejects a job directory symlink before starting a worker", async () => {
    let startCommand = "";
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          startCommand = String(JSON.parse(String(init?.body)).cmd);
          return jsonResponse({
            exitCode: 2,
            stdout: "",
            stderr: "INSTABOX_JOB_DIR_SYMLINK\n",
          });
        }
        return jsonResponse(machineResponse());
      },
    });

    await expect(provider.dispatch({
      goal: "reject symlink",
      nodeIds: ["node-instabox"],
      command: "true",
    })).rejects.toThrow("INSTABOX_JOB_START_FAILED:INSTABOX_JOB_DIR_SYMLINK");
    expect(startCommand).toContain('[ -L "$job_dir" ]');
  });

  it("rejects a symlinked jobRoot parent path before starting a worker", async () => {
    let startCommand = "";
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          startCommand = String(JSON.parse(String(init?.body)).cmd);
          return jsonResponse({
            exitCode: 2,
            stdout: "",
            stderr: "INSTABOX_JOB_PATH_SYMLINK:/tmp/linked-parent\n",
          });
        }
        return jsonResponse(machineResponse());
      },
    });

    await expect(provider.dispatch({
      goal: "reject parent symlink",
      nodeIds: ["node-instabox"],
      command: "true",
    })).rejects.toThrow(
      "INSTABOX_JOB_START_FAILED:INSTABOX_JOB_PATH_SYMLINK:/tmp/linked-parent",
    );
    expect(startCommand).toContain("assert_no_symlink_components");
    expect(startCommand).toContain('job_root=$(dirname -- "$job_dir")');
  });

  it("surfaces a missing remote preflight tool", async () => {
    let startCommand = "";
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          startCommand = String(JSON.parse(String(init?.body)).cmd);
          return jsonResponse({
            exitCode: 127,
            stdout: "",
            stderr: "INSTABOX_JOB_TOOL_UNAVAILABLE:setsid\n",
          });
        }
        return jsonResponse(machineResponse());
      },
    });

    await expect(provider.dispatch({
      goal: "missing tool",
      nodeIds: ["node-instabox"],
      command: "true",
    })).rejects.toThrow(
      "INSTABOX_JOB_START_FAILED:INSTABOX_JOB_TOOL_UNAVAILABLE:setsid",
    );
    expect(startCommand).toContain('command -v "$tool"');
  });

  it("rejects an unsafe job root at construction", () => {
    expect(() => new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      jobRoot: "/tmp/../instabox-jobs",
      fetch: vi.fn(),
    })).toThrow("INSTABOX_JOB_ROOT_INVALID");
  });

  it("fails closed when the machine is not targeted or the API rejects the request", async () => {
    const provider = new InstaboxProvider({
      apiKey: "vault-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      fetch: async () => jsonResponse({ error: "forbidden" }, 403),
    });

    await expect(provider.dispatch({
      goal: "wrong node",
      nodeIds: ["other"],
      command: "uname -a",
    })).rejects.toThrow("INSTABOX_NODE_NOT_TARGETED");
    await expect(provider.listNodes()).rejects.toThrow("INSTABOX_HTTP_403");
  });
});

describe("InstaboxProvider remote job output budget", () => {
  // The remote job scripts need a POSIX runtime with /proc; on Windows the
  // suite fakes /exec responses instead of executing scripts locally.
  it.skipIf(process.platform === "win32")(
    "bounds on-disk job output at runtime and keeps truncation recoverable",
    async () => {
      const jobRoot = mkdtempSync(join(tmpdir(), "instabox-jobs-"));
      const execute = promisify(execFile);
      const runRemote = async (cmd: string) => {
        try {
          const { stdout, stderr } = await execute("bash", ["-c", cmd], {
            timeout: 30_000,
            maxBuffer: 16 * 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error) {
          const failure = error as { code?: unknown; stdout?: string; stderr?: string };
          return {
            exitCode: typeof failure.code === "number" ? failure.code : 1,
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? "",
          };
        }
      };
      const limit = 64;
      const producedStdoutBytes = 5_000;
      const provider = new InstaboxProvider({
        apiKey: "test-key",
        machineName: "dsh-fusion-test",
        nodeId: "node-instabox",
        jobRoot,
        outputLimitBytes: limit,
        fetch: async (url, init) => {
          if (new URL(String(url)).pathname.endsWith("/exec")) {
            const body = JSON.parse(String(init?.body)) as { cmd: string };
            return jsonResponse(await runRemote(body.cmd));
          }
          return jsonResponse(machineResponse());
        },
      });
      try {
        const dispatched = await provider.dispatch({
          goal: "noisy job",
          nodeIds: ["node-instabox"],
          command: `head -c ${producedStdoutBytes} /dev/zero | tr '\\0' 'a'; echo DONE`,
        });
        let task = dispatched;
        for (let attempt = 0; attempt < 300 && task.status === "running"; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          task = await provider.inspect(dispatched.id);
        }
        expect(
          task.status,
          `summary evidence: ${task.evidence.find((item) => item.kind === "summary")?.value ?? "none"}`,
        ).toBe("completed");
        const jobDir = join(jobRoot, dispatched.id);
        // The stored output never exceeds the configured budget, even
        // though the command produced far more than the limit.
        expect(readFileSync(join(jobDir, "stdout")).byteLength).toBeLessThanOrEqual(limit);
        expect(readFileSync(join(jobDir, "stdout.part")).byteLength).toBeLessThanOrEqual(limit);
        // Truncation stays recoverable: the true produced size is recorded
        // next to the bounded output, so inspect can still report it.
        expect(readFileSync(join(jobDir, "stdout.total"), "utf8").trim())
          .toBe(String(producedStdoutBytes + "DONE\n".length));
        const summary = task.evidence.find((item) => item.kind === "summary");
        expect(summary?.value).toContain("stdoutTruncated=true");
        const stdoutEvidence = task.evidence.find((item) => item.kind === "command");
        expect(stdoutEvidence?.value).toContain("[truncated]");
      } finally {
        rmSync(jobRoot, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

// Execute the generated cancel script locally against a real sleeper
// process (so /proc identity checks run for real), with shell-function
// fakes only for kill, the group-state ps query, and the reuse mutation.
// This exercises the real signal/confirmation branches, not script text.
describe("InstaboxProvider cancel confirmation", () => {
  const taskId = "INSTABOX-cancel-test";

  interface CancelScenario {
    error: Error | undefined;
    signals: string;
    status: string;
  }

  async function runCancelScenario(options: {
    signalDenied?: boolean;
    termSurvives?: boolean;
    lingersAfterKill?: boolean;
    reuseAfterTerm?: boolean;
    zombieStates?: string;
    afterKillStates?: string;
  }): Promise<CancelScenario> {
    const jobRoot = mkdtempSync(join(tmpdir(), "instabox-cancel-"));
    const jobDir = join(jobRoot, taskId);
    mkdirSync(jobDir, { recursive: true });
    // A real session-leader process makes the script's /proc identity
    // checks (including the [ -r ] probe) run against a genuine stat.
    const sleeper = spawn("setsid", ["sleep", "120"], { stdio: "ignore" });
    const pid = sleeper.pid;
    if (pid === undefined) throw new Error("sleeper failed to start");
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const pidStarttime = execFileSync("awk", ["{print $22}", `/proc/${pid}/stat`], {
      encoding: "utf8",
    }).trim();
    writeFileSync(join(jobDir, "status"), "RUNNING\n");
    writeFileSync(join(jobDir, "pid"), `${pid}\n`);
    writeFileSync(join(jobDir, "boot_id"), `${bootId}\n`);
    writeFileSync(join(jobDir, "pid_starttime"), `${pidStarttime}\n`);
    writeFileSync(join(jobDir, "stdout.part"), "partial\n");
    writeFileSync(join(jobDir, "stderr.part"), "");
    const signalsPath = join(jobRoot, "signals");
    const flag = (value: boolean | undefined) => (value ? "1" : "0");
    const prelude = [
      "signalled=0", "gone=0", "leader_gone=0",
      "awk() {",
      `  if [ "\${@: -1}" = "/proc/${pid}/stat" ] && [ "$signalled" = 1 ] && [ ${flag(options.reuseAfterTerm)} = 1 ] && [ "$1" = '{print $22}' ]; then`,
      "    printf '111111\\n'",
      "    return",
      "  fi",
      '  command awk "$@"',
      "}",
      "ps() {",
      '  case "$*" in',
      `    *stat=*) if [ "$signalled" = 1 ] && [ -n '${options.zombieStates ?? ""}' ]; then printf '${options.zombieStates ?? ""}\\n';`,
      `      elif [ "$leader_gone" = 1 ] && [ -n '${options.afterKillStates ?? ""}' ]; then printf '${options.afterKillStates ?? ""}\\n';`,
      '      elif [ "$gone" = 0 ]; then printf \'S\\n\'; fi ;;',
      '    *) command ps "$@" ;;',
      "  esac", "}",
      "kill() {",
      '  if [ "$1" = "-0" ]; then [ "$gone" = 0 ]; return; fi',
      `  printf '%s\\n' "$1" >> '${signalsPath}'`,
      `  if [ ${flag(options.signalDenied)} = 1 ]; then return 1; fi`,
      "  signalled=1",
      '  if [ "$1" = "-KILL" ]; then',
      `    if [ ${flag(options.lingersAfterKill)} = 1 ]; then leader_gone=1; else gone=1; fi`,
      "    return 0",
      "  fi",
      `  if [ "$1" = "-TERM" ] && [ ${flag(options.termSurvives)} = 0 ]; then gone=1; fi`,
      "  return 0",
      "}",
      "sleep() { :; }",
    ].join("\n");
    const execute = promisify(execFile);
    const runRemote = async (cmd: string) => {
      try {
        const { stdout, stderr } = await execute("bash", ["-c", `${prelude}\n${cmd}`], {
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
        };
      }
    };
    const provider = new InstaboxProvider({
      apiKey: "test-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      jobRoot,
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          const body = JSON.parse(String(init?.body)) as { cmd: string };
          return jsonResponse(await runRemote(body.cmd));
        }
        return jsonResponse(machineResponse());
      },
    });
    let error: Error | undefined;
    try {
      await provider.cancel(taskId);
    } catch (caught) {
      error = caught as Error;
    }
    const readOr = (path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    };
    const signals = readOr(signalsPath);
    const status = readOr(join(jobDir, "status")).trim();
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Sleeper already gone.
    }
    rmSync(jobRoot, { recursive: true, force: true });
    return { error, signals, status };
  }

  it.skipIf(process.platform === "win32")("confirms cancellation only after the group is gone", async () => {
    const result = await runCancelScenario({});
    expect(result.error).toBeUndefined();
    expect(result.signals).toBe("-TERM\n");
    expect(result.status).toBe("CANCELLED");
  });

  it.skipIf(process.platform === "win32")("escalates to KILL when TERM is ignored, then confirms", async () => {
    const result = await runCancelScenario({ termSurvives: true });
    expect(result.error).toBeUndefined();
    expect(result.signals).toBe("-TERM\n-KILL\n");
    expect(result.status).toBe("CANCELLED");
  });

  it.skipIf(process.platform === "win32")("does not claim cancellation when signals are denied", async () => {
    const result = await runCancelScenario({ signalDenied: true });
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain("INSTABOX_TASK_CANCEL_FAILED:CANCELLATION_UNCONFIRMED");
    expect(result.signals).toBe("-TERM\n");
    expect(result.status).toBe("RUNNING");
  });

  it.skipIf(process.platform === "win32")("does not claim cancellation while group members linger after KILL", async () => {
    const result = await runCancelScenario({ termSurvives: true, lingersAfterKill: true });
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain("INSTABOX_TASK_CANCEL_FAILED:CANCELLATION_UNCONFIRMED");
    expect(result.signals).toBe("-TERM\n-KILL\n");
    expect(result.status).toBe("RUNNING");
  });

  it.skipIf(process.platform === "win32")("does not report LOST when the job published its terminal status during inspect", async () => {
    // Race: inspect reads status=RUNNING, the worker then publishes its
    // terminal status and exits, so the identity probe sees a missing
    // process and would report LOST for a job that actually completed.
    // A cat fake serves RUNNING for the first status read and COMPLETED
    // for any later one; the referenced process is already dead.
    const jobRoot = mkdtempSync(join(tmpdir(), "instabox-inspect-race-"));
    const raceTaskId = "INSTABOX-inspect-race";
    const jobDir = join(jobRoot, raceTaskId);
    mkdirSync(jobDir, { recursive: true });
    const sleeper = spawn("setsid", ["sleep", "120"], { stdio: "ignore" });
    const pid = sleeper.pid;
    if (pid === undefined) throw new Error("sleeper failed to start");
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const pidStarttime = execFileSync("awk", ["{print $22}", `/proc/${pid}/stat`], {
      encoding: "utf8",
    }).trim();
    writeFileSync(join(jobDir, "status"), "RUNNING\n");
    writeFileSync(join(jobDir, "pid"), `${pid}\n`);
    writeFileSync(join(jobDir, "boot_id"), `${bootId}\n`);
    writeFileSync(join(jobDir, "pid_starttime"), `${pidStarttime}\n`);
    writeFileSync(join(jobDir, "exit"), "0\n");
    writeFileSync(join(jobDir, "started_at"), "2026-10-22T01:02:03Z\n");
    writeFileSync(join(jobDir, "finished_at"), "2026-10-22T01:02:04Z\n");
    writeFileSync(join(jobDir, "command.sha256"), `${"a".repeat(64)}\n`);
    writeFileSync(join(jobDir, "stdout"), "finished output\n");
    writeFileSync(join(jobDir, "stderr"), "");
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const statusPath = join(jobDir, "status");
    const countPath = join(jobRoot, "status-reads");
    const prelude = [
      "cat() {",
      `  if [ "\${@: -1}" = '${statusPath}' ]; then`,
      // The counter must live in a file: read_file runs cat inside a
      // command substitution, whose subshell would discard a variable.
      `    reads=$(command cat '${countPath}' 2>/dev/null || printf '0')`,
      "    reads=$((reads + 1))",
      `    printf '%s' "$reads" > '${countPath}'`,
      '    if [ "$reads" -le 1 ]; then printf \'RUNNING\\n\'; else printf \'COMPLETED\\n\'; fi',
      "    return",
      "  fi",
      '  command cat "$@"',
      "}",
    ].join("\n");
    const execute = promisify(execFile);
    const runRemote = async (cmd: string) => {
      try {
        const { stdout, stderr } = await execute("bash", ["-c", `${prelude}\n${cmd}`], {
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
        };
      }
    };
    const provider = new InstaboxProvider({
      apiKey: "test-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      jobRoot,
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          const body = JSON.parse(String(init?.body)) as { cmd: string };
          return jsonResponse(await runRemote(body.cmd));
        }
        return jsonResponse(machineResponse());
      },
    });
    try {
      const task = await provider.inspect(raceTaskId);
      expect(task.status).toBe("completed");
      expect(task.error).toBeUndefined();
    } finally {
      rmSync(jobRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("treats a job directory without a committed status as not found", async () => {
    // Crash during start, before the commit point: the directory holds a
    // partial manifest but no status file. The job never started, so
    // recovery must see a lookup miss — not an invalid job that would
    // poison deterministic recovery into a false KEY_REUSE/uncertain.
    const jobRoot = mkdtempSync(join(tmpdir(), "instabox-uncommitted-"));
    const uncommittedId = "INSTABOX-uncommitted";
    const jobDir = join(jobRoot, uncommittedId);
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, "command.sha256"), `${"a".repeat(64)}\n`);
    writeFileSync(join(jobDir, "idempotency.key"), "retry-key\n");
    const execute = promisify(execFile);
    const runRemote = async (cmd: string) => {
      try {
        const { stdout, stderr } = await execute("bash", ["-c", cmd], {
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
        };
      }
    };
    let startCommand = "";
    const provider = new InstaboxProvider({
      apiKey: "test-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      jobRoot,
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          const body = JSON.parse(String(init?.body)) as { cmd: string };
          if (body.cmd.includes("# INSTABOX_JOB_START")) startCommand = body.cmd;
          return jsonResponse(await runRemote(body.cmd));
        }
        return jsonResponse(machineResponse());
      },
    });
    try {
      await expect(provider.inspect(uncommittedId))
        .rejects.toThrow(`INSTABOX_TASK_NOT_FOUND:${uncommittedId}`);
      // The same deterministic id can then be dispatched for real: the
      // uncommitted directory does not block or corrupt the retry.
      const dispatched = await provider.dispatch({
        goal: "retry after start crash",
        nodeIds: ["node-instabox"],
        command: "echo recovered",
        taskId: uncommittedId,
        idempotencyKey: "retry-key",
        dispatchFingerprint: "fingerprint-1",
      });
      expect(dispatched.status).toBe("running");
      // Manifest files are published before the status commit point.
      expect(startCommand.indexOf("idempotency.key"))
        .toBeLessThan(startCommand.indexOf('status" STARTING'));
      expect(startCommand.indexOf("request.sha256"))
        .toBeLessThan(startCommand.indexOf('status" STARTING'));
      let task = dispatched;
      for (let attempt = 0; attempt < 100 && task.status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        task = await provider.inspect(uncommittedId);
      }
      expect(task.status).toBe("completed");
    } finally {
      rmSync(jobRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("fails an aged workerless STARTING job instead of reporting it running forever", async () => {
    const jobRoot = mkdtempSync(join(tmpdir(), "instabox-orphan-"));
    const orphanId = "INSTABOX-orphan-start";
    const jobDir = join(jobRoot, orphanId);
    mkdirSync(jobDir, { recursive: true });
    const aged = new Date(Date.now() - 10 * 60_000).toISOString();
    writeFileSync(join(jobDir, "status"), "STARTING\n");
    writeFileSync(join(jobDir, "started_at"), `${aged}\n`);
    writeFileSync(join(jobDir, "command.sha256"), `${"a".repeat(64)}\n`);
    writeFileSync(join(jobDir, "idempotency.key"), "retry-key\n");
    writeFileSync(join(jobDir, "request.sha256"), `${"b".repeat(64)}\n`);
    const execute = promisify(execFile);
    const runRemote = async (cmd: string) => {
      try {
        const { stdout, stderr } = await execute("bash", ["-c", cmd], {
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
        };
      }
    };
    const provider = new InstaboxProvider({
      apiKey: "test-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      jobRoot,
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          const body = JSON.parse(String(init?.body)) as { cmd: string };
          return jsonResponse(await runRemote(body.cmd));
        }
        return jsonResponse(machineResponse());
      },
    });
    try {
      const task = await provider.inspect(orphanId);
      expect(task.status).toBe("failed");
      expect(task.error).toContain("INSTABOX_TASK_LOST:starting_without_worker");
    } finally {
      rmSync(jobRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("keeps a fresh workerless STARTING job running while its start is in flight", async () => {
    const jobRoot = mkdtempSync(join(tmpdir(), "instabox-fresh-start-"));
    const freshId = "INSTABOX-fresh-start";
    const jobDir = join(jobRoot, freshId);
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, "status"), "STARTING\n");
    writeFileSync(join(jobDir, "started_at"), `${new Date().toISOString()}\n`);
    writeFileSync(join(jobDir, "command.sha256"), `${"a".repeat(64)}\n`);
    const execute = promisify(execFile);
    const runRemote = async (cmd: string) => {
      try {
        const { stdout, stderr } = await execute("bash", ["-c", cmd], {
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
        };
      }
    };
    const provider = new InstaboxProvider({
      apiKey: "test-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      jobRoot,
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          const body = JSON.parse(String(init?.body)) as { cmd: string };
          return jsonResponse(await runRemote(body.cmd));
        }
        return jsonResponse(machineResponse());
      },
    });
    try {
      const task = await provider.inspect(freshId);
      expect(task.status).toBe("running");
      expect(task.error).toBeUndefined();
    } finally {
      rmSync(jobRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("cancels a genuinely running job and confirms its group is gone", async () => {
    const jobRoot = mkdtempSync(join(tmpdir(), "instabox-cancel-real-"));
    const execute = promisify(execFile);
    const runRemote = async (cmd: string) => {
      try {
        const { stdout, stderr } = await execute("bash", ["-c", cmd], {
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
        };
      }
    };
    const provider = new InstaboxProvider({
      apiKey: "test-key",
      machineName: "dsh-fusion-test",
      nodeId: "node-instabox",
      jobRoot,
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith("/exec")) {
          const body = JSON.parse(String(init?.body)) as { cmd: string };
          return jsonResponse(await runRemote(body.cmd));
        }
        return jsonResponse(machineResponse());
      },
    });
    try {
      const dispatched = await provider.dispatch({
        goal: "long job",
        nodeIds: ["node-instabox"],
        command: "sleep 60",
      });
      expect(dispatched.status).toBe("running");
      await provider.cancel(dispatched.id);
      const jobDir = join(jobRoot, dispatched.id);
      expect(readFileSync(join(jobDir, "status"), "utf8").trim()).toBe("CANCELLED");
      const inspected = await provider.inspect(dispatched.id);
      expect(inspected.status).toBe("cancelled");
    } finally {
      rmSync(jobRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("treats Z+ zombie group members as dead, not alive", async () => {
    const result = await runCancelScenario({ zombieStates: "Z+" });
    expect(result.error).toBeUndefined();
    expect(result.signals).toBe("-TERM\n");
    expect(result.status).toBe("CANCELLED");
  });

  it.skipIf(process.platform === "win32")("treats Z zombie group members as dead, not alive", async () => {
    const result = await runCancelScenario({ zombieStates: "Z" });
    expect(result.error).toBeUndefined();
    expect(result.signals).toBe("-TERM\n");
    expect(result.status).toBe("CANCELLED");
  });

  it.skipIf(process.platform === "win32")("still treats an S+ group member as alive after KILL", async () => {
    const result = await runCancelScenario({
      termSurvives: true,
      lingersAfterKill: true,
      afterKillStates: "S+",
    });
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain("INSTABOX_TASK_CANCEL_FAILED:CANCELLATION_UNCONFIRMED");
    expect(result.signals).toBe("-TERM\n-KILL\n");
    expect(result.status).toBe("RUNNING");
  });

  it.skipIf(process.platform === "win32")("never KILLs a group whose identity was reused after TERM", async () => {
    const result = await runCancelScenario({ termSurvives: true, reuseAfterTerm: true });
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain("INSTABOX_TASK_ALREADY_TERMINAL:LOST");
    expect(result.signals).toBe("-TERM\n");
    expect(result.status).toBe("RUNNING");
  });
});
