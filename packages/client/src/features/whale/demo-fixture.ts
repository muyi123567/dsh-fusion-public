import type { AgentTeamRecord, NodeRecord, TaskRecord } from "@dsh-fusion/core";
import { buildWhalePanelModel } from "./model.js";

/**
 * SYNTHETIC DESIGN-GALLERY DATA ONLY.
 * A/B/C share this exact exported model. Runtime model.ts never imports it.
 * Fixed dates are fixture metadata, not a claim of live observation or latency.
 */
const AT = "2026-11-16T08:00:00.000Z";
const PROVIDER = "whale-design-demo";

function host(id: string, name: string, patch: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id, externalId: id, providerId: PROVIDER, name, platform: "linux",
    roles: ["worker"], status: "online", configState: "current",
    transports: ["ssh"], capabilities: [], ...patch,
  };
}
function task(id: string, goal: string, status: TaskRecord["status"], hostIds: string[], patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id, goal, status, targetNodeIds: hostIds, transport: "ssh",
    evidence: [], createdAt: AT, updatedAt: AT, ...patch,
  };
}
function team(id: string, name: string, taskIds: string[], patch: Partial<AgentTeamRecord> = {}): AgentTeamRecord {
  return {
    id, providerId: PROVIDER, name, workspace: `/design-gallery/${id}`,
    phase: "running", captainSessionId: `demo-captain:${id}`,
    memberIds: [`demo-captain:${id}`, `demo-worker:${id}:1`, `demo-worker:${id}:2`],
    taskIds, ...patch,
  };
}

const nodes: NodeRecord[] = [
  host("demo-north", "North · 构建", {
    cpuPercent: 48, memoryPercent: 62,
    hostAccess: { sharingMode: "shared", maxConcurrentTasks: 4, ownerId: "demo-build" },
  }),
  host("demo-tide", "Tide · 测试", {
    cpuPercent: 27, memoryPercent: 38, configState: "drift",
    hostAccess: { sharingMode: "shared", maxConcurrentTasks: 3 },
  }),
  host("demo-reef", "Reef · 审查", {
    // CPU and memory absent: intentionally unknown, never fabricated as zero.
    hostAccess: { sharingMode: "shared", maxConcurrentTasks: 2 },
  }),
  host("demo-deep", "Deep · 运行", {
    status: "offline", configState: "unknown",
    unavailableReason: "合成演示：主机离线，资源读数未观测。",
    hostAccess: { sharingMode: "dedicated", maxConcurrentTasks: 1 },
  }),
];

const tasks: TaskRecord[] = [
  task("demo-voyage-1", "构建面板候选", "running", ["demo-north"], { progress: 64 }),
  task("demo-voyage-2", "生成可复核产物", "completed", ["demo-north"], {
    progress: 100,
    evidence: [{ kind: "artifact", label: "合成演示产物", value: "demo://gallery/candidate" }],
  }),
  task("demo-voyage-3", "等待构建候选", "queued", ["demo-north"], {
    dependsOnTaskIds: ["demo-voyage-1"],
  }),
  task("demo-voyage-4", "检查任务入口", "claimed", ["demo-reef"]),
  task("demo-echo-1", "执行交互回归", "running", ["demo-tide"], { progress: 38 }),
  task("demo-echo-2", "审查回归证据", "verifying", ["demo-reef"], {
    // 100% reported progress is still verifying, never completed.
    progress: 100,
    evidence: [{ kind: "summary", label: "合成演示回执", value: "待独立验收" }],
  }),
  task("demo-echo-3", "检查配置漂移", "failed", ["demo-tide"], {
    error: "合成演示：配置核对失败，等待处理。",
  }),
  task("demo-echo-4", "整理测试摘要", "queued", ["demo-tide"]),
  task("demo-bay-1", "运行环境核对", "failed", ["demo-deep"], {
    error: "合成演示：目标主机离线，未确认运行结果。",
  }),
  task("demo-bay-2", "复核依赖结果", "verifying", ["demo-reef"], {
    evidence: [{ kind: "summary", label: "合成演示摘要", value: "等待审查" }],
  }),
  task("demo-bay-3", "确认可用性", "completed", ["demo-tide"], { progress: 100 }),
  // queued is the core pending state; blocked remains a separate derived flag.
  task("demo-bay-4", "等待运行条件", "queued", ["demo-deep"], {
    dependsOnTaskIds: ["demo-bay-1"],
    agentTeamTask: {
      teamId: "demo-bay", taskId: "waiting-runtime", revision: 3,
      ready: false, blockedBy: [], writeScopes: [],
    },
  }),
];

const agentTeams: AgentTeamRecord[] = [
  team("demo-voyage", "远航", ["demo-voyage-1", "demo-voyage-2", "demo-voyage-3", "demo-voyage-4"]),
  team("demo-echo", "回声", ["demo-echo-1", "demo-echo-2", "demo-echo-3", "demo-echo-4"]),
  team("demo-bay", "蓝湾", ["demo-bay-1", "demo-bay-2", "demo-bay-3", "demo-bay-4"], { phase: "staged" }),
];

export const WHALE_DEMO_MODEL = buildWhalePanelModel({
  nodes, tasks, agentTeams, demo: true, loaded: true, stale: false,
});
