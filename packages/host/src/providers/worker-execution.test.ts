import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { HuaweiSshProvider } from "./huawei-ssh-provider.js";
import { InstaboxProvider } from "./instabox-provider.js";
import { readWorkerExecutionObservation } from "./worker-execution.js";

const runBash = promisify(execFile);
const nodeId = "fixture-worker";
const command = String.raw`printf '\377\000\012\012'; exit 7`;

describe("worker reported material manifest", () => {
  const digest = "a".repeat(64);
  const baseManifest = {
    version: 1,
    workspace: { id: "attempt-1", path: "/var/lib/dsh-fusion/jobs/worker-1/workspace" },
    source: { revision: "7", digest },
    code: { path: "src/revision.txt", digest }, input: { path: "inputs/test.json", digest },
    runtime: { path: "runtime/identity.json", digest, evidence: "declared" },
    config: { path: "config/test.json", digest },
    artifacts: [{ path: "dist/out.bin", digest, bytes: 4 }],
  };

  function observation(manifestText?: string) {
    const lines = [
      "WORKER_TASK_ID=worker-1", "LOST_REASON=", "STATUS=COMPLETED", "EXIT=0",
      `COMMAND_SHA256=${digest}`, `CAPTURE_COMMAND_SHA256=${digest}`,
      "STARTED_AT=2026-11-20T12:00:00.000Z", "FINISHED_AT=2026-11-20T12:00:01.000Z",
      "STDOUT=", "STDOUT_TOTAL=0", "STDERR=", "STDERR_TOTAL=0",
    ];
    if (manifestText !== undefined) lines.push(`EXECUTION_MANIFEST_B64=${Buffer.from(manifestText).toString("base64")}`);
    return readWorkerExecutionObservation(lines.join("\n"), "worker-1", "node-1", 4096);
  }

  it("accepts only a bounded canonical v1 report while leaving it explicitly untrusted", () => {
    const canonical = JSON.stringify(baseManifest);
    expect(observation(canonical)).toMatchObject({ reportedMaterials: baseManifest });
    expect(observation(JSON.stringify({ ...baseManifest, unexpected: true }))).toBeUndefined();
    expect(observation(` ${canonical}`)).toBeUndefined();
    expect(observation(JSON.stringify({ ...baseManifest, workspace: { ...baseManifest.workspace, path: "/tmp/../outside" } }))).toBeUndefined();
    expect(observation(JSON.stringify({ ...baseManifest, artifacts: [{ ...baseManifest.artifacts[0], path: "../out.bin" }] }))).toBeUndefined();
  });
});

describe.each(["Huawei SSH", "Instabox"] as const)("%s", (providerKind) => {
  it.skipIf(process.platform === "win32")("observes only complete terminal worker bytes", async () => {
    const jobRoot = await mkdtemp(join(tmpdir(), "fusion-execution-observation-"));
    let adjustMetadata = (stdout: string) => stdout;
    const execute = async (script: string) => {
      try {
        const { stdout, stderr } = await runBash("bash", ["-c", script], { timeout: 10_000 });
        return { exitCode: 0, stdout: adjustMetadata(stdout), stderr };
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
        };
      }
    };
    const createProvider = () => providerKind === "Huawei SSH"
      ? new HuaweiSshProvider({ host: "fixture", keyPath: "unused", nodeId, jobRoot, run: execute })
      : new InstaboxProvider({
          apiKey: "fixture-key",
          machineName: "fixture",
          nodeId,
          jobRoot,
          fetch: async (url, init) => {
            if (new URL(String(url)).pathname.endsWith("/exec")) {
              const { cmd } = JSON.parse(String(init?.body)) as { cmd: string };
              return Response.json(await execute(cmd));
            }
            return Response.json({ id: "fixture", name: "fixture", state: "running", runtime: { ready: true } });
          },
        });

    try {
      const dispatched = await createProvider().dispatch({ goal: "byte fixture", nodeIds: [nodeId], command });
      expect(dispatched).not.toHaveProperty("executionObservation");
      const provider = createProvider();
      await expect.poll(async () => (await provider.inspect(dispatched.id)).status).toBe("failed");
      const task = await provider.inspect(dispatched.id);
      expect(task).toMatchObject({
        executionObservation: {
          taskId: dispatched.id,
          nodeId,
          commandSha256: "5739092bbb79aa6255baf8550f983849d7a2354a2c58d126ec0e3a80586867c3",
          startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
          finishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
          exitCode: 7,
          // The four stdout bytes contain invalid UTF-8, a NUL and two newlines.
          stdout: { sha256: "24d88ed1cc7553049067cca98826fc0c0adb66fec53ac14c0819d38f98db6a3a", bytes: 4 },
          stderr: { sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", bytes: 0 },
        },
      });
      expect(task.evidence).toContainEqual({ kind: "log", label: `${task.id}:stderr`, value: "(empty)" });

      for (const [field, invalid] of [
        // Both strings decode to the same bytes under Node's permissive base64 decoder.
        ["STDOUT", "/wAKCh=="],
        ["EXIT", "7e0"],
        ["EXIT", ""],
        ["STATUS", "CANCELLED"],
        ["STATUS", "COMPLETED"],
        ["LOST_REASON", "process_missing"],
        ["COMMAND_SHA256", "b".repeat(64)],
        ["STARTED_AT", "2026-02-30T00:00:00Z"],
        ["FINISHED_AT", "2020-01-01T00:00:00Z"],
      ] as const) {
        adjustMetadata = (stdout) => stdout.replace(new RegExp(`^${field}=.*$`, "mu"), `${field}=${invalid}`);
        const inspected = await provider.inspect(task.id);
        expect(inspected, `${field}=${invalid}`).not.toHaveProperty("executionObservation");
      }
      adjustMetadata = (stdout) => stdout;

      const job = join(jobRoot, task.id);
      await rename(join(job, "stderr"), join(job, "old-stderr"));
      await expect(provider.inspect(task.id)).resolves.not.toHaveProperty("executionObservation");
      await rename(join(job, "old-stderr"), join(job, "stderr"));
      await writeFile(join(job, "stdout.total"), "5\n");
      await expect(provider.inspect(task.id)).resolves.not.toHaveProperty("executionObservation");
      await writeFile(join(job, "stdout.total"), "4\n");
      await writeFile(join(job, "task_id"), "another-task\n");
      await expect(provider.inspect(task.id)).resolves.not.toHaveProperty("executionObservation");
    } finally {
      await rm(jobRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
