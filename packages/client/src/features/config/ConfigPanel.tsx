import { useRef, useState } from "react";
import type { ConfigSnapshot, NodeRecord } from "@dsh-fusion/core";
import { GitCommitHorizontal, RefreshCw, ShieldCheck } from "lucide-react";
import { DriftBadge } from "./DriftBadge.js";

export function ConfigPanel({
  nodes,
  snapshot,
  onApply,
}: {
  nodes: NodeRecord[];
  snapshot: ConfigSnapshot;
  onApply: (nodeId: string) => void | Promise<void>;
}) {
  const inFlight = useRef(new Set<string>());
  const [pendingNodes, setPendingNodes] = useState<Set<string>>(() => new Set());
  const [applyErrors, setApplyErrors] = useState<Map<string, string>>(() => new Map());

  async function apply(nodeId: string) {
    if (inFlight.current.has(nodeId)) return;
    inFlight.current.add(nodeId);
    setPendingNodes(new Set(inFlight.current));
    setApplyErrors((errors) => {
      const next = new Map(errors);
      next.delete(nodeId);
      return next;
    });
    try {
      await onApply(nodeId);
    } catch (error) {
      setApplyErrors((errors) => new Map(errors).set(nodeId, error instanceof Error ? error.message : String(error)));
    } finally {
      inFlight.current.delete(nodeId);
      setPendingNodes(new Set(inFlight.current));
    }
  }

  return (
    <>
      <div className="fusion-config-banner">
        <div>
          <strong>期望版本 {snapshot.revision}</strong>
          <small>desired {snapshot.desiredCommit ?? "unknown"} · applied {snapshot.appliedCommit ?? "unknown"}</small>
        </div>
        <span className="fusion-ok"><ShieldCheck size={14} /> 原子应用与 doctor 回滚</span>
      </div>
      <div className="fusion-config-facts">
        <span><GitCommitHorizontal size={14} /> 配置哈希 {snapshot.hash.slice(0, 12)}</span>
        <span><RefreshCw size={14} /> 插件 {Object.entries(snapshot.pluginVersions).map(([name, version]) => `${name}@${version}`).join(" · ")}</span>
      </div>
      <div className="fusion-config-list">
        {nodes.map((node) => {
          const configurable = node.capabilities.includes("config");
          const offline = node.status === "offline";
          const state = offline ? "unknown" : node.configState;
          const pending = pendingNodes.has(node.id);
          const needsApply = configurable && !offline && state !== "current";
          return (
            <div className="fusion-config-row" key={node.id}>
              <span className="fusion-node-cell">
                <i className={`fusion-node-dot ${node.status}`} />
                <strong>{node.name}</strong>
              </span>
              <span>{node.configHash ?? "未知"}</span>
              <DriftBadge state={state} offline={offline} />
              <button
                type="button"
                className="fusion-ghost-button"
                aria-label={`应用 ${node.name} 配置`}
                disabled={!needsApply || pending}
                onClick={() => { void apply(node.id); }}
              >
                {pending ? "应用中…" : !configurable ? "只读" : offline ? "离线不可用" : needsApply ? "应用配置" : "配置一致"}
              </button>
              {applyErrors.has(node.id) ? (
                <p className="fusion-config-error" role="alert" style={{ gridColumn: "1 / -1" }}>配置应用失败：{applyErrors.get(node.id)}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}
