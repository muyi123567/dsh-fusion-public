import { useRef, useState } from "react";
import {
  Waves,
  CircleCheckBig,
  CircleHelp,
  Command,
  FolderKanban,
  GitBranch,
  MessagesSquare,
  Network,
  PanelsTopLeft,
  Plus,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  UsersRound,
  X,
} from "lucide-react";
import type { BotRecord, GroupRecord, NodeRecord, SessionRecord } from "@dsh-fusion/core";
import { WhaleGlyph } from "../features/whale/WhaleGlyph.js";
import { BotAvatar } from "./BotAvatar.js";
import { useMediaQuery, useOverlayModal } from "./focus-utils.js";

export type WorkspaceMode = "ocean" | "setup" | "bot" | "fleet" | "tasks" | "sessions" | "rooms" | "runs" | "terminal" | "config";

const primaryNavigation: Array<{ id: WorkspaceMode; label: string; icon: typeof Command }> = [
  { id: "ocean", label: "鲸群总览", icon: Waves },
  { id: "bot", label: "对话", icon: Command },
  { id: "tasks", label: "多机任务", icon: FolderKanban },
  { id: "sessions", label: "Mission Control", icon: PanelsTopLeft },
  { id: "rooms", label: "会话房间", icon: MessagesSquare },
  { id: "runs", label: "Run Center", icon: GitBranch },
];

const infrastructureNavigation: Array<{ id: WorkspaceMode; label: string; icon: typeof Command }> = [
  { id: "terminal", label: "终端", icon: SquareTerminal },
  { id: "fleet", label: "节点", icon: Network },
  { id: "config", label: "配置", icon: Settings2 },
  { id: "setup", label: "开箱检查", icon: CircleCheckBig },
];

export function Sidebar(props: {
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  bots: BotRecord[];
  groups: GroupRecord[];
  nodes: NodeRecord[];
  sessions: SessionRecord[];
  selectedBotId: string;
  selectedSessionId?: string;
  onSelectBot: (bot: BotRecord) => void;
  onSelectNode: (node: NodeRecord) => void;
  onSelectSession: (session: SessionRecord) => void;
  onSelectRoom?: (roomId: string) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const [notice, setNotice] = useState<string>();
  const asideRef = useRef<HTMLElement>(null);
  // The sidebar is a modal overlay only in its fixed mobile
  // presentation (<=760px); on wider layouts it is a static
  // region and keeps plain aside semantics.
  const mobileViewport = useMediaQuery("(max-width: 760px)");
  const overlayActive = props.mobileOpen && mobileViewport;
  useOverlayModal(overlayActive, asideRef);

  return (
    <aside
      ref={asideRef}
      id="fusion-sidebar"
      className={"fusion-sidebar" + (props.mobileOpen ? " is-mobile-open" : "")}
      aria-label="鲸 · 工作区导航"
      {...(overlayActive ? { role: "dialog", "aria-modal": true } : {})}
    >
      <div className="fusion-brand">
        <span className="fusion-brand-mark"><WhaleGlyph size={42}/></span>
        <span className="fusion-brand-copy"><strong>鲸</strong><small>WHΛLE</small></span>
        <button type="button" className="fusion-sidebar-close" aria-label="关闭导航" onClick={props.onCloseMobile}><X size={14} /></button>
      </div>

      <nav className="fusion-nav" aria-label="工作区">
        <span className="fusion-nav-label">工作台</span>
        {primaryNavigation.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={props.mode === id ? "is-active" : ""}
            onClick={() => props.onModeChange(id)}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
        <span className="fusion-nav-label">运行基础设施</span>
        {infrastructureNavigation.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={props.mode === id ? "is-active" : ""}
            onClick={() => props.onModeChange(id)}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="fusion-side-section">
        <div className="fusion-side-heading">
          <span>我的 Agent</span>
          <button type="button" aria-label="添加 Bot" onClick={() => setNotice("添加 Bot 需要实时 Bot provider")}><Plus size={14} /></button>
        </div>
        {props.bots.map((bot) => (
          <button
            type="button"
            className={"fusion-bot-row" + (bot.id === props.selectedBotId ? " is-selected" : "")}
            key={bot.id}
            aria-label={bot.name}
            onClick={() => props.onSelectBot(bot)}
          >
            <BotAvatar bot={bot} />
            <span className="fusion-row-copy">
              <strong>{bot.name}</strong>
              <small>{bot.role}</small>
            </span>
            {bot.status === "working" && <span className="fusion-live-dot" />}
          </button>
        ))}
      </div>

      <div className="fusion-side-section">
        <div className="fusion-side-heading">
          <span>群聊</span>
          <button type="button" aria-label="添加群聊" onClick={() => setNotice("添加群聊需要实时 Bot provider")}><Plus size={14} /></button>
        </div>
        {props.groups.map((group) => (
          <button
            type="button"
            className="fusion-group-row"
            key={group.id}
            onClick={() => {
              if (group.providerId === "agent-room") props.onSelectRoom?.(group.id);
            }}
          >
            <UsersRound size={16} />
            <span>{group.name}</span>
            {group.unreadCount > 0 && <b>{group.unreadCount}</b>}
          </button>
        ))}
      </div>

      <div className="fusion-side-section fusion-fleet-section">
        <div className="fusion-side-heading">
          <span>主机海域</span>
          <button type="button" aria-label="添加节点" onClick={() => props.onModeChange("setup")}><Plus size={14} /></button>
        </div>
        {props.nodes.map((node) => (
          <button type="button" className="fusion-node-row" key={node.id} onClick={() => props.onSelectNode(node)}>
            <span className={"fusion-node-dot " + node.status} />
            <span>{node.name}</span>
            <small>
              {node.status !== "online"
                ? node.status === "degraded" ? "降级" : "离线"
                : node.configState === "drift"
                  ? "漂移"
                  : node.configState === "unknown"
                    ? "配置未验"
                    : "在线"}
            </small>
          </button>
        ))}
      </div>

      <div className="fusion-side-section">
        <div className="fusion-side-heading">
          <span>远端会话</span>
          <button type="button" aria-label="添加会话" onClick={() => setNotice("添加会话需要实时 Session provider")}><Plus size={14} /></button>
        </div>
        {props.sessions.map((session) => {
          const compositeId = `${session.providerId}:${session.id}`;
          return (
            <button
              type="button"
              className={"fusion-node-row" + (compositeId === props.selectedSessionId ? " is-selected" : "")}
              key={compositeId}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(
                  "application/x-dsh-fusion-session",
                  JSON.stringify({
                    sourceId: session.providerId,
                    nativeSessionId: session.id,
                  }),
                );
                event.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => props.onSelectSession(session)}
            >
              <span className={`fusion-session-state ${session.status}`} />
              <span>{session.title}</span>
              <small>{session.status}</small>
            </button>
          );
        })}
      </div>

      <div className="fusion-sidebar-footer">
        {notice === undefined ? null : <p className="fusion-sidebar-notice">{notice}</p>}
        <button type="button" onClick={() => props.onModeChange("setup")}><CircleHelp size={15} /><span>帮助</span></button>
        <button type="button" onClick={() => setNotice("安全边界：loopback、Tailscale 与工作区白名单")}><ShieldCheck size={15} /><span>安全</span></button>
      </div>
    </aside>
  );
}
