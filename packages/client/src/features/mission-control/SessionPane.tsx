import { useState } from "react";
import type { NodeRecord, SessionHubSessionRecord } from "@dsh-fusion/core";
import {
  ArrowDown,
  ArrowUp,
  Columns2,
  Maximize2,
  Minimize2,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import {
  actionBlockLabel,
  promptActionAvailability,
} from "../actions/action-availability.js";
import { useSessionHistory } from "./use-session-hub.js";
import { fusionBrowserUrl } from "../../routes.js";

export function SessionPane({
  session,
  node,
  historyUrl,
  promptUrl,
  historyRefreshSignal,
  maximized,
  wide,
  onMaximize,
  onResize,
  onMoveRow,
  onOpenMain,
  onRemove,
}: {
  session: SessionHubSessionRecord;
  node?: NodeRecord;
  historyUrl?: string;
  promptUrl?: string;
  historyRefreshSignal?: number;
  maximized: boolean;
  wide: boolean;
  onMaximize: () => void;
  onResize: () => void;
  onMoveRow: (direction: -1 | 1) => void;
  onOpenMain: () => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [promptError, setPromptError] = useState<string>();
  const [sentNonce, setSentNonce] = useState(0);
  const history = useSessionHistory({
    ...(historyUrl === undefined ? {} : { historyUrl }),
    sourceId: session.sourceId,
    sessionId: session.nativeSessionId,
    // The external signal only re-reads once this session's own
    // version moves; the pane's own sends go through forceSignal
    // and always re-read.
    refreshSignal: historyRefreshSignal ?? 0,
    forceSignal: sentNonce,
    ...(session.historySeq === undefined ? {} : { historySeq: session.historySeq }),
    enabled: session.sourceId === "dsh-local",
  });
  const promptAvailability = promptActionAvailability({
    hasSession: true,
    hasEndpoint: promptUrl !== undefined,
    sourceSupported: session.sourceId === "dsh-local",
    agentAvailable: session.agentAvailable,
  });
  const canPrompt = promptAvailability.allowed;
  const statusClass = session.lastError === undefined
    ? session.running
      ? "live"
      : "idle"
    : "error";
  const statusText = session.lastError === undefined
    ? session.running
      ? "运行中"
      : "空闲"
    : "错误";
  const availability = session.agentAvailable ? "Agent 可用" : "Agent 未激活";

  return (
    <section
      className={`fusion-session-pane${wide ? " is-wide" : ""}`}
      aria-label={`会话 ${session.title}`}
    >
      <header className="fusion-session-pane-head">
        <span className={`fusion-session-state ${statusClass}`} />
        <div>
          <strong>{session.title}</strong>
          <small>{node?.name ?? session.cwd ?? "未绑定节点"} · {statusText} · {availability}</small>
        </div>
        <div className="fusion-pane-actions">
          <button type="button" aria-label={`上移 ${session.title}`} onClick={() => onMoveRow(-1)}><ArrowUp size={13} /></button>
          <button type="button" aria-label={`下移 ${session.title}`} onClick={() => onMoveRow(1)}><ArrowDown size={13} /></button>
          <button type="button" aria-label={`切宽 ${session.title}`} onClick={onResize}><Columns2 size={13} /></button>
          <button type="button" aria-label={`${maximized ? "还原" : "最大化"} ${session.title}`} onClick={onMaximize}>
            {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button type="button" aria-label={`主视图打开 ${session.title}`} onClick={onOpenMain}><SquareArrowOutUpRight size={13} /></button>
          <button type="button" aria-label={`移除 ${session.title}`} onClick={onRemove}><X size={13} /></button>
        </div>
      </header>
      <div className="fusion-session-identity">
        <span>来源 {session.sourceId}</span>
        {session.parentNativeId === undefined
          ? null
          : <span>父会话 {session.parentNativeId}</span>}
        {session.origin === "subagent"
          ? <span>子代理 {session.subagentMode ?? "unknown"}</span>
          : null}
        <span>{statusText} · {availability}</span>
      </div>
      <div className="fusion-session-stream">
        {session.sourceId !== "dsh-local" ? (
          <div className="fusion-session-history-empty">Bridge 会话没有可读取的本地 history。</div>
        ) : history.loading ? (
          <div className="fusion-session-history-empty">读取会话历史…</div>
        ) : history.error === undefined ? (
          history.messages.length === 0 ? (
            <div className="fusion-session-history-empty">此会话暂无文本历史。</div>
          ) : history.messages.map((message) => (
            <div
              className={message.role === "user" ? "fusion-session-user" : "fusion-session-agent"}
              key={`${message.role}:${message.seq}`}
            >
              {message.role === "assistant" ? <span>Agent</span> : null}
              <p>{message.text}</p>
              <small>#{message.seq} · {new Date(message.time).toLocaleTimeString("zh-CN", { hour12: false })}</small>
            </div>
          ))
        ) : (
          <div className="fusion-session-history-empty" role="alert">历史读取失败：{history.error}</div>
        )}
      </div>
      <footer className="fusion-session-composer">
        <div className="fusion-session-composer-input">
          <textarea
            aria-label={`输入 ${session.title}`}
            readOnly={!canPrompt}
            value={draft}
            placeholder={canPrompt ? "输入 Prompt，Ctrl+Enter 发送" : "当前会话不可输入"}
            rows={1}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.ctrlKey) {
                event.preventDefault();
                void submitPrompt();
              }
            }}
          />
          {promptError === undefined ? (
            <span>
              {canPrompt
                ? "Prompt 将以 queue 模式提交到当前 DSH Session。"
                : "只有本地且 Agent 可用的 Session 支持 Prompt。"}
            </span>
          ) : (
            <span role="alert">{promptError}</span>
          )}
        </div>
        <button
          type="button"
          disabled={!canPrompt || sending || draft.trim() === ""}
          title={promptAvailability.allowed ? undefined : actionBlockLabel(promptAvailability.reason)}
          onClick={() => void submitPrompt()}
        >
          {sending ? "发送中" : "发送"}
        </button>
      </footer>
    </section>
  );

  async function submitPrompt(): Promise<void> {
    if (!canPrompt || promptUrl === undefined || draft.trim() === "" || sending) return;
    setSending(true);
    setPromptError(undefined);
    try {
      const response = await fetch(fusionBrowserUrl(promptUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId: session.sourceId,
          sessionId: session.nativeSessionId,
          text: draft.trim(),
          mode: "queue",
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        accepted?: boolean;
      };
      if (!response.ok || payload.accepted !== true) {
        throw new Error(payload.error ?? `Prompt HTTP ${response.status}`);
      }
      setDraft("");
      setSentNonce((current) => current + 1);
    } catch (error) {
      setPromptError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }
}
