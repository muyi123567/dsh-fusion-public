import type { NodeRecord, TaskRecord } from "@dsh-fusion/core";
import type {
  FusionTaskTopology,
  FusionTaskTopologyEdge,
  FusionTaskTopologyEntity,
  FusionTaskTopologyRelation,
} from "@dsh-fusion/core";
export type {
  FusionTaskTopology,
  FusionTaskTopologyEdge,
  FusionTaskTopologyEntity,
  FusionTaskTopologyEntityKind,
  FusionTaskTopologyEntityStatus,
  FusionTaskTopologyRelation,
} from "@dsh-fusion/core";

export function evidenceGroupKeyOf(kind: TaskRecord["evidence"][number]["kind"], label: string): string {
  if (kind === "summary" || /summary/iu.test(label)) return "summary";
  if (kind === "command" || /stdout/iu.test(label)) return "stdout";
  if (kind === "log" || /stderr/iu.test(label)) return "stderr";
  if (kind === "artifact" || kind === "git") return "artifact";
  return "other";
}

const evidenceLabels: Record<string, string> = {
  summary: "summary",
  stdout: "stdout",
  stderr: "stderr",
  artifact: "artifact",
  other: "其他证据",
};

export function evidenceGroupLabelOf(key: string): string {
  return evidenceLabels[key] ?? key;
}

export function ownerKeyOf(task: TaskRecord): string {
  return task.requestedByBotId?.trim() || "operator";
}

export function ownerLabelOf(key: string): string {
  if (key === "operator") return "DSH 操作员";
  return `DS Bot · ${key}`;
}

export function buildTaskTopology(
  tasks: readonly TaskRecord[],
  nodes: readonly NodeRecord[],
): FusionTaskTopology {
  const entities = new Map<string, FusionTaskTopologyEntity>();
  const edges = new Map<string, FusionTaskTopologyEdge>();
  const ownerIds: string[] = [];
  const taskIds: string[] = [];
  const nodeIds: string[] = [];
  const evidenceGroupIds: string[] = [];

  const addEntity = (entity: FusionTaskTopologyEntity): string => {
    const existing = entities.get(entity.id);
    if (existing === undefined) {
      entities.set(entity.id, entity);
      return entity.id;
    }
    existing.taskIds = [...new Set([...existing.taskIds, ...entity.taskIds])];
    existing.nodeIds = [...new Set([...existing.nodeIds, ...entity.nodeIds])];
    return existing.id;
  };

  const connect = (source: string, target: string, relation: FusionTaskTopologyRelation): void => {
    const id = `${source}->${target}`;
    edges.set(id, { id, source, target, relation });
  };

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const ownerEntityIds = new Set<string>();
  const nodeEntityIds = new Set<string>();
  const evidenceEntityIds = new Set<string>();

  for (const task of tasks) {
    taskIds.push(task.id);
    const taskEntity = addEntity({
      id: `task:${task.id}`,
      kind: "task",
      label: task.goal,
      detail: `#${task.id} · ${task.transport}`,
      status: task.status,
      taskIds: [task.id],
      nodeIds: task.targetNodeIds.map((nodeId) => `node:${nodeId}`),
      ...(task.progress === undefined ? {} : { progress: task.progress }),
      evidenceCount: task.evidence.length,
    });

    const ownerKey = ownerKeyOf(task);
    const ownerEntity = addEntity({
      id: `owner:${ownerKey}`,
      kind: "owner",
      label: ownerLabelOf(ownerKey),
      detail: "任务创建来源",
      status: "unknown",
      taskIds: [task.id],
      nodeIds: [],
    });
    ownerEntityIds.add(ownerEntity);
    connect(ownerEntity, taskEntity, "owns");

    const targetIds = task.targetNodeIds.length === 0 ? ["unassigned"] : task.targetNodeIds;
    for (const nodeId of targetIds) {
      const node = nodesById.get(nodeId);
      const nodeEntity = addEntity({
        id: `node:${nodeId}`,
        kind: "node",
        label: node?.name ?? (nodeId === "unassigned" ? "未分配节点" : nodeId),
        detail: node?.providerId ?? "未观测来源",
        status: node?.status ?? "unknown",
        taskIds: [task.id],
        nodeIds: [nodeId],
      });
      nodeEntityIds.add(nodeEntity);
      connect(taskEntity, nodeEntity, "executes_on");
    }

    const groups = new Set<string>();
    for (const evidence of task.evidence) {
      const key = evidenceGroupKeyOf(evidence.kind, evidence.label);
      groups.add(key);
    }
    if (groups.size === 0) groups.add("empty");
    for (const key of groups) {
      const evidenceEntity = addEntity({
        id: `evidence:${key}`,
        kind: "evidence",
        label: evidenceGroupLabelOf(key),
        detail: key === "empty" ? "暂无证据" : "执行产物",
        status: "unknown",
        taskIds: [task.id],
        nodeIds: [],
      });
      evidenceEntityIds.add(evidenceEntity);
      connect(taskEntity, evidenceEntity, "produces");
    }
  }

  for (const entity of entities.values()) {
    if (entity.kind === "owner") {
      entity.detail = `${entity.taskIds.length} 个任务`;
    }
    if (entity.kind === "node") {
      const nodeId = entity.id.slice("node:".length);
      entity.detail = `${nodesById.get(nodeId)?.providerId ?? "未观测来源"} · ${entity.taskIds.length} 个任务`;
    }
    if (entity.kind === "evidence") {
      entity.detail = `${entity.taskIds.length} 个任务`;
    }
  }

  return {
    version: 1,
    entities: [...entities.values()],
    edges: [...edges.values()],
    ownerIds: [...ownerEntityIds],
    taskIds,
    nodeIds: [...nodeEntityIds],
    evidenceGroupIds: [...evidenceEntityIds],
  };
}
