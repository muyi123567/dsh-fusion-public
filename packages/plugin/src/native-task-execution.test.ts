import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskRecord } from "@dsh-fusion/core";
import { createNativeTaskExecution, nativeExecutionReviewBytes } from "./native-task-execution.js";

const taskId = "dsh-native-team:s:17";
const time = "2026-11-20T12:00:00.000Z";
const command = "printf 'bounded job fixture'";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const reviewKey = generateKeyPairSync("ed25519");
const rotatedKey = generateKeyPairSync("ed25519");
const publicKey = (key: typeof reviewKey) => key.publicKey.export({ type: "spki", format: "pem" }).toString();
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "native-execution-test-"));
  directories.push(directory);
  let source: TaskRecord | undefined = {
    id: taskId, goal: "Authoritative subject", description: "Authoritative requirements", status: "claimed",
    targetNodeIds: [], evidence: [], transport: "dsh-fleet", createdAt: time, updatedAt: time,
    agentTeamTask: { teamId: "s", taskId: "17", revision: 2, ownerId: "owner", blockedBy: [], writeScopes: ["docs/"], ready: true },
  };
  let sourceUnavailable = false;
  let sourceReadCount = 0;
  const unavailableSourceReads = new Set<number>();
  let dispatchCount = 0;
  let observed: TaskRecord | undefined;
  let dispatchResponse: (() => TaskRecord) | undefined;
  let beforeInspect: (() => void) | undefined;
  let submitted: {
    goal: string;
    nodeIds: string[];
    command: string;
    idempotencyKey: string;
    executionWorkspace?: { id: string; sourceRevision: string; sourceDigest: string };
    executionMaterialsDigest?: string;
  } | undefined;
  const inspections: Array<[string, string]> = [];
  const options = {
    directory, jobs: [{ id: "checks", label: "Read-only checks", command, nodeIds: ["node-a", "node-b"] }],
    reviewerKeys: { reviewer: publicKey(reviewKey), owner: publicKey(rotatedKey) },
    readTask: async () => {
      sourceReadCount += 1;
      if (sourceUnavailable || unavailableSourceReads.has(sourceReadCount)) throw new Error("provider unavailable");
      return source;
    },
    taskIdFor: (node: string, key: string) => `${node}-${sha(key).slice(0, 24)}`,
    dispatch: async (input: NonNullable<typeof submitted>) => {
      dispatchCount += 1;
      submitted = input;
      if (dispatchResponse) return dispatchResponse();
      throw new Error("worker response unavailable");
    },
    inspect: async (node: string, workerId: string) => {
      inspections.push([node, workerId]);
      beforeInspect?.();
      if (!observed) throw new Error("worker not found");
      return observed;
    },
    now: () => new Date(time),
  };
  const service = createNativeTaskExecution(options);
  const { sourceToken } = await service.read(taskId);
  const request = { taskId, sourceToken: sourceToken!, jobId: "checks", nodeId: "node-a", requestId: "request-1" };

  const observedWorker = (status: TaskRecord["status"] = "completed"): TaskRecord => {
    if (!submitted) throw new Error("fixture has no dispatch");
    const nodeId = submitted.nodeIds[0]!;
    const id = options.taskIdFor(nodeId, submitted.idempotencyKey);
    return {
      id, goal: submitted.goal, targetNodeIds: [nodeId], status, transport: "ssh",
      evidence: [{ kind: "log", label: "private-log", value: "do not persist contents" }],
      createdAt: time, updatedAt: time, idempotencyKey: submitted.idempotencyKey,
      dispatchFingerprint: sha(JSON.stringify({
        command,
        ...(submitted.executionWorkspace === undefined ? {} : { executionWorkspace: submitted.executionWorkspace }),
        ...(submitted.executionMaterialsDigest === undefined ? {} : { executionMaterialsDigest: submitted.executionMaterialsDigest }),
        goal: submitted.goal, nodeIds: [nodeId],
      })),
      executionObservation: {
        taskId: id, nodeId, commandSha256: sha(command), startedAt: time, finishedAt: time, exitCode: 0,
        stdout: { bytes: 10, sha256: sha("0123456789") }, stderr: { bytes: 0, sha256: sha("") },
      },
    };
  };

  return {
    directory, service, options, request, observedWorker, inspections,
    get dispatchCount() { return dispatchCount; },
    get sourceReadCount() { return sourceReadCount; },
    get submitted() { return submitted; },
    set observed(worker: TaskRecord | undefined) { observed = worker; },
    set dispatchResponse(response: () => TaskRecord) { dispatchResponse = response; },
    set beforeInspect(hook: () => void) { beforeInspect = hook; },
    set sourceUnavailable(value: boolean) { sourceUnavailable = value; },
    failSourceReadAt(readNumber: number) { unavailableSourceReads.add(readNumber); },
    set source(value: TaskRecord | undefined) { source = value; },
    get source() { return source; },
  };
}

