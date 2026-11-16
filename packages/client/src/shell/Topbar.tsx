import { useState } from "react";
import { Bell, Menu, MoreHorizontal, Search, Settings2 } from "lucide-react";
import type { BotRecord, NodeRecord } from "@dsh-fusion/core";
import type { WorkspaceMode } from "./Sidebar.js";
import { BotAvatar } from "./BotAvatar.js";
import type { FusionStreamGap } from "../stream/use-fusion-stream.js";

export function Topbar({
  mode,
  selectedBot,
  selectedNode,
  onToggleSidebar,
  onToggleDetails,
  detailsOpen = false,
  onOpenConfig,
  streamStatus,
  streamRefusal,
  streamGap,
}: {
  mode: WorkspaceMode;
  selectedBot: BotRecord;
  selectedNode: NodeRecord;
  onToggleSidebar: () => void;
  onToggleDetails: () => void;
  detailsOpen?: boolean;
  onOpenConfig: () => void;
  /**
   * The live event stream's state. The panel polls on a timer either way, so
   * a degraded stream is not a failure - but it has to be visible, otherwise
   * an operator cannot tell a live panel from a stale one.
   */
  streamStatus?: "disabled" | "connecting" | "live" | "polling";
  streamRefusal?: string | undefined;
  streamGap?: FusionStreamGap | undefined;
}) {
  const [notice, setNotice] = useState<string>();
  const title = mode === "setup" ? "开箱检查" : mode === "bot" ? selectedBot.name : mode === "fleet" ? "节点矩阵" : mode === "tasks" ? "多机任务" : mode === "sessions" ? "Mission Control" : mode === "rooms" ? "会话房间" : mode === "runs" ? "Run Center" : mode === "terminal" ? "SSH Hub" : "配置与版本";
  return (
    <header className="fusion-topbar">
      <div className="fusion-topbar-title">
        <BotAvatar bot={selectedBot} />
        <div>
          <strong>{title}</strong>
          <small>{mode === "setup" ? "安装、连接与运行前检查" : mode === "bot" ? selectedBot.role : mode === "fleet" ? selectedNode.name : mode === "sessions" ? "多会话并行控制" : mode === "rooms" ? "成员与真实 timeline" : mode === "runs" ? "DAG 编排与失败归因" : mode === "terminal" ? "多机终端工作区" : "DSH FUSION"}</small>
        </div>
      </div>
      <div className="fusion-topbar-actions">
        <button type="button" className="fusion-mobile-menu" aria-label="打开导航" onClick={onToggleSidebar}><Menu size={17} /></button>
        {streamStatus === undefined || streamStatus === "disabled" ? null : (
          <span
            className="fusion-stream-chip"
            data-stream-status={streamStatus}
            title={streamRefusal ?? (streamStatus === "live" ? "实时事件流已连接" : "实时事件流不可用，已回退到轮询")}
          >
            <span className="fusion-stream-dot" aria-hidden="true" />
            {streamStatus === "live" ? "实时" : streamStatus === "connecting" ? "连接中" : "轮询"}
          </span>
        )}
        {streamGap === undefined ? null : (
          <span
            className="fusion-topbar-notice"
            title={`事件缺口 seq ${streamGap.missingFrom}-${streamGap.missingTo}，已请求全量快照拉取`}
          >
            缺口 seq {streamGap.missingFrom}-{streamGap.missingTo}
          </span>
        )}
        {notice === undefined ? null : <span className="fusion-topbar-notice">{notice}</span>}
        <button
          type="button"
          aria-label="搜索"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("dsh-fusion:focus-search"));
            if (mode !== "tasks") setNotice("当前工作区没有可搜索内容");
          }}
        >
          <Search size={17} />
        </button>
        <button type="button" aria-label="通知" onClick={() => setNotice("当前没有新的运行时通知")}><Bell size={17} /></button>
        {mode === "setup" || mode === "tasks" ? null : <button type="button" className="fusion-details-toggle" aria-label="打开详情" aria-expanded={detailsOpen} aria-controls="fusion-right-drawer" onClick={onToggleDetails}><MoreHorizontal size={17} /></button>}
        <button type="button" className="fusion-config-chip" aria-label="打开配置" onClick={onOpenConfig}>
          <Settings2 size={13} /> 配置
        </button>
      </div>
    </header>
  );
}
