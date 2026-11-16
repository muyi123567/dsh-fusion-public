import { describe, expect, it, vi } from "vitest";
import type { ExecCapabilityObservation } from "@dsh-fusion/core";
import type { RuntimeNodeRecord, RuntimeTaskRecord } from "./plugin-runtime.js";
import { createDispatchFingerprint, FleetRouter, type RoutableFleetProvider } from "./fleet-router.js";

const checkedAt = 1_700_000_000_000;

function node(id: string, providerId: string): RuntimeNodeRecord {
  return {
    id,
    externalId: id,
    providerId,
    name: id,
    platform: "linux",
    roles: ["worker"],
    status: "online",
    transports: providerId === "instabox" ? ["dsh-fleet"] : ["ssh"],
    capabilities: ["linux"],
    configState: "unknown",
  };
}

function task(nodeId: string, status: RuntimeTaskRecord["status"], prefix: string): RuntimeTaskRecord {
  return {
    id: `${prefix}-${nodeId}`,
    goal: `check ${nodeId}`,
    targetNodeIds: [nodeId],
    transport: "ssh",
    status,
    progress: status === "completed" ? 100 : 50,
    evidence: [{ kind: "command", label: "probe", value: nodeId }],
    expectedEvidence: ["command"],
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
  };
}


function withExecutionReceipt(record: RuntimeTaskRecord): RuntimeTaskRecord {
  return {
    ...record,
    expectedEvidence: ["summary", "command", "log"],
    evidence: [
      { kind: "summary", label: record.id + ":summary",
        value: "status=" + record.status + "\nexit=" + (record.status === "completed" ? "0" : "pending") + "\ntaskId=" + record.id },
      { kind: "command", label: record.id + ":stdout", value: "(empty)" },
      { kind: "log", label: record.id + ":stderr", value: "(empty)" },
    ],
  };
}

