import { useRef, useState } from "react";
import type { ConfigSnapshot, NodeRecord } from "@dsh-fusion/core";
import { GitCommitHorizontal } from "lucide-react";
import { fusionBrowserUrl } from "../../routes.js";
import { ConfigPanel } from "./ConfigPanel.js";
import { buildConfigApplyErrorMessage } from "./config-apply-error.js";

export function ConfigWorkspace({
  nodes,
  snapshot,
  pluginMode,
  onRefresh,
}: {
  nodes: NodeRecord[];
  snapshot: ConfigSnapshot;
  pluginMode: boolean;
  onRefresh?: () => Promise<void>;
}) {
  const [checked, setChecked] = useState(false);
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const [checkError, setCheckError] = useState<string>();

  async function refresh() {
    if (!onRefresh) return;
    try {
      await onRefresh();
    } catch (error) {
      throw new Error(`刷新失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function check() {
    if (!pluginMode || checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setChecked(false);
    setCheckError(undefined);
    try {
      const response = await fetch(fusionBrowserUrl("/plugins/dsh-fusion/config/status"));
      const body = await response.json() as { ok?: boolean; state?: string; message?: string; error?: string };
      // Drift/missing/invalid are completed diagnoses, even when the config is not healthy.
      const diagnosed = body.state !== undefined && ["current", "drift", "missing", "invalid"].includes(body.state);
      const failed = body.state !== undefined && ["doctor-failed", "apply-failed", "unreachable"].includes(body.state);
      if (!response.ok || failed || (body.ok === false && !diagnosed)) {
        throw new Error(body.message ?? body.error ?? `config status ${body.state ?? response.status}`);
      }
      await refresh();
      setChecked(true);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }

  return (
    <section className="fusion-page">
      <div className="fusion-page-head"><div><h1>配置与版本</h1><p>一套配置源，按节点渲染；运行态和密钥不跨机同步。</p></div><button type="button" className="fusion-primary-button" disabled={!pluginMode || checking} onClick={() => { void check(); }}><GitCommitHorizontal size={14} /> {checking ? "检查中…" : checked ? "已检查" : "检查漂移"}</button></div>
      {pluginMode ? null : <p>配置检查不可用：未连接检查服务</p>}
      {checkError === undefined ? null : <p className="fusion-config-error" role="alert">配置检查失败：{checkError}</p>}
      <ConfigPanel
        nodes={nodes}
        snapshot={snapshot}
        onApply={async (nodeId) => {
          const response = await fetch(fusionBrowserUrl(pluginMode ? "/plugins/dsh-fusion/config/apply" : "/api/fusion/config/apply"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ nodeId }),
          });
          if (!response.ok) {
            const body: unknown = await response.json().catch(() => ({}));
            throw new Error(buildConfigApplyErrorMessage(response.status, body));
          }
          await refresh();
        }}
      />
    </section>
  );
}
