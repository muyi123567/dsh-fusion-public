import type { TaskRecord } from "@dsh-fusion/core";

const taskLabels: Record<string, string> = {
  blocked: "受阻", queued: "排队", claimed: "已认领", running: "进行中",
  verifying: "待验收", completed: "已回报完成", failed: "失败", cancelled: "已取消",
};
const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function nativeTaskLabel(status: string) {
  return Object.hasOwn(taskLabels, status) ? taskLabels[status] as string : status;
}

export function nativeTaskStatus(task: TaskRecord, projectedBlocked?: boolean): string {
  if (task.status === "failed" || task.status === "completed" || task.status === "cancelled") return task.status;
  const blocked = projectedBlocked ?? (task.agentTeamTask?.ready === false || Boolean(task.agentTeamTask?.blockedBy.some(Boolean)));
  return blocked ? "blocked" : task.status;
}

export function nativeTaskFact(task: TaskRecord, projectedBlocked?: boolean): string {
  switch (nativeTaskStatus(task, projectedBlocked)) {
    case "failed": return task.error || "来源回报失败，原因未提供。";
    case "blocked": return task.agentTeamTask?.ready === false
      ? "上游声明尚未就绪。"
      : "来源记录中有依赖未完成或状态未知。";
    case "verifying": return "独立审查结论未提供";
    case "completed": return "来源已回报完成，独立审查结论未提供。";
    case "cancelled": return "来源状态为已取消。";
    case "claimed": return "来源状态为已认领。";
    case "running": return "来源状态为进行中。";
    case "queued": return "来源状态为排队。";
    default: return `来源状态为${task.status}。`;
  }
}

export function nativeTaskTime(task: TaskRecord) {
  const updated = Date.parse(task.updatedAt);
  return Number.isFinite(updated) ? timeFormatter.format(updated) : "时间未提供";
}
