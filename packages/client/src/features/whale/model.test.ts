import { describe, expect, it } from "vitest";
import type { AgentTeamRecord, NodeRecord, TaskRecord } from "@dsh-fusion/core";
import { buildWhalePanelModel, WHALE_PANEL_LIMITS } from "./model.js";
import { WHALE_DEMO_MODEL } from "./demo-fixture.js";

const AT = "2026-11-16T08:00:00.000Z";

function node(id: string, patch: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id, externalId: id, providerId: "synthetic-hosts", name: id,
    platform: "linux", roles: ["worker"], status: "online",
    configState: "current", transports: ["ssh"], capabilities: [], ...patch,
  };
}
function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id, goal: id, targetNodeIds: ["north"], transport: "ssh",
    status: "running", evidence: [], createdAt: AT, updatedAt: AT, ...patch,
  };
}
function team(id: string, taskIds: string[], patch: Partial<AgentTeamRecord> = {}): AgentTeamRecord {
  return {
    id, providerId: "synthetic-teams", name: id, workspace: "/demo",
    phase: "running", captainSessionId: `captain:${id}`,
    memberIds: ["captain", "worker"], taskIds, ...patch,
  };
}
function project(tasks: TaskRecord[] = [], nodes: NodeRecord[] = [], agentTeams: AgentTeamRecord[] = []) {
  return buildWhalePanelModel({ tasks, nodes, agentTeams, loaded: true, stale: false, demo: false });
}
function freezeDeep(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeDeep(child);
  Object.freeze(value);
}