function signed(payload: Parameters<typeof nativeExecutionReviewBytes>[0], key = reviewKey) {
  // Independently build the format expected by external signers.
  const bytes = Buffer.from(JSON.stringify([
    "dsh-native-execution-review/v1", payload.taskId, payload.attemptId, payload.receiptSha256,
    payload.reviewerId, payload.verdict, payload.summary,
  ]));
  expect(nativeExecutionReviewBytes(payload)).toEqual(bytes);
  return { ...payload, signature: sign(null, bytes, key.privateKey).toString("base64") };
}

describe("native execution", () => {
  const materialPins = {
    code: { path: "src/revision.txt", digest: sha("code-v1") },
    input: { path: "inputs/fixture.json", digest: sha("input-v1") },
    runtime: { path: "runtime/identity.json", digest: sha("runtime-v1"), evidence: "measured" as const },
    config: { path: "config/checks.json", digest: sha("config-v1") },
    artifacts: [{ path: "dist/result.bin", digest: sha("artifact-v1"), bytes: 11 }],
  };

  function materialManifest(attemptId: string, sourceToken: string, overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      workspace: { id: attemptId, path: `/var/lib/dsh-fusion/workspaces/${attemptId}` },
      source: { revision: "2", digest: sourceToken },
      code: materialPins.code,
      input: materialPins.input,
      runtime: materialPins.runtime,
      config: materialPins.config,
      artifacts: materialPins.artifacts,
      ...overrides,
    };
  }

  async function rewriteStoredAttempt(directory: string, mutate: (entry: Record<string, unknown>) => void) {
    const database = new DatabaseSync(join(directory, `${sha(taskId)}.sqlite`));
    try {
      const row = database.prepare("SELECT payload FROM execution WHERE singleton = 1").get() as { payload: string };
      const payload = JSON.parse(row.payload) as Array<Record<string, unknown>>;
      mutate(payload[0]!);
      database.prepare("UPDATE execution SET payload = ? WHERE singleton = 1").run(JSON.stringify(payload));
    } finally {
      database.close();
    }
  }

  function receiptV1Digest(receipt: Record<string, any>): string {
    return sha(JSON.stringify([
      "dsh-native-execution-receipt/v1", receipt.taskId, receipt.sourceToken, receipt.attemptId,
      receipt.jobId, receipt.nodeId, receipt.workerTaskId, `native-execution:${receipt.attemptId}`,
      receipt.commandSha256, receipt.dispatchFingerprint, receipt.startedAt, receipt.finishedAt,
      receipt.exitCode, receipt.stdout.sha256, receipt.stdout.bytes, receipt.stderr.sha256, receipt.stderr.bytes,
    ]));
  }

  it("issues a v2 receipt only when configured pins match adapter-observed worker materials", async () => {
    const f = await fixture();
    const service = createNativeTaskExecution({
      ...f.options,
      jobs: [{ ...f.options.jobs[0]!, requireMaterials: true, expectedMaterials: materialPins }],
      verifyMaterials: async input => materialManifest(input.attemptId, input.expected.source.digest) as never,
    });
    const attempt = await service.start(f.request);
    f.observed = f.observedWorker();
    const read = await service.read(taskId);
    expect(read.attempts[0]).toMatchObject({
      id: attempt.id,
      executionState: "exited",
      receipt: {
        materials: {
          expected: {
            source: { revision: "2", digest: f.request.sourceToken },
            code: materialPins.code, input: materialPins.input, runtime: materialPins.runtime,
            config: materialPins.config, artifacts: materialPins.artifacts,
          },
          observed: {
            workspace: { id: attempt.id, path: `/var/lib/dsh-fusion/workspaces/${attempt.id}` },
            artifacts: [{ path: "dist/result.bin", digest: sha("artifact-v1"), bytes: 11 }],
          },
        },
      },
    });
    expect(read.attempts[0]!.receipt!.sha256).toMatch(/^[a-f0-9]{64}$/);
    const receiptSha256 = read.attempts[0]!.receipt!.sha256;
    const reviewPayload = {
      taskId, attemptId: attempt.id, receiptSha256, reviewerId: "reviewer",
      verdict: "passed" as const, summary: "Reviewed this exact pinned material manifest",
    };
    await service.review(signed(reviewPayload));

    const changedPins = { ...materialPins, code: { ...materialPins.code, digest: sha("next code") } };
    const changedPolicy = createNativeTaskExecution({
      ...f.options,
      jobs: [{ ...f.options.jobs[0]!, requireMaterials: true, expectedMaterials: changedPins }],
      verifyMaterials: async input => materialManifest(input.attemptId, input.expected.source.digest) as never,
    });
    expect((await changedPolicy.read(taskId)).attempts[0]).toMatchObject({
      executionState: "exited", review: { state: "stale", verdict: "passed" },
    });
  });

  it("keeps material expectations immutable across configuration changes and restart", async () => {
    const f = await fixture();
    const first = createNativeTaskExecution({
      ...f.options,
      jobs: [{ ...f.options.jobs[0]!, requireMaterials: true, expectedMaterials: materialPins }],
      verifyMaterials: async input => materialManifest(input.attemptId, input.expected.source.digest) as never,
    });
    const started = await first.start(f.request);
    expect(f.submitted?.executionWorkspace).toEqual({
      id: started.id, sourceRevision: "2", sourceDigest: f.request.sourceToken,
    });
    f.observed = f.observedWorker();
    const changedPins = { ...materialPins, code: { ...materialPins.code, digest: sha("new configured code") } };
    const restarted = createNativeTaskExecution({
      ...f.options,
      jobs: [{ ...f.options.jobs[0]!, requireMaterials: true, expectedMaterials: changedPins }],
      verifyMaterials: async input => materialManifest(input.attemptId, input.expected.source.digest) as never,
    });
    const read = await restarted.read(taskId);
    expect(read.attempts[0]).toMatchObject({
      id: started.id,
      executionState: "exited",
      receipt: { materials: { expected: { code: materialPins.code } } },
    });
  });

  it("rejects material receipts on ordinary attempts and missing materials on required attempts", async () => {
    const ordinary = await fixture();
    const materialService = createNativeTaskExecution({
      ...ordinary.options,
      jobs: [{ ...ordinary.options.jobs[0]!, requireMaterials: true, expectedMaterials: materialPins }],
      verifyMaterials: async input => materialManifest(input.attemptId, input.expected.source.digest) as never,
    });
    await materialService.start(ordinary.request);
    ordinary.observed = ordinary.observedWorker();
    await materialService.read(taskId);
    await rewriteStoredAttempt(ordinary.directory, entry => {
      delete entry.materialsRequired;
      delete entry.expectedSourceRevision;
      delete entry.expectedMaterials;
    });
    await expect(ordinary.service.read(taskId)).rejects.toMatchObject({ code: "store-unavailable" });

    const required = await fixture();
    const requiredService = createNativeTaskExecution({
      ...required.options,
      jobs: [{ ...required.options.jobs[0]!, requireMaterials: true, expectedMaterials: materialPins }],
      verifyMaterials: async input => materialManifest(input.attemptId, input.expected.source.digest) as never,
    });
    await requiredService.start(required.request);
    required.observed = required.observedWorker();
    await requiredService.read(taskId);
    await rewriteStoredAttempt(required.directory, entry => {
      const receipt = entry.receipt as Record<string, any>;
      delete receipt.materials;
      receipt.sha256 = receiptV1Digest(receipt);
    });
    await expect(required.service.read(taskId)).rejects.toMatchObject({ code: "store-unavailable" });
  });

  it("keeps required-material attempts unconfirmed without an adapter verifier or when observed pins differ", async () => {
    const f = await fixture();
    const configuredJob = { ...f.options.jobs[0]!, requireMaterials: true, expectedMaterials: materialPins };
    const noVerifier = createNativeTaskExecution({ ...f.options, jobs: [configuredJob] });
    await expect(noVerifier.start(f.request)).rejects.toMatchObject({ code: "job-unavailable" });

    const mismatched = createNativeTaskExecution({
      ...f.options,
      jobs: [configuredJob],
      verifyMaterials: async input => materialManifest(input.attemptId, input.expected.source.digest, {
      code: { ...materialPins.code, digest: sha("changed-code") },
      }) as never,
    });
    await mismatched.start(f.request);
    f.observed = f.observedWorker();
    expect((await mismatched.read(taskId)).attempts[0]).toMatchObject({ executionState: "unconfirmed" });
  });

  it("does not dispatch a material job when runtime identity is only declared", async () => {
    const f = await fixture();
    const declaredPins = { ...materialPins, runtime: { ...materialPins.runtime, evidence: "declared" as const } };
    const service = createNativeTaskExecution({
      ...f.options,
      jobs: [{ ...f.options.jobs[0]!, requireMaterials: true, expectedMaterials: declaredPins }],
      verifyMaterials: async input => materialManifest(input.attemptId, input.expected.source.digest, {
        runtime: declaredPins.runtime,
      }) as never,
    });
    await expect(service.start(f.request)).rejects.toMatchObject({ code: "job-unavailable" });
    expect(f.dispatchCount).toBe(0);
  });

  it("commits one multi-instance intent and recovers through the exact provider after an ambiguous dispatch", async () => {
    const f = await fixture();
    const [first, duplicate] = await Promise.all([f.service.start(f.request), createNativeTaskExecution(f.options).start(f.request)]);
    expect(first).toMatchObject({ sourceState: "current", executionState: "unconfirmed", nodeId: "node-a" });
    expect(duplicate.id).toBe(first.id);
    expect(f.dispatchCount).toBe(1);
    await expect(f.service.start({ ...f.request, requestId: "new-uuid" })).rejects.toMatchObject({ code: "attempt-conflict" });
    await expect(f.service.start({ ...f.request, nodeId: "node-b" })).rejects.toMatchObject({ code: "attempt-conflict" });
    expect(f.inspections).toEqual([["node-a", first.workerTaskId], ["node-a", first.workerTaskId]]);
    f.observed = f.observedWorker();
    const restarted = createNativeTaskExecution(f.options);
    const [attempt] = (await restarted.read(taskId)).attempts;
    expect(attempt).toMatchObject({ id: first.id, executionState: "exited", receipt: { attemptId: first.id, workerTaskId: first.workerTaskId, exitCode: 0, commandSha256: sha(command) } });
    expect(attempt!.receipt!.sha256).toMatch(/^[a-f0-9]{64}$/);
    await restarted.start(f.request);
    expect(f.dispatchCount).toBe(1);
    for (const file of await readdir(f.directory)) {
      const contents = (await readFile(join(f.directory, file))).toString("utf8");
      expect(contents).not.toContain(command);
      expect(contents).not.toContain("Authoritative requirements");
      expect(contents).not.toContain("do not persist contents");
    }
  });

  it("retries only a reserved attempt after a transient pre-dispatch source read failure", async () => {
    const f = await fixture();
    // The start preflight is the next read; fail the source recheck after the durable reservation.
    f.failSourceReadAt(f.sourceReadCount + 2);
    const reserved = await f.service.start(f.request);
    expect(reserved).toMatchObject({ sourceState: "unavailable", executionState: "unconfirmed" });
    expect(f.dispatchCount).toBe(0);

    const recovered = await f.service.start(f.request);
    expect(recovered).toMatchObject({ id: reserved.id, sourceState: "current", executionState: "unconfirmed" });
    expect(f.dispatchCount).toBe(1);
    expect(f.submitted?.idempotencyKey).toBe(`native-execution:${reserved.id}`);
    expect(f.options.taskIdFor("node-a", f.submitted!.idempotencyKey)).toBe(reserved.workerTaskId);

    const running = f.observedWorker("running");
    f.observed = running;
    const runningRead = await f.service.start(f.request);
    expect(runningRead).toMatchObject({ id: reserved.id, executionState: "running" });
    expect(f.dispatchCount).toBe(1);

    f.observed = f.observedWorker();
    expect(await f.service.start(f.request)).toMatchObject({ id: reserved.id, executionState: "exited" });
    expect(f.dispatchCount).toBe(1);
  });

  it.each([
    ["foreign record", (t: TaskRecord) => { t.id = "foreign-worker"; }],
    ["foreign node", (t: TaskRecord) => { t.executionObservation!.nodeId = "node-b"; }],
    ["multi-node record", (t: TaskRecord) => { t.targetNodeIds.push("node-b"); }],
    ["missing idempotency key", (t: TaskRecord) => { delete t.idempotencyKey; }],
    ["foreign fingerprint", (t: TaskRecord) => { t.dispatchFingerprint = sha("foreign payload"); }],
    ["wrong command", (t: TaskRecord) => { t.executionObservation!.commandSha256 = sha("other command"); }],
    ["unknown exit fact", (t: TaskRecord) => { t.executionObservation!.exitCode = Number.NaN; }],
    ["nonterminal record", (t: TaskRecord) => { t.status = "running"; }],
    ["truncated stream hash", (t: TaskRecord) => { t.executionObservation!.stdout.sha256 = "a"; }],
    ["invalid timestamp", (t: TaskRecord) => { t.executionObservation!.finishedAt = "2026-02-31T12:00:00Z"; }],
    ["inconsistent empty stream", (t: TaskRecord) => { t.executionObservation!.stderr.sha256 = sha("missing bytes"); }],
  ])("does not issue a receipt for %s", async (_label, mutate) => {
    const f = await fixture();
    await f.service.start(f.request);
    const worker = f.observedWorker();
    mutate(worker);
    f.observed = worker;
    expect((await f.service.read(taskId)).attempts[0]!.receipt).toBeUndefined();
  });

  it("requires a provider inspection even when the dispatch response looks terminal", async () => {
    const f = await fixture();
    f.dispatchResponse = f.observedWorker;
    const record = await f.service.start(f.request);
    expect(record).toMatchObject({ nodeId: "node-a", executionState: "unconfirmed" });
    expect(record.receipt).toBeUndefined();
  });

  it("does not dispatch a completed authoritative task even when its projection is marked ready", async () => {
    const f = await fixture();
    f.source = { ...f.source!, status: "completed" };
    const { sourceToken } = await f.service.read(taskId);
    expect(sourceToken).toBeDefined();
    await expect(f.service.start({ ...f.request, sourceToken: sourceToken! }))
      .rejects.toMatchObject({ code: "job-unavailable" });
    expect(f.dispatchCount).toBe(0);
  });

  it("rechecks the task after a slow inspection before exposing a version and receipt as current", async () => {
    const f = await fixture();
    await f.service.start(f.request);
    f.observed = f.observedWorker();
    const source = f.source!;
    f.beforeInspect = () => {
      f.source = { ...source, agentTeamTask: { ...source.agentTeamTask!, revision: 3 } };
    };
    const panel = await f.service.read(taskId);
    expect(panel.sourceRevision).toBe(3);
    expect(panel.attempts[0]).toMatchObject({ sourceState: "stale", executionState: "unconfirmed" });
    expect(panel.attempts[0]?.receipt).toBeUndefined();
  });

  it("verifies a signed independent verdict and marks it stale when the requirement, receipt, or trust changes", async () => {
    const f = await fixture();
    const first = await f.service.start(f.request);
    f.observed = f.observedWorker();
    const [attempt] = (await f.service.read(taskId)).attempts;
    const receiptSha256 = attempt!.receipt!.sha256;
    const base = { taskId, attemptId: first.id, receiptSha256, reviewerId: "reviewer", verdict: "passed" as const, summary: "Compared the job result with the requirement" };
    const review = signed(base);
    await expect(f.service.review({ ...review, verdict: "failed" })).rejects.toMatchObject({ code: "review-invalid" });
    await expect(f.service.review(signed({ ...base, reviewerId: "owner" }, rotatedKey))).rejects.toMatchObject({ code: "review-untrusted" });
    await expect(f.service.review(review)).resolves.toMatchObject({ review: { state: "current", verdict: "passed", reviewerId: "reviewer", receiptSha256 } });
    const rotated = createNativeTaskExecution({ ...f.options, reviewerKeys: { reviewer: publicKey(rotatedKey) } });
    expect((await rotated.read(taskId)).attempts[0]!.review?.state).toBe("stale");
    await expect(rotated.review(signed(base, rotatedKey))).rejects.toMatchObject({ code: "attempt-conflict" });
    const original = f.source!;
    f.source = { ...original, description: "changed without incrementing the revision" };
    expect((await f.service.read(taskId)).attempts[0]).toMatchObject({ sourceState: "stale", review: { state: "stale" } });
    await expect(f.service.start(f.request)).rejects.toMatchObject({ code: "source-stale" });
    f.source = original;
    const changed = f.observedWorker();
    changed.executionObservation!.stdout.sha256 = sha("abcdefghij");
    f.observed = changed;
    expect((await f.service.read(taskId)).attempts[0]).toMatchObject({ executionState: "unconfirmed", review: { state: "stale" } });
    await expect(f.service.review(review)).rejects.toMatchObject({ code: "receipt-unavailable" });
  });

  it("marks a signed review stale when its execution node is removed from the job allowlist", async () => {
    const f = await fixture();
    const started = await f.service.start(f.request);
    f.observed = f.observedWorker();
    const [attempt] = (await f.service.read(taskId)).attempts;
    await f.service.review(signed({
      taskId, attemptId: started.id, receiptSha256: attempt!.receipt!.sha256, reviewerId: "reviewer",
      verdict: "passed", summary: "Reviewed the exact worker result",
    }));

    const revokedNode = createNativeTaskExecution({
      ...f.options,
      jobs: [{ ...f.options.jobs[0]!, nodeIds: ["node-b"] }],
    });
    expect((await revokedNode.read(taskId)).attempts[0]).toMatchObject({
      nodeId: "node-a", executionState: "exited", review: { state: "stale", verdict: "passed" },
    });
  });

  it("distinguishes absent and unavailable authoritative tasks and rejects corrupt persisted state", async () => {
    const f = await fixture();
    await f.service.start(f.request);
    f.source = undefined;
    expect(await f.service.read(taskId)).toMatchObject({ taskAvailable: false, attempts: [{ sourceState: "stale" }] });
    await expect(f.service.start(f.request)).rejects.toMatchObject({ code: "task-missing" });
    f.sourceUnavailable = true;
    expect(await f.service.read(taskId)).toMatchObject({ taskAvailable: false, sourceUnavailable: true, attempts: [{ sourceState: "unavailable" }] });
    await expect(f.service.start(f.request)).rejects.toMatchObject({ code: "source-unavailable" });
    const files = await readdir(f.directory);
    expect(files).toHaveLength(1);
    await writeFile(join(f.directory, files[0]!), "damaged file");
    await expect(f.service.read(taskId)).rejects.toMatchObject({ code: "store-unavailable" });
  });
});
