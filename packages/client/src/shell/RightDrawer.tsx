import { useRef, useState } from "react";
import type { BotRecord, NodeRecord, TaskRecord } from "@dsh-fusion/core";
import { Activity, Check, CircleAlert, CircleDot, Cpu, HardDrive, Network } from "lucide-react";
import { NodeDetails } from "../features/fleet/NodeDetails.js";
import type { WorkspaceMode } from "./Sidebar.js";
import { BotAvatar } from "./BotAvatar.js";
import { useMediaQuery, useOverlayModal } from "./focus-utils.js";

export function RightDrawer({
  mode,
  bot,
  node,
  tasks,
  mobileOpen,
  onCloseMobile,
}: {
  mode: WorkspaceMode;
  bot: BotRecord;
  node: NodeRecord;
  tasks: TaskRecord[];
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const task = [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const [notice, setNotice] = useState<string>();
  const asideRef = useRef<HTMLElement>(null);
  // The drawer is a modal overlay only in its fixed
  // presentation (<=1120px); above that it is an always
  // visible static region and must not trap focus.
  const overlayViewport = useMediaQuery("(max-width: 1120px)");
  const overlayActive = mobileOpen && overlayViewport;
  useOverlayModal(overlayActive, asideRef);
  const botStatusLabel = bot.status === "working"
    ? "工作中"
    : bot.status === "idle"
      ? "空闲"
      : "离线";
  const configLabel = node.configState === "current"
    ? "配置一致"
    : node.configState === "drift"
      ? "配置漂移"
      : "配置未验证";

  return (
    <aside
      ref={asideRef}
      id="fusion-right-drawer"
      className={"fusion-drawer" + (mobileOpen ? " is-mobile-open" : "")}
      aria-label="详情"
      {...(overlayActive ? { role: "dialog", "aria-modal": true } : {})}
    >
      <div className="fusion-drawer-head">
        <span>详情</span>
        <button type="button" className="fusion-drawer-close" aria-label="关闭详情" onClick={onCloseMobile}>×</button>
      </div>
      {mode === "fleet" && <NodeDetails node={node} tasks={tasks} />}
      {mode !== "fleet" && <div className="fusion-drawer-profile">
        <BotAvatar bot={bot} large />
        <strong>{bot.name}</strong>
        <small>{bot.role}</small>
        <span className={`fusion-online ${bot.status}`}>
          <CircleDot size={11} /> {botStatusLabel} · {bot.model}
          {bot.reasoningEffort === undefined ? "" : ` · ${bot.reasoningEffort}`}
        </span>
      </div>}
      {mode !== "fleet" && <div className="fusion-drawer-tabs"><span className="is-active">详情</span><span>节点</span><span>任务</span><span>配置</span></div>}
      {mode !== "fleet" && <section className="fusion-drawer-section">
        <h3>
          当前多机状态
          <span className={node.configState === "current" ? "fusion-ok" : "fusion-warning"}>
            {node.configState === "current" ? <Check size={12} /> : <CircleAlert size={12} />}
            {configLabel}
          </span>
        </h3>
        <div className="fusion-node-mini">
          <span className={`fusion-node-dot ${node.status}`} />
          <div><strong>{node.name}</strong><small>{node.status} · {node.dshVersion}</small></div>
          <span>{node.cpuPercent === undefined ? "未报告" : `${node.cpuPercent}%`}</span>
        </div>
        <div className="fusion-node-metrics">
          <span><Cpu size={13} /> CPU {node.cpuPercent === undefined ? "未报告" : `${node.cpuPercent}%`}</span>
          <span><HardDrive size={13} /> 内存 {node.memoryPercent === undefined ? "未报告" : `${node.memoryPercent}%`}</span>
        </div>
      </section>}
      {mode !== "fleet" && <section className="fusion-drawer-section">
        <h3>当前任务</h3>
        {task === undefined ? <p className="fusion-muted">当前没有任务</p> : <div className="fusion-task-mini"><Activity size={15} /><div><strong>{task.goal}</strong><small>{task.progress === undefined ? "进度未报告" : `${task.progress}%`} · {task.status}</small></div></div>}
      </section>}
      {mode !== "fleet" && <section className="fusion-drawer-section">
        <h3>连接</h3>
        <p className="fusion-muted"><Network size={13} /> {node.transports.join(" · ")}</p>
      </section>}
      {mode !== "fleet" && <div className="fusion-drawer-actions">
        <button type="button" className="primary" onClick={() => setNotice("在对话输入框中向 Chief 派发任务")}>派发任务</button>
        <button type="button" onClick={() => setNotice(task?.sessionId === undefined ? "当前任务没有会话" : `已选择会话 ${task.sessionId}`)}>查看会话</button>
        {notice === undefined ? null : <p className="fusion-inline-notice">{notice}</p>}
      </div>}
      {mode === "fleet" && <div className="fusion-drawer-actions">
        <button type="button" className="primary" onClick={() => setNotice("请从 Chief 对话派发任务")}>派发任务</button>
        <button type="button" onClick={() => setNotice(node.transports.includes("ssh") ? `在终端页选择节点 ${node.name} 打开终端` : "终端入口需要 SSH transport")}>打开终端</button>
        {notice === undefined ? null : <p className="fusion-inline-notice">{notice}</p>}
      </div>}
    </aside>
  );
}