describe("buildWhalePanelModel", () => {
  it("distinguishes unobserved, observed-empty, stale and explicitly marked demo", () => {
    const input = { nodes: [], tasks: [], demo: false, loaded: false, stale: true };
    expect(buildWhalePanelModel(input)).toMatchObject({
      pods: [], hosts: [], krill: [], attention: [], freshness: "unobserved", demo: false,
      summary: { hosts: 0, online: 0, teams: 0, active: 0, waiting: 0, completed: 0, unknownHosts: 0 },
    });
    expect(buildWhalePanelModel({ ...input, loaded: true, stale: false }).freshness).toBe("current");
    expect(buildWhalePanelModel({ ...input, loaded: true }).freshness).toBe("stale");
    expect(buildWhalePanelModel({ ...input, demo: true }).demo).toBe(true);
    expect(project().demo).toBe(false);
  });

  it("uses exact team taskIds, never names, transport, provider or projection teamId alone", () => {
    const tasks = [
      task("exact", { goal: "same", targetNodeIds: ["north", "north", "missing-host"] }),
      task("looks-related", { goal: "same" }),
      task("native-only", {
        agentTeamTask: { teamId: "voyage", taskId: "native", blockedBy: [], writeScopes: [] },
      }),
      task("other", { targetNodeIds: ["reef"] }),
    ];
    const model = project(tasks, [node("north"), node("reef")], [
      team("voyage", ["exact", "exact", "not-observed"], { name: "same", memberIds: ["a", "a", "b"] }),
      team("echo", ["other"], { name: "same" }),
    ]);
    expect(model.pods[0]).toMatchObject({
      id: "voyage", taskIds: ["exact", "not-observed"], hostIds: ["north", "missing-host"], memberCount: 2, active: 1,
    });
    expect(model.krill.find((entry) => entry.id === "exact")?.teamId).toBe("voyage");
    expect(model.krill.find((entry) => entry.id === "looks-related")).not.toHaveProperty("teamId");
    expect(model.krill.find((entry) => entry.id === "native-only")).not.toHaveProperty("teamId");
    expect(model.krill).toHaveLength(4);
    expect(model.summary.teams).toBe(2);
    expect(model.summary.unknownHosts).toBe(1);
  });

  it("does not invent one team owner for taskIds explicitly shared by two teams", () => {
    const model = project([task("shared")], [node("north")], [
      team("one", ["shared"]), team("two", ["shared"]),
    ]);
    expect(model.pods.map((pod) => pod.taskIds)).toEqual([["shared"], ["shared"]]);
    expect(model.krill[0]).not.toHaveProperty("teamId");
    expect(model.summary.active).toBe(1);
    expect(model.hosts[0]?.active).toBe(1);
  });

  it("deduplicates stable IDs and target IDs without coalescing equal names", () => {
    const model = project([
      task("repeat", { status: "failed" }),
      task("repeat", { status: "running", targetNodeIds: ["north", "north"] }),
      task("separate", { goal: "repeat", status: "queued" }),
    ], [node("north", { status: "offline" }), node("north"), node("other", { name: "north" })], [
      team("one", ["repeat"]), team("one", ["repeat", "separate"]),
    ]);
    expect(model.summary).toMatchObject({ hosts: 2, online: 2, teams: 1, active: 1, waiting: 1 });
    expect(model.hosts.find((host) => host.id === "north")?.active).toBe(1);
    expect(model.krill).toHaveLength(2);
    expect(model.attention).toEqual([]);
  });

  it("counts host execution leaves once, retaining parents and children as selectable task records", () => {
    const model = project([
      task("parent", {
        targetNodeIds: ["north", "tide", "reef"],
        childTaskRefs: [
          { id: "child-a", targetNodeIds: ["north"] },
          { id: "child-a", targetNodeIds: ["north"] },
          { id: "child-b", targetNodeIds: ["north"] },
          { id: "terminal-child", targetNodeIds: ["tide"] },
          { id: "not-observed", targetNodeIds: ["reef"], status: "running" },
        ],
      }),
      task("child-a"),
      task("child-b", { targetNodeIds: ["north", "north"] }),
      task("terminal-child", { targetNodeIds: ["tide"], status: "completed" }),
    ], [node("north"), node("tide"), node("reef")]);
    expect(model.hosts.map((host) => [host.id, host.active])).toEqual([
      ["north", 2], ["tide", 0], ["reef", 1],
    ]);
    expect(model.krill).toHaveLength(4);
    expect(model.krill.some((entry) => entry.id === "not-observed")).toBe(false);
    expect(model.summary).toMatchObject({ active: 3, completed: 1 });
  });

  it("uses inline child states for host load and links inline failures to the parent", () => {
    const parent = task("FLEET-parent", {
      targetNodeIds: ["north", "tide", "reef"],
      childTaskRefs: [
        { id: "inline-done", targetNodeIds: ["north"], status: "completed" },
        { id: "inline-running", targetNodeIds: ["tide", "tide"], status: "running" },
        { id: "inline-running", targetNodeIds: ["tide", "tide"], status: "running" },
        { id: "inline-failed", targetNodeIds: ["reef"], status: "failed" },
      ],
    });
    freezeDeep(parent);
    const model = project([parent], [node("north"), node("tide"), node("reef")]);
    expect(model.hosts.map((host) => host.active)).toEqual([0, 1, 0]);
    expect(model.krill.map((entry) => entry.id)).toEqual(["FLEET-parent"]);
    expect(model.krill[0]?.status).toBe("running");
    expect(model.summary.active).toBe(1);
    expect(model.attention).toHaveLength(1);
    expect(model.attention[0]).toMatchObject({ taskId: "FLEET-parent", severity: "error" });
    expect(model.attention[0]?.detail).toContain("inline-failed");
    expect(model.attention[0]).not.toHaveProperty("hostId");
  });

  it("prefers full child records over stale inline states without counting the parent again", () => {
    for (const status of ["running", "completed"] as const) {
      const model = project([
        task("FLEET-parent", {
          childTaskRefs: [{ id: "child", targetNodeIds: ["north"], status: "failed" }],
        }),
        task("child", { status }),
      ], [node("north")]);
      expect(model.hosts[0]?.active).toBe(status === "running" ? 1 : 0);
      expect(model.attention).toEqual([]);
    }
  });

  it("retains unobserved team declarations without fabricating task records or status totals", () => {
    const model = project([], [], [team("declared", ["missing", "missing"])]);
    expect(model.pods[0]).toMatchObject({
      taskIds: ["missing"], hostIds: [], active: 0, completed: 0, blocked: 0,
    });
    expect(model.krill).toEqual([]);
    expect(model.attention).toEqual([]);
    expect(model.summary).toMatchObject({ teams: 1, active: 0, waiting: 0, completed: 0 });
  });

  it("deduplicates mirrored native dependencies even before the dependency record is observed", () => {
    const dependent = task("agent-teams:T:A", {
      status: "queued",
      dependsOnTaskIds: ["agent-teams:T:B", "agent-teams:T:B"],
      agentTeamTask: { teamId: "T", taskId: "A", blockedBy: ["B", "B"], writeScopes: [] },
    });
    const missing = project([dependent]);
    expect(missing.krill[0]).toMatchObject({ dependencies: 1, blocked: true });
    const observed = project([dependent, task("agent-teams:T:B", {
      status: "completed",
      agentTeamTask: { teamId: "T", taskId: "B", blockedBy: [], writeScopes: [] },
    })]);
    expect(observed.krill.find((entry) => entry.id === dependent.id)).toMatchObject({
      dependencies: 1, blocked: false,
    });
  });

  it("keeps real descendant targets even when stale child refs disagree", () => {
    const model = project([
      task("parent", { childTaskRefs: [{ id: "child", targetNodeIds: ["old-host"] }] }),
      task("child"),
      task("self", { targetNodeIds: ["reef"], childTaskRefs: [{ id: "self", targetNodeIds: ["reef"] }] }),
    ], [node("north"), node("reef")]);
    expect(model.hosts.map((host) => host.active)).toEqual([1, 1]);
    expect(model.summary.unknownHosts).toBe(0);
  });

  it("retains each missing host ID without creating hosts or treating unassigned as an unknown host", () => {
    const model = project([
      task("first", { targetNodeIds: ["missing", "missing", "north"] }),
      task("second", { targetNodeIds: ["missing", "other-missing"] }),
      task("unassigned", { targetNodeIds: [] }),
    ], [node("north")]);
    expect(model.krill[0]?.hostIds).toEqual(["missing", "north"]);
    expect(model.krill[1]?.hostIds).toEqual(["missing", "other-missing"]);
    expect(model.krill[2]?.hostIds).toEqual([]);
    expect(model.summary).toMatchObject({ hosts: 1, unknownHosts: 2 });
    expect(model.hosts.map((host) => host.id)).toEqual(["north"]);
    expect(model.attention).toEqual([]);
  });

  it("normalizes unsafe percentages while preserving genuine zero and unknown", () => {
    const model = project([
      task("nan", { progress: NaN }), task("inf", { progress: Infinity }),
      task("negative", { progress: -9 }), task("overflow", { progress: 125 }),
      task("zero", { progress: 0 }), task("fraction", { progress: 42.5 }), task("absent"),
    ], [
      node("nan", { cpuPercent: NaN, memoryPercent: Infinity }),
      node("clamp", { cpuPercent: -10, memoryPercent: 130 }),
      node("zero", { cpuPercent: 0, memoryPercent: 0 }),
    ]);
    expect(model.hosts[0]).not.toHaveProperty("cpu");
    expect(model.hosts[0]).not.toHaveProperty("memory");
    expect(model.hosts[1]).toMatchObject({ cpu: 0, memory: 100 });
    expect(model.hosts[2]).toMatchObject({ cpu: 0, memory: 0 });
    expect(model.krill.map((entry) => entry.progress)).toEqual([undefined, undefined, 0, 100, 0, 42.5, undefined]);
    expect(model.krill[0]).not.toHaveProperty("progress");
    expect(model.krill[1]).not.toHaveProperty("progress");
    expect(model.krill[6]).not.toHaveProperty("progress");
  });

  it("retains only valid capacity/revision metadata without guessing resource usage", () => {
    const model = project([
      task("invalid", { agentTeamTask: {
        teamId: "native", taskId: "bad", blockedBy: [], writeScopes: [], revision: Infinity,
      } }),
      task("valid", { agentTeamTask: {
        teamId: "native", taskId: "good", blockedBy: [], writeScopes: [], revision: 0,
      } }),
    ], [
      node("valid", { hostAccess: { sharingMode: "shared", ownerId: "operator", maxConcurrentTasks: 3 } }),
      node("invalid", { hostAccess: { sharingMode: "shared", maxConcurrentTasks: NaN } }),
    ]);
    expect(model.hosts[0]).toMatchObject({ capacity: 3, owner: "operator" });
    expect(model.hosts[1]).not.toHaveProperty("capacity");
    expect(model.hosts[1]).not.toHaveProperty("cpu");
    expect(model.krill[0]).not.toHaveProperty("revision");
    expect(model.krill[1]?.revision).toBe(0);
  });

  it("keeps verifying separate from completed, including reported progress of 100", () => {
    const model = project([
      task("verify", { status: "verifying", progress: 100 }),
      task("done", { status: "completed" }),
      task("claimed", { status: "claimed" }),
      task("queued", { status: "queued" }),
      task("failed", { status: "failed" }),
      task("cancelled", { status: "cancelled" }),
    ], [node("north")], [team("all", ["verify", "done", "claimed", "queued", "failed", "cancelled"])]);
    expect(model.summary).toMatchObject({ active: 2, waiting: 1, completed: 1 });
    expect(model.pods[0]).toMatchObject({ active: 2, completed: 1 });
    expect(model.hosts[0]?.active).toBe(2);
    expect(model.krill.find((entry) => entry.id === "verify")?.status).toBe("verifying");
    expect(model.krill.find((entry) => entry.id === "done")).not.toHaveProperty("progress");
    expect(model.attention.find((entry) => entry.taskId === "verify")).toMatchObject({ severity: "warning" });
  });

  it("derives blocked from unfinished or missing dependencies and native readiness, never inventing a status", () => {
    const model = project([
      task("done", { status: "completed" }),
      task("pending", { status: "queued" }),
      task("clear", { status: "queued", dependsOnTaskIds: ["done"] }),
      task("wait", { status: "queued", dependsOnTaskIds: ["pending", "pending", "missing"] }),
      task("native", { status: "claimed", agentTeamTask: {
        teamId: "external", taskId: "native", ready: false, blockedBy: [], writeScopes: [],
      } }),
      task("old-terminal", { status: "completed", dependsOnTaskIds: ["pending"] }),
    ], [node("north")], [team("all", ["clear", "wait", "native", "old-terminal"])]);
    expect(model.krill.find((entry) => entry.id === "clear")?.blocked).toBe(false);
    expect(model.krill.find((entry) => entry.id === "wait")).toMatchObject({
      status: "queued", blocked: true, dependencies: 2,
    });
    expect(model.krill.find((entry) => entry.id === "native")).toMatchObject({ status: "claimed", blocked: true });
    expect(model.krill.find((entry) => entry.id === "old-terminal")?.blocked).toBe(false);
    expect(model.pods[0]?.blocked).toBe(2);
    expect(model.attention.filter((entry) => entry.taskId).map((entry) => entry.taskId)).toEqual(["wait", "native"]);
  });

  it("resolves native blockedBy in its team namespace and deduplicates mirrored dependencies", () => {
    const projection = (teamId: string, taskId: string, blockedBy: string[] = []) => ({
      teamId, taskId, blockedBy, writeScopes: [],
    });
    const model = project([
      task("team-a:done", { status: "completed", agentTeamTask: projection("a", "same") }),
      task("team-b:pending", { status: "queued", agentTeamTask: projection("b", "same") }),
      task("a:clear", { status: "queued", agentTeamTask: projection("a", "next", ["same"]) }),
      task("b:wait", {
        status: "queued", dependsOnTaskIds: ["team-b:pending"],
        agentTeamTask: projection("b", "next", ["same", "same"]),
      }),
      task("c:missing", { status: "queued", agentTeamTask: projection("c", "next", ["same"]) }),
    ]);
    expect(model.krill.find((entry) => entry.id === "a:clear")).toMatchObject({ blocked: false, dependencies: 1 });
    expect(model.krill.find((entry) => entry.id === "b:wait")).toMatchObject({ blocked: true, dependencies: 1 });
    expect(model.krill.find((entry) => entry.id === "c:missing")).toMatchObject({ blocked: true, dependencies: 1 });
  });

  it("emits only offline/drift/failed/blocked/verifying attention with exact callback IDs", () => {
    const model = project([
      task("failed", { status: "failed", error: "synthetic failure" }),
      task("verify", { status: "verifying" }),
      task("blocked", { status: "queued", dependsOnTaskIds: ["absent"] }),
      task("done", { status: "completed" }),
      task("cancel", { status: "cancelled" }),
    ], [
      node("down", { status: "offline", configState: "drift" }),
      node("degraded", { status: "degraded", configState: "unknown" }),
      node("quiet", { cpuPercent: 99 }),
    ]);
    expect(model.attention).toHaveLength(5);
    expect(new Set(model.attention.map((entry) => entry.id)).size).toBe(5);
    for (const entry of model.attention) {
      expect(Boolean(entry.taskId) !== Boolean(entry.hostId)).toBe(true);
      if (entry.taskId) expect(["failed", "verify", "blocked"]).toContain(entry.taskId);
      if (entry.hostId) expect(entry.hostId).toBe("down");
    }
    expect(model.attention.find((entry) => entry.taskId === "failed")).toMatchObject({
      severity: "error", detail: "synthetic failure",
    });
    const stale = buildWhalePanelModel({ tasks: [], nodes: [], loaded: true, stale: true, demo: false });
    expect(stale.attention).toEqual([]);
  });

  it("is deterministic and never mutates or exposes input arrays", () => {
    const input = {
      nodes: [node("north")],
      tasks: [task("one", { dependsOnTaskIds: ["missing"], progress: NaN })],
      agentTeams: [team("team", ["one", "one"])], loaded: true, stale: false, demo: false,
    };
    freezeDeep(input);
    const first = buildWhalePanelModel(input);
    const second = buildWhalePanelModel(input);
    expect(first).toEqual(second);
    expect(Number.isNaN(input.tasks[0]?.progress)).toBe(true);
    first.krill[0]?.hostIds.push("local-selection");
    first.pods[0]?.taskIds.push("local-selection");
    first.pods[0]?.hostIds.push("local-selection");
    expect(input.tasks[0]?.targetNodeIds).toEqual(["north"]);
    expect(input.agentTeams[0]?.taskIds).toEqual(["one", "one"]);
    expect(second.krill[0]?.hostIds).toEqual(["north"]);
  });

  it("bounds returned rows and relationship arrays but counts the complete observed input", () => {
    const nodes = Array.from({ length: WHALE_PANEL_LIMITS.hosts + 5 }, (_, i) => node(`h${i}`));
    const tasks = Array.from({ length: WHALE_PANEL_LIMITS.krill + 7 }, (_, i) => task(`t${i}`, {
      status: i === WHALE_PANEL_LIMITS.krill + 6 ? "failed" : "running",
      targetNodeIds: ["h0", `unobserved-${i}`],
    }));
    const teams = Array.from({ length: WHALE_PANEL_LIMITS.pods + 3 }, (_, i) => team(`p${i}`, tasks.map((entry) => entry.id)));
    const model = project(tasks, nodes, teams);
    expect(model.hosts).toHaveLength(WHALE_PANEL_LIMITS.hosts);
    expect(model.krill).toHaveLength(WHALE_PANEL_LIMITS.krill);
    expect(model.pods).toHaveLength(WHALE_PANEL_LIMITS.pods);
    expect(model.pods[0]?.taskIds).toHaveLength(WHALE_PANEL_LIMITS.krill);
    expect(model.pods[0]?.hostIds).toHaveLength(WHALE_PANEL_LIMITS.hosts);
    expect(model.summary).toMatchObject({
      hosts: nodes.length, online: nodes.length, teams: teams.length,
      active: tasks.length - 1, unknownHosts: tasks.length,
    });
    expect(model.hosts[0]?.active).toBe(tasks.length - 1);
    expect(model.pods[0]?.active).toBe(tasks.length - 1);
    expect(model.attention.some((entry) => entry.taskId === tasks.at(-1)?.id)).toBe(true);
    const alerts = project(
      Array.from({ length: WHALE_PANEL_LIMITS.attention + 5 }, (_, i) => task(`verify${i}`, { status: "verifying" })),
      [node("offline", { status: "offline" })],
    ).attention;
    expect(alerts).toHaveLength(WHALE_PANEL_LIMITS.attention);
    expect(alerts[0]).toMatchObject({ hostId: "offline", severity: "error" });
  });
});

