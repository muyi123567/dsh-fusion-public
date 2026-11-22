import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BridgeSchemaMismatchError,
  emptyAgentTeamsBridgeResult,
  mapAgentTeamsSnapshot,
  type NativeSessionSummary,
  type SessionControllerLike,
} from "@dsh-fusion/host";
import { loadNativeAgentTeams } from "./native-agent-teams.js";

type ReadController = Pick<SessionControllerLike, "list" | "projections">;

function session(sessionId: string, extra: Partial<NativeSessionSummary> = {}): NativeSessionSummary {
  return {
    sessionId,
    agentAvailable: false,
    updatedAt: 1_794_787_200_000,
    running: false,
    blank: false,
    cwd: "/workspace/fusion",
    ...extra,
  };
}

// Official dsh-v0.2.2-rc.3 TeamTaskView uses subject, not title.
// packages/team/agent-team/src/types.ts at 38a6a5c965aa99ab525161efb7cc5cf1fe62fced.
function task(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "implement",
    revision: 4,
    subject: "Implement native bridge",
    description: "Observe the root Session task board",
    status: "pending",
    blockedBy: ["design"],
    writeScopes: ["packages/plugin/src"],
    ready: false,
    writeScopeWarnings: ["packages/plugin/src overlaps review"],
    ownerId: "worker-session",
    ownerName: "root/worker",
    ...extra,
  };
}

function projection(team: unknown): { kind: "sequenced"; asOfSeq: number; values: Record<string, unknown> } {
  return { kind: "sequenced", asOfSeq: 17, values: { agentTeam: team } };
}

function controller(team: unknown, roots = [session("root")]): ReadController {
  return {
    list: vi.fn(async () => ({ items: roots })),
    projections: vi.fn(async () => projection(team)),
  };
}

afterEach(() => vi.useRealTimers());

