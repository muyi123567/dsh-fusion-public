export type FleetNotificationType = "created" | "approved" | "rejected" | "failed";

export interface FleetNotificationEvent {
  type: FleetNotificationType;
  requestId: string;
  taskId: string;
  jobId: string;
  nodeId: string;
  requestedBy: string;
  status: string;
  attemptId?: string;
  error?: string;
  reason?: string;
}

export function formatFleetNotification(event: FleetNotificationEvent): string {
  const title = event.type === "created" ? "待审批派发"
    : event.type === "approved" ? "派发已批准"
    : event.type === "rejected" ? "派发已拒绝"
    : "派发失败";
  const lines = [
    `[鲸群] ${title}`,
    `请求：${event.requestedBy} · ${event.jobId} @ ${event.nodeId}`,
    `任务：${event.taskId}`,
    `状态：${event.status}`,
    ...(event.attemptId === undefined ? [] : [`执行记录：${event.attemptId}`]),
    ...(event.error === undefined ? [] : [`错误：${event.error}`]),
    ...(event.reason === undefined ? [] : [`原因：${event.reason}`]),
  ];
  return lines.join("\n");
}
