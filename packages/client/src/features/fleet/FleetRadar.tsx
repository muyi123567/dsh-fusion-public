import { useRef, useState } from "react";
import type { NodeRecord } from "@dsh-fusion/core";
import { Check, CircleAlert, Cpu, HardDrive, Network, Plus, Server } from "lucide-react";
import { mergeNodes } from "./node-model.js";
import {
  fleetObservabilityView,
  type FleetObservability,
} from "./fleet-observability.js";

function checkedTimeLabel(checkedAt: number): string {
  const date = new Date(checkedAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function FleetRadar({ nodes, selectedNodeId, onSelectNode, onCheck, onOpenSetup, fleet }: {
  nodes: NodeRecord[];
  selectedNodeId: string;
  onSelectNode: (id: string) => void;
  onCheck?: () => Promise<void>;
  onOpenSetup?: () => void;
  fleet?: FleetObservability;
}) {
  const observability = fleetObservabilityView(fleet);
  const visibleNodes = mergeNodes(nodes);
  const [lastChecked, setLastChecked] = useState<string>();
  const checkingRef = useRef(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string>();
  async function check() {
    if (!onCheck || checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setLastChecked(undefined);
    setCheckError(undefined);
    try {
      await onCheck();
      setLastChecked("刚刚");
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }
  const configLabel = (state: NodeRecord["configState"]) =>
    state === "current" ? "配置一致" : state === "drift" ? "配置漂移" : "配置未验证";

  return (
    <section className="fusion-page" aria-label="舰队雷达">
      <div className="fusion-page-head"><div><h1>舰队雷达</h1><p>节点、会话和执行能力保持在一个视图里。</p></div><button type="button" className="fusion-primary-button" disabled={!onCheck || checking} onClick={() => { void check(); }}>{checking ? "检查中…" : "配置检查"}</button></div>
      {onCheck ? null : <p>配置检查不可用：未连接检查服务</p>}
      {checkError === undefined ? null : <p className="fusion-config-error" role="alert">配置检查失败：{checkError}</p>}
      <div className="fusion-radar-summary"><span><b>{visibleNodes.length}</b> 节点</span><span><b>{visibleNodes.filter((node) => node.status === "online").length}</b> 在线</span><span><b>{visibleNodes.filter((node) => node.configState === "drift").length}</b> 配置漂移</span><span><Check size={14} /> SeekFleet 控制面{lastChecked === undefined ? "" : ` · ${lastChecked}检查`}</span></div>
      {observability === undefined ? null : (
        <div className="fusion-radar-summary" role="status">
          <span>数据时间 {checkedTimeLabel(observability.checkedAt)}</span>
          {observability.stale ? <span className="fusion-warning">快照已过期 · 后台刷新中</span> : null}
          {observability.inspectAttempts === undefined ? null : (
            <span>巡检累计 {observability.inspectAttempts} 次 · 失败 {observability.inspectFailures} 次</span>
          )}
          {observability.lastRoundAttempts === undefined ? null : (
            <span>最近一轮 {observability.lastRoundAttempts} 次 · 失败 {observability.lastRoundFailures} 次 · 队列峰值 {observability.peakQueueDepth} · {observability.lastRoundRunning ? "进行中" : `耗时 ${observability.lastRoundDurationMs} ms`}</span>
          )}
        </div>
      )}
      {visibleNodes.length === 0 ? (
        <div className="fusion-fleet-empty">
          <Server size={26} aria-hidden="true" />
          <strong>还没有可观测的执行节点</strong>
          <span>先在开箱检查中配置 Instabox 或 SSH 节点，节点上线后会自动进入舰队矩阵。</span>
          {onOpenSetup === undefined ? null : (
            <button type="button" className="fusion-primary-button" onClick={onOpenSetup}>
              <Plus size={14} /> 添加执行节点
            </button>
          )}
        </div>
      ) : (
        <div className="fusion-radar-table">
          <div className="fusion-radar-row fusion-radar-header"><span>节点</span><span>状态</span><span>传输</span><span>能力</span><span>配置</span><span>资源</span></div>
          {visibleNodes.map((node) => (
            <button type="button" className={"fusion-radar-row" + (selectedNodeId === node.id ? " is-selected" : "")} key={node.id} onClick={() => onSelectNode(node.id)}>
              <span className="fusion-node-cell"><i className={"fusion-node-dot " + node.status} /><strong>{node.name}</strong><small>{node.platform}</small></span>
              <span className={`fusion-status ${node.status}`}><CircleAlert size={13} /> {node.status === "online" ? "在线" : node.status === "degraded" ? "降级" : "离线"}</span>
              <span className="fusion-transport"><Network size={13} /> {node.transports[0]}</span>
              <span>{node.capabilities.slice(0, 3).join(" · ")}</span>
              <span className={node.configState === "current" && node.status !== "offline" ? "fusion-ok" : "fusion-warning"}>{configLabel(node.status === "offline" ? "unknown" : node.configState)}</span>
              <span className="fusion-resource">
                <Cpu size={13} /> {node.cpuPercent === undefined ? "未报告" : `${node.cpuPercent}%`}
                <HardDrive size={13} /> {node.memoryPercent === undefined ? "未报告" : `${node.memoryPercent}%`}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
