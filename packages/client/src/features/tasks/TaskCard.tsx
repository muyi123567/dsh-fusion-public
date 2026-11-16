import { useMemo } from "react";
import type { NodeRecord, TaskChildReference, TaskRecord } from "@dsh-fusion/core";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  FileCheck2,
  Play,
  TerminalSquare,
} from "lucide-react";
import { taskEvidenceStatus, taskStatusLabel } from "./task-model.js";

export function TaskCard({
  task,
  nodes,
  onOpenSession,
  onOpenEvidence,
}: {
  task: TaskRecord;
  nodes: NodeRecord[];
  onOpenSession: (sessionId: string) => void;
  onOpenEvidence: () => void;
}) {
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const childrenByNodeId = useMemo(() => {
    const index = new Map<string, TaskChildReference[]>();
    for (const child of task.childTaskRefs ?? []) {
      for (const id of child.targetNodeIds) index.set(id, [...(index.get(id) ?? []), child]);
    }
    return index;
  }, [task.childTaskRefs]);
  const assignedNodes = task.targetNodeIds.map(
    (id) => nodesById.get(id) ?? {
      id,
      name: id,
      status: "offline" as const,
    },
  );
  const reportedProgress = task.progress;

  return (
    <article className="fusion-task-card" aria-label={`任务 ${task.goal}`}>
      <div className="fusion-task-card-head">
        <span className="fusion-task-icon"><ArrowUpRight size={15} /></span>
        <div><strong>多机任务 · {task.goal}</strong><small>#{task.id}</small></div>
        <span className={`fusion-status ${task.status}`}>
          {task.status === "completed" ? <Check size={12} /> : task.status === "failed" ? <CircleAlert size={12} /> : <Play size={12} />}
          {taskStatusLabel(task.status)}
        </span>
      </div>
      <div className="fusion-task-node-list">
        {assignedNodes.map((node) => {
          const children = childrenByNodeId.get(node.id) ?? [];
          const child = children.length === 1 ? children[0] : undefined;
          const isSingleTask = task.targetNodeIds.length === 1 && (task.childTaskRefs?.length ?? 0) === 0;
          const status = isSingleTask ? task.status : child?.status;
          const progress = isSingleTask ? reportedProgress : child?.progress;
          return (
          <div className="fusion-task-node" key={node.id}>
            <span className={`fusion-node-dot ${node.status}`} />
            <strong>{node.name}</strong>
            <small>
              {node.status === "online"
                ? `节点在线 · ${status === undefined ? "子任务状态未报告" : taskStatusLabel(status)}`
                : "节点不可用"}
            </small>
            <i className="fusion-mini-progress">
              <span style={{ width: `${progress ?? 0}%` }} />
            </i>
            <em>{progress === undefined ? "未报告" : `${progress}%`}</em>
          </div>
          );
        })}
      </div>
      <div className="fusion-task-card-progress">
        <span><FileCheck2 size={13} /> {taskEvidenceStatus(task)}</span>
        <strong>{reportedProgress === undefined ? "进度未报告" : `${reportedProgress}%`}</strong>
      </div>
      <div className="fusion-task-card-foot">
        <button type="button" onClick={onOpenEvidence}>任务证据</button>
        <button
          type="button"
          disabled={task.sessionId === undefined}
          onClick={() => {
            if (task.sessionId !== undefined) onOpenSession(task.sessionId);
          }}
        >
          <TerminalSquare size={13} /> 查看会话
        </button>
      </div>
    </article>
  );
}
