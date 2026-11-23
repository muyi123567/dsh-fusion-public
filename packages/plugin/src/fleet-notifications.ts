import { createHmac } from "node:crypto";

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

export function createFleetWebhook(options: {
  url: string;
  secret?: string;
  timeoutMs?: number;
}): (event: FleetNotificationEvent) => Promise<boolean> {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new Error("FLEET_WEBHOOK_URL_INVALID");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("FLEET_WEBHOOK_URL_INVALID");
  if (options.url.length > 2048) throw new Error("FLEET_WEBHOOK_URL_INVALID");
  const secret = options.secret?.trim();
  if (secret !== undefined && (secret === "" || secret.length > 256)) throw new Error("FLEET_WEBHOOK_SECRET_INVALID");
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 5_000, 100), 10_000);
  return async (event) => {
    const body = JSON.stringify({
      source: "dsh-fusion", version: 1, event, text: formatFleetNotification(event),
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "dsh-fusion-webhook/1",
    };
    if (secret !== undefined) {
      headers["x-dsh-fusion-signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}
