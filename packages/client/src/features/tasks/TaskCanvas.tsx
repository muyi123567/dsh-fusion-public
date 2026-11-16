import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { NodeRecord, TaskEvidence, TaskRecord } from "@dsh-fusion/core";
import {
  Bot,
  CircleAlert,
  CircleCheckBig,
  FileCheck2,
  FileText,
  ListChecks,
  Play,
  Server,
  UserRound,
} from "lucide-react";
import { taskStatusLabel } from "./task-model.js";
import "./task-canvas.css";

type CanvasEdgeKind = "owner" | "node" | "evidence";

interface CanvasEdge {
  id: string;
  d: string;
  kind: CanvasEdgeKind;
  selected: boolean;
}

interface EvidenceGroup {
  key: string;
  label: string;
  count: number;
}

interface CanvasOwner {
  key: string;
  label: string;
  detail: string;
  taskIds: string[];
}

interface CanvasNode {
  key: string;
  label: string;
  status: NodeRecord["status"] | "unknown";
  detail: string;
  taskIds: string[];
}

function ownerKeyOf(task: TaskRecord): string {
  return task.requestedByBotId?.trim() || "operator";
}

function ownerLabelOf(key: string): string {
  if (key === "operator") return "DSH 操作员";
  return `DS Bot · ${key}`;
}

function evidenceGroupOf(item: TaskEvidence): string {
  if (item.kind === "summary" || /summary/iu.test(item.label)) return "summary";
  if (item.kind === "command" || /stdout/iu.test(item.label)) return "stdout";
  if (item.kind === "log" || /stderr/iu.test(item.label)) return "stderr";
  if (item.kind === "artifact" || item.kind === "git") return "artifact";
  return "other";
}

const evidenceLabels: Record<string, string> = {
  summary: "summary",
  stdout: "stdout",
  stderr: "stderr",
  artifact: "artifact",
  other: "其他证据",
};

function cubicPath(start: { x: number; y: number }, end: { x: number; y: number }): string {
  const dx = Math.max(26, Math.abs(end.x - start.x) * 0.45);
  return [
    `M ${start.x} ${start.y}`,
    `C ${start.x + dx} ${start.y} ${end.x - dx} ${end.y} ${end.x} ${end.y}`,
  ].join(" ");
}

