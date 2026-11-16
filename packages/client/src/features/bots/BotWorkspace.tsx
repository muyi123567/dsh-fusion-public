import { useMemo, useState } from "react";
import { ArrowUp, Paperclip, Sparkles, TerminalSquare } from "lucide-react";
import type { BotRecord, NodeRecord, SessionRecord, TaskRecord } from "@dsh-fusion/core";
import {
  actionBlockLabel,
  promptActionAvailability,
} from "../actions/action-availability.js";
import { TaskCard } from "../tasks/TaskCard.js";
import { TaskDetails } from "../tasks/TaskDetails.js";
import { useSessionHistory } from "../mission-control/use-session-hub.js";
import { fusionBrowserUrl } from "../../routes.js";

export function BotWorkspace({
  bot,
  tasks,
  nodes,
  session,
  sessionHubUrl,
  connectionStale = false,
  draft: draftProp,
  onDraftChange,
  onOpenTask,
}: {
  bot: BotRecord;
  tasks: TaskRecord[];
  nodes: NodeRecord[];
  session?: SessionRecord;
  sessionHubUrl?: string;
  connectionStale?: boolean;
  // The workspace (App) can own the composer draft per Bot so
  // an unsent message survives page switches and overlay
  // remounts; without an owner it stays internal as before.
  draft?: string;
  onDraftChange?: (draft: string) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const [evidenceTaskId, setEvidenceTaskId] = useState<string>();
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const evidenceTask = evidenceTaskId === undefined ? undefined : tasksById.get(evidenceTaskId);
  const [sessionId, setSessionId] = useState<string>();
  const [internalDraft, setInternalDraft] = useState("");
  const draft = draftProp ?? internalDraft;
  const setDraft = (value: string) => {
    if (onDraftChange === undefined) setInternalDraft(value);
    else onDraftChange(value);
  };
  const [uiNotice, setUiNotice] = useState<string>();
  const [sending, setSending] = useState(false);
  const [sentNonce, setSentNonce] = useState(0);
  const promptAvailability = promptActionAvailability({
    hasSession: session !== undefined,
    hasEndpoint: sessionHubUrl !== undefined,
    ...(session === undefined ? {} : { sessionStatus: session.status }),
    stale: connectionStale,
  });
  const canSend = promptAvailability.allowed;
  const history = useSessionHistory({
    ...(sessionHubUrl === undefined
      ? {}
      : { historyUrl: `${sessionHubUrl}/history` }),
    sourceId: session?.providerId ?? "",
    sessionId: session?.id ?? "",
    enabled: session !== undefined && sessionHubUrl !== undefined,
    refreshSignal: sentNonce,
  });
  const historyMessages = history.messages.map((message) => ({
    id: `history-${message.seq}`,
    from: message.role === "assistant" ? bot.name : "用户",
    content: message.text,
  }));
  const messages = historyMessages.length === 0
    ? bot.recentMessages ?? []
    : historyMessages;

  const sendMessage = async () => {
    const text = draft.trim();
    if (text === "" || !canSend || session === undefined || sessionHubUrl === undefined || sending) {
      return;
    }
    setSending(true);
    setUiNotice(undefined);
    try {
      const response = await fetch(fusionBrowserUrl(`${sessionHubUrl}/prompt`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId: session.providerId,
          sessionId: session.id,
          text,
          mode: "queue",
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        accepted?: boolean;
        error?: string;
      };
      if (!response.ok || payload.accepted !== true) {
        throw new Error(payload.error ?? `Prompt HTTP ${response.status}`);
      }
      setDraft("");
      setSentNonce((current) => current + 1);
    } catch (error) {
      setUiNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="fusion-chat" aria-label="Bot 对话">
      <div className="fusion-chat-head">
        <div>
          <strong>{bot.name}</strong>
          <small>
            {bot.role} · {bot.model}
            {bot.reasoningEffort === undefined ? "" : ` · ${bot.reasoningEffort}`}
          </small>
        </div>
        <button type="button" className="fusion-ghost-button" onClick={() => setUiNotice("会话设置由 DS Bot provider 提供")}><Sparkles size={14} /> 会话设置</button>
      </div>
      {uiNotice === undefined && history.error === undefined ? null : (
        <p className="fusion-inline-notice fusion-chat-notice" role="alert">
          {uiNotice ?? `历史读取失败：${history.error}`}
        </p>
      )}
      <div className="fusion-messages">
        {messages.map((message, index) => (
          <div className="fusion-message assistant" key={message.id ?? `${message.from}-${index}`}>
            <small>{message.from}</small>
            <p>{message.content}</p>
          </div>
        ))}
        {messages.length === 0 ? (
          <div className="fusion-message assistant is-empty">
            <p>当前 Bot provider 未返回消息记录。</p>
          </div>
        ) : null}
        {tasks.slice(0, 1).map((task) => (
          <div className="fusion-inline-task" key={task.id}>
            <TaskCard
              task={task}
              nodes={nodes}
              onOpenSession={setSessionId}
              onOpenEvidence={() => {
                if (onOpenTask !== undefined) onOpenTask(task.id);
                else setEvidenceTaskId((current) => current === task.id ? undefined : task.id);
              }}
            />
            {sessionId === undefined ? null : (
              <div className="fusion-session-notice">
                <TerminalSquare size={14} />
                <span>已选择会话</span>
                <code>{sessionId}</code>
              </div>
            )}
          </div>
        ))}
        {evidenceTask === undefined ? evidenceTaskId === undefined ? null : <p>当前快照未返回此任务，无法确认状态或证据。</p> : (
          <TaskDetails task={evidenceTask} tasks={tasks} nodes={nodes} onSelectTask={(id) => { setEvidenceTaskId(id); onOpenTask?.(id); }} onClose={() => setEvidenceTaskId(undefined)} />
        )}
      </div>
      <div className="fusion-composer">
        <Paperclip size={16} />
        <input
          aria-label="发送消息"
          placeholder={promptAvailability.allowed
            ? "向 Bot 发送消息…"
            : promptAvailability.reason === "stale" || promptAvailability.reason === "session-ended"
              ? actionBlockLabel(promptAvailability.reason)
              : "当前没有可用的 Bot 发送适配器"}
          value={draft}
          disabled={!canSend}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendMessage();
            }
          }}
        />
        <button
          type="button"
          className="fusion-send"
          aria-label="发送"
          disabled={!canSend || sending || draft.trim() === ""}
          onClick={() => void sendMessage()}
        >
          <ArrowUp size={16} />
        </button>
      </div>
    </section>
  );
}
