import type { NodeRecord, TaskRecord } from "@dsh-fusion/core";
import {
  Activity,
  Check,
  CircleAlert,
  Clock,
  Cpu,
  HardDrive,
  Network,
  Server,
} from "lucide-react";

export function NodeDetails({ node, tasks }: { node: NodeRecord; tasks: TaskRecord[] }) {
  const activeTasks = tasks.filter(
    (task) =>
      task.targetNodeIds.includes(node.id) &&
      ["queued", "claimed", "running", "verifying"].includes(task.status),
  );
  const configLabel = node.configState === "current"
    ? "配置一致"
    : node.configState === "drift"
      ? "配置漂移"
      : "配置未验证";

  return (
    <>
      <div className="fusion-drawer-profile">
        <span className={`fusion-node-hero ${node.status}`}><Server size={25} /></span>
        <strong>{node.name}</strong>
        <small>{node.platform} · {node.roles.join(" · ")}</small>
        <span className={`fusion-online ${node.status}`}>
          {node.status === "online" ? <Check size={11} /> : <CircleAlert size={11} />}
          {node.status === "online" ? "在线" : node.status === "degraded" ? "降级" : "离线"}
          {node.dshVersion === undefined ? "" : ` · DSH ${node.dshVersion}`}
        </span>
      </div>
      {node.hostAccess === undefined ? null : (
        <section className="fusion-drawer-section">
          <h3>Host 权限</h3>
          <dl className="fusion-node-facts">
            <div>
              <dt>所有者</dt>
              <dd>{node.hostAccess.ownerId ?? "未指定"}</dd>
            </div>
            <div>
              <dt>共享模式</dt>
              <dd>{node.hostAccess.sharingMode === "shared" ? "共享 Host" : "专属 Host"}</dd>
            </div>
            <div>
              <dt>并发配额</dt>
              <dd>{node.hostAccess.maxConcurrentTasks === undefined
                ? "未限制"
                : `${node.hostAccess.maxConcurrentTasks} 个活动任务`}</dd>
            </div>
          </dl>
        </section>
      )}
      <section className="fusion-drawer-section">
        <h3>
          节点状态
          <span className={node.configState === "current" ? "fusion-ok" : "fusion-warning"}>
            {node.configState === "current" ? <Check size={12} /> : <CircleAlert size={12} />}
            {configLabel}
          </span>
        </h3>
        <div className="fusion-node-metrics">
          <span><Cpu size={13} /> CPU {node.cpuPercent === undefined ? "未报告" : `${node.cpuPercent}%`}</span>
          <span><HardDrive size={13} /> 内存 {node.memoryPercent === undefined ? "未报告" : `${node.memoryPercent}%`}</span>
        </div>
        <dl className="fusion-node-facts">
          <div><dt>配置哈希</dt><dd>{node.configHash ?? "未知"}</dd></div>
          <div><dt>最近心跳</dt><dd><Clock size={12} /> {node.lastHeartbeat ?? "未知"}</dd></div>
        </dl>
      </section>
      <section className="fusion-drawer-section">
        <h3>传输与能力</h3>
        <p className="fusion-muted"><Network size={13} /> {node.transports.join(" · ")}</p>
        <div className="fusion-capability-list">
          {node.capabilities.map((capability) => <span key={capability}>{capability}</span>)}
        </div>
      </section>
      <section className="fusion-drawer-section">
        <h3>活跃任务 <span className="fusion-muted">{activeTasks.length}</span></h3>
        {activeTasks.length === 0 ? (
          <p className="fusion-muted">当前没有活跃任务</p>
        ) : activeTasks.map((task) => (
          <div className="fusion-task-mini" key={task.id}>
            <Activity size={15} />
            <div><strong>{task.goal}</strong><small>{task.progress === undefined ? "进度未报告" : `${task.progress}%`} · {task.status}</small></div>
          </div>
        ))}
      </section>
      {/* No actions block here: the drawer renders its own
          dispatch/terminal actions below (with notices), and a
          second pair inside the details used to be dead
          buttons with no handlers at all. */}
    </>
  );
}
