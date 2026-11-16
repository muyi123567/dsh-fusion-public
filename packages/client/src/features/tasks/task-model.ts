import type { TaskRecord, TaskStatus } from "@dsh-fusion/core";

const labels: Record<TaskStatus, string> = {
  queued: "等待执行",
  claimed: "已领取",
  running: "正在执行",
  verifying: "证据校验",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function taskStatusLabel(status: TaskStatus): string {
  return labels[status];
}

export function taskEvidenceStatus(task: TaskRecord): string {
  if (task.evidence.length === 0) return "待提交证据";
  return `${task.evidence.length} 项证据`;
}
