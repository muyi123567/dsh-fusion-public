import { createPortal } from "react-dom";
import { useState, type CSSProperties, type ReactNode } from "react";
import type { NodeRecord, SessionHubSessionRecord } from "@dsh-fusion/core";
import type { PaneLayout } from "./pane-store.js";
import { SessionPane } from "./SessionPane.js";

function PaneHost({ children, className, style }: {
  children: ReactNode;
  className: string;
  style: CSSProperties;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <div className={className} style={style} ref={setHost}>
      {host === null ? null : createPortal(children, host)}
    </div>
  );
}

export function PaneGrid({
  sessions,
  nodes,
  historyUrl,
  promptUrl,
  historyRefreshSignal,
  layout,
  maximizedPaneId,
  widePaneId,
  onMaximize,
  onResize,
  onMoveRow,
  onOpenMain,
  onRemove,
}: {
  sessions: SessionHubSessionRecord[];
  nodes: NodeRecord[];
  historyUrl?: string;
  promptUrl?: string;
  historyRefreshSignal?: number;
  layout: PaneLayout;
  maximizedPaneId?: string;
  widePaneId?: string;
  onMaximize: (sessionId: string) => void;
  onResize: (sessionId: string) => void;
  onMoveRow: (sessionId: string, direction: -1 | 1) => void;
  onOpenMain: (sessionId: string) => void;
  onRemove: (sessionId: string) => void;
}) {
  const visibleSessions = layout.panes
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is SessionHubSessionRecord => session !== undefined);

  return (
    <div className={`fusion-pane-grid${maximizedPaneId === undefined ? "" : " has-maximized"}`}>
      {visibleSessions.map((session) => {
        const row = layout.rows[session.id] ?? 0;
        const wide = widePaneId === session.id;
        const maximized = maximizedPaneId === session.id;
        return (
          <PaneHost
            className={`fusion-pane-host${wide ? " is-wide" : ""}${maximized ? " is-maximized" : ""}`}
            key={session.id}
            style={{ gridRow: row + 1, gridColumn: wide || maximized ? "1 / -1" : "auto" }}
          >
            <SessionPane
              session={session}
              {...(historyUrl === undefined ? {} : { historyUrl })}
              {...(promptUrl === undefined ? {} : { promptUrl })}
              {...(historyRefreshSignal === undefined ? {} : {
                historyRefreshSignal,
              })}
              maximized={maximized}
              wide={wide}
              onMaximize={() => onMaximize(session.id)}
              onResize={() => onResize(session.id)}
              onMoveRow={(direction) => onMoveRow(session.id, direction)}
              onOpenMain={() => onOpenMain(session.id)}
              onRemove={() => onRemove(session.id)}
            />
          </PaneHost>
        );
      })}
    </div>
  );
}