describe("loadNativeAgentTeams", () => {
  it("returns undefined for absent capability and old contexts lacking read methods", async () => {
    await expect(loadNativeAgentTeams(undefined)).resolves.toBeUndefined();
    for (const old of [{}, { list: vi.fn() }, { projections: vi.fn() }, { list: 1, projections: 2 }]) {
      await expect(loadNativeAgentTeams(old as unknown as ReadController)).resolves.toBeUndefined();
      if ("list" in old && typeof old.list === "function") expect(old.list).not.toHaveBeenCalled();
    }
  });

  it("returns undefined when no root carries an agentTeam projection key", async () => {
    const reads: ReadController = {
      list: vi.fn(async () => ({ items: [session("root"), session("gone")] })),
      projections: vi.fn(async ({ sessionId }) => sessionId === "gone"
        ? null
        : { asOfSeq: 2, values: { goal: { phase: "active" } } }),
    };
    await expect(loadNativeAgentTeams(reads)).resolves.toBeUndefined();
    const noRoots = controller({ enabled: true, tasks: [] }, []);
    await expect(loadNativeAgentTeams(noRoots)).resolves.toBeUndefined();
    expect(noRoots.projections).not.toHaveBeenCalled();
  });

  it("avoids detail reads when the listing explicitly lacks a native board", async () => {
    const reads = controller({ enabled: true, tasks: [] }, [
      session("legacy-root", { projections: { kind: "sequenced", asOfSeq: 4, values: {} } }),
    ]);
    await expect(loadNativeAgentTeams(reads)).resolves.toBeUndefined();
    expect(reads.projections).not.toHaveBeenCalled();
  });

  it("distinguishes supported empty and disabled native boards from unavailable capability", async () => {
    const enabled = await loadNativeAgentTeams(controller({ enabled: true, tasks: [] }));
    expect(enabled).toBeDefined();
    expect(enabled?.tasks).toEqual([]);
    expect(enabled?.agentTeams).toMatchObject([{
      id: "dsh-native-team:root",
      providerId: "dsh-native-teams",
      captainSessionId: "root",
      memberIds: [],
      taskIds: [],
    }]);
    await expect(loadNativeAgentTeams(controller({ enabled: false, tasks: [] })))
      .resolves.toEqual(emptyAgentTeamsBridgeResult());
  });

  it("reads only roots using list({}, signal) and projections({sessionId}, signal)", async () => {
    const reads = controller({ enabled: true, tasks: [] }, [
      session("root"),
      session("child", { parentSessionId: "root" }),
      session("subagent", { origin: "subagent" }),
      session("nested", { parentSessionId: "child", origin: "subagent" }),
      session("root"), // Duplicate listing entries must not duplicate a board.
    ]);
    const initialize = vi.fn(() => { throw new Error("must never initialize an Agent"); });
    Object.assign(reads, { initialize });
    await loadNativeAgentTeams(reads);
    expect(reads.list).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(reads.list).mock.calls[0]?.[1];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(reads.list).toHaveBeenCalledWith({}, signal);
    expect(reads.projections).toHaveBeenCalledTimes(1);
    expect(reads.projections).toHaveBeenCalledWith({ sessionId: "root" }, signal);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("preserves real rc.3 metadata without inventing bots, groups, Sessions, or evidence", async () => {
    const nativeTask = task();
    const before = structuredClone(nativeTask);
    const reads = controller({ enabled: true, tasks: [nativeTask] });
    const result = await loadNativeAgentTeams(reads);
    expect(result?.tasks).toEqual([{
      id: "dsh-native-team:root:implement",
      goal: "Implement native bridge",
      description: "Observe the root Session task board",
      targetNodeIds: [],
      dependsOnTaskIds: ["dsh-native-team:root:design"],
      agentTeamTask: {
        teamId: "root",
        taskId: "implement",
        revision: 4,
        ownerId: "worker-session",
        ownerName: "root/worker",
        blockedBy: ["design"],
        writeScopes: ["packages/plugin/src"],
        ready: false,
        writeScopeWarnings: ["packages/plugin/src overlaps review"],
      },
      transport: "dsh-fleet",
      status: "queued",
      sessionId: "root",
      evidence: [],
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: new Date(session("root").updatedAt).toISOString(),
    }]);
    expect(result?.agentTeams[0]).toMatchObject({
      providerId: "dsh-native-teams",
      workspace: "/workspace/fusion",
      captainSessionId: "root",
      taskIds: ["dsh-native-team:root:implement"],
    });
    expect(result?.bots).toEqual([]);
    expect(result?.groups).toEqual([]);
    expect(result?.sessions).toEqual([]);
    expect(nativeTask).toEqual(before);
    result?.tasks[0]?.agentTeamTask?.blockedBy.push("local");
    expect(nativeTask.blockedBy).toEqual(["design"]);
  });

  it.each([
    ["multiline", "\n  Preserve the task body.\r\n\r\nReview <details> literally.  \n"],
    ["explicitly empty", ""],
  ])("preserves %s native task descriptions verbatim", async (_label, description) => {
    const nativeTask = task({ description });
    const before = structuredClone(nativeTask);
    const result = await loadNativeAgentTeams(controller({ enabled: true, tasks: [nativeTask] }));

    expect(result?.tasks[0]).toHaveProperty("description", description);
    expect(result?.tasks[0]?.goal).toBe("Implement native bridge");
    expect(nativeTask).toEqual(before);
  });

  it.each([
    ["pending", "queued"],
    ["in_progress", "running"],
    ["completed", "completed"],
    ["deleted", "cancelled"],
  ])("maps native %s to observed %s", async (status, expected) => {
    const result = await loadNativeAgentTeams(controller({
      enabled: true,
      tasks: [task({ status, blockedBy: [], writeScopes: [], writeScopeWarnings: [], ready: true })],
    }));
    expect(result?.tasks[0]?.status).toBe(expected);
    expect(result?.tasks[0]?.agentTeamTask?.ready).toBe(true);
    expect(result?.tasks[0]?.agentTeamTask?.writeScopeWarnings).toEqual([]);
  });

  it("keeps root and task namespace components unambiguous", async () => {
    const reads = controller({ enabled: true, tasks: [task({ id: "x:y", blockedBy: ["a:b"] })] }, [
      session("root:branch"), session("root"),
    ]);
    const result = await loadNativeAgentTeams(reads);
    expect(result?.tasks.map((entry) => entry.id)).toEqual([
      "dsh-native-team:root%3Abranch:x%3Ay", "dsh-native-team:root:x%3Ay",
    ]);
    expect(result?.tasks[0]?.dependsOnTaskIds).toEqual(["dsh-native-team:root%3Abranch:a%3Ab"]);
    expect(result?.tasks[0]?.agentTeamTask?.taskId).toBe("x:y");
  });

  it.each([
    undefined,
    null,
    { enabled: true },
    { tasks: [] },
    { enabled: true, tasks: {} },
    { enabled: "true", tasks: [] },
    { enabled: true, tasks: [task({ subject: undefined, title: "wrong contract" })] },
    { enabled: true, tasks: [task({ description: undefined })] },
    { enabled: true, tasks: [task({ description: null })] },
    { enabled: true, tasks: [task({ revision: -1 })] },
    { enabled: true, tasks: [task({ status: "running" })] },
    { enabled: true, tasks: [task({ blockedBy: "design" })] },
    { enabled: true, tasks: [task({ writeScopes: [1] })] },
    { enabled: true, tasks: [task({ ready: "yes" })] },
    { enabled: true, tasks: [task({ writeScopeWarnings: [{}] })] },
    { enabled: true, tasks: [task(), task()] },
    { enabled: true, tasks: [], failure: 42 },
    { teams: [] }, // Legacy companion envelope is not a native projection.
  ])("rejects malformed known native projection %#", async (value) => {
    await expect(loadNativeAgentTeams(controller(value))).rejects.toBeInstanceOf(BridgeSchemaMismatchError);
  });

  it.each(["migration-required", "cached"])("rejects %s projection caches", async (kind) => {
    const reads = controller({ enabled: true, tasks: [] });
    vi.mocked(reads.projections).mockResolvedValueOnce({
      kind, asOfSeq: 17, values: { agentTeam: { enabled: true, tasks: [] } },
    } as Awaited<ReturnType<ReadController["projections"]>>);
    await expect(loadNativeAgentTeams(reads)).rejects.toBeInstanceOf(BridgeSchemaMismatchError);
  });

  it("surfaces TeamProjection.failure even if the last valid tasks are present", async () => {
    await expect(loadNativeAgentTeams(controller({
      enabled: true, tasks: [task()], failure: "TEAM_JOURNAL_INVALID",
    }))).rejects.toThrow("TEAM_JOURNAL_INVALID");
  });

  it("rejects malformed controller response envelopes rather than returning green empty", async () => {
    const reads = controller({ enabled: true, tasks: [] });
    vi.mocked(reads.list).mockResolvedValueOnce({} as Awaited<ReturnType<ReadController["list"]>>);
    await expect(loadNativeAgentTeams(reads)).rejects.toBeInstanceOf(BridgeSchemaMismatchError);
    vi.mocked(reads.projections).mockResolvedValueOnce({ asOfSeq: 1 } as Awaited<ReturnType<ReadController["projections"]>>);
    await expect(loadNativeAgentTeams(reads)).rejects.toBeInstanceOf(BridgeSchemaMismatchError);
  });

  it.each(["list", "projections"] as const)("bounds a hung %s read even when it ignores cancellation", async (method) => {
    vi.useFakeTimers();
    const reads = controller({ enabled: true, tasks: [] });
    let observedSignal: AbortSignal | undefined;
    if (method === "list") {
      vi.mocked(reads.list).mockImplementation((_request, signal) => {
        observedSignal = signal;
        return new Promise(() => {});
      });
    } else {
      vi.mocked(reads.projections).mockImplementation((_request, signal) => {
        observedSignal = signal;
        return new Promise(() => {});
      });
    }
    const rejected = expect(loadNativeAgentTeams(reads, 25)).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(observedSignal?.aborted).toBe(true);
  });

  it("limits projection concurrency to four and preserves listing order", async () => {
    const roots = Array.from({ length: 9 }, (_, i) => session("root-" + i));
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const reads: ReadController = {
      list: vi.fn(async () => ({ items: roots })),
      projections: vi.fn(async () => {
        maximum = Math.max(maximum, ++active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return projection({ enabled: true, tasks: [] });
      }),
    };
    const loading = loadNativeAgentTeams(reads);
    for (const count of [4, 8, 9]) {
      await vi.waitFor(() => expect(reads.projections).toHaveBeenCalledTimes(count));
      for (const release of releases.splice(0).reverse()) release();
    }
    const result = await loading;
    expect(maximum).toBe(4);
    expect(result?.agentTeams.map((entry) => entry.captainSessionId)).toEqual(roots.map((entry) => entry.sessionId));
  });

  it("propagates read failures and aborts the round without reading more roots", async () => {
    const reads = controller({ enabled: true, tasks: [] }, Array.from({ length: 12 }, (_, i) => session("root-" + i)));
    const failure = new Error("projection permission denied");
    let observedSignal: AbortSignal | undefined;
    vi.mocked(reads.projections).mockImplementation(async (_request, signal) => {
      observedSignal = signal;
      throw failure;
    });
    await expect(loadNativeAgentTeams(reads)).rejects.toBe(failure);
    expect(observedSignal?.aborted).toBe(true);
    expect(vi.mocked(reads.projections).mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("leaves the legacy mapper and its namespace intact for the main-thread merge", async () => {
    const legacy = mapAgentTeamsSnapshot({ teams: [{
      teamId: "root", captainSessionId: "root", tasks: [{ id: "implement", subject: "Legacy", status: "pending" }],
    }] });
    const before = structuredClone(legacy);
    const native = await loadNativeAgentTeams(controller({ enabled: true, tasks: [task()] }));
    expect(legacy).toEqual(before);
    expect(legacy.tasks[0]?.id).toBe("agent-teams:root:implement");
    expect(native?.tasks[0]?.id).toBe("dsh-native-team:root:implement");
    expect(native?.agentTeams[0]?.id).not.toBe(legacy.agentTeams[0]?.id);
  });

  it.each([undefined, NaN, Infinity, -2, 0.5, Number.MAX_SAFE_INTEGER + 1, "17"])(
    "rejects malformed sequenced projection cursors %# instead of a healthy empty board",
    async (asOfSeq) => {
      const reads = controller({ enabled: true, tasks: [] });
      vi.mocked(reads.projections).mockResolvedValueOnce({
        ...projection({ enabled: true, tasks: [] }), asOfSeq,
      } as Awaited<ReturnType<ReadController["projections"]>>);
      await expect(loadNativeAgentTeams(reads)).rejects.toBeInstanceOf(BridgeSchemaMismatchError);
    },
  );

  it("accepts the upstream empty-log cursor -1", async () => {
    const reads = controller({ enabled: true, tasks: [] });
    vi.mocked(reads.projections).mockResolvedValueOnce({
      ...projection({ enabled: true, tasks: [] }), asOfSeq: -1,
    });
    expect((await loadNativeAgentTeams(reads))?.agentTeams).toHaveLength(1);
  });

  it.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid task revision %s", async (revision) => {
    await expect(loadNativeAgentTeams(controller({ enabled: true, tasks: [task({ revision })] })))
      .rejects.toBeInstanceOf(BridgeSchemaMismatchError);
  });

  it.each(["", " ", "\ud800"])("rejects invalid native identity %j before namespace encoding", async (id) => {
    for (const reads of [
      controller({ enabled: true, tasks: [] }, [session(id)]),
      controller({ enabled: true, tasks: [task({ id })] }),
      controller({ enabled: true, tasks: [task({ blockedBy: [id] })] }),
    ]) {
      await expect(loadNativeAgentTeams(reads)).rejects.toBeInstanceOf(BridgeSchemaMismatchError);
    }
  });

  it("validates tasks even on disabled boards instead of hiding corruption", async () => {
    await expect(loadNativeAgentTeams(controller({ enabled: false, tasks: [task({ ready: "yes" })] })))
      .rejects.toBeInstanceOf(BridgeSchemaMismatchError);
    await expect(loadNativeAgentTeams(controller({ enabled: false, tasks: [task()] })))
      .resolves.toEqual(emptyAgentTeamsBridgeResult());
  });

  it("rejects sparse task and blocker arrays as schema mismatches", async () => {
    for (const tasks of [new Array(1), [task({ blockedBy: new Array(1) })]]) {
      await expect(loadNativeAgentTeams(controller({ enabled: true, tasks })))
        .rejects.toBeInstanceOf(BridgeSchemaMismatchError);
    }
  });

  it("does not schedule later roots when one concurrent read fails beside a success", async () => {
    const roots = Array.from({ length: 9 }, (_, i) => session("root-" + i));
    const releases: Array<{ resolve: (value: ReturnType<typeof projection>) => void; reject: (error: Error) => void }> = [];
    const reads: ReadController = {
      list: vi.fn(async () => ({ items: roots })),
      projections: vi.fn(() => new Promise<ReturnType<typeof projection>>((resolve, reject) => releases.push({ resolve, reject }))),
    };
    const failure = new Error("first board failed");
    const rejected = expect(loadNativeAgentTeams(reads)).rejects.toBe(failure);
    await vi.waitFor(() => expect(reads.projections).toHaveBeenCalledTimes(4));
    releases[0]!.reject(failure);
    for (const release of releases.slice(1)) release.resolve(projection({ enabled: true, tasks: [] }));
    await rejected;
    await Promise.resolve();
    expect(reads.projections).toHaveBeenCalledTimes(4);
  });

  it("does not resume reading roots after a timed-out controller eventually returns", async () => {
    vi.useFakeTimers();
    let finishList!: (value: { items: NativeSessionSummary[] }) => void;
    const reads = controller({ enabled: true, tasks: [] });
    vi.mocked(reads.list).mockImplementation(() => new Promise((resolve) => { finishList = resolve; }));
    const rejected = expect(loadNativeAgentTeams(reads, 10)).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    finishList({ items: [session("late-root")] });
    await vi.runAllTimersAsync();
    expect(reads.projections).not.toHaveBeenCalled();
  });

  it("keeps percent escapes and Unicode namespace components distinct", async () => {
    const result = await loadNativeAgentTeams(controller({
      enabled: true, tasks: [task({ id: "x:y" }), task({ id: "x%3Ay" }), task({ id: "任务" })],
    }, [session("root:branch"), session("root%3Abranch")]));
    const ids = result!.tasks.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(6);
    expect(result!.tasks.map((entry) => entry.agentTeamTask!.taskId))
      .toEqual(["x:y", "x%3Ay", "任务", "x:y", "x%3Ay", "任务"]);
  });

});
