import { useMemo } from "react";
import type { NodeRecord, TaskRecord } from "@dsh-fusion/core";
import { Server, X } from "lucide-react";
import { TaskEvidence } from "./TaskEvidence.js";
import { taskStatusLabel } from "./task-model.js";
import "./task-details.css";

export function TaskDetails({ task, tasks, nodes, onSelectTask, onClose }: {
  task: TaskRecord;
  tasks: readonly TaskRecord[];
  nodes: readonly NodeRecord[];
  onSelectTask: (taskId: string) => void;
  onClose: () => void;
}) {
  const tasksById = useMemo(() => new Map(tasks.map((item) => [item.id, item])), [tasks]);
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  return (
    <section className="fusion-task-details" aria-label="任务详情" data-status={task.status}>
      <header>
        <div>
          <span className="fusion-task-details-eyebrow">任务详情</span>
          <h2>{task.goal}</h2>
          <code>#{task.id}</code>
        </div>
        <button type="button" aria-label="关闭任务详情" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="fusion-task-details-status">
        <span className={`fusion-status ${task.status}`}>{taskStatusLabel(task.status)}</span>
        <div>
          <span>进度</span>
          <b>{task.progress === undefined ? "未报告" : `${task.progress}%`}</b>
          <i aria-hidden="true"><span style={{ width: `${task.progress ?? 0}%` }} /></i>
        </div>
      </div>
      <dl className="fusion-task-details-facts">
        <div><dt>传输</dt><dd>{task.transport}</dd></div>
        <div><dt>创建时间</dt><dd>{formatTaskTimestamp(task.createdAt)}</dd></div>
        <div><dt>更新时间</dt><dd>{formatTaskTimestamp(task.updatedAt)}</dd></div>
        <div><dt>会话</dt><dd>{task.sessionId ?? "未关联会话"}</dd></div>
        <div><dt>发起 Bot</dt><dd>{task.requestedByBotId ?? "未提供"}</dd></div>
      </dl>
      <section className="fusion-task-detail-section" aria-label="目标节点与来源">
        <h3><Server size={14} /> 目标节点</h3>
        {task.targetNodeIds.length === 0 ? <p className="fusion-muted">未报告目标节点</p> : task.targetNodeIds.map((id) => {
          const node = nodesById.get(id);
          return (
            <div className="fusion-task-detail-target" key={id}>
              <span className={`fusion-node-dot ${node?.status ?? "offline"}`} />
              <div>
                <strong>{node?.name ?? id}</strong>
                <small>{id} · <code>{node?.providerId ?? "未提供来源"}</code></small>
              </div>
            </div>
          );
        })}
      </section>
      {task.error === undefined ? null : <div role="alert"><strong>任务错误</strong><pre>{task.error}</pre></div>}
      {task.childTaskRefs === undefined || task.childTaskRefs.length === 0 ? null : (
        <section className="fusion-task-detail-section" aria-label="子任务">
          <h3>子任务</h3>
          {task.childTaskRefs.map((reference) => {
            const child = tasksById.get(reference.id);
            const status = child?.status ?? reference.status;
            const progress = child === undefined ? reference.progress : child.progress;
            return <article className="fusion-task-child" key={reference.id}>
              <button type="button" aria-label={`查看子任务 ${reference.id}`} onClick={() => onSelectTask(reference.id)}>{reference.id}</button>
              <span>{status === undefined ? "未观测" : taskStatusLabel(status)}</span>
              <span>{(child?.targetNodeIds ?? reference.targetNodeIds).map((id) => nodesById.get(id)?.name ?? id).join("、") || "未报告目标节点"}</span>
              <small>{progress === undefined ? "进度未报告" : `${progress}%`} · {child === undefined ? "完整记录未返回，证据不可用" : `${child.evidence.length} 项证据`}</small>
              {child?.error === undefined ? null : <pre>{child.error}</pre>}
            </article>;
          })}
        </section>
      )}
      <TaskEvidence task={task} onClose={onClose} />
    </section>
  );
}

function formatTaskTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
