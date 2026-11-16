import { describe, expect, it } from "vitest";
import { BridgeSchemaMismatchError } from "@dsh-fusion/host";
import {
  createFusionRuntime,
  type HuaweiRuntimeProvider,
  type RuntimeAgentFlowRecord,
  type RuntimeAgentTeamRecord,
  type RuntimeBotRecord,
  type RuntimeGroupRecord,
  type RuntimeNodeRecord,
  type RuntimeRoomRecord,
  type RuntimeSessionRecord,
  type RuntimeTaskEvidence,
  type RuntimeTaskDispatchInput,
  type RuntimeTaskRecord,
} from "./plugin-runtime.js";

const checkedAt = 1_700_000_000_000;

const node: RuntimeNodeRecord = {
  id: "node-huawei",
  externalId: "root@huawei",
  providerId: "huawei-ssh",
  name: "Huawei Worker",
  platform: "linux",
  roles: ["worker"],
  status: "online",
  transports: ["ssh"],
  capabilities: ["ssh", "monitor"],
  configState: "current",
  lastHeartbeat: "2026-10-21T00:00:00.000Z",
};

const bot: RuntimeBotRecord = {
  id: "agent-teams:team-1:captain",
  providerId: "agent-teams",
  name: "Captain",
  role: "coordinator",
  model: "deepseek",
  isMain: true,
  status: "working",
  memoryCount: 3,
  usageTokens: 120,
};

const group: RuntimeGroupRecord = {
  id: "agent-room:room-1",
  providerId: "agent-room",
  name: "Release Room",
  memberBotIds: [bot.id],
  unreadCount: 2,
};

const session: RuntimeSessionRecord = {
  id: "agent-bus:session-1",
  providerId: "agent-bus",
  title: "Release review",
  status: "live",
  updatedAt: "2026-10-21T00:02:00.000Z",
};

const task: RuntimeTaskRecord = {
  id: "agent-bus:task-1",
  goal: "Verify release",
  targetNodeIds: [node.id],
  transport: "ssh",
  status: "running",
  progress: 50,
  evidence: [],
  expectedEvidence: ["command"],
  createdAt: "2026-10-21T00:01:00.000Z",
  updatedAt: "2026-10-21T00:02:00.000Z",
};

const agentTeam: RuntimeAgentTeamRecord = {
  id: "agent-teams:team-1",
  providerId: "agent-teams",
  name: "Release Team",
  workspace: "F:\\AI\\release",
  phase: "running",
  captainSessionId: "agent-teams:team-1:captain",
  memberIds: [bot.id],
  taskIds: ["agent-teams:team-1:task-1"],
};

const agentFlow: RuntimeAgentFlowRecord = {
  id: "agent-bus:flow-1",
  providerId: "agent-bus",
  name: "Release Flow",
  workspacePath: "F:\\AI\\release",
  taskIds: [task.id],
  archived: false,
};

const room: RuntimeRoomRecord = {
  id: "agent-room:room-1",
  providerId: "agent-room",
  name: "Release Room",
  topic: "Release readiness",
  status: "open",
  leaderSessionId: "agent-room:room-1:leader",
  memberIds: [bot.id],
  activityCount: 2,
};

const doctorEvidence: RuntimeTaskEvidence[] = [{
  kind: "command",
  label: "huawei-doctor",
  value: "systemctl is-system-running: running",
}];

const dispatchInput: RuntimeTaskDispatchInput = {
  goal: "Verify kernel",
  nodeIds: [node.id],
  command: "uname -r",
};

