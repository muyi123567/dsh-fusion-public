import type { AgentTeamRecord, NodeRecord, SessionHubSnapshot, TaskRecord, TaskStatus } from "@dsh-fusion/core";
import type { WhaleAttention, WhaleHost, WhaleKrill, WhalePanelModel, WhalePod } from "./types.js";

/**
 * Rendering bounds, not source totals. Summary and per-pod/per-host counts use
 * ALL distinct observed records, before clipping. Link arrays use the matching
 * row limit; callers should label bounded views and offer the full task/fleet
 * destination. Attention is a bounded queue, not a total incident count.
 */
export const WHALE_PANEL_LIMITS = Object.freeze({
  pods: 80,
  hosts: 160,
  krill: 600,
  attention: 80,
});

export interface WhalePanelInput {
  sessionHub?: SessionHubSnapshot;
  nodes: NodeRecord[];
  tasks: TaskRecord[];
  agentTeams?: AgentTeamRecord[];
  demo: boolean;
  loaded: boolean;
  stale: boolean;
}

function distinct<T extends { id: string }>(records: readonly T[]): T[] {
  // Stable identity only. Last occurrence wins; never merge by name/transport.
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

function percent(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : undefined;
}

function nonnegativeInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function active(status: TaskStatus): boolean {
  return status === "claimed" || status === "running" || status === "verifying";
}

function terminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function nativeKey(teamId: string, taskId: string): string {
  return JSON.stringify([teamId, taskId]);
}

/**
 * Pure, read-only projection. Never dispatches, reads clocks or imports fixtures.
 *
 * Task totals count distinct TaskRecord IDs (parents remain selectable).
 * Host.active counts active observed execution records, yielding a parent's
 * host slot to its observed children on that host. Inline child states count;
 * missing child states are never invented. Host counts are consequently not additive with task totals.
 * unknownHosts counts distinct target IDs absent from the full node snapshot;
 * an unassigned task (zero target IDs) does not create an imaginary host.
 *
 * Only AgentTeam.taskIds establishes pod membership. Missing team/task data
 * stays unknown; ambiguous multi-pod membership does not invent a single owner.
 */
export function buildWhalePanelModel(input: WhalePanelInput): WhalePanelModel {
  const nodes = distinct(input.nodes);
  const tasks = distinct(input.tasks);
  const teams = distinct(input.agentTeams ?? []);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const nativeTasks = new Map<string, TaskRecord>();
  const hostIdsByTask = new Map<string, string[]>();
  const teamIdsByTask = new Map<string, Set<string>>();
  const teamTasks = new Map<string, TaskRecord[]>();
  const krillById = new Map<string, WhaleKrill>();
  const hostActive = new Map<string, Set<string>>();
  const unknownHosts = new Set<string>();
  const countHostExecution = (hostId: string, taskId: string): void => {
    const executions = hostActive.get(hostId) ?? new Set<string>();
    executions.add(taskId);
    hostActive.set(hostId, executions);
  };

  for (const task of tasks) {
    const hostIds = [...new Set(task.targetNodeIds)];
    hostIdsByTask.set(task.id, hostIds);
    for (const hostId of hostIds) {
      if (!nodesById.has(hostId)) unknownHosts.add(hostId);
    }
    const native = task.agentTeamTask;
    if (native !== undefined) nativeTasks.set(nativeKey(native.teamId, native.taskId), task);
  }

  for (const team of teams) {
    const observed: TaskRecord[] = [];
    for (const taskId of new Set(team.taskIds)) {
      const task = tasksById.get(taskId);
      if (task === undefined) continue;
      observed.push(task);
      const memberships = teamIdsByTask.get(taskId) ?? new Set<string>();
      memberships.add(team.id);
      teamIdsByTask.set(taskId, memberships);
    }
    teamTasks.set(team.id, observed);
  }

  let activeCount = 0;
  let waitingCount = 0;
  let completedCount = 0;

  for (const task of tasks) {
    const dependencies = new Set<string>();
    let unfinishedDependency = false;
    const declaredDependencyIds = new Set(task.dependsOnTaskIds ?? []);
    for (const dependencyId of declaredDependencyIds) {
      if (dependencyId === "") continue;
      dependencies.add(JSON.stringify(["task", dependencyId]));
      if (tasksById.get(dependencyId)?.status !== "completed") unfinishedDependency = true;
    }
    const native = task.agentTeamTask;
    for (const dependencyId of native?.blockedBy ?? []) {
      if (dependencyId === "" || native === undefined) continue;
      // The bridge's explicit namespace identifies mirrors even in partial snapshots.
      const mirrorId = `agent-teams:${native.teamId}:${dependencyId}`;
      const dependency = nativeTasks.get(nativeKey(native.teamId, dependencyId))
        ?? tasksById.get(mirrorId);
      const resolvedId = dependency?.id ?? (declaredDependencyIds.has(mirrorId) ? mirrorId : undefined);
      dependencies.add(resolvedId === undefined
        ? JSON.stringify(["native", native.teamId, dependencyId])
        : JSON.stringify(["task", resolvedId]));
      if (dependency?.status !== "completed") unfinishedDependency = true;
    }
    const blocked = !terminal(task.status) && (native?.ready === false || unfinishedDependency);
    const progress = percent(task.progress);
    const revision = nonnegativeInteger(native?.revision);
    const memberships = teamIdsByTask.get(task.id);
    const teamId = memberships?.size === 1 ? [...memberships][0] : undefined;
    const hostIds = hostIdsByTask.get(task.id) ?? [];
    const krill: WhaleKrill = {
      id: task.id,
      title: task.goal,
      status: task.status,
      hostIds: hostIds.slice(0, WHALE_PANEL_LIMITS.hosts),
      dependencies: dependencies.size,
      evidenceCount: task.evidence.length,
      blocked,
      ...(teamId === undefined ? {} : { teamId }),
      ...(progress === undefined ? {} : { progress }),
      ...(revision === undefined ? {} : { revision }),
    };
    krillById.set(task.id, krill);

    if (active(task.status)) activeCount += 1;
    const delegatedHosts = new Set<string>();
    for (const reference of distinct(task.childTaskRefs ?? [])) {
      if (reference.id === task.id) continue;
      const child = tasksById.get(reference.id);
      // Full records override inline refs; absent inline status remains unknown.
      if (child === undefined && reference.status === undefined) continue;
      const childHostIds = child === undefined
        ? [...new Set(reference.targetNodeIds)]
        : hostIdsByTask.get(child.id) ?? [];
      for (const hostId of childHostIds) {
        delegatedHosts.add(hostId);
        if (child === undefined && reference.status !== undefined && active(reference.status)) {
          countHostExecution(hostId, reference.id);
        }
      }
    }
    if (active(task.status)) {
      for (const hostId of hostIds) {
        if (!delegatedHosts.has(hostId)) countHostExecution(hostId, task.id);
      }
    }
    if (task.status === "queued") waitingCount += 1;
    if (task.status === "completed") completedCount += 1;
  }

  const pods: WhalePod[] = teams.slice(0, WHALE_PANEL_LIMITS.pods).map((team) => {
    const observed = teamTasks.get(team.id) ?? [];
    const hostIds = new Set<string>();
    let podActive = 0;
    let completed = 0;
    let blocked = 0;
    for (const task of observed) {
      for (const hostId of hostIdsByTask.get(task.id) ?? []) hostIds.add(hostId);
      if (active(task.status)) podActive += 1;
      if (task.status === "completed") completed += 1;
      if (krillById.get(task.id)?.blocked === true) blocked += 1;
    }
    return {
      id: team.id, name: team.name, providerId: team.providerId, workspace: team.workspace,
      state: team.phase, memberCount: new Set(team.memberIds).size,
      taskIds: [...new Set(team.taskIds)].slice(0, WHALE_PANEL_LIMITS.krill),
      hostIds: [...hostIds].slice(0, WHALE_PANEL_LIMITS.hosts),
      active: podActive, completed, blocked,
    };
  });

  const hosts: WhaleHost[] = nodes.slice(0, WHALE_PANEL_LIMITS.hosts).map((node) => {
    const cpu = percent(node.cpuPercent);
    const memory = percent(node.memoryPercent);
    const capacity = nonnegativeInteger(node.hostAccess?.maxConcurrentTasks);
    const owner = node.hostAccess?.ownerId;
    return {
      id: node.id, name: node.name, status: node.status, configState: node.configState,
      transports: [...node.transports],
      active: hostActive.get(node.id)?.size ?? 0,
      ...(cpu === undefined ? {} : { cpu }),
      ...(memory === undefined ? {} : { memory }),
      ...(capacity === undefined || capacity === 0 ? {} : { capacity }),
      ...(owner === undefined || owner.trim() === "" ? {} : { owner }),
    };
  });

  // Bounded buckets preserve errors ahead of warnings, including an error
  // encountered after the visible task/node window. No invented overflow alert.
  const errors: WhaleAttention[] = [];
  const warnings: WhaleAttention[] = [];
  const addAttention = (entry: WhaleAttention): void => {
    const bucket = entry.severity === "error" ? errors : warnings;
    if (bucket.length < WHALE_PANEL_LIMITS.attention) bucket.push(entry);
  };
  for (const node of nodes) {
    if (node.status === "offline") addAttention({
      id: `host:offline:${node.id}`, hostId: node.id, severity: "error",
      title: `${node.name} · 离线`,
      detail: node.unavailableReason || "主机状态为 offline；执行可用性未确认。",
    });
    if (node.configState === "drift") addAttention({
      id: `host:drift:${node.id}`, hostId: node.id, severity: "warning",
      title: `${node.name} · 配置漂移`, detail: "已观测配置与期望配置不一致。",
    });
  }
  for (const task of tasks) {
    const krill = krillById.get(task.id)!;
    if (task.status === "failed") addAttention({
      id: `task:failed:${task.id}`, taskId: task.id, severity: "error",
      title: `${task.goal} · 失败`, detail: task.error || "任务状态为 failed；请检查任务证据。",
    });
    for (const reference of distinct(task.childTaskRefs ?? [])) {
      // Standalone children emit their own alert; inline failures open the real parent.
      if (reference.id === task.id || tasksById.has(reference.id) || reference.status !== "failed") continue;
      addAttention({
        id: `task:child-failed:${JSON.stringify([task.id, reference.id])}`,
        taskId: task.id, severity: "error",
        title: `${task.goal} · 子任务失败`,
        detail: `子任务 ${reference.id} 状态为 failed；请查看父任务中的子任务与证据。`,
      });
    }
    if (krill.blocked === true) addAttention({
      id: `task:blocked:${task.id}`, taskId: task.id, severity: "warning",
      title: `${task.goal} · 受阻`,
      detail: task.agentTeamTask?.ready === false
        ? "原生任务板 ready=false；任务尚未就绪。"
        : "依赖尚未完成或尚未观测；请查看依赖任务。",
    });
    if (task.status === "verifying") addAttention({
      id: `task:verifying:${task.id}`, taskId: task.id, severity: "warning",
      title: `${task.goal} · 待验收`, detail: "任务状态为 verifying，尚未完成验收。",
    });
  }

  return {
    pods, hosts,
    // Session identity is source-scoped; membership counts never create life.
    subagents: [...new Map((input.sessionHub?.sessions ?? [])
      .filter((session) => session.origin === "subagent" && session.parentNativeId?.trim())
      .map((session) => {
        const id = JSON.stringify([session.sourceId, session.nativeSessionId]);
        const source = input.sessionHub?.sources.find((entry) => entry.sourceId === session.sourceId);
        const status = session.lastError?.trim() ? "failed" as const
          : input.sessionHub?.provider === "unavailable" || input.sessionHub?.provider === "failed"
            || source?.state !== "available" || !session.agentAvailable ? "unknown" as const
          : session.running ? "running" as const : "idle" as const;
        return [id, { id, name: session.title,
          parentId: JSON.stringify([session.sourceId, session.parentNativeId]), status }] as const;
      })).values()],
    schedules: [],
    schedulesObserved: false,
    krill: [...krillById.values()].slice(0, WHALE_PANEL_LIMITS.krill),
    attention: [...errors, ...warnings].slice(0, WHALE_PANEL_LIMITS.attention),
    freshness: !input.loaded ? "unobserved" : input.stale ? "stale" : "current",
    demo: input.demo,
    summary: {
      hosts: nodes.length,
      online: nodes.filter((node) => node.status === "online").length,
      teams: teams.length,
      active: activeCount,
      waiting: waitingCount,
      completed: completedCount,
      unknownHosts: unknownHosts.size,
    },
  };
}
