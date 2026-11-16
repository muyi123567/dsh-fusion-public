import { useEffect, useState } from "react";
import type { NodeRecord, SessionHubSnapshot, SessionRecord } from "@dsh-fusion/core";
import { PanelsTopLeft, Plus, X } from "lucide-react";
import { PaneGrid } from "./PaneGrid.js";
import type { PaneLayout } from "./pane-store.js";
import {
  addPane,
  loadPanes,
  persistPanes,
  removePane,
  setPaneRow,
} from "./pane-store.js";
import {
  exactSessionForTarget,
  legacySessionForPersistedId,
  parseSessionDragData,
  useSessionHub,
} from "./use-session-hub.js";

export function MissionControl({
  sessions,
  sessionHubUrl,
  sessionHubSnapshot,
  refreshSignal,
  nodes,
  requestedSessionSourceId,
  requestedSessionId,
  requestToken,
  mainSessionId,
  onOpenMain,
}: {
  sessions: SessionRecord[];
  sessionHubUrl?: string;
  sessionHubSnapshot?: SessionHubSnapshot;
  refreshSignal?: number;
  nodes: NodeRecord[];
  requestedSessionSourceId?: string;
  requestedSessionId?: string;
  requestToken?: number;
  mainSessionId?: string;
  onOpenMain: (sessionId: string) => void;
}) {
  const [layout, setLayout] = useState<PaneLayout>(() => loadPanes());
  const [maximizedPaneId, setMaximizedPaneId] = useState<string>();
  const [widePaneId, setWidePaneId] = useState<string>();
  const sessionHub = useSessionHub({
    ...(sessionHubUrl === undefined ? {} : { endpoint: sessionHubUrl }),
    ...(sessionHubSnapshot === undefined ? {} : { authoritativeSnapshot: sessionHubSnapshot }),
    fallbackSessions: sessions,
    ...(refreshSignal === undefined ? {} : { refreshSignal }),
  });
  const hubSessions = sessionHub.snapshot.sessions;

  useEffect(() => {
    if (requestedSessionSourceId === undefined || requestedSessionId === undefined) return;
    const requested = exactSessionForTarget(hubSessions, {
      sourceId: requestedSessionSourceId,
      nativeSessionId: requestedSessionId,
    });
    if (requested !== undefined) {
      setLayout((current) => addPane(current, requested.id));
    }
  }, [requestedSessionSourceId, requestedSessionId, requestToken, hubSessions]);

  useEffect(() => {
    if (sessionHub.loading) return;
    setLayout((current) => {
      let changed = false;
      const rows = { ...current.rows };
      const panes: string[] = [];
      for (const paneId of current.panes) {
        if (hubSessions.some((session) => session.id === paneId)) {
          panes.push(paneId);
          continue;
        }
        const migrated = legacySessionForPersistedId(hubSessions, paneId);
        if (migrated === undefined) {
          const source = sessionHub.snapshot.sources.find((candidate) => paneId.startsWith(`${candidate.sourceId}:`));
          const ambiguousLegacy = hubSessions.filter((session) => session.nativeSessionId === paneId).length > 1;
          // A failed/missing source cannot prove a persisted Session was removed.
          if (!ambiguousLegacy && source?.state !== "available") {
            panes.push(paneId);
            continue;
          }
          changed = true;
          continue;
        }
        changed = true;
        if (rows[paneId] !== undefined && rows[migrated.id] === undefined) {
          rows[migrated.id] = rows[paneId];
        }
        panes.push(migrated.id);
      }
      return changed
        ? persistPanes(panes, rows)
        : current;
    });
  }, [hubSessions, sessionHub.loading, sessionHub.snapshot.sources, sessionHub.error]);

  const availableSessions = hubSessions.filter((session) => !layout.panes.includes(session.id));
  const mainSession = mainSessionId === undefined
    ? undefined
    : hubSessions.find((session) => session.id === mainSessionId);

  return (
    <section
      className="fusion-page fusion-mission-control"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const target = parseSessionDragData(
          event.dataTransfer.getData("application/x-dsh-fusion-session"),
        );
        if (target === undefined) return;
        const session = exactSessionForTarget(hubSessions, target);
        if (session !== undefined) setLayout((current) => addPane(current, session.id));
      }}
    >
      <div className="fusion-page-head">
        <div><h1>Mission Control</h1><p>并行观察、切换和引导多个 DSH 会话。</p></div>
        <div className="fusion-mission-actions">
          {availableSessions.map((session) => (
            <button
              type="button"
              className="fusion-ghost-button"
              key={session.id}
              onClick={() => setLayout((current) => addPane(current, session.id))}
            >
              <Plus size={13} /> {session.title}
            </button>
          ))}
        </div>
      </div>
      {sessionHub.error === undefined ? null : (
        <p className="fusion-session-notice" role="status">
          Session Hub 不可用，继续使用现有 sessions：{sessionHub.error}
        </p>
      )}
      {sessionHub.error !== undefined || !sessionHub.usingFallback ? null : (
        <p className="fusion-session-notice" role="status">
          Session Hub 降级，已合并现有 sessions。
        </p>
      )}
      {mainSession === undefined ? null : (
        <div className="fusion-main-session-banner">
          <PanelsTopLeft size={15} />
          <span>主视图</span>
          <strong>{mainSession.title}</strong>
          <button type="button" aria-label="关闭主视图" onClick={() => onOpenMain(mainSession.id)}><X size={13} /></button>
        </div>
      )}
      {layout.panes.length === 0 ? (
        <div className="fusion-pane-empty">
          <PanelsTopLeft size={28} />
          <strong>把会话拖到这里</strong>
          <span>也可以从上方按钮添加，布局会保存在本机。</span>
        </div>
      ) : (
        <PaneGrid
          sessions={hubSessions}
          nodes={nodes}
          {...(sessionHubUrl === undefined ? {} : {
            historyUrl: `${sessionHubUrl}/history`,
            promptUrl: `${sessionHubUrl}/prompt`,
          })}
          {...(refreshSignal === undefined ? {} : { historyRefreshSignal: refreshSignal })}
          layout={layout}
          {...(maximizedPaneId === undefined ? {} : { maximizedPaneId })}
          {...(widePaneId === undefined ? {} : { widePaneId })}
          onMaximize={(sessionId) => setMaximizedPaneId((current) => current === sessionId ? undefined : sessionId)}
          onResize={(sessionId) => setWidePaneId((current) => current === sessionId ? undefined : sessionId)}
          onMoveRow={(sessionId, direction) => setLayout((current) => setPaneRow(
            current,
            sessionId,
            (current.rows[sessionId] ?? 0) + direction,
          ))}
          onOpenMain={onOpenMain}
          onRemove={(sessionId) => {
            setLayout((current) => removePane(current, sessionId));
            setMaximizedPaneId((current) => current === sessionId ? undefined : current);
            setWidePaneId((current) => current === sessionId ? undefined : current);
          }}
        />
      )}
    </section>
  );
}