describe("WHALE_DEMO_MODEL", () => {
  it("is one explicitly synthetic 3-team / 4-host / 12-task gallery dataset", () => {
    expect(WHALE_DEMO_MODEL.demo).toBe(true);
    expect(WHALE_DEMO_MODEL.freshness).toBe("current");
    expect(WHALE_DEMO_MODEL.summary).toMatchObject({ teams: 3, hosts: 4 });
    expect(WHALE_DEMO_MODEL.krill).toHaveLength(12);
    expect(WHALE_DEMO_MODEL.pods.map((pod) => pod.name)).toEqual(["远航", "回声", "蓝湾"]);
    expect(WHALE_DEMO_MODEL.hosts.map((host) => host.name)).toEqual([
      "North · 构建", "Tide · 测试", "Reef · 审查", "Deep · 运行",
    ]);
    expect(WHALE_DEMO_MODEL.hosts.some((host) => host.status === "offline")).toBe(true);
    expect(WHALE_DEMO_MODEL.hosts.some((host) => host.configState === "drift")).toBe(true);
    expect(WHALE_DEMO_MODEL.hosts.some((host) => host.cpu === undefined)).toBe(true);
    expect(new Set(WHALE_DEMO_MODEL.krill.map((entry) => entry.status))).toEqual(new Set([
      "queued", "claimed", "running", "verifying", "completed", "failed",
    ]));
    expect(project().krill).toEqual([]);
    expect(project().pods).toEqual([]);
  });
});