describe("FusionRuntime", () => {
  it("marks a missing optional native task board not-configured", async () => {
    const runtime = createFusionRuntime({
      loaders: { agentTeams: async () => { throw new Error("NATIVE_AGENT_TEAMS_UNAVAILABLE"); } },
    });
    const snapshot = await runtime.snapshot();
    expect(snapshot.providers.agentTeams.state).toBe("not-configured");
  });

  it("merges every configured provider into one snapshot with statuses", async () => {
    const runtime = createFusionRuntime({
      loaders: {
        nodes: async () => ({ nodes: [node] }),
        agentTeams: async () => ({
          bots: [bot],
          groups: [],
          sessions: [],
          tasks: [],
          agentTeams: [agentTeam],
        }),
        agentBus: async () => ({
          sessions: [session],
          tasks: [task],
          agentFlows: [agentFlow],
        }),
        room: async () => ({
          groups: [group],
          sessions: [],
          rooms: [room],
        }),
      },
      huaweiProvider: {
        id: "huawei-test",
        async health() {
          return { state: "connected", checkedAt, version: "test" };
        },
        async dispatch() {
          return task;
        },
        async doctor() {
          return { node, evidence: doctorEvidence };
        },
      },
    });

    const snapshot = await runtime.snapshot();

    expect(snapshot.nodes).toEqual([node]);
    expect(snapshot.bots).toEqual([bot]);
    expect(snapshot.groups).toEqual([group]);
    expect(snapshot.sessions).toEqual([session]);
    expect(snapshot.tasks).toEqual([task]);
    expect(snapshot.agentTeams).toEqual([agentTeam]);
    expect(snapshot.agentFlows).toEqual([agentFlow]);
    expect(snapshot.rooms).toEqual([room]);
    expect(snapshot.providers.nodes.state).toBe("connected");
    expect(snapshot.providers.agentTeams.state).toBe("connected");
    expect(snapshot.providers.agentBus.state).toBe("connected");
    expect(snapshot.providers.room.state).toBe("connected");
    expect(snapshot.providers.huawei).toMatchObject({
      state: "connected",
      version: "test",
    });
  });

  it("keeps successful provider data when AgentTeams fails", async () => {
    const runtime = createFusionRuntime({
      loaders: {
        nodes: async () => ({ nodes: [node] }),
        agentTeams: async () => {
          throw new Error("AgentTeams unavailable");
        },
        room: async () => ({
          groups: [group],
          sessions: [],
          rooms: [room],
        }),
      },
    });

    const snapshot = await runtime.snapshot();

    expect(snapshot.nodes).toEqual([node]);
    expect(snapshot.groups).toEqual([group]);
    expect(snapshot.rooms).toEqual([room]);
    expect(snapshot.agentTeams).toEqual([]);
    expect(snapshot.providers.nodes.state).toBe("connected");
    expect(snapshot.providers.room.state).toBe("connected");
    expect(snapshot.providers.agentTeams).toMatchObject({
      state: "offline",
      message: "AgentTeams unavailable",
      error: {
        code: "LOAD_FAILED",
        message: "AgentTeams unavailable",
      },
    });
  });

  it("deduplicates records merged from multiple providers by stable id", async () => {
    const runtime = createFusionRuntime({
      loaders: {
        agentTeams: async () => ({
          bots: [bot],
          groups: [],
          sessions: [session, { ...session, title: "duplicate session" }],
          tasks: [task],
          agentTeams: [agentTeam],
        }),
        agentBus: async () => ({
          sessions: [{ ...session, title: "AgentBus session" }],
          tasks: [{ ...task, goal: "duplicate task" }],
          agentFlows: [agentFlow],
        }),
      },
    });

    const snapshot = await runtime.snapshot();

    expect(snapshot.sessions).toEqual([session]);
    expect(snapshot.tasks).toEqual([task]);
  });

  it("includes locally tracked remote tasks in snapshots", async () => {
    const runtime = createFusionRuntime({
      loaders: {
        tasks: async () => [task],
      },
    });

    await expect(runtime.snapshot()).resolves.toMatchObject({
      tasks: [task],
    });
  });

  it("records rejected and timed out loaders without rejecting the snapshot", async () => {
    const runtime = createFusionRuntime({
      timeoutMs: 25,
      loaders: {
        nodes: async () => ({ nodes: [node] }),
        agentBus: async () => {
          throw new Error("AgentBus rejected");
        },
        room: () => new Promise(() => {}),
      },
    });

    const snapshot = await runtime.snapshot();

    expect(snapshot.nodes).toEqual([node]);
    expect(snapshot.providers.agentBus).toMatchObject({
      state: "offline",
      error: {
        code: "LOAD_FAILED",
        message: "AgentBus rejected",
      },
    });
    expect(snapshot.providers.room).toMatchObject({
      state: "offline",
      error: {
        code: "TIMEOUT",
        message: "room timed out after 25ms",
      },
    });
  });

  it("marks a schema-mismatched bridge source offline instead of connected with zero tasks", async () => {
    const runtime = createFusionRuntime({
      loaders: {
        agentBus: async () => {
          throw new Error("BRIDGE_SCHEMA_MISMATCH:agent-bus:tasks");
        },
      },
    });

    const snapshot = await runtime.snapshot();

    expect(snapshot.providers.agentBus).toMatchObject({
      state: "offline",
      error: {
        code: "SCHEMA_MISMATCH",
        message: "BRIDGE_SCHEMA_MISMATCH:agent-bus:tasks",
      },
    });
    expect(snapshot.tasks).toEqual([]);
  });

  it("reports a loader-provided fetch time as the provider checkedAt instead of now", async () => {
    const runtime = createFusionRuntime({
      loaders: {
        agentBus: async () => ({
          sessions: [],
          tasks: [],
          agentFlows: [],
          fetchedAt: 1_234_567,
        }),
        agentTeams: async () => ({
          bots: [],
          groups: [],
          sessions: [],
          tasks: [],
          agentTeams: [],
        }),
      },
    });

    const snapshot = await runtime.snapshot();

    // The bus data was fetched at the loader-reported time
    // (e.g. served from a bridge round cache): checkedAt must
    // be that fetch time, not the snapshot moment. A provider
    // without a reported fetch time keeps the live stamp.
    expect(snapshot.providers.agentBus).toMatchObject({
      state: "connected",
      checkedAt: 1_234_567,
    });
    expect(snapshot.providers.agentTeams.checkedAt).toBeGreaterThan(1_700_000_000_000);
  });

  it("classifies a BridgeSchemaMismatchError instance with the dedicated code", async () => {
    const runtime = createFusionRuntime({
      loaders: {
        room: async () => {
          throw new BridgeSchemaMismatchError("room", "shape");
        },
      },
    });

    const snapshot = await runtime.snapshot();

    expect(snapshot.providers.room).toMatchObject({
      state: "offline",
      error: {
        code: "SCHEMA_MISMATCH",
        message: "BRIDGE_SCHEMA_MISMATCH:room:shape",
      },
    });
  });

  it("runs in no-provider mode and rejects Huawei-only actions", async () => {
    const runtime = createFusionRuntime();

    const snapshot = await runtime.snapshot();

    expect(snapshot).toEqual({
      nodes: [],
      bots: [],
      groups: [],
      sessions: [],
      tasks: [],
      fleetTasks: [],
      bridgeTasks: [],
      config: [],
      agentTeams: [],
      agentFlows: [],
      rooms: [],
      providers: {
        nodes: expect.objectContaining({ state: "not-configured" }),
        agentTeams: expect.objectContaining({ state: "not-configured" }),
        agentBus: expect.objectContaining({ state: "not-configured" }),
        room: expect.objectContaining({ state: "not-configured" }),
        huawei: expect.objectContaining({ state: "not-configured" }),
      },
    });
    await expect(runtime.dispatchTask(dispatchInput)).rejects.toThrow("HUAWEI_PROVIDER_NOT_CONFIGURED");
    await expect(runtime.doctorNode()).rejects.toThrow("HUAWEI_PROVIDER_NOT_CONFIGURED");
    await expect(runtime.cancelTask("task-1")).rejects.toThrow("HUAWEI_PROVIDER_NOT_CONFIGURED");
    await expect(runtime.inspectTask("task-1")).rejects.toThrow("HUAWEI_PROVIDER_NOT_CONFIGURED");
  });

  it("reuses a cached fleet snapshot instead of probing the remote again", async () => {
    let nodeProbes = 0;
    let taskProbes = 0;
    const runtime = createFusionRuntime({
      loaders: {
        nodes: async () => {
          nodeProbes += 1;
          return { nodes: [node] };
        },
        tasks: async () => {
          taskProbes += 1;
          return [task];
        },
      },
      cachedFleet: {
        nodes: [node],
        tasks: [task],
        huawei: { state: "connected", checkedAt },
        nodeProvider: { state: "connected", checkedAt },
      },
    });

    const snapshot = await runtime.snapshot();

    expect(snapshot.nodes).toEqual([node]);
    expect(snapshot.fleetTasks).toEqual([task]);
    expect(snapshot.bridgeTasks).toEqual([]);
    expect(snapshot.providers.nodes.state).toBe("connected");
    expect(snapshot.providers.huawei.state).toBe("connected");
    expect(nodeProbes).toBe(0);
    expect(taskProbes).toBe(0);
  });

  it("reports the observed configuration state of each node", async () => {
    const runtime = createFusionRuntime({
      cachedFleet: {
        nodes: [node],
        tasks: [],
        huawei: { state: "connected", checkedAt },
        nodeProvider: { state: "connected", checkedAt },
        configStates: [{ nodeId: node.id, state: "drift", hash: "sha256:bbb" }],
      },
    });

    const snapshot = await runtime.snapshot();

    expect(snapshot.config).toEqual([
      { nodeId: node.id, state: "drift", hash: "sha256:bbb" },
    ]);
  });

  it("reports no configuration state when nothing was observed", async () => {
    const runtime = createFusionRuntime({
      cachedFleet: {
        nodes: [node],
        tasks: [],
        huawei: { state: "connected", checkedAt },
        nodeProvider: { state: "connected", checkedAt },
      },
    });

    const snapshot = await runtime.snapshot();

    expect(snapshot.config).toEqual([]);
  });

  it("separates fleet tasks from upstream bridge tasks in a snapshot", async () => {
    const runtime = createFusionRuntime({
      loaders: {
        agentTeams: async () => ({
          bots: [],
          groups: [],
          sessions: [],
          tasks: [{ ...task, id: "agent-teams:task-1" }],
          agentTeams: [],
        }),
        tasks: async () => [task],
      },
    });

    const snapshot = await runtime.snapshot();

    expect(snapshot.fleetTasks.map((entry) => entry.id)).toEqual([task.id]);
    expect(snapshot.bridgeTasks.map((entry) => entry.id)).toEqual(["agent-teams:task-1"]);
    expect(snapshot.tasks.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([task.id, "agent-teams:task-1"]),
    );
  });

  it("delegates task dispatch and node doctor to the Huawei provider", async () => {
    const dispatchedTask: RuntimeTaskRecord = {
      ...task,
      id: "HUAWEI-dispatched",
      status: "completed",
      progress: 100,
    };
    const calls: Array<{ operation: string; input?: RuntimeTaskDispatchInput; taskId?: string }> = [];
    const huaweiProvider: HuaweiRuntimeProvider = {
      id: "huawei-test",
      async health() {
        return { state: "connected", checkedAt };
      },
      async dispatch(input) {
        calls.push({ operation: "dispatch", input });
        return dispatchedTask;
      },
      async doctor() {
        calls.push({ operation: "doctor" });
        return { node, evidence: doctorEvidence };
      },
      async inspect(taskId) {
        calls.push({ operation: "inspect", taskId });
        return dispatchedTask;
      },
      async cancel(taskId) {
        calls.push({ operation: "cancel", taskId });
      },
    };
    const runtime = createFusionRuntime({ huaweiProvider });

    await expect(runtime.dispatchTask(dispatchInput)).resolves.toEqual(dispatchedTask);
    await expect(runtime.doctorNode()).resolves.toEqual({ node, evidence: doctorEvidence });
    await expect(runtime.inspectTask(" task-1 ")).resolves.toEqual(dispatchedTask);
    await expect(runtime.cancelTask(" task-1 ")).resolves.toBeUndefined();
    expect(calls).toEqual([
      { operation: "dispatch", input: dispatchInput },
      { operation: "doctor" },
      { operation: "inspect", taskId: "task-1" },
      { operation: "cancel", taskId: "task-1" },
    ]);
  });

  it("serializes cyclic route data and bigint values without throwing", () => {
    const runtime = createFusionRuntime();
    const payload: Record<string, unknown> = {
      ok: true,
      count: 42n,
    };
    payload.self = payload;

    const json = runtime.serializeRouteJson(payload);
    const parsed = JSON.parse(json) as {
      ok: boolean;
      count: string;
      self: string;
    };

    expect(parsed).toEqual({
      ok: true,
      count: "42",
      self: "[Circular]",
    });
  });
});