function executionProvider(...args: Parameters<typeof provider>): RoutableFleetProvider {
  const original = provider(...args);
  return { ...original, async dispatch(input) {
    return withExecutionReceipt(await original.dispatch(input));
  } };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushAsyncHandlers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function provider(
  id: string,
  nodeId: string,
  prefix: string,
  calls: string[],
): RoutableFleetProvider {
  return {
    id,
    async health() {
      return { state: "connected", checkedAt };
    },
    async listNodes() {
      return [node(nodeId, id)];
    },
    async dispatch(input) {
      calls.push(`${id}:dispatch:${input.nodeIds.join(",")}`);
      return task(nodeId, "completed", prefix);
    },
    async doctor(selectedNodeId) {
      calls.push(`${id}:doctor:${selectedNodeId ?? "default"}`);
      return {
        node: node(nodeId, id),
        evidence: [{ kind: "command", label: "doctor", value: nodeId }],
      };
    },
    async cancel(taskId) {
      calls.push(`${id}:cancel:${taskId}`);
    },
  };
}

describe("FleetRouter", () => {
  it("rejects a second task while a host is at its concurrency limit", async () => {
    const firstDispatch = deferred<RuntimeTaskRecord>();
    const dispatch = vi.fn(() => firstDispatch.promise);
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("p1", "hw-1", "HUAWEI", []),
        dispatch,
      },
    }], {
      hostAccess: {
        "hw-1": {
          ownerId: "team-alpha",
          sharingMode: "dedicated",
          maxConcurrentTasks: 1,
        },
      },
    });

    const first = router.dispatch({ goal: "first", nodeIds: ["hw-1"], command: "date" });
    await flushMicrotasks();
    await expect(router.dispatch({
      goal: "second",
      nodeIds: ["hw-1"],
      command: "date",
    })).rejects.toThrow("FLEET_NODE_CONCURRENCY_LIMIT:hw-1:1");

    firstDispatch.resolve(task("hw-1", "running", "HUAWEI"));
    await expect(first).resolves.toMatchObject({ status: "running" });
    await expect(router.dispatch({
      goal: "third",
      nodeIds: ["hw-1"],
      command: "date",
    })).rejects.toThrow("FLEET_NODE_CONCURRENCY_LIMIT:hw-1:1");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("surfaces host ownership and quota on listed nodes", async () => {
    const router = new FleetRouter([
      { nodeIds: ["hw-1"], provider: provider("p1", "hw-1", "HUAWEI", []) },
    ], {
      hostAccess: {
        "hw-1": {
          ownerId: "team-alpha",
          sharingMode: "shared",
          maxConcurrentTasks: 3,
        },
      },
    });

    await expect(router.listNodes()).resolves.toEqual([
      expect.objectContaining({
        id: "hw-1",
        hostAccess: {
          ownerId: "team-alpha",
          sharingMode: "shared",
          maxConcurrentTasks: 3,
        },
      }),
    ]);
  });

  it("probes only explicit unique nodes and rejects unknown nodes before any probe", async () => {
    const probe = vi.fn(async () => ({ nodeId: "hw-1", providerId: "huawei-ssh", state: "supported" as const,
      checkedAt: Date.now(), expiresAt: Date.now() + 30_000, source: "fixture", reasonCodes: [], checks: [{ id: "bash", ok: true }] }));
    const dispatch = vi.fn();
    const router = new FleetRouter([{ nodeIds: ["hw-1"], provider: {
      ...provider("huawei-ssh", "hw-1", "HUAWEI", []), dispatch, probeExecCapability: probe,
    } }]);
    await expect(router.probeExecCapabilities(["hw-1", "unknown"])).rejects.toThrow("FLEET_NODE_UNKNOWN");
    expect(probe).not.toHaveBeenCalled();
    const observations = await router.probeExecCapabilities(["hw-1", "hw-1"]);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.state).toBe("supported");
    expect(probe).toHaveBeenCalledWith();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps missing, failed and wrong-identity capability sources unknown", async () => {
    const router = new FleetRouter([
      { nodeIds: ["hw-1"], provider: provider("p1", "hw-1", "HUAWEI", []) },
      { nodeIds: ["hw-2"], provider: { ...provider("p2", "hw-2", "HUAWEI", []),
        async probeExecCapability() { throw new Error("private remote failure"); } } },
      { nodeIds: ["hw-3"], provider: { ...provider("p3", "hw-3", "HUAWEI", []),
        async probeExecCapability() { return { nodeId: "other", providerId: "p3", state: "supported" as const,
          checkedAt: Date.now(), expiresAt: Date.now() + 30_000, source: "fixture", reasonCodes: [], checks: [] }; } } },
    ]);
    const observations = await router.probeExecCapabilities(["hw-1", "hw-2", "hw-3"]);
    expect(observations.map((entry) => entry.state)).toEqual(["unknown", "unknown", "unknown"]);
    expect(observations.map((entry) => entry.reasonCodes)).toEqual([
      ["EXEC_PROBE_UNAVAILABLE"], ["EXEC_PROBE_FAILED"], ["EXEC_PROBE_IDENTITY_MISMATCH"],
    ]);
    expect(JSON.stringify(observations)).not.toContain("private remote failure");
  });

  it.each([
    { checks: undefined }, { checks: [{ id: "bash", ok: "yes" }] },
    { reasonCodes: null }, { state: "not-a-state" },
  ])("keeps malformed capability observations unknown: %j", async (change) => {
    const router = new FleetRouter([{ nodeIds: ["hw-1"], provider: {
      ...provider("p1", "hw-1", "HUAWEI", []),
      async probeExecCapability() { return { nodeId: "hw-1", providerId: "p1", state: "supported",
        checkedAt: Date.now(), expiresAt: Date.now() + 30_000, source: "fixture",
        checks: [{ id: "bash", ok: true }], reasonCodes: [], ...change } as unknown as ExecCapabilityObservation; },
    } }]);
    expect(await router.probeExecCapabilities(["hw-1"])).toEqual([
      expect.objectContaining({ state: "unknown", reasonCodes: ["EXEC_PROBE_INVALID"] }),
    ]);
  });

  it("bounds capability probe concurrency and settles a never-resolving source", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const routes = Array.from({ length: 6 }, (_, index) => ({ nodeIds: [`hw-${index}`], provider: {
        ...provider(`p${index}`, `hw-${index}`, "HUAWEI", []),
        probeExecCapability() { calls.push(`hw-${index}`); return new Promise<never>(() => {}); },
      } }));
      const router = new FleetRouter(routes);
      const pending = router.probeExecCapabilities(routes.flatMap((route) => route.nodeIds));
      await flushMicrotasks();
      expect(calls).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(10_000);
      const observations = await pending;
      // Timed-out providers cannot be aborted by this interface. Do not reuse
      // their slots to start more calls which would exceed the physical bound.
      expect(calls).toHaveLength(4);
      expect(observations).toHaveLength(6);
      expect(observations.slice(0, 4).every((entry) => entry.reasonCodes.includes("EXEC_PROBE_TIMEOUT"))).toBe(true);
      expect(observations.slice(4).every((entry) => entry.reasonCodes.includes("EXEC_PROBE_BUSY"))).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("shares physical probes across requests, keeps hung slots after timeout and releases on settlement", async () => {
    vi.useFakeTimers();
    const physical = deferred<ExecCapabilityObservation>();
    const probe = vi.fn(() => physical.promise);
    const router = new FleetRouter([{ nodeIds: ["hw-1"], provider: {
      ...provider("p1", "hw-1", "HUAWEI", []), probeExecCapability: probe,
    } }]);
    const left = router.probeExecCapabilities(["hw-1"]);
    const right = router.probeExecCapabilities(["hw-1"]);
    try {
      await flushMicrotasks();
      expect(probe).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await left)[0]?.reasonCodes).toEqual(["EXEC_PROBE_TIMEOUT"]);
      expect((await right)[0]?.reasonCodes).toEqual(["EXEC_PROBE_TIMEOUT"]);
      const retry = router.probeExecCapabilities(["hw-1"]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await retry)[0]?.reasonCodes).toEqual(["EXEC_PROBE_TIMEOUT"]);
      expect(probe).toHaveBeenCalledTimes(1);
      physical.resolve({ nodeId: "hw-1", providerId: "p1", state: "supported", checkedAt: Date.now(),
        expiresAt: Date.now() + 30_000, source: "fixture", reasonCodes: [], checks: [{ id: "bash", ok: true }] });
      await flushMicrotasks();
      expect((await router.probeExecCapabilities(["hw-1"]))[0]?.state).toBe("supported");
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      physical.resolve({ nodeId: "hw-1", providerId: "p1", state: "unknown", checkedAt: Date.now(),
        expiresAt: Date.now() + 30_000, source: "fixture", reasonCodes: [], checks: [] });
      await Promise.all([left, right]);
      vi.useRealTimers();
    }
  });

  it("shares a global physical budget across different concurrent request selections", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const routes = Array.from({ length: 5 }, (_, index) => ({ nodeIds: [`hw-${index}`], provider: {
        ...provider(`p${index}`, `hw-${index}`, "HUAWEI", []),
        probeExecCapability() { calls.push(`hw-${index}`); return new Promise<never>(() => {}); },
      } }));
      const router = new FleetRouter(routes);
      const occupied = router.probeExecCapabilities(["hw-0", "hw-1", "hw-2", "hw-3"]);
      await flushMicrotasks();
      const overflow = router.probeExecCapabilities(["hw-4"]);
      await flushMicrotasks();
      expect(calls).toHaveLength(4);
      expect((await overflow)[0]?.reasonCodes).toEqual(["EXEC_PROBE_BUSY"]);
      await vi.advanceTimersByTimeAsync(5_000);
      await occupied;
      expect((await router.probeExecCapabilities(["hw-4"]))[0]?.reasonCodes).toEqual(["EXEC_PROBE_BUSY"]);
      expect(calls).toHaveLength(4);
    } finally { vi.useRealTimers(); }
  });

  it("keeps identical deferred dispatches coalesced until completion", async () => {
    const pending = deferred<RuntimeTaskRecord>();
    const dispatch = vi.fn(() => pending.promise);
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: { ...provider("huawei-ssh", "hw-1", "HUAWEI", []), dispatch },
    }]);
    const input = { goal: "probe", command: "date", nodeIds: ["hw-1"], idempotencyKey: "deferred-key" };
    const left = router.dispatch(input);
    const right = router.dispatch(input);
    const settled = vi.fn();
    void right.then(settled);
    await flushMicrotasks();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    pending.resolve(task("hw-1", "completed", "HUAWEI"));
    expect(await right).toEqual(await left);
  });

  it.each([
    { command: "uname -a" },
    { goal: "another goal" },
    { nodeIds: ["hw-2"] },
  ])("rejects conflicting deferred dispatch immediately: %j", async (change) => {
    const pending = deferred<RuntimeTaskRecord>();
    const dispatch = vi.fn(() => pending.promise);
    const router = new FleetRouter([{
      nodeIds: ["hw-1", "hw-2"],
      provider: { ...provider("huawei-ssh", "hw-1", "HUAWEI", []), dispatch },
    }]);
    const input = { goal: "probe", command: "date", nodeIds: ["hw-1"], idempotencyKey: "deferred-key" };
    const original = router.dispatch(input);
    const settled = vi.fn();
    const conflict = router.dispatch({ ...input, ...change }).then(
      () => settled("resolved"),
      (error: Error) => settled(error.message),
    );
    try {
      await flushMicrotasks();
      expect(settled).toHaveBeenCalledWith("FLEET_IDEMPOTENCY_KEY_REUSE:deferred-key");
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve(task("hw-1", "completed", "HUAWEI"));
      await Promise.all([original, conflict]);
    }
    expect(await router.dispatch(input)).toEqual(await original);
  });

  it.each([false, true])("waits for the full recovered parent with persisted child=%s", async (restoreChild) => {
    const input = { goal: "recover both", command: "date", nodeIds: ["hw-1", "ib-1"], idempotencyKey: "parent-key" };
    const fingerprint = createDispatchFingerprint(input);
    const child = (nodeId: string, prefix: string): RuntimeTaskRecord => ({
      ...task(nodeId, "completed", prefix),
      idempotencyKey: input.idempotencyKey,
      dispatchFingerprint: fingerprint,
    });
    const secondEntered = deferred<void>();
    const second = deferred<void>();
    const dispatch = vi.fn();
    const changed = vi.fn();
    const router = new FleetRouter([
      {
        nodeIds: ["hw-1"], taskPrefixes: ["HUAWEI-"],
        provider: {
          ...provider("huawei-ssh", "hw-1", "HUAWEI", []), dispatch,
          async inspect(id) { return { ...child("hw-1", "HUAWEI"), id }; },
        },
      },
      {
        nodeIds: ["ib-1"], taskPrefixes: ["INSTABOX-"],
        provider: {
          ...provider("instabox", "ib-1", "INSTABOX", []), dispatch,
          async inspect(id) {
            secondEntered.resolve();
            await second.promise;
            return { ...child("ib-1", "INSTABOX"), id };
          },
        },
      },
    ], { initialTasks: restoreChild ? [child("hw-1", "HUAWEI")] : [], onChange: changed });
    const original = router.dispatch(input);
    // A legacy partial record must not short-circuit the recovery before B is inspected.
    await flushMicrotasks();
    const settled = vi.fn();
    const retry = router.dispatch(input);
    void retry.then(settled);
    try {
      await flushMicrotasks();
      expect(settled).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
    } finally {
      second.resolve();
      await Promise.all([original, retry]);
    }
    await secondEntered.promise;
    const aggregate = await original;
    expect(await retry).toEqual(aggregate);
    expect(aggregate.id).toMatch(/^FLEET-/u);
    expect(aggregate.targetNodeIds).toEqual(input.nodeIds);
    expect(aggregate.childTaskRefs).toHaveLength(2);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await router.dispatch(input)).toEqual(aggregate);
  });

  it("coalesces concurrent dispatches sharing an idempotency key", async () => {
    const calls: string[] = [];
    const router = new FleetRouter([
      { nodeIds: ["hw-1"], provider: provider("huawei-ssh", "hw-1", "HUAWEI", calls), taskPrefixes: ["HUAWEI-"] },
    ]);
    const input = {
      goal: "retry safe",
      command: "uname -a",
      nodeIds: ["hw-1"],
      idempotencyKey: "retry-key",
    };

    const [left, right] = await Promise.all([
      router.dispatch(input),
      router.dispatch(input),
    ]);

    expect(calls).toEqual(["huawei-ssh:dispatch:hw-1"]);
    expect(right.id).toBe(left.id);
  });

  it("rejects reuse of an idempotency key for a different request", async () => {
    const calls: string[] = [];
    const router = new FleetRouter([
      { nodeIds: ["hw-1"], provider: provider("huawei-ssh", "hw-1", "HUAWEI", calls), taskPrefixes: ["HUAWEI-"] },
    ]);
    const input = {
      goal: "retry safe",
      command: "uname -a",
      nodeIds: ["hw-1"],
      idempotencyKey: "retry-key",
    };
    await router.dispatch(input);

    await expect(router.dispatch({ ...input, command: "date" })).rejects.toThrow(
      "FLEET_IDEMPOTENCY_KEY_REUSE:retry-key",
    );
    expect(calls).toEqual(["huawei-ssh:dispatch:hw-1"]);
  });

  it("returns the persisted task when a restored idempotency key is retried", async () => {
    const calls: string[] = [];
    const persisted = {
      ...task("hw-1", "completed", "HUAWEI"),
      idempotencyKey: "retry-key",
      dispatchFingerprint: createDispatchFingerprint({
        goal: "retry safe",
        command: "uname -a",
        nodeIds: ["hw-1"],
      }),
    };
    const router = new FleetRouter([
      { nodeIds: ["hw-1"], provider: provider("huawei-ssh", "hw-1", "HUAWEI", calls), taskPrefixes: ["HUAWEI-"] },
    ], { initialTasks: [persisted] });

    await expect(router.dispatch({
      goal: "retry safe",
      command: "uname -a",
      nodeIds: ["hw-1"],
      idempotencyKey: "retry-key",
    })).resolves.toEqual(persisted);
    expect(calls).toEqual([]);
  });

  it("recovers a remote deterministic task after a process restart", async () => {
    const dispatch = vi.fn();
    const input = {
      goal: "crash safe",
      command: "uname -a",
      nodeIds: ["hw-1"],
      idempotencyKey: "crash-key",
    };
    const fingerprint = createDispatchFingerprint(input);
    let inspectedTaskId = "";
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        dispatch,
        async inspect(taskId: string) {
          inspectedTaskId = taskId;
          return {
            ...task("hw-1", "completed", "HUAWEI"),
            id: taskId,
            idempotencyKey: "crash-key",
            dispatchFingerprint: fingerprint,
          };
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    const recovered = await router.dispatch(input);

    expect(recovered.id).toMatch(/^HUAWEI-[a-f0-9]{32}$/u);
    expect(recovered.id).toBe(inspectedTaskId);
    expect(recovered.idempotencyKey).toBe("crash-key");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("recovers deterministic multi-node children without redispatching", async () => {
    const input = {
      goal: "multi-node crash safe",
      command: "uname -a",
      nodeIds: ["hw-1", "ib-1"],
      idempotencyKey: "multi-crash-key",
    };
    const fingerprint = createDispatchFingerprint(input);
    const dispatch = vi.fn();
    const inspectIds: string[] = [];
    const recoveredChild = (nodeId: string, prefix: string) => ({
      ...task(nodeId, "completed", prefix),
      transport: prefix === "INSTABOX" ? "dsh-fleet" as const : "ssh" as const,
      idempotencyKey: "multi-crash-key",
      dispatchFingerprint: fingerprint,
    });
    const router = new FleetRouter([
      {
        nodeIds: ["hw-1"],
        provider: {
          ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
          dispatch,
          async inspect(taskId: string) {
            inspectIds.push(taskId);
            return withExecutionReceipt({ ...recoveredChild("hw-1", "HUAWEI"), id: taskId });
          },
        },
        taskPrefixes: ["HUAWEI-"],
      },
      {
        nodeIds: ["ib-1"],
        provider: {
          ...provider("instabox", "ib-1", "INSTABOX", []),
          dispatch,
          async inspect(taskId: string) {
            inspectIds.push(taskId);
            return withExecutionReceipt({ ...recoveredChild("ib-1", "INSTABOX"), id: taskId });
          },
        },
        taskPrefixes: ["INSTABOX-"],
      },
    ]);

    const aggregate = await router.dispatch(input);

    expect(aggregate.id).toMatch(/^FLEET-[a-f0-9]{32}$/u);
    expect(aggregate.status).toBe("completed");
    expect(aggregate.childTaskRefs?.map((child) => child.id)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^HUAWEI-[a-f0-9]{32}$/u), expect.stringMatching(/^INSTABOX-[a-f0-9]{32}$/u)]),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(inspectIds).toHaveLength(2);
  });

  it("fails closed instead of redispatching when deterministic recovery inspection is inconclusive", async () => {
    // Crash window: the first dispatch started the remote job, then the
    // process died before the ledger write landed. On retry the provider
    // exists but its inspect fails transiently. Treating that failure as
    // "task not found" would dispatch a second time against the same
    // deterministic id (the real providers hard-fail with
    // *_JOB_ALREADY_EXISTS, and a lenient provider would run the command
    // twice). The router must refuse and let the caller retry later.
    const dispatch = vi.fn(async () => task("hw-1", "running", "HUAWEI"));
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        dispatch,
        async inspect() {
          throw new Error("HUAWEI_SSH_TIMEOUT");
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    await expect(router.dispatch({
      goal: "crash window",
      command: "uname -a",
      nodeIds: ["hw-1"],
      idempotencyKey: "crash-window-key",
    })).rejects.toThrow(/^FLEET_IDEMPOTENCY_RECOVERY_UNCERTAIN:/u);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails the whole multi-node dispatch closed when one child's recovery is inconclusive", async () => {
    const hwDispatch = vi.fn(async () => task("hw-1", "running", "HUAWEI"));
    const ibDispatch = vi.fn(async () => task("ib-1", "running", "INSTABOX"));
    const router = new FleetRouter([
      {
        nodeIds: ["hw-1"],
        provider: {
          ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
          dispatch: hwDispatch,
          async inspect() {
            throw new Error("HUAWEI_SSH_TIMEOUT");
          },
        },
        taskPrefixes: ["HUAWEI-"],
      },
      {
        nodeIds: ["ib-1"],
        provider: {
          ...provider("instabox", "ib-1", "INSTABOX", []),
          dispatch: ibDispatch,
          async inspect(taskId: string) {
            throw new Error(`INSTABOX_TASK_NOT_FOUND:${taskId}`);
          },
        },
        taskPrefixes: ["INSTABOX-"],
      },
    ]);

    await expect(router.dispatch({
      goal: "multi crash window",
      command: "uname -a",
      nodeIds: ["hw-1", "ib-1"],
      idempotencyKey: "multi-crash-window-key",
    })).rejects.toThrow(/^FLEET_IDEMPOTENCY_RECOVERY_UNCERTAIN:/u);
    expect(hwDispatch).not.toHaveBeenCalled();
    expect(ibDispatch).not.toHaveBeenCalled();
  });

  it("dispatches fresh when deterministic recovery inspection is a clean miss", async () => {
    const dispatch = vi.fn(async (input: {
      goal: string;
      nodeIds: string[];
      command?: string;
      taskId?: string;
    }) => ({
      ...task("hw-1", "completed", "HUAWEI"),
      id: input.taskId ?? "HUAWEI-unexpected",
    }));
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        dispatch,
        async inspect(taskId: string) {
          throw new Error(`HUAWEI_TASK_NOT_FOUND:${taskId}`);
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    const dispatched = await router.dispatch({
      goal: "fresh after miss",
      command: "uname -a",
      nodeIds: ["hw-1"],
      idempotencyKey: "fresh-miss-key",
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatched.id).toMatch(/^HUAWEI-[a-f0-9]{32}$/u);
    expect(dispatched.idempotencyKey).toBe("fresh-miss-key");
  });

  it("keeps an unreachable provider's node visible as offline", async () => {
    const calls: string[] = [];
    const huawei = provider("huawei-ssh", "hw-1", "HUAWEI", calls);
    const instabox: RoutableFleetProvider = {
      id: "instabox",
      async health() {
        return { state: "offline", checkedAt };
      },
      describeNodes() {
        return [{ ...node("ib-1", "instabox"), status: "offline" }];
      },
      async listNodes() {
        throw new Error("INSTABOX_TIMEOUT");
      },
      async dispatch(input) {
        calls.push(`instabox:dispatch:${input.nodeIds.join(",")}`);
        return task("ib-1", "completed", "INSTABOX");
      },
      async doctor() {
        throw new Error("INSTABOX_TIMEOUT");
      },
    };
    const router = new FleetRouter([
      { nodeIds: ["hw-1"], provider: huawei, taskPrefixes: ["HUAWEI-"] },
      { nodeIds: ["ib-1"], provider: instabox, taskPrefixes: ["INSTABOX-"] },
    ]);

    const nodes = await router.listNodes();
    expect(nodes.map((entry) => entry.id)).toEqual(["hw-1", "ib-1"]);
    const instaboxNode = nodes.find((entry) => entry.id === "ib-1");
    expect(instaboxNode?.status).toBe("offline");
    expect(instaboxNode?.unavailableReason).toContain("INSTABOX_TIMEOUT");
  });

  it("keeps a node visible even when the provider cannot describe itself", async () => {
    const calls: string[] = [];
    const huawei = provider("huawei-ssh", "hw-1", "HUAWEI", calls);
    const failing: RoutableFleetProvider = {
      id: "instabox",
      async health() {
        return { state: "offline", checkedAt };
      },
      async listNodes() {
        throw new Error("INSTABOX_TIMEOUT");
      },
      async dispatch(input) {
        calls.push(`instabox:dispatch:${input.nodeIds.join(",")}`);
        return task("ib-1", "completed", "INSTABOX");
      },
      async doctor() {
        throw new Error("INSTABOX_TIMEOUT");
      },
    };
    const router = new FleetRouter([
      { nodeIds: ["hw-1"], provider: huawei, taskPrefixes: ["HUAWEI-"] },
      { nodeIds: ["ib-1"], provider: failing, taskPrefixes: ["INSTABOX-"] },
    ]);

    const nodes = await router.listNodes();
    expect(nodes.map((entry) => entry.id)).toEqual(["hw-1", "ib-1"]);
    const instaboxNode = nodes.find((entry) => entry.id === "ib-1");
    expect(instaboxNode?.status).toBe("offline");
    expect(instaboxNode?.unavailableReason).toContain("INSTABOX_TIMEOUT");
  });

  it("fails hard when every provider is unreachable", async () => {
    const failing = (id: string): RoutableFleetProvider => ({
      id,
      async health() {
        return { state: "offline", checkedAt };
      },
      async listNodes() {
        throw new Error(`${id}_UNREACHABLE`);
      },
      async dispatch() {
        throw new Error(`${id}_UNREACHABLE`);
      },
      async doctor() {
        throw new Error(`${id}_UNREACHABLE`);
      },
    });
    const router = new FleetRouter([
      { nodeIds: ["hw-1"], provider: failing("huawei-ssh") },
      { nodeIds: ["ib-1"], provider: failing("instabox") },
    ]);

    await expect(router.listNodes()).rejects.toThrow("FLEET_NODES_UNAVAILABLE");
  });

  it("reports a degraded fleet when a provider is unreachable", async () => {
    const calls: string[] = [];
    const huawei = provider("huawei-ssh", "hw-1", "HUAWEI", calls);
    const failing: RoutableFleetProvider = {
      id: "instabox",
      async health() {
        return { state: "offline", checkedAt };
      },
      async listNodes() {
        throw new Error("INSTABOX_TIMEOUT");
      },
      async dispatch() {
        throw new Error("INSTABOX_TIMEOUT");
      },
      async doctor() {
        throw new Error("INSTABOX_TIMEOUT");
      },
    };
    const router = new FleetRouter([
      { nodeIds: ["hw-1"], provider: huawei, taskPrefixes: ["HUAWEI-"] },
      { nodeIds: ["ib-1"], provider: failing, taskPrefixes: ["INSTABOX-"] },
    ]);

    const health = await router.health();
    expect(health.state).toBe("degraded");
    expect(health.message).toContain("INSTABOX_TIMEOUT");
  });

  it("combines real providers and routes tasks by node id", async () => {
    const calls: string[] = [];
    const huawei = executionProvider("huawei-ssh", "hw-1", "HUAWEI", calls);
    const instabox = executionProvider("instabox", "ib-1", "INSTABOX", calls);
    const router = new FleetRouter([
      { nodeIds: ["hw-1"], provider: huawei, taskPrefixes: ["HUAWEI-"] },
      { nodeIds: ["ib-1"], provider: instabox, taskPrefixes: ["INSTABOX-"] },
    ]);

    await expect(router.listNodes()).resolves.toEqual([
      expect.objectContaining({ id: "hw-1" }),
      expect.objectContaining({ id: "ib-1" }),
    ]);
    await expect(router.health()).resolves.toMatchObject({
      state: "connected",
      message: "2/2 fleet providers connected",
    });

    const single = await router.dispatch({
      goal: "check Huawei",
      nodeIds: ["hw-1"],
      command: "uname -a",
    });
    expect(single.id).toBe("HUAWEI-hw-1");

    const aggregate = await router.dispatch({
      goal: "check both",
      nodeIds: ["hw-1", "ib-1"],
      command: "date",
    });
    expect(aggregate).toMatchObject({
      status: "completed",
      progress: 100,
      targetNodeIds: ["hw-1", "ib-1"],
    });
    expect(aggregate.evidence.map((item) => item.label)).toEqual([
      "[hw-1] HUAWEI-hw-1:summary",
      "[hw-1] HUAWEI-hw-1:stdout",
      "[hw-1] HUAWEI-hw-1:stderr",
      "[ib-1] INSTABOX-ib-1:summary",
      "[ib-1] INSTABOX-ib-1:stdout",
      "[ib-1] INSTABOX-ib-1:stderr",
    ]);

    await router.doctor("ib-1");
    expect(calls).toContain("huawei-ssh:dispatch:hw-1");
    expect(calls).toContain("instabox:doctor:ib-1");
  });

  it("fails closed for unknown nodes and rejects unsupported cancellation", async () => {
    const originalProvider = provider("huawei-ssh", "hw-1", "HUAWEI", []);
    const { cancel: _cancel, ...providerWithoutCancel } = originalProvider;
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: providerWithoutCancel,
      taskPrefixes: ["HUAWEI-"],
    }]);

    await expect(router.dispatch({
      goal: "unknown",
      nodeIds: ["missing"],
      command: "date",
    })).rejects.toThrow("FLEET_NODE_UNKNOWN:missing");
    await expect(router.cancel("HUAWEI-unknown")).rejects.toThrow("FLEET_CANCEL_NOT_SUPPORTED");
  });

  it("rejects duplicate node ids instead of routing to multiple providers", () => {
    expect(() => new FleetRouter([
      { nodeIds: ["shared"], provider: provider("hw", "shared", "HUAWEI", []) },
      { nodeIds: ["shared"], provider: provider("ib", "shared", "INSTABOX", []) },
    ])).toThrow("FLEET_NODE_ID_CONFLICT:shared");
  });

  it("preserves successful children when another provider dispatch fails", async () => {
    const calls: string[] = [];
    const router = new FleetRouter([
      {
        nodeIds: ["hw-1"],
        provider: provider("huawei-ssh", "hw-1", "HUAWEI", calls),
        taskPrefixes: ["HUAWEI-"],
      },
      {
        nodeIds: ["ib-1"],
        provider: {
          ...provider("instabox", "ib-1", "INSTABOX", calls),
          async dispatch() {
            throw new Error("INSTABOX_UNAVAILABLE");
          },
        },
        taskPrefixes: ["INSTABOX-"],
      },
    ]);

    const aggregate = await router.dispatch({
      goal: "check both",
      nodeIds: ["hw-1", "ib-1"],
      command: "date",
    });

    expect(aggregate).toMatchObject({
      status: "failed",
      targetNodeIds: ["hw-1", "ib-1"],
      error: "INSTABOX_UNAVAILABLE",
    });
    expect(aggregate.childTaskRefs).toHaveLength(2);
    expect(aggregate.evidence).toContainEqual(expect.objectContaining({ value: "hw-1" }));
    await expect(router.listTasks()).resolves.toContainEqual(
      expect.objectContaining({ id: aggregate.id, status: "failed" }),
    );
  });

  it("keeps a partial failure active until surviving children settle", async () => {
    const running = task("hw-1", "running", "HUAWEI");
    const completed = task("hw-1", "completed", "HUAWEI");
    const router = new FleetRouter([
      {
        nodeIds: ["hw-1"],
        provider: {
          ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
          async dispatch() {
            return running;
          },
          async inspect() {
            return completed;
          },
        },
        taskPrefixes: ["HUAWEI-"],
      },
      {
        nodeIds: ["ib-1"],
        provider: {
          ...provider("instabox", "ib-1", "INSTABOX", []),
          async dispatch() {
            throw new Error("INSTABOX_UNAVAILABLE");
          },
        },
        taskPrefixes: ["INSTABOX-"],
      },
    ]);

    const aggregate = await router.dispatch({
      goal: "partial failure",
      nodeIds: ["hw-1", "ib-1"],
      command: "date",
    });
    expect(aggregate.status).toBe("running");

    await router.refreshTasks();
    await expect(router.listTasks()).resolves.toContainEqual(
      expect.objectContaining({ id: aggregate.id, status: "failed" }),
    );
  });

  it("refreshes running remote tasks through provider inspection", async () => {
    const running = task("hw-1", "running", "HUAWEI");
    const completed = task("hw-1", "completed", "HUAWEI");
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async dispatch() {
          return running;
        },
        async inspect() {
          return completed;
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    await router.dispatch({ goal: "check", nodeIds: ["hw-1"], command: "date" });
    await router.refreshTasks();
    await expect(router.listTasks()).resolves.toEqual([completed]);
  });

  it("restores task routing from an injected ledger and persists inspected changes", async () => {
    const running = task("hw-1", "running", "HUAWEI");
    const completed = task("hw-1", "completed", "HUAWEI");
    const changes: RuntimeTaskRecord[][] = [];
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async inspect() {
          return completed;
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }], {
      initialTasks: [running],
      onChange(tasks) {
        changes.push(tasks);
      },
    });

    await router.refreshTasks();
    await expect(router.listTasks()).resolves.toEqual([completed]);
    expect(changes.at(-1)).toEqual([completed]);
  });

  it("bounds concurrent provider inspects during a refresh round", async () => {
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const initial = Array.from({ length: 10 }, (_, index) => ({
      ...task("peak-1", "running", "PEAK"),
      id: `PEAK-${index + 1}`,
    }));
    const router = new FleetRouter([{
      nodeIds: ["peak-1"],
      provider: {
        ...provider("peak-provider", "peak-1", "PEAK", []),
        async inspect(taskId: string) {
          calls += 1;
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 25));
          inFlight -= 1;
          return { ...task("peak-1", "completed", "PEAK"), id: taskId };
        },
      },
      taskPrefixes: ["PEAK-"],
    }], { initialTasks: initial });

    await router.refreshTasks();

    expect(calls).toBe(10);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("does not let one slow provider consume the whole inspect budget", async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slowTasks = Array.from({ length: 10 }, (_, index) => ({
      ...task("slow-1", "running", "SLOW"),
      id: `SLOW-${index + 1}`,
    }));
    const fastTasks = [1, 2].map((index) => ({
      ...task("fast-1", "running", "FAST"),
      id: `FAST-${index}`,
    }));
    const router = new FleetRouter([
      {
        nodeIds: ["slow-1"],
        provider: {
          ...provider("slow-provider", "slow-1", "SLOW", []),
          async inspect(taskId: string) {
            await slowGate;
            return { ...task("slow-1", "completed", "SLOW"), id: taskId };
          },
        },
        taskPrefixes: ["SLOW-"],
      },
      {
        nodeIds: ["fast-1"],
        provider: {
          ...provider("fast-provider", "fast-1", "FAST", []),
          async inspect(taskId: string) {
            return { ...task("fast-1", "completed", "FAST"), id: taskId };
          },
        },
        taskPrefixes: ["FAST-"],
      },
    ], { initialTasks: [...slowTasks, ...fastTasks] });

    const refresh = router.refreshTasks();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const during = await router.listTasks();
    expect(during.filter((entry) => entry.id.startsWith("FAST-")).map((entry) => entry.status))
      .toEqual(["completed", "completed"]);
    expect(during.filter((entry) => entry.id.startsWith("SLOW-")).every((entry) => entry.status === "running"))
      .toBe(true);

    releaseSlow();
    await refresh;
    const after = await router.listTasks();
    expect(after.filter((entry) => entry.id.startsWith("SLOW-")).every((entry) => entry.status === "completed"))
      .toBe(true);
  });

  it("records per-round inspect attempts, failures, and duration", async () => {
    const initial = [1, 2, 3].map((index) => ({
      ...task("stats-1", "running", "STATS"),
      id: `STATS-${index}`,
    }));
    const router = new FleetRouter([{
      nodeIds: ["stats-1"],
      provider: {
        ...provider("stats-provider", "stats-1", "STATS", []),
        async inspect(taskId: string) {
          if (taskId === "STATS-3") throw new Error("inspect boom");
          return { ...task("stats-1", "completed", "STATS"), id: taskId };
        },
      },
      taskPrefixes: ["STATS-"],
    }], { initialTasks: initial });

    expect(router.inspectStats().totals).toEqual({ attempts: 0, failures: 0 });
    expect(router.inspectStats().lastRound).toBeUndefined();

    await router.refreshTasks();
    let stats = router.inspectStats();
    expect(stats.totals).toEqual({ attempts: 3, failures: 1 });
    expect(stats.lastRound).toMatchObject({
      round: 1,
      attempts: 3,
      failures: 1,
      peakQueueDepth: 0,
    });
    expect(stats.lastRound?.durationMs).toBeGreaterThanOrEqual(0);

    // Completed tasks carry evidence and are skipped next round; the
    // still-running failed task is the only retry.
    await router.refreshTasks();
    stats = router.inspectStats();
    expect(stats.totals).toEqual({ attempts: 4, failures: 2 });
    expect(stats.lastRound).toMatchObject({ round: 2, attempts: 1, failures: 1 });
  });

  it("records the peak inspect queue depth while a round is queued", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const initial = Array.from({ length: 10 }, (_, index) => ({
      ...task("queue-1", "running", "QUEUE"),
      id: `QUEUE-${index + 1}`,
    }));
    const router = new FleetRouter([{
      nodeIds: ["queue-1"],
      provider: {
        ...provider("queue-provider", "queue-1", "QUEUE", []),
        async inspect(taskId: string) {
          await gate;
          return { ...task("queue-1", "completed", "QUEUE"), id: taskId };
        },
      },
      taskPrefixes: ["QUEUE-"],
    }], { initialTasks: initial });

    const refresh = router.refreshTasks();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const during = router.inspectStats();
    expect(during.lastRound?.attempts).toBe(10);
    // Per-provider budget is 4: 10 attempts leave 6 waiting for a slot.
    expect(during.lastRound?.peakQueueDepth).toBe(6);

    releaseGate();
    await refresh;
    const after = router.inspectStats();
    expect(after.totals).toEqual({ attempts: 10, failures: 0 });
    expect(after.lastRound?.peakQueueDepth).toBe(6);
    expect(after.lastRound?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("counts direct inspects in the totals but not in the closed round", async () => {
    const initial = [1, 2].map((index) => ({
      ...task("direct-1", "running", "DIRECT"),
      id: `DIRECT-${index}`,
    }));
    const router = new FleetRouter([{
      nodeIds: ["direct-1"],
      provider: {
        ...provider("direct-provider", "direct-1", "DIRECT", []),
        async inspect(taskId: string) {
          return { ...task("direct-1", "completed", "DIRECT"), id: taskId };
        },
      },
      taskPrefixes: ["DIRECT-"],
    }], { initialTasks: initial });

    await router.refreshTasks();
    await router.inspect("DIRECT-1");
    const stats = router.inspectStats();
    expect(stats.totals.attempts).toBe(3);
    expect(stats.lastRound?.attempts).toBe(2);
  });

  it("rehydrates evidence for terminal tasks restored without evidence", async () => {
    const completed = task("hw-1", "completed", "HUAWEI");
    const restored = { ...completed, evidence: [] };
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async inspect() {
          return completed;
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }], {
      initialTasks: [restored],
    });

    await router.refreshTasks();
    await expect(router.listTasks()).resolves.toEqual([completed]);
  });

  it("keeps a self-referenced restored task verifying until evidence can be inspected", async () => {
    const completed = {
      ...task("ib-1", "completed", "INSTABOX"),
      transport: "dsh-fleet" as const,
      evidence: [],
      childTaskRefs: [{ id: "INSTABOX-ib-1", targetNodeIds: ["ib-1"] }],
    };
    const router = new FleetRouter([{
      nodeIds: ["ib-1"],
      provider: provider("instabox", "ib-1", "INSTABOX", []),
      taskPrefixes: ["INSTABOX-"],
    }], {
      initialTasks: [completed],
    });

    await router.refreshTasks();
    await expect(router.listTasks()).resolves.toContainEqual(
      expect.objectContaining({ id: completed.id, status: "verifying" }),
    );
    await expect(router.inspect(completed.id)).rejects.toThrow("FLEET_TASK_INSPECT_UNSUPPORTED:");
  });

  it("preserves ledger goal metadata when remote inspection rehydrates evidence", async () => {
    const completed = task("hw-1", "completed", "HUAWEI");
    const restored = {
      ...completed,
      goal: "original persisted goal",
      evidence: [],
    };
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async inspect() {
          return { ...completed, goal: "generic remote fallback" };
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }], {
      initialTasks: [restored],
    });

    await router.refreshTasks();
    await expect(router.listTasks()).resolves.toContainEqual(
      expect.objectContaining({
        id: completed.id,
        goal: "original persisted goal",
        evidence: completed.evidence,
      }),
    );
  });

  it("restores aggregate child routes and rehydrates multi-node evidence", async () => {
    const huaweiTask = task("hw-1", "completed", "HUAWEI");
    const instaboxTask = {
      ...task("ib-1", "completed", "INSTABOX"),
      transport: "dsh-fleet" as const,
    };
    const restored: RuntimeTaskRecord = {
      id: "FLEET-restored",
      goal: "check both",
      targetNodeIds: ["hw-1", "ib-1"],
      transport: "dsh-fleet",
      status: "completed",
      progress: 100,
      evidence: [],
      childTaskRefs: [
        { id: huaweiTask.id, targetNodeIds: ["hw-1"], status: "completed", progress: 100 },
        { id: instaboxTask.id, targetNodeIds: ["ib-1"], status: "completed", progress: 100 },
      ],
      createdAt: "2026-10-21T00:00:00.000Z",
      updatedAt: "2026-10-21T00:00:00.000Z",
    };
    const router = new FleetRouter([
      {
        nodeIds: ["hw-1"],
        provider: {
          ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
          async inspect() {
            return huaweiTask;
          },
        },
        taskPrefixes: ["HUAWEI-"],
      },
      {
        nodeIds: ["ib-1"],
        provider: provider("instabox", "ib-1", "INSTABOX", []),
        taskPrefixes: ["INSTABOX-"],
      },
    ], {
      initialTasks: [restored],
    });

    await router.refreshTasks();
    const [aggregate] = await router.listTasks();
    expect(aggregate).toMatchObject({
      id: restored.id,
      status: "verifying",
      targetNodeIds: ["hw-1", "ib-1"],
    });
    expect(aggregate?.evidence.map((item) => item.label)).toEqual([
      "[hw-1] probe",
    ]);
  });

  it("does not rewrite an already terminal aggregate as cancelled", async () => {
    const completed = task("hw-1", "completed", "HUAWEI");
    const cancel = async () => {
      throw new Error("REMOTE_CANCEL_SHOULD_NOT_RUN");
    };
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        cancel,
      },
      taskPrefixes: ["HUAWEI-"],
    }], {
      initialTasks: [completed],
    });

    await expect(router.cancel(completed.id)).rejects.toThrow(
      "FLEET_TASK_ALREADY_TERMINAL:completed",
    );
    await expect(router.listTasks()).resolves.toContainEqual(completed);
  });

  it("gates a completed single-node dispatch until evidence is present", async () => {
    const incomplete = { ...task("hw-1", "completed", "HUAWEI"), evidence: [] };
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async dispatch() {
          return incomplete;
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    const dispatched = await router.dispatch({
      goal: "check",
      nodeIds: ["hw-1"],
      command: "date",
    });

    expect(dispatched.status).toBe("verifying");
    expect(dispatched.updatedAt).not.toBe(incomplete.updatedAt);
  });

  it("gates completed fulfilled children in a multi-node dispatch", async () => {
    const incomplete = { ...task("hw-1", "completed", "HUAWEI"), evidence: [] };
    const complete = task("ib-1", "completed", "INSTABOX");
    const router = new FleetRouter([
      {
        nodeIds: ["hw-1"],
        provider: {
          ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
          async dispatch() {
            return incomplete;
          },
        },
        taskPrefixes: ["HUAWEI-"],
      },
      {
        nodeIds: ["ib-1"],
        provider: {
          ...provider("instabox", "ib-1", "INSTABOX", []),
          async dispatch() {
            return complete;
          },
        },
        taskPrefixes: ["INSTABOX-"],
      },
    ]);

    const aggregate = await router.dispatch({
      goal: "check both",
      nodeIds: ["hw-1", "ib-1"],
      command: "date",
    });

    expect(aggregate.status).toBe("verifying");
    expect(aggregate.childTaskRefs?.map((child) => child.status)).toEqual([
      "verifying",
      "completed",
    ]);
  });

  it("gates an unknown task returned by provider inspection", async () => {
    const incomplete = { ...task("hw-1", "completed", "HUAWEI"), evidence: [] };
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async inspect() {
          return incomplete;
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    await expect(router.inspect(incomplete.id)).resolves.toMatchObject({
      id: incomplete.id,
      status: "verifying",
    });
  });

  it("gates a completed task merged from known provider inspection", async () => {
    const running = { ...task("hw-1", "running", "HUAWEI"), evidence: [] };
    const incomplete = { ...task("hw-1", "completed", "HUAWEI"), evidence: [] };
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async dispatch() {
          return running;
        },
        async inspect() {
          return incomplete;
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    await router.dispatch({ goal: "check", nodeIds: ["hw-1"], command: "date" });
    await router.refreshTasks();

    await expect(router.listTasks()).resolves.toContainEqual(
      expect.objectContaining({ id: running.id, status: "verifying" }),
    );
  });

  it("shares one refresh round across concurrent readLiveTasks callers", async () => {
    const running = { ...task("hw-1", "running", "HUAWEI"), evidence: [] };
    const completed = task("hw-1", "completed", "HUAWEI");
    const inspection = deferred<RuntimeTaskRecord>();
    let inspectCalls = 0;
    let markInspectStarted!: () => void;
    const inspectStarted = new Promise<void>((resolve) => {
      markInspectStarted = resolve;
    });
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async dispatch() {
          return running;
        },
        async inspect() {
          inspectCalls += 1;
          markInspectStarted();
          return inspection.promise;
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    await router.dispatch({ goal: "check", nodeIds: ["hw-1"], command: "date" });
    const firstRead = router.readLiveTasks();
    const secondRead = router.readLiveTasks();
    await inspectStarted;

    expect(inspectCalls).toBe(1);

    inspection.resolve(completed);
    const [firstTasks, secondTasks] = await Promise.all([firstRead, secondRead]);
    expect(firstTasks).toContainEqual(completed);
    expect(secondTasks).toContainEqual(completed);
  });

  it("reports inspect failures through provider-scoped health and clears them on recovery", async () => {
    const running = { ...task("hw-1", "running", "HUAWEI"), evidence: [] };
    const completed = task("hw-1", "completed", "HUAWEI");
    let inspectShouldFail = true;
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async dispatch() {
          return running;
        },
        async inspect() {
          if (inspectShouldFail) throw new Error("HUAWEI_INSPECT_TIMEOUT");
          return completed;
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    await router.dispatch({ goal: "check", nodeIds: ["hw-1"], command: "date" });
    await router.readLiveTasks();

    await expect(router.health()).resolves.toMatchObject({
      state: "degraded",
    });
    await expect(router.providerHealth()).resolves.toMatchObject({
      "huawei-ssh": {
        state: "degraded",
        message: expect.stringContaining("HUAWEI_INSPECT_TIMEOUT"),
      },
    });

    inspectShouldFail = false;
    await router.readLiveTasks();

    await expect(router.health()).resolves.toMatchObject({
      state: "connected",
    });
    await expect(router.providerHealth()).resolves.toMatchObject({
      "huawei-ssh": {
        state: "connected",
      },
    });
  });

  it("preserves successful sibling updates when another child inspect fails", async () => {
    const huaweiRunning = {
      ...task("hw-1", "running", "HUAWEI"),
      evidence: [],
    };
    const instaboxRunning = {
      ...task("ib-1", "running", "INSTABOX"),
      evidence: [],
    };
    const instaboxCompleted = {
      ...task("ib-1", "completed", "INSTABOX"),
      evidence: [{ kind: "command" as const, label: "ib done", value: "kernel-ok" }],
    };
    const router = new FleetRouter([
      {
        nodeIds: ["hw-1"],
        provider: {
          ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
          async dispatch() {
            return huaweiRunning;
          },
          async inspect() {
            throw new Error("HUAWEI_INSPECT_TIMEOUT");
          },
        },
        taskPrefixes: ["HUAWEI-"],
      },
      {
        nodeIds: ["ib-1"],
        provider: {
          ...provider("instabox", "ib-1", "INSTABOX", []),
          async dispatch() {
            return instaboxRunning;
          },
          async inspect() {
            return instaboxCompleted;
          },
        },
        taskPrefixes: ["INSTABOX-"],
      },
    ]);

    const aggregate = await router.dispatch({
      goal: "check both",
      nodeIds: ["hw-1", "ib-1"],
      command: "date",
    });
    const tasks = await router.readLiveTasks();
    const refreshed = tasks.find((entry) => entry.id === aggregate.id);

    expect(refreshed?.childTaskRefs?.map((child) => child.status)).toEqual([
      "running",
      "completed",
    ]);
    expect(refreshed?.evidence).toContainEqual(
      expect.objectContaining({ label: "[ib-1] ib done" }),
    );
    await expect(router.providerHealth()).resolves.toMatchObject({
      "huawei-ssh": {
        state: "degraded",
        message: expect.stringContaining("HUAWEI_INSPECT_TIMEOUT"),
      },
      instabox: {
        state: "connected",
      },
    });
  });

  it("does not let a late refresh overwrite a concurrent cancellation", async () => {
    const running = { ...task("hw-1", "running", "HUAWEI"), evidence: [] };
    const completed = task("hw-1", "completed", "HUAWEI");
    const inspection = deferred<RuntimeTaskRecord>();
    let markInspectStarted!: () => void;
    const inspectStarted = new Promise<void>((resolve) => {
      markInspectStarted = resolve;
    });
    const calls: string[] = [];
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", calls),
        async dispatch() {
          return running;
        },
        async inspect() {
          markInspectStarted();
          return inspection.promise;
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    await router.dispatch({ goal: "check", nodeIds: ["hw-1"], command: "date" });
    const refresh = router.readLiveTasks();
    await inspectStarted;
    await router.cancel(running.id);
    inspection.resolve(completed);
    const tasks = await refresh;

    expect(tasks).toContainEqual(
      expect.objectContaining({ id: running.id, status: "cancelled" }),
    );
    expect(calls).toContain(`huawei-ssh:cancel:${running.id}`);
  });

  it.each(["sync", "async"] as const)(
    "degrades health and recovers after a %s ledger write failure",
    async (mode) => {
      let ledgerShouldFail = true;
      const router = new FleetRouter([{
        nodeIds: ["hw-1"],
        provider: provider("huawei-ssh", "hw-1", "HUAWEI", []),
        taskPrefixes: ["HUAWEI-"],
      }], {
        onChange() {
          if (!ledgerShouldFail) return;
          if (mode === "sync") throw new Error("LEDGER_DISK_FULL");
          return Promise.reject(new Error("LEDGER_DISK_FULL"));
        },
      });

      await router.dispatch({ goal: "check", nodeIds: ["hw-1"], command: "date" });
      await flushAsyncHandlers();

      await expect(router.health()).resolves.toMatchObject({
        state: "degraded",
        message: expect.stringContaining("LEDGER_WRITE_FAILED"),
      });
      await expect(router.providerHealth()).resolves.toMatchObject({
        "fleet-router": {
          state: "degraded",
          message: expect.stringContaining("LEDGER_WRITE_FAILED"),
        },
      });

      ledgerShouldFail = false;
      await router.dispatch({ goal: "check again", nodeIds: ["hw-1"], command: "date" });
      await flushAsyncHandlers();

      await expect(router.health()).resolves.toMatchObject({ state: "connected" });
      const providerHealth = await router.providerHealth();
      expect(providerHealth["fleet-router"]).toBeUndefined();
    },
  );

  it("ignores an older ledger failure that settles after a newer success", async () => {
    const lateFailure = deferred<void>();
    let ledgerWrites = 0;
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: provider("huawei-ssh", "hw-1", "HUAWEI", []),
      taskPrefixes: ["HUAWEI-"],
    }], {
      onChange() {
        ledgerWrites += 1;
        return ledgerWrites === 1 ? lateFailure.promise : undefined;
      },
    });

    await router.dispatch({ goal: "first", nodeIds: ["hw-1"], command: "date" });
    await router.dispatch({ goal: "second", nodeIds: ["hw-1"], command: "date" });
    await flushAsyncHandlers();
    lateFailure.reject(new Error("LEDGER_DISK_FULL"));
    await flushAsyncHandlers();

    await expect(router.health()).resolves.toMatchObject({ state: "connected" });
    const providerHealth = await router.providerHealth();
    expect(providerHealth["fleet-router"]).toBeUndefined();
  });

  it("awaits an in-flight refresh before reporting health errors", async () => {
    const running = { ...task("hw-1", "running", "HUAWEI"), evidence: [] };
    const inspection = deferred<void>();
    let markInspectStarted!: () => void;
    const inspectStarted = new Promise<void>((resolve) => {
      markInspectStarted = resolve;
    });
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async dispatch() {
          return running;
        },
        async inspect() {
          markInspectStarted();
          await inspection.promise;
          throw new Error("HUAWEI_INSPECT_TIMEOUT");
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    await router.dispatch({ goal: "check", nodeIds: ["hw-1"], command: "date" });
    const refresh = router.readLiveTasks();
    await inspectStarted;
    const health = router.health();
    const providerHealth = router.providerHealth();
    await flushMicrotasks();
    inspection.reject(new Error("HUAWEI_INSPECT_TIMEOUT"));

    await expect(refresh).resolves.toBeDefined();
    await expect(health).resolves.toMatchObject({ state: "degraded" });
    await expect(providerHealth).resolves.toMatchObject({
      "huawei-ssh": {
        state: "degraded",
        message: expect.stringContaining("HUAWEI_INSPECT_TIMEOUT"),
      },
    });
  });

  it("keeps a successful unknown-task inspect when a concurrent inspect fails", async () => {
    const completed = task("hw-1", "completed", "HUAWEI");
    const success = deferred<RuntimeTaskRecord>();
    const failure = deferred<RuntimeTaskRecord>();
    const successStarted = deferred<void>();
    const failureStarted = deferred<void>();
    let inspectCalls = 0;
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async inspect() {
          inspectCalls += 1;
          if (inspectCalls === 1) {
            successStarted.resolve();
            return success.promise;
          }
          failureStarted.resolve();
          return failure.promise;
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    const successfulInspect = router.inspect(completed.id);
    await successStarted.promise;
    const failingInspect = router.inspect(completed.id);
    await failureStarted.promise;
    success.resolve(completed);
    await successfulInspect;
    failure.reject(new Error("REMOTE_INSPECT_FAILED"));

    await expect(failingInspect).rejects.toThrow("REMOTE_INSPECT_FAILED");
    await expect(router.listTasks()).resolves.toContainEqual(completed);
  });

  it("keeps a successful single-task inspect when a concurrent inspect fails", async () => {
    const running = { ...task("hw-1", "running", "HUAWEI"), evidence: [] };
    const completed = task("hw-1", "completed", "HUAWEI");
    const success = deferred<RuntimeTaskRecord>();
    const failure = deferred<RuntimeTaskRecord>();
    const successStarted = deferred<void>();
    const failureStarted = deferred<void>();
    let inspectCalls = 0;
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async dispatch() {
          return running;
        },
        async inspect() {
          inspectCalls += 1;
          if (inspectCalls === 1) {
            successStarted.resolve();
            return success.promise;
          }
          failureStarted.resolve();
          return failure.promise;
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    await router.dispatch({ goal: "check", nodeIds: ["hw-1"], command: "date" });
    const successfulInspect = router.inspect(running.id);
    await successStarted.promise;
    const failingInspect = router.inspect(running.id);
    await failureStarted.promise;
    success.resolve(completed);
    await successfulInspect;
    failure.reject(new Error("REMOTE_INSPECT_FAILED"));

    await expect(failingInspect).rejects.toThrow("REMOTE_INSPECT_FAILED");
    await expect(router.listTasks()).resolves.toContainEqual(completed);
  });

  it("keeps a successful aggregate inspect when a concurrent inspect fails", async () => {
    const huaweiRunning = {
      ...task("hw-1", "running", "HUAWEI"),
      evidence: [],
    };
    const huaweiCompleted = withExecutionReceipt(task("hw-1", "completed", "HUAWEI"));
    const success = deferred<RuntimeTaskRecord>();
    const failure = deferred<RuntimeTaskRecord>();
    const successStarted = deferred<void>();
    const failureStarted = deferred<void>();
    let inspectCalls = 0;
    const router = new FleetRouter([
      {
        nodeIds: ["hw-1"],
        provider: {
          ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
          async dispatch() {
            return huaweiRunning;
          },
          async inspect() {
            inspectCalls += 1;
            if (inspectCalls === 1) {
              successStarted.resolve();
              return success.promise;
            }
            failureStarted.resolve();
            return failure.promise;
          },
        },
        taskPrefixes: ["HUAWEI-"],
      },
      {
        nodeIds: ["ib-1"],
        provider: {
          ...provider("instabox", "ib-1", "INSTABOX", []),
          async dispatch() {
            throw new Error("INSTABOX_UNAVAILABLE");
          },
        },
        taskPrefixes: ["INSTABOX-"],
      },
    ]);

    const aggregate = await router.dispatch({
      goal: "check both",
      nodeIds: ["hw-1", "ib-1"],
      command: "date",
    });
    const successfulInspect = router.inspect(aggregate.id);
    await successStarted.promise;
    const failingInspect = router.inspect(aggregate.id);
    await failureStarted.promise;
    success.resolve(huaweiCompleted);
    await successfulInspect;
    failure.reject(new Error("REMOTE_INSPECT_FAILED"));

    await expect(failingInspect).rejects.toThrow("REMOTE_INSPECT_FAILED");
    const tasks = await router.listTasks();
    const refreshed = tasks.find((entry) => entry.id === aggregate.id);
    expect(refreshed?.childTaskRefs?.map((child) => child.status)).toEqual([
      "completed",
      "failed",
    ]);
  });

  it("preserves successful child cancellations when a sibling cancellation fails", async () => {
    const huaweiRunning = {
      ...task("hw-1", "running", "HUAWEI"),
      evidence: [],
    };
    const instaboxRunning = {
      ...task("ib-1", "running", "INSTABOX"),
      evidence: [],
    };
    const router = new FleetRouter([
      {
        nodeIds: ["hw-1"],
        provider: {
          ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
          async dispatch() {
            return huaweiRunning;
          },
          async cancel() {},
        },
        taskPrefixes: ["HUAWEI-"],
      },
      {
        nodeIds: ["ib-1"],
        provider: {
          ...provider("instabox", "ib-1", "INSTABOX", []),
          async dispatch() {
            return instaboxRunning;
          },
          async cancel() {
            throw new Error("INSTABOX_CANCEL_FAILED");
          },
        },
        taskPrefixes: ["INSTABOX-"],
      },
    ]);

    const aggregate = await router.dispatch({
      goal: "cancel both",
      nodeIds: ["hw-1", "ib-1"],
      command: "date",
    });

    await expect(router.cancel(aggregate.id)).rejects.toThrow("INSTABOX_CANCEL_FAILED");
    const tasks = await router.listTasks();
    const cancelled = tasks.find((entry) => entry.id === aggregate.id);
    expect(cancelled?.childTaskRefs?.map((child) => child.status)).toEqual([
      "cancelled",
      "running",
    ]);
    await expect(router.providerHealth()).resolves.toMatchObject({
      "huawei-ssh": {
        state: "connected",
      },
      instabox: {
        state: "degraded",
        message: expect.stringContaining("TASK_CANCEL_FAILED"),
      },
    });
  });

  it("expires stale provider health errors after the finite TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T00:00:00.000Z"));
    try {
      const router = new FleetRouter([{
        nodeIds: ["hw-1"],
        provider: {
          ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
          async inspect() {
            throw new Error("UNKNOWN_TASK_INSPECT_FAILED");
          },
        },
        taskPrefixes: ["HUAWEI-"],
      }]);

      await expect(router.inspect("HUAWEI-missing")).rejects.toThrow(
        "UNKNOWN_TASK_INSPECT_FAILED",
      );
      await expect(router.health()).resolves.toMatchObject({ state: "degraded" });

      vi.advanceTimersByTime(60_000);

      await expect(router.health()).resolves.toMatchObject({ state: "connected" });
      const providerHealth = await router.providerHealth();
      expect(providerHealth["huawei-ssh"]).toMatchObject({ state: "connected" });
      expect(providerHealth["huawei-ssh"]?.message).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries ledger writes three times with exponential backoff", async () => {
    vi.useFakeTimers();
    try {
      let writes = 0;
      const router = new FleetRouter([{
        nodeIds: ["hw-1"],
        provider: provider("huawei-ssh", "hw-1", "HUAWEI", []),
        taskPrefixes: ["HUAWEI-"],
      }], {
        onChange() {
          writes += 1;
          throw new Error("LEDGER_DISK_FULL");
        },
      });

      await router.dispatch({ goal: "check", nodeIds: ["hw-1"], command: "date" });
      expect(writes).toBe(1);

      await vi.advanceTimersByTimeAsync(99);
      expect(writes).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(writes).toBe(2);
      await vi.advanceTimersByTimeAsync(200);
      expect(writes).toBe(3);
      await vi.advanceTimersByTimeAsync(400);
      expect(writes).toBe(4);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writes).toBe(4);
      await expect(router.health()).resolves.toMatchObject({ state: "degraded" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes ledger retries and saves the latest dirty snapshot", async () => {
    vi.useFakeTimers();
    try {
      const firstWrite = deferred<void>();
      const goals: string[] = [];
      let writes = 0;
      const dispatchProvider = {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async dispatch(input: { goal: string; nodeIds: string[]; command?: string }) {
          return { ...task("hw-1", "running", "HUAWEI"), goal: input.goal, evidence: [] };
        },
      };
      const router = new FleetRouter([{
        nodeIds: ["hw-1"],
        provider: dispatchProvider,
        taskPrefixes: ["HUAWEI-"],
      }], {
        onChange(tasks) {
          writes += 1;
          goals.push(tasks[0]?.goal ?? "");
          return writes === 1 ? firstWrite.promise : undefined;
        },
      });

      await router.dispatch({ goal: "first", nodeIds: ["hw-1"], command: "date" });
      await router.dispatch({ goal: "second", nodeIds: ["hw-1"], command: "date" });

      expect(writes).toBe(1);
      expect(goals).toEqual(["first"]);

      firstWrite.reject(new Error("LEDGER_DISK_FULL"));
      await flushMicrotasks();

      expect(writes).toBe(2);
      expect(goals).toEqual(["first", "second"]);
      await expect(router.health()).resolves.toMatchObject({ state: "connected" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps whitespace-only evidence from completing a dispatched task", async () => {
    const blankEvidence: RuntimeTaskRecord = {
      ...task("hw-1", "completed", "HUAWEI"),
      evidence: [{ kind: "command", label: "output", value: " \t\n " }],
    };
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async dispatch() {
          return blankEvidence;
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    const dispatched = await router.dispatch({
      goal: "check",
      nodeIds: ["hw-1"],
      command: "date",
    });

    expect(dispatched.status).toBe("verifying");
  });

  it("keeps ledger dirty state and a durable error after retries exhaust", async () => {
    vi.useFakeTimers();
    try {
      let shouldFail = true;
      let writes = 0;
      const router = new FleetRouter([{
        nodeIds: ["hw-1"],
        provider: provider("huawei-ssh", "hw-1", "HUAWEI", []),
        taskPrefixes: ["HUAWEI-"],
      }], {
        onChange() {
          writes += 1;
          if (shouldFail) throw new Error("LEDGER_DISK_FULL");
        },
      });

      await router.dispatch({ goal: "check", nodeIds: ["hw-1"], command: "date" });
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(400);
      expect(writes).toBe(4);

      await vi.advanceTimersByTimeAsync(60_000);
      await expect(router.health()).resolves.toMatchObject({
        state: "degraded",
        message: expect.stringContaining("LEDGER_WRITE_FAILED"),
      });
      await expect(router.providerHealth()).resolves.toMatchObject({
        "fleet-router": {
          state: "degraded",
          message: expect.stringContaining("LEDGER_WRITE_FAILED"),
        },
      });
      const ledgerState = router as unknown as {
        ledgerDirtyTasks?: RuntimeTaskRecord[];
      };
      expect(ledgerState.ledgerDirtyTasks).toHaveLength(1);

      shouldFail = false;
      await router.dispatch({ goal: "recover", nodeIds: ["hw-1"], command: "date" });
      await flushMicrotasks();

      expect(writes).toBe(5);
      await expect(router.health()).resolves.toMatchObject({ state: "connected" });
      const providerHealth = await router.providerHealth();
      expect(providerHealth["fleet-router"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not occupy the task version when a single cancellation fails", async () => {
    const running = { ...task("hw-1", "running", "HUAWEI"), evidence: [] };
    const completed = task("hw-1", "completed", "HUAWEI");
    const inspection = deferred<RuntimeTaskRecord>();
    const inspectStarted = deferred<void>();
    const cancellation = deferred<void>();
    const cancelStarted = deferred<void>();
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async dispatch() {
          return running;
        },
        async inspect() {
          inspectStarted.resolve();
          return inspection.promise;
        },
        async cancel() {
          cancelStarted.resolve();
          await cancellation.promise;
          throw new Error("REMOTE_CANCEL_FAILED");
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    await router.dispatch({ goal: "check", nodeIds: ["hw-1"], command: "date" });
    const refresh = router.readLiveTasks();
    await inspectStarted.promise;
    const cancelled = router.cancel(running.id);
    await cancelStarted.promise;
    cancellation.reject(new Error("REMOTE_CANCEL_FAILED"));
    await expect(cancelled).rejects.toThrow("REMOTE_CANCEL_FAILED");
    inspection.resolve(completed);
    await refresh;

    await expect(router.listTasks()).resolves.toContainEqual(completed);
  });

  it("does not occupy the aggregate version when every child cancellation fails", async () => {
    const huaweiRunning = {
      ...task("hw-1", "running", "HUAWEI"),
      evidence: [],
    };
    const instaboxRunning = {
      ...task("ib-1", "running", "INSTABOX"),
      evidence: [],
    };
    const huaweiCompleted = task("hw-1", "completed", "HUAWEI");
    const inspection = deferred<RuntimeTaskRecord>();
    const inspectStarted = deferred<void>();
    const cancellation = deferred<void>();
    const cancelStarted = deferred<void>();
    const router = new FleetRouter([
      {
        nodeIds: ["hw-1"],
        provider: {
          ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
          async dispatch() {
            return huaweiRunning;
          },
          async inspect() {
            inspectStarted.resolve();
            return inspection.promise;
          },
          async cancel() {
            cancelStarted.resolve();
            await cancellation.promise;
            throw new Error("HUAWEI_CANCEL_FAILED");
          },
        },
        taskPrefixes: ["HUAWEI-"],
      },
      {
        nodeIds: ["ib-1"],
        provider: {
          ...provider("instabox", "ib-1", "INSTABOX", []),
          async dispatch() {
            return instaboxRunning;
          },
          async cancel() {
            cancelStarted.resolve();
            await cancellation.promise;
            throw new Error("INSTABOX_CANCEL_FAILED");
          },
        },
        taskPrefixes: ["INSTABOX-"],
      },
    ]);

    const aggregate = await router.dispatch({
      goal: "cancel both",
      nodeIds: ["hw-1", "ib-1"],
      command: "date",
    });
    const refresh = router.readLiveTasks();
    await inspectStarted.promise;
    const cancelled = router.cancel(aggregate.id);
    await cancelStarted.promise;
    cancellation.reject(new Error("REMOTE_CANCEL_FAILED"));
    await expect(cancelled).rejects.toThrow("REMOTE_CANCEL_FAILED");
    inspection.resolve(huaweiCompleted);
    await refresh;

    const tasks = await router.listTasks();
    const completed = tasks.find((entry) => entry.id === aggregate.id);
    expect(completed?.childTaskRefs?.map((child) => child.status)).toEqual([
      "completed",
      "running",
    ]);
  });

  it("does not occupy the task version when an unknown cancellation fails", async () => {
    const inspected = task("hw-1", "completed", "HUAWEI");
    const inspection = deferred<RuntimeTaskRecord>();
    const inspectStarted = deferred<void>();
    const cancellation = deferred<void>();
    const cancelStarted = deferred<void>();
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async inspect() {
          inspectStarted.resolve();
          return inspection.promise;
        },
        async cancel() {
          cancelStarted.resolve();
          await cancellation.promise;
          throw new Error("REMOTE_CANCEL_FAILED");
        },
      },
      taskPrefixes: ["HUAWEI-"],
    }]);

    const inspectedTask = router.inspect(inspected.id);
    await inspectStarted.promise;
    const cancelled = router.cancel(inspected.id);
    await cancelStarted.promise;
    cancellation.reject(new Error("REMOTE_CANCEL_FAILED"));
    await expect(cancelled).rejects.toThrow("REMOTE_CANCEL_FAILED");
    inspection.resolve(inspected);
    await inspectedTask;

    await expect(router.listTasks()).resolves.toContainEqual(inspected);
  });

  it("catches unexpected background refresh rejections from listTasks", async () => {
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: provider("huawei-ssh", "hw-1", "HUAWEI", []),
      taskPrefixes: ["HUAWEI-"],
    }]);
    const refresh = vi.spyOn(router, "refreshTasks").mockImplementationOnce(() => {
      throw new Error("REFRESH_FAILED");
    });

    try {
      await expect(router.listTasks()).resolves.toEqual([]);
      await flushMicrotasks();
    } finally {
      refresh.mockRestore();
    }
  });

  it("routes restored same-family tasks by target node before a shared task prefix", async () => {
    const calls: string[] = [];
    const restored = task("node-b", "running", "HUAWEI");
    const providerA: RoutableFleetProvider = {
      ...provider("huawei-ssh:node-a", "node-a", "HUAWEI", calls),
      inspect: vi.fn(async (taskId) => {
        calls.push(`node-a:inspect:${taskId}`);
        throw new Error(`HUAWEI_TASK_NOT_FOUND:${taskId}`);
      }),
    };
    const providerB: RoutableFleetProvider = {
      ...provider("huawei-ssh:node-b", "node-b", "HUAWEI", calls),
      inspect: vi.fn(async (taskId) => {
        calls.push(`node-b:inspect:${taskId}`);
        return { ...restored, id: taskId, evidence: [] };
      }),
    };
    const router = new FleetRouter([
      { nodeIds: ["node-a"], provider: providerA, taskPrefixes: ["HUAWEI-"] },
      { nodeIds: ["node-b"], provider: providerB, taskPrefixes: ["HUAWEI-"] },
    ], { initialTasks: [restored] });

    await router.inspect(restored.id);
    expect(calls).toContain(`node-b:inspect:${restored.id}`);
    expect(calls).not.toContain(`node-a:inspect:${restored.id}`);

    await router.cancel(restored.id);
    expect(calls).toContain(`huawei-ssh:node-b:cancel:${restored.id}`);
    expect(calls).not.toContain(`huawei-ssh:node-a:cancel:${restored.id}`);
  });

  it("probes every same-prefix provider when an unknown task is not in the ledger", async () => {
    const taskId = "HUAWEI-unknown";
    const providerA: RoutableFleetProvider = {
      ...provider("huawei-ssh:node-a", "node-a", "HUAWEI", []),
      inspect: vi.fn(async () => {
        throw new Error(`HUAWEI_TASK_NOT_FOUND:${taskId}`);
      }),
    };
    const remoteTask = task("node-b", "running", "HUAWEI");
    const providerB: RoutableFleetProvider = {
      ...provider("huawei-ssh:node-b", "node-b", "HUAWEI", []),
      inspect: vi.fn(async () => ({ ...remoteTask, id: taskId, evidence: [] })),
    };
    const router = new FleetRouter([
      { nodeIds: ["node-a"], provider: providerA, taskPrefixes: ["HUAWEI-"] },
      { nodeIds: ["node-b"], provider: providerB, taskPrefixes: ["HUAWEI-"] },
    ]);

    await expect(router.inspect(taskId)).resolves.toMatchObject({
      id: taskId,
      targetNodeIds: ["node-b"],
    });
    expect(providerA.inspect).toHaveBeenCalledTimes(1);
    expect(providerB.inspect).toHaveBeenCalledTimes(1);
  });
  it.each(["inspect", "refresh", "cancel"] as const)(
    "keeps the latest idempotent receipt durable after %s",
    async (operation) => {
      const input = { goal: "durable receipt", command: "date", nodeIds: ["hw-1"], idempotencyKey: "receipt-key" };
      const restored: RuntimeTaskRecord = {
        ...task("hw-1", "running", "HUAWEI"),
        goal: input.goal,
        idempotencyKey: input.idempotencyKey,
        dispatchFingerprint: createDispatchFingerprint(input),
      };
      let saved: RuntimeTaskRecord[] = [];
      const dispatch = vi.fn(async () => task("hw-1", "running", "DUPLICATE"));
      const route = {
        nodeIds: ["hw-1"],
        taskPrefixes: ["HUAWEI-"],
        provider: {
          ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
          dispatch,
          async inspect() { return task("hw-1", "completed", "HUAWEI"); },
        },
      };
      const router = new FleetRouter([route], {
        initialTasks: [restored],
        onChange(tasks) { saved = tasks; },
      });

      if (operation === "inspect") await router.inspect(restored.id);
      else if (operation === "refresh") await router.refreshTasks();
      else await router.cancel(restored.id);
      const status = operation === "cancel" ? "cancelled" : "completed";
      expect(saved).toContainEqual(expect.objectContaining({
        id: restored.id, status, idempotencyKey: input.idempotencyKey,
        dispatchFingerprint: restored.dispatchFingerprint,
      }));
      await expect(router.dispatch(input)).resolves.toMatchObject({ id: restored.id, status });
      const restarted = new FleetRouter([route], { initialTasks: saved });
      await expect(restarted.dispatch(input)).resolves.toMatchObject({ id: restored.id, status });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(["inspect", "refresh", "cancel"] as const)(
    "preserves a one-child aggregate identity after %s",
    async (operation) => {
      const child = task("hw-1", "running", "HUAWEI");
      const restored: RuntimeTaskRecord = {
        ...child,
        id: "FLEET-one-child",
        goal: "aggregate goal",
        childTaskRefs: [{ id: child.id, targetNodeIds: ["hw-1"], status: "running" }],
      };
      const router = new FleetRouter([{
        nodeIds: ["hw-1"],
        provider: {
          ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
          async inspect() { return task("hw-1", "completed", "HUAWEI"); },
        },
      }], { initialTasks: [restored] });

      if (operation === "inspect") await router.inspect(restored.id);
      else if (operation === "refresh") await router.refreshTasks();
      else await router.cancel(restored.id);
      const [latest] = await router.listTasks();
      expect(latest).toMatchObject({
        id: restored.id,
        goal: restored.goal,
        status: operation === "cancel" ? "cancelled" : "completed",
        childTaskRefs: [{ id: child.id, status: operation === "cancel" ? "cancelled" : "completed" }],
      });
    },
  );

  it("reserves quota for legacy aggregate children with no persisted status", async () => {
    const restored: RuntimeTaskRecord = {
      ...task("hw-1", "running", "FLEET"),
      id: "FLEET-legacy",
      childTaskRefs: [{ id: "HUAWEI-legacy", targetNodeIds: ["hw-1"] }],
    };
    const dispatch = vi.fn(async () => task("hw-1", "running", "DUPLICATE"));
    const router = new FleetRouter([{
      nodeIds: ["hw-1"], provider: { ...provider("huawei-ssh", "hw-1", "HUAWEI", []), dispatch },
    }], {
      initialTasks: [restored],
      hostAccess: { "hw-1": { ownerId: "owner", sharingMode: "dedicated", maxConcurrentTasks: 1 } },
    });

    await expect(router.dispatch({ goal: "overflow", nodeIds: ["hw-1"] }))
      .rejects.toThrow("FLEET_NODE_CONCURRENCY_LIMIT:hw-1:1");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps a successful cancellation when an older running inspect settles first", async () => {
    const running = task("hw-1", "running", "HUAWEI");
    const inspected = deferred<RuntimeTaskRecord>();
    const inspectStarted = deferred<void>();
    const cancelled = deferred<void>();
    const cancelStarted = deferred<void>();
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async inspect() { inspectStarted.resolve(); return inspected.promise; },
        async cancel() { cancelStarted.resolve(); await cancelled.promise; },
      },
    }], { initialTasks: [running] });

    const refresh = router.refreshTasks();
    await inspectStarted.promise;
    const cancel = router.cancel(running.id);
    await cancelStarted.promise;
    inspected.resolve({ ...running, progress: 75 });
    await refresh;
    cancelled.resolve();
    await cancel;
    await expect(router.listTasks()).resolves.toContainEqual(
      expect.objectContaining({ id: running.id, status: "cancelled", progress: 75 }),
    );
  });

  it.each(["inspect", "refresh", "cancel"] as const)(
    "keeps an aggregate idempotent receipt durable after %s",
    async (operation) => {
      const input = { goal: "aggregate receipt", command: "date", nodeIds: ["hw-1", "ib-1"], idempotencyKey: "aggregate-receipt" };
      const restored: RuntimeTaskRecord = {
        ...task("hw-1", "running", "FLEET"),
        id: "FLEET-receipt",
        goal: input.goal,
        targetNodeIds: input.nodeIds,
        idempotencyKey: input.idempotencyKey,
        dispatchFingerprint: createDispatchFingerprint(input),
        childTaskRefs: [
          { id: "HUAWEI-hw-1", targetNodeIds: ["hw-1"], status: "running" },
          { id: "INSTABOX-ib-1", targetNodeIds: ["ib-1"], status: "running" },
        ],
      };
      let saved: RuntimeTaskRecord[] = [];
      const dispatch = vi.fn(async () => task("hw-1", "running", "DUPLICATE"));
      const routes = [
        { nodeId: "hw-1", prefix: "HUAWEI", providerId: "huawei-ssh" },
        { nodeId: "ib-1", prefix: "INSTABOX", providerId: "instabox" },
      ].map(({ nodeId, prefix, providerId }) => ({
        nodeIds: [nodeId],
        provider: {
          ...provider(providerId, nodeId, prefix, []),
          dispatch,
          async inspect() { return withExecutionReceipt(task(nodeId, "completed", prefix)); },
        },
      }));
      const router = new FleetRouter(routes, {
        initialTasks: [restored], onChange(tasks) { saved = tasks; },
      });
      if (operation === "inspect") await router.inspect(restored.id);
      else if (operation === "refresh") await router.refreshTasks();
      else await router.cancel(restored.id);
      const status = operation === "cancel" ? "cancelled" : "completed";
      expect(saved).toContainEqual(expect.objectContaining({
        id: restored.id, status, idempotencyKey: input.idempotencyKey,
        dispatchFingerprint: restored.dispatchFingerprint,
      }));
      await expect(router.dispatch(input)).resolves.toMatchObject({ id: restored.id, status });
      const restarted = new FleetRouter(routes, { initialTasks: saved });
      await expect(restarted.dispatch(input)).resolves.toMatchObject({ id: restored.id, status });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("keeps successful aggregate cancellations after an older refresh advances progress", async () => {
    const child = task("hw-1", "running", "HUAWEI");
    const restored: RuntimeTaskRecord = {
      ...child, id: "FLEET-cancel-race",
      childTaskRefs: [{ id: child.id, targetNodeIds: ["hw-1"], status: "running" }],
    };
    const inspected = deferred<RuntimeTaskRecord>();
    const inspectStarted = deferred<void>();
    const cancellation = deferred<void>();
    const cancelStarted = deferred<void>();
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        async inspect() { inspectStarted.resolve(); return inspected.promise; },
        async cancel() { cancelStarted.resolve(); await cancellation.promise; },
      },
    }], { initialTasks: [restored] });
    const refresh = router.refreshTasks();
    await inspectStarted.promise;
    const cancel = router.cancel(restored.id);
    await cancelStarted.promise;
    inspected.resolve({ ...child, progress: 75 });
    await refresh;
    cancellation.resolve();
    await cancel;
    await expect(router.listTasks()).resolves.toContainEqual(expect.objectContaining({
      id: restored.id, status: "cancelled",
      childTaskRefs: [{ id: child.id, targetNodeIds: ["hw-1"], status: "cancelled", progress: 75 }],
    }));
  });


  it("downgrades a restored aggregate when one completed child's receipt belongs to another task", async () => {
    const childEvidence = (nodeId: string, childId: string, receiptTaskId: string) => {
      const prefix = "[" + nodeId + "] " + childId + ":";
      return [
        { kind: "summary" as const, label: prefix + "summary", value: "status=completed\nexit=0\ntaskId=" + receiptTaskId },
        { kind: "command" as const, label: prefix + "stdout", value: "(empty)" },
        { kind: "log" as const, label: prefix + "stderr", value: "(empty)" },
      ];
    };
    const restored: RuntimeTaskRecord = {
      ...task("ib-1", "completed", "FLEET"),
      id: "FLEET-old-ledger",
      goal: "restore both children",
      targetNodeIds: ["ib-1", "hw-1"],
      status: "completed",
      expectedEvidence: ["summary", "command", "log"],
      childTaskRefs: [
        { id: "INSTABOX-ib-1", targetNodeIds: ["ib-1"], status: "completed" },
        { id: "HUAWEI-hw-1", targetNodeIds: ["hw-1"], status: "completed" },
      ],
      evidence: [
        ...childEvidence("ib-1", "INSTABOX-ib-1", "INSTABOX-ib-1"),
        ...childEvidence("hw-1", "HUAWEI-hw-1", "some-other-task"),
      ],
    };
    const router = new FleetRouter([
      { nodeIds: ["ib-1"], provider: provider("instabox", "ib-1", "INSTABOX", []) },
      { nodeIds: ["hw-1"], provider: provider("huawei-ssh", "hw-1", "HUAWEI", []) },
    ], { initialTasks: [restored] });

    const [recovered] = await router.listTasks();
    expect(recovered).toMatchObject({
      id: restored.id,
      status: "verifying",
      childTaskRefs: [
        { id: "INSTABOX-ib-1", status: "completed" },
        { id: "HUAWEI-hw-1", status: "verifying" },
      ],
    });
  });

  it("does not return a foreign receipt as completed through idempotent reuse", async () => {
    const input = {
      goal: "retry safe",
      command: "uname -a",
      nodeIds: ["hw-1"],
      idempotencyKey: "foreign-receipt-key",
    };
    const persisted: RuntimeTaskRecord = {
      ...task("hw-1", "completed", "HUAWEI"),
      idempotencyKey: input.idempotencyKey,
      dispatchFingerprint: createDispatchFingerprint(input),
      expectedEvidence: ["summary", "command", "log"],
      evidence: [
        { kind: "summary", label: "HUAWEI-hw-1:summary", value: "status=completed\nexit=0\ntaskId=foreign-task" },
        { kind: "command", label: "HUAWEI-hw-1:stdout", value: "(empty)" },
        { kind: "log", label: "HUAWEI-hw-1:stderr", value: "(empty)" },
      ],
    };
    const router = new FleetRouter([
      { nodeIds: ["hw-1"], provider: provider("huawei-ssh", "hw-1", "HUAWEI", []) },
    ], { initialTasks: [persisted] });

    await expect(router.dispatch(input)).resolves.toMatchObject({
      id: persisted.id,
      status: "verifying",
    });
  });


  it("keeps an unknown task cancelled when its inspect registers first", async () => {
    const taskId = "HUAWEI-unknown-cancel-race";
    const inspection = deferred<RuntimeTaskRecord>();
    const inspectStarted = deferred<void>();
    const cancellation = deferred<void>();
    const cancelStarted = deferred<void>();
    const providerUnderTest: RoutableFleetProvider = {
      ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
      async inspect() { inspectStarted.resolve(); return inspection.promise; },
      async cancel() { cancelStarted.resolve(); await cancellation.promise; },
    };
    const router = new FleetRouter([
      { nodeIds: ["hw-1"], provider: providerUnderTest, taskPrefixes: ["HUAWEI-"] },
    ]);

    const inspecting = router.inspect(taskId);
    await inspectStarted.promise;
    const cancelling = router.cancel(taskId);
    await cancelStarted.promise;
    inspection.resolve({ ...task("hw-1", "running", "HUAWEI"), id: taskId, evidence: [] });
    await inspecting;
    cancellation.resolve();
    await cancelling;

    await expect(router.listTasks()).resolves.toContainEqual(
      expect.objectContaining({ id: taskId, status: "cancelled" }),
    );
  });

  it("inspects a deterministic single-node task only once after an idempotent miss", async () => {
    const dispatch = vi.fn(async () => task("hw-1", "running", "HUAWEI"));
    const inspect = vi.fn(async (taskId: string) => {
      throw new Error("HUAWEI_TASK_NOT_FOUND:" + taskId);
    });
    const router = new FleetRouter([{
      nodeIds: ["hw-1"],
      taskPrefixes: ["HUAWEI-"],
      provider: {
        ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
        dispatch,
        inspect,
      },
    }]);

    await router.dispatch({
      goal: "recover once",
      command: "date",
      nodeIds: ["hw-1"],
      idempotencyKey: "inspect-once-key",
    });

    expect(inspect).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("reserves quota for a recovered child while another child is still being inspected", async () => {
    const input = { goal: "partial recovery", command: "date", nodeIds: ["hw-1", "ib-1"], idempotencyKey: "partial-reservation-key" };
    const fingerprint = createDispatchFingerprint(input);
    const recovered = deferred<RuntimeTaskRecord>();
    const inspectStarted = deferred<void>();
    const instaboxDispatch = vi.fn(async () => task("ib-1", "running", "INSTABOX"));
    const huaweiProvider: RoutableFleetProvider = {
      ...provider("huawei-ssh", "hw-1", "HUAWEI", []),
      async inspect(taskId) { throw new Error("HUAWEI_TASK_NOT_FOUND:" + taskId); },
    };
    const instaboxProvider: RoutableFleetProvider = {
      ...provider("instabox", "ib-1", "INSTABOX", []),
      dispatch: instaboxDispatch,
      async inspect(taskId) {
        inspectStarted.resolve();
        return { ...(await recovered.promise), id: taskId };
      },
    };
    const router = new FleetRouter([
      { nodeIds: ["hw-1"], provider: huaweiProvider, taskPrefixes: ["HUAWEI-"] },
      { nodeIds: ["ib-1"], provider: instaboxProvider, taskPrefixes: ["INSTABOX-"] },
    ], {
      hostAccess: {
        "ib-1": { ownerId: "owner", sharingMode: "dedicated", maxConcurrentTasks: 1 },
      },
    });

    const original = router.dispatch(input);
    await inspectStarted.promise;
    try {
      await expect(router.dispatch({ goal: "overlap", nodeIds: ["ib-1"] }))
        .rejects.toThrow("FLEET_NODE_CONCURRENCY_LIMIT:ib-1:1");
    } finally {
      recovered.resolve({
        ...task("ib-1", "running", "INSTABOX"),
        id: "INSTABOX-recovered",
        idempotencyKey: input.idempotencyKey,
        dispatchFingerprint: fingerprint,
        evidence: [],
      });
      await original;
    }
    expect(instaboxDispatch).not.toHaveBeenCalled();
  });

});
