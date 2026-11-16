// One place decides whether a write action is currently
// available, and why not. Before this module each surface
// re-derived its own subset: the task composer blocked on a
// stale snapshot while the list's cancel button ignored
// staleness (and stayed clickable with no handler wired),
// the Bot composer checked only that a session and a URL
// existed, and the session pane additionally required a
// supported source and an active agent. The server remains
// the authority; this only makes the client explain itself
// consistently.

export type ActionBlockReason =
  | "no-handler"
  | "terminal-status"
  | "in-flight"
  | "stale"
  | "no-session"
  | "no-endpoint"
  | "unsupported-source"
  | "agent-unavailable"
  | "session-ended";

export type ActionAvailability =
  | { allowed: true }
  | { allowed: false; reason: ActionBlockReason };

const ALLOWED: ActionAvailability = { allowed: true };

function blocked(reason: ActionBlockReason): ActionAvailability {
  return { allowed: false, reason };
}

const BLOCK_LABELS: Record<ActionBlockReason, string> = {
  "no-handler": "当前视图未连接此动作",
  "terminal-status": "任务已结束",
  "in-flight": "操作进行中",
  "stale": "数据已过期，等待刷新",
  "no-session": "没有可用会话",
  "no-endpoint": "当前没有可用的 Bot 发送适配器",
  "unsupported-source": "该来源不支持发送消息",
  "agent-unavailable": "Agent 未激活",
  "session-ended": "会话已结束",
};

export function actionBlockLabel(reason: ActionBlockReason): string {
  return BLOCK_LABELS[reason];
}

export function cancelActionAvailability(input: {
  status: string;
  hasHandler: boolean;
  pending: boolean;
  stale: boolean;
}): ActionAvailability {
  if (!input.hasHandler) return blocked("no-handler");
  // Terminal matches the server: a failed task's process is
  // gone just as a completed or cancelled one is, so it can
  // never be cancelled again.
  if (input.status === "completed" || input.status === "cancelled" || input.status === "failed") {
    return blocked("terminal-status");
  }
  if (input.stale) return blocked("stale");
  if (input.pending) return blocked("in-flight");
  return ALLOWED;
}

export function promptActionAvailability(input: {
  hasSession: boolean;
  hasEndpoint: boolean;
  // SessionPane inputs: only some sources accept prompts, and
  // the hub record carries agent activation.
  sourceSupported?: boolean;
  agentAvailable?: boolean;
  // BotWorkspace inputs: the mapped session record's own
  // lifecycle, plus snapshot staleness shared with other pages.
  sessionStatus?: string;
  stale?: boolean;
}): ActionAvailability {
  if (!input.hasSession) return blocked("no-session");
  if (!input.hasEndpoint) return blocked("no-endpoint");
  if (input.sourceSupported === false) return blocked("unsupported-source");
  if (input.agentAvailable === false) return blocked("agent-unavailable");
  if (input.sessionStatus === "finished" || input.sessionStatus === "error") {
    return blocked("session-ended");
  }
  if (input.stale === true) return blocked("stale");
  return ALLOWED;
}
