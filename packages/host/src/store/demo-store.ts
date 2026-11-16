import type {
  BotRecord,
  ConfigSnapshot,
  FusionEvent,
  FusionEventInput,
  GroupRecord,
  NodeRecord,
  SessionRecord,
  TaskRecord,
  TaskStatus,
} from "@dsh-fusion/core";
import {
  FUSION_DEFAULT_MODEL_ROUTE,
  FUSION_DEFAULT_REASONING_EFFORT,
  FUSION_PLUGIN_VERSION,
} from "@dsh-fusion/core";
import {
  replayEventsWithGap,
  type FusionReplayResult,
} from "../events/event-bus.js";
import type { EvidenceSubmission, WorkerTaskEvent } from "../tasks/evidence.js";
import { TaskService } from "../tasks/task-service.js";

export interface FusionSnapshot {
  bots: BotRecord[];
  groups: GroupRecord[];
  nodes: NodeRecord[];
  sessions: SessionRecord[];
  tasks: TaskRecord[];
  config: ConfigSnapshot;
}

export class DemoStore {
  private readonly bots: BotRecord[];
  private readonly groups: GroupRecord[];
  private readonly nodes: NodeRecord[];
  private readonly sessions: SessionRecord[];
  private readonly tasks: TaskRecord[];
  private readonly config: ConfigSnapshot;
  private readonly events: FusionEvent[] = [];
  private readonly listeners = new Set<(event: FusionEvent) => void>();
  private nextSeq = 1;

  constructor(snapshot: FusionSnapshot) {
    this.bots = structuredClone(snapshot.bots);
    this.groups = structuredClone(snapshot.groups);
    this.nodes = structuredClone(snapshot.nodes);
    this.sessions = structuredClone(snapshot.sessions);
    this.tasks = structuredClone(snapshot.tasks);
    this.config = structuredClone(snapshot.config);
  }

  snapshot(): FusionSnapshot {
    return {
      bots: structuredClone(this.bots),
      groups: structuredClone(this.groups),
      nodes: structuredClone(this.nodes),
      sessions: structuredClone(this.sessions),
      tasks: structuredClone(this.tasks),
      config: structuredClone(this.config),
    };
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  createTask(input: { goal: string; nodeIds: string[]; requestedByBotId?: string | undefined }): TaskRecord {
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: `T-${Date.now()}-${this.tasks.length + 1}`,
      goal: input.goal,
      targetNodeIds: input.nodeIds,
      transport: "seekfleet",
      status: "queued",
      progress: 0,
      evidence: [],
      createdAt: now,
      updatedAt: now,
    };
    if (input.requestedByBotId !== undefined) task.requestedByBotId = input.requestedByBotId;
    this.tasks.unshift(task);
    this.publish({ type: "task.updated", taskId: task.id, status: task.status });
    return structuredClone(task);
  }

  setTaskStatus(taskId: string, status: TaskStatus, progress: number): TaskRecord | undefined {
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (task === undefined) return undefined;
    task.status = status === "completed" ? "verifying" : status;
    task.progress = progress;
    task.updatedAt = new Date().toISOString();
    this.publish({ type: "task.updated", taskId: task.id, status: task.status });
    return structuredClone(task);
  }

  cancelTask(taskId: string): TaskRecord | undefined {
    return this.setTaskStatus(taskId, "cancelled", 0);
  }

  applyWorkerEvent(taskId: string, event: WorkerTaskEvent): TaskRecord | undefined {
    const index = this.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return undefined;
    const updated = new TaskService(this.tasks[index]!).applyWorkerEvent(event);
    this.tasks[index] = updated;
    this.publish({ type: "task.updated", taskId: updated.id, status: updated.status });
    return structuredClone(updated);
  }

  completeTaskWithEvidence(taskId: string, submission: EvidenceSubmission) {
    const index = this.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return undefined;
    const result = new TaskService(this.tasks[index]!).completeWithEvidence(submission);
    this.tasks[index] = result.task;
    this.publish({ type: "task.updated", taskId: result.task.id, status: result.task.status });
    return structuredClone(result);
  }