export function TaskCanvas({
  tasks,
  nodes,
  selectedTaskId,
  onSelectTask,
}: {
  tasks: readonly TaskRecord[];
  nodes: readonly NodeRecord[];
  selectedTaskId?: string;
  onSelectTask: (taskId: string) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const elementRefs = useRef(new Map<string, HTMLElement>());
  const [edges, setEdges] = useState<CanvasEdge[]>([]);

  const owners = useMemo<CanvasOwner[]>(() => {
    const grouped = new Map<string, string[]>();
    for (const task of tasks) {
      const key = ownerKeyOf(task);
      const taskIds = grouped.get(key);
      if (taskIds === undefined) grouped.set(key, [task.id]);
      else taskIds.push(task.id);
    }
    return [...grouped.entries()].map(([key, taskIds]) => ({
      key,
      label: ownerLabelOf(key),
      detail: `${taskIds.length} 个任务`,
      taskIds,
    }));
  }, [tasks]);

  const nodesById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );

  const tasksById = useMemo(() => {
    const indexed = new Map<string, TaskRecord>();
    for (const task of tasks) {
      // Preserve Array.find's first-match behavior for duplicate task IDs.
      if (!indexed.has(task.id)) indexed.set(task.id, task);
    }
    return indexed;
  }, [tasks]);

  const canvasNodes = useMemo<CanvasNode[]>(() => {
    const grouped = new Map<string, string[]>();
    for (const task of tasks) {
      const ids = task.targetNodeIds.length === 0 ? ["unassigned"] : task.targetNodeIds;
      for (const id of ids) {
        const taskIds = grouped.get(id);
        if (taskIds === undefined) grouped.set(id, [task.id]);
        else taskIds.push(task.id);
      }
    }
    return [...grouped.entries()].map(([key, taskIds]) => {
      const node = nodesById.get(key);
      return {
        key,
        label: node?.name ?? (key === "unassigned" ? "未分配节点" : key),
        status: node?.status ?? "unknown",
        detail: node?.providerId ?? "未观测来源",
        taskIds,
      };
    });
  }, [nodesById, tasks]);

  const evidenceGroups = useMemo<EvidenceGroup[]>(() => {
    const counts = new Map<string, number>();
    let total = 0;
    for (const task of tasks) {
      for (const item of task.evidence) {
        const key = evidenceGroupOf(item);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        total += 1;
      }
    }
    if (total === 0) return [{ key: "empty", label: "暂无证据", count: 0 }];
    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => ({
        key,
        label: evidenceLabels[key] ?? key,
        count,
      }));
  }, [tasks]);

  const selectedOwnerKey = selectedTaskId === undefined
    ? undefined
    : ownerKeyOf(tasks.find((task) => task.id === selectedTaskId) ?? { id: "", goal: "", targetNodeIds: [], transport: "dsh-fleet", status: "queued", evidence: [], createdAt: "", updatedAt: "" });

  const selectedNodeIds = useMemo(() => new Set(
    selectedTaskId === undefined
      ? []
      : (tasks.find((task) => task.id === selectedTaskId)?.targetNodeIds.length
        ? tasks.find((task) => task.id === selectedTaskId)!.targetNodeIds
        : ["unassigned"]),
  ), [selectedTaskId, tasks]);

  const selectedEvidenceGroups = useMemo(() => {
    const selectedTask = tasks.find((task) => task.id === selectedTaskId);
    if (selectedTask === undefined || selectedTask.evidence.length === 0) {
      return new Set(selectedTask === undefined ? [] : ["empty"]);
    }
    return new Set(selectedTask.evidence.map((item) => evidenceGroupOf(item)));
  }, [selectedTaskId, tasks]);

  const setRef = (key: string) => (element: HTMLElement | null) => {
    if (element === null) elementRefs.current.delete(key);
    else elementRefs.current.set(key, element);
  };

  useLayoutEffect(() => {
    const measure = () => {
      const grid = gridRef.current;
      if (grid === null) return;
      const canvasBox = grid.getBoundingClientRect();
      const point = (element: HTMLElement, side: "left" | "right") => {
        const box = element.getBoundingClientRect();
        return {
          x: (side === "right" ? box.right : box.left) - canvasBox.left,
          y: box.top + box.height / 2 - canvasBox.top,
        };
      };
      const next: CanvasEdge[] = [];
      const connect = (
        sourceKey: string,
        targetKey: string,
        kind: CanvasEdgeKind,
        selected: boolean,
      ) => {
        const source = elementRefs.current.get(sourceKey);
        const target = elementRefs.current.get(targetKey);
        if (source === undefined || target === undefined) return;
        const start = point(source, "right");
        const end = point(target, "left");
        next.push({
          id: `${sourceKey}->${targetKey}`,
          d: cubicPath(start, end),
          kind,
          selected,
        });
      };

      for (const owner of owners) {
        for (const taskId of owner.taskIds) {
          connect(
            `owner:${owner.key}`,
            `task:${taskId}`,
            "owner",
            selectedTaskId === taskId,
          );
        }
      }
      for (const task of tasks) {
        const ids = task.targetNodeIds.length === 0 ? ["unassigned"] : task.targetNodeIds;
        for (const nodeId of ids) {
          connect(`task:${task.id}`, `node:${nodeId}`, "node", selectedTaskId === task.id);
        }
      }
      for (const node of canvasNodes) {
        for (const group of evidenceGroups) {
          const hasEvidence = group.key === "empty"
            ? node.taskIds.some((taskId) => tasksById.get(taskId)?.evidence.length === 0)
            : node.taskIds.some((taskId) => tasksById.get(taskId)?.evidence.some(
              (item) => evidenceGroupOf(item) === group.key,
            ));
          if (!hasEvidence) continue;
          connect(
            `node:${node.key}`,
            `evidence:${group.key}`,
            "evidence",
            selectedNodeIds.has(node.key) && selectedEvidenceGroups.has(group.key),
          );
        }
      }
      setEdges(next);
    };

    measure();
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    resizeObserver?.observe(gridRef.current ?? document.body);
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [
    canvasNodes,
    evidenceGroups,
    owners,
    selectedEvidenceGroups,
    selectedNodeIds,
    selectedTaskId,
    tasks,
    tasksById,
  ]);

  useEffect(() => {
    if (selectedTaskId === undefined) return;
    const selectedElement = elementRefs.current.get(`task:${selectedTaskId}`);
    if (typeof selectedElement?.scrollIntoView === "function") {
      selectedElement.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [selectedTaskId]);

  return (
    <section className="fusion-task-canvas" aria-label="任务归属画布">
      <div className="fusion-task-canvas-scroll">
        <div className="fusion-task-canvas-grid" ref={gridRef}>
          <svg className="fusion-task-canvas-edges" aria-hidden="true" focusable="false">
            {edges.map((edge) => (
              <path
                className={`fusion-task-canvas-edge is-${edge.kind}` + (edge.selected ? " is-selected" : "")}
                data-kind={edge.kind}
                d={edge.d}
                key={edge.id}
              />
            ))}
          </svg>
          <div className="fusion-task-canvas-column" data-zone="owners">
        <header>
          <strong>发起者</strong>
          <small>任务创建来源</small>
        </header>
        <ul>
          {owners.map((owner) => (
            <li key={owner.key}>
              <button
                ref={setRef(`owner:${owner.key}`)}
                type="button"
                aria-label={`${owner.label} ${owner.taskIds.length} 个任务`}
                className={
                  "fusion-task-canvas-card"
                  + (owner.key === selectedOwnerKey ? " is-linked" : "")
                }
                onClick={() => {
                  if (owner.taskIds.length === 0) return;
                  onSelectTask(owner.taskIds[0] ?? owner.key);
                }}
              >
                <span className="fusion-task-canvas-icon">
                  {owner.key === "operator" ? <UserRound size={14} /> : <Bot size={14} />}
                </span>
                <span className="fusion-task-canvas-copy">
                  <strong>{owner.label}</strong>
                  <small>{owner.detail}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

          <div className="fusion-task-canvas-column" data-zone="tasks">
        <header>
          <strong>任务</strong>
          <small>{tasks.length} 个任务</small>
        </header>
        <ul>
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                ref={setRef(`task:${task.id}`)}
                type="button"
                aria-label={`查看任务 ${task.id}`}
                aria-pressed={selectedTaskId === task.id}
                className={
                  "fusion-task-canvas-card is-task"
                  + (selectedTaskId === task.id ? " is-selected" : "")
                }
                onClick={() => onSelectTask(task.id)}
              >
                <span className="fusion-task-canvas-card-head">
                  <strong>{task.goal}</strong>
                  <span className={`fusion-status ${task.status}`}>
                    {task.status === "completed" ? <CircleCheckBig size={11} /> : task.status === "failed" ? <CircleAlert size={11} /> : <Play size={11} />}
                    {taskStatusLabel(task.status)}
                  </span>
                </span>
                <small>#{task.id}</small>
                <span className="fusion-task-canvas-progress">
                  <i aria-hidden="true"><span style={{ width: `${task.progress ?? 0}%` }} /></i>
                  <b>{task.progress === undefined ? "未报告" : `${task.progress}%`}</b>
                </span>
                <span className="fusion-task-canvas-card-foot">
                  <span><ListChecks size={11} /> {(task.childTaskRefs ?? []).length} 子任务</span>
                  <span><FileCheck2 size={11} /> {task.evidence.length} 证据</span>
                </span>
              </button>
            </li>
          ))}
          {tasks.length === 0 ? <li className="fusion-task-canvas-empty">没有符合筛选条件的任务</li> : null}
        </ul>
      </div>

          <div className="fusion-task-canvas-column" data-zone="nodes">
        <header>
          <strong>执行节点</strong>
          <small>{canvasNodes.length} 个目标</small>
        </header>
        <ul>
          {canvasNodes.map((node) => (
            <li key={node.key}>
              <article
                ref={setRef(`node:${node.key}`)}
                className={
                  "fusion-task-canvas-card"
                  + (selectedNodeIds.has(node.key) ? " is-linked" : "")
                }
                aria-label={`执行节点 ${node.label} ${node.taskIds.length} 个任务`}
              >
                <span className="fusion-task-canvas-icon">
                  <Server size={14} />
                </span>
                <span className="fusion-task-canvas-copy">
                  <strong>
                    {node.label}
                    <i className={`fusion-node-dot ${node.status}`} />
                  </strong>
                  <small>{node.detail} · {node.taskIds.length} 个任务</small>
                </span>
              </article>
            </li>
          ))}
        </ul>
      </div>

          <div className="fusion-task-canvas-column" data-zone="evidence">
        <header>
          <strong>证据</strong>
          <small>执行产物</small>
        </header>
        <ul>
          {evidenceGroups.map((group) => (
            <li key={group.key}>
              <article
                ref={setRef(`evidence:${group.key}`)}
                className={
                  "fusion-task-canvas-card"
                  + (selectedEvidenceGroups.has(group.key) ? " is-linked" : "")
                }
                aria-label={`证据 ${group.label} ${group.count} 项`}
              >
                <span className="fusion-task-canvas-icon">
                  {group.key === "empty" ? <CircleAlert size={14} /> : <FileText size={14} />}
                </span>
                <span className="fusion-task-canvas-copy">
                  <strong>{group.label}</strong>
                  <small>{group.count} 项</small>
                </span>
              </article>
            </li>
          ))}
        </ul>
      </div>
          </div>
        </div>
    </section>
  );
}