  publish(input: FusionEventInput): FusionEvent {
    const event = {
      ...input,
      seq: this.nextSeq++,
      at: new Date().toISOString(),
    } as FusionEvent;
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: (event: FusionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  eventsSince(seq: number): FusionEvent[] {
    return this.events.filter((event) => event.seq > seq);
  }

  replayWithGap(afterSeq: number): FusionReplayResult {
    return replayEventsWithGap(this.events, this.lastSeq, afterSeq);
  }
}

export function createDemoSnapshot(): FusionSnapshot {
  return {
    bots: [
      {
        id: "chief",
        providerId: "demo",
        name: "Chief",
        role: "Chief of Staff",
        model: FUSION_DEFAULT_MODEL_ROUTE,
        reasoningEffort: FUSION_DEFAULT_REASONING_EFFORT,
        isMain: true,
        status: "idle",
        memoryCount: 12,
        usageTokens: 69000,
      },
      {
        id: "node-ops",
        providerId: "demo",
        name: "节点管家",
        role: "节点运维与资源管理",
        model: FUSION_DEFAULT_MODEL_ROUTE,
        reasoningEffort: FUSION_DEFAULT_REASONING_EFFORT,
        isMain: false,
        status: "working",
        memoryCount: 8,
        usageTokens: 18400,
      },
      {
        id: "executor",
        providerId: "demo",
        name: "工法管家",
        role: "工程方法与自动化",
        model: FUSION_DEFAULT_MODEL_ROUTE,
        reasoningEffort: FUSION_DEFAULT_REASONING_EFFORT,
        isMain: false,
        status: "idle",
        memoryCount: 6,
        usageTokens: 12100,
      },
      {
        id: "search",
        providerId: "demo",
        name: "搜索管家",
        role: "知识搜索与信息整理",
        model: FUSION_DEFAULT_MODEL_ROUTE,
        reasoningEffort: FUSION_DEFAULT_REASONING_EFFORT,
        isMain: false,
        status: "idle",
        memoryCount: 4,
        usageTokens: 9200,
      },
    ],
    groups: [
      { id: "content-code", providerId: "demo", name: "内容与代码", adminBotId: "chief", memberBotIds: ["chief", "executor", "search"], unreadCount: 3 },
      { id: "ops", providerId: "demo", name: "运维值班", adminBotId: "node-ops", memberBotIds: ["chief", "node-ops"], unreadCount: 0 },
    ],
    nodes: [
      {
        id: "windows-main",
        externalId: "windows-main",
        providerId: "demo",
        name: "Windows 控制机",
        platform: "windows",
        roles: ["control", "worker"],
        status: "online",
        transports: ["seekfleet", "ssh"],
        capabilities: ["windows", "powershell", "browser", "fleet"],
        dshVersion: "0.2.0-rc.2",
        configHash: "4f7c2a",
        configState: "current",
        lastHeartbeat: new Date().toISOString(),
        cpuPercent: 12,
        memoryPercent: 36,
      },
      {
        id: "tencent",
        externalId: "tencent",
        providerId: "demo",
        name: "腾讯 Worker",
        platform: "linux",
        roles: ["worker"],
        status: "online",
        transports: ["seekfleet", "ssh"],
        capabilities: ["linux", "build", "pytest", "fleet"],
        dshVersion: "0.2.0-rc.2",
        configHash: "4f7c2a",
        configState: "current",
        lastHeartbeat: new Date().toISOString(),
        cpuPercent: 48,
        memoryPercent: 62,
      },
      {
        id: "oracle",
        externalId: "oracle",
        providerId: "demo",
        name: "Oracle Worker",
        platform: "linux",
        roles: ["worker"],
        status: "online",
        transports: ["seekfleet", "ssh"],
        capabilities: ["linux", "gpu", "fleet"],
        dshVersion: "0.2.0-rc.2",
        configHash: "91d0be",
        configState: "drift",
        lastHeartbeat: new Date().toISOString(),
        cpuPercent: 18,
        memoryPercent: 41,
      },
    ],
    sessions: [
      { id: "session-chief", providerId: "demo", nodeId: "windows-main", botId: "chief", title: "Chief · 多机任务", status: "live", updatedAt: new Date().toISOString() },
      { id: "session-tencent", providerId: "demo", nodeId: "tencent", botId: "executor", title: "腾讯 · 全量测试", status: "live", updatedAt: new Date().toISOString() },
      { id: "session-oracle", providerId: "demo", nodeId: "oracle", botId: "node-ops", title: "Oracle · 配置检查", status: "idle", updatedAt: new Date().toISOString() },
    ],
    tasks: [
      {
        id: "T-demo-001",
        goal: "运行全量测试",
        requestedByBotId: "chief",
        targetNodeIds: ["windows-main", "tencent", "oracle"],
        transport: "seekfleet",
        status: "running",
        progress: 62,
        sessionId: "session-tencent",
        evidence: [
          { kind: "log", label: "windows-test.log", value: "环境准备完成" },
          { kind: "log", label: "tencent-test.log", value: "应用测试执行中" },
        ],
        expectedEvidence: ["log", "artifact"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    config: {
      revision: "4f7c2a",
      hash: "sha256:4f7c2a",
      desiredCommit: "4f7c2a",
      appliedCommit: "4f7c2a",
      pluginVersions: {
        "dsh-fusion": FUSION_PLUGIN_VERSION,
        "dsh-bots": "0.2.70",
        "seekfleet": "0.1.1",
      },
      nodeStates: {
        "windows-main": "current",
        tencent: "current",
        oracle: "drift",
      },
    },
  };
}

export function createEmptySnapshot(): FusionSnapshot {
  return {
    bots: [],
    groups: [],
    nodes: [],
    sessions: [],
    tasks: [],
    config: {
      revision: "unconfigured",
      hash: "sha256:unconfigured",
      pluginVersions: {
        "dsh-fusion": FUSION_PLUGIN_VERSION,
      },
      nodeStates: {},
    },
  };
}
