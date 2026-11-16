import { useState } from "react";
import type { ConfigSnapshot, NodeRecord } from "@dsh-fusion/core";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  MinusCircle,
  RefreshCw,
  Server,
  SlidersHorizontal,
  UsersRound,
  Wrench,
} from "lucide-react";
import type { FusionProviderStatusMap } from "../bridges/bridge-sources-model.js";
import {
  orderedProviderStatuses,
  providerLabel,
  providerStateLabel,
  providerStatusDetail,
} from "../bridges/bridge-sources-model.js";
import {
  buildSetupReadiness,
  type SetupCheck,
  type SetupTone,
} from "./setup-readiness.js";

function CheckIcon({ tone }: { tone: SetupTone }) {
  if (tone === "ready") return <Check size={15} aria-hidden="true" />;
  if (tone === "attention") return <CircleAlert size={15} aria-hidden="true" />;
  if (tone === "pending") return <Clock3 size={15} aria-hidden="true" />;
  return <MinusCircle size={15} aria-hidden="true" />;
}

function checkStatusLabel(check: SetupCheck): string {
  if (check.tone === "ready") return check.required ? "已就绪" : "已连接";
  if (check.tone === "attention") return "需处理";
  if (check.tone === "pending") return "等待中";
  return "可选";
}

function checkIcon(check: SetupCheck) {
  if (check.id === "runtime") return <SlidersHorizontal size={17} aria-hidden="true" />;
  if (check.id === "nodes") return <Server size={17} aria-hidden="true" />;
  if (check.id === "config") return <Check size={17} aria-hidden="true" />;
  return <UsersRound size={17} aria-hidden="true" />;
}

export function SetupWorkspace({
  snapshotLoaded,
  pluginMode,
  allowDemo,
  nodes,
  providers,
  config,
  snapshotError,
  onCheck,
  onOpenConfig,
  onOpenFleet,
  onOpenTasks,
}: {
  snapshotLoaded: boolean;
  pluginMode: boolean;
  allowDemo: boolean;
  nodes: readonly NodeRecord[];
  providers: FusionProviderStatusMap;
  config: ConfigSnapshot;
  snapshotError?: string;
  onCheck?: () => Promise<void>;
  onOpenConfig: () => void;
  onOpenFleet: () => void;
  onOpenTasks: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string>();
  const [lastChecked, setLastChecked] = useState<string>();
  const readiness = buildSetupReadiness({
    snapshotLoaded,
    pluginMode,
    nodes,
    providers,
    config,
  });
  const providerRows = orderedProviderStatuses(providers);

  const runCheck = async () => {
    if (onCheck === undefined || checking) return;
    setChecking(true);
    setCheckError(undefined);
    setLastChecked(undefined);
    try {
      await onCheck();
      setLastChecked("刚刚完成检查");
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  };

  const runNextAction = () => {
    if (readiness.nextAction.target === "config") onOpenConfig();
    else if (readiness.nextAction.target === "fleet") onOpenFleet();
    else if (readiness.nextAction.target === "tasks") onOpenTasks();
  };

  return (
    <section className="fusion-page fusion-setup-page" aria-label="开箱检查">
      <div className="fusion-page-head">
        <div>
          <h1>开箱检查</h1>
          <p>按当前 DSH 快照确认运行时、节点、配置与协作能力。</p>
        </div>
        <div className="fusion-setup-head-actions">
          {allowDemo ? <span className="fusion-setup-demo">演示数据</span> : null}
          <button
            type="button"
            className="fusion-ghost-button"
            disabled={onCheck === undefined || checking}
            title={onCheck === undefined ? "当前预览模式没有 doctor 路由" : undefined}
            onClick={() => { void runCheck(); }}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {checking ? "检查中…" : "运行环境检查"}
          </button>
        </div>
      </div>

      {snapshotError === undefined ? null : (
        <p className="fusion-setup-alert" role="status">
          当前显示的是上次成功快照；刷新失败原因：{snapshotError}
        </p>
      )}
      {checkError === undefined ? null : (
        <p className="fusion-setup-alert" role="alert">
          环境检查失败：{checkError}
        </p>
      )}
      {lastChecked === undefined ? null : (
        <p className="fusion-setup-success" role="status">
          <Check size={14} aria-hidden="true" /> {lastChecked}
        </p>
      )}

      <div className="fusion-setup-summary">
        <div className="fusion-setup-score">
          <strong>{readiness.readyRequired}/{readiness.totalRequired}</strong>
          <span>基础项就绪</span>
        </div>
        <div className={`fusion-setup-next is-${readiness.nextAction.tone}`}>
          <span>{readiness.nextAction.label}</span>
          <p>{readiness.nextAction.detail}</p>
        </div>
        {readiness.nextAction.target === null ? (
          <span className="fusion-setup-waiting">
            <Clock3 size={14} aria-hidden="true" /> 等待状态
          </span>
        ) : (
          <button type="button" className="fusion-primary-button" onClick={runNextAction}>
            {readiness.nextAction.label}
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      <ol className="fusion-setup-checks" aria-label="上线检查项">
        {readiness.checks.map((check) => (
          <li className={`fusion-setup-check is-${check.tone}`} key={check.id}>
            <span className="fusion-setup-check-icon">{checkIcon(check)}</span>
            <div>
              <div className="fusion-setup-check-title">
                <strong>{check.label}</strong>
                <span>
                  <CheckIcon tone={check.tone} />
                  {checkStatusLabel(check)}
                </span>
              </div>
              <p>{check.detail}</p>
            </div>
          </li>
        ))}
      </ol>

      <section className="fusion-setup-section" aria-labelledby="fusion-provider-health">
        <div className="fusion-setup-section-head">
          <div>
            <h2 id="fusion-provider-health">连接状态</h2>
            <p>状态来自当前权威快照，缺失来源不会显示为成功。</p>
          </div>
          <span>{providerRows.length} 个来源</span>
        </div>
        {providerRows.length === 0 ? (
          <p className="fusion-setup-empty">宿主尚未报告 provider 状态。</p>
        ) : (
          <div className="fusion-setup-provider-list" role="list">
            {providerRows.map(([providerId, status]) => (
              <div className="fusion-setup-provider" role="listitem" key={providerId}>
                <span className={`fusion-setup-provider-dot is-${status.state}`} />
                <strong>{providerLabel(providerId)}</strong>
                <span className={`fusion-setup-provider-state is-${status.state}`}>
                  {providerStateLabel(status.state)}
                </span>
                <small>{providerStatusDetail(status)}</small>
              </div>
            ))}
          </div>
        )}
      </section>

      <details className="fusion-setup-companion">
        <summary>
          <Wrench size={16} aria-hidden="true" />
          <span>
            <strong>可选协作组件</strong>
            <small>Room、AgentTeams、AgentBus</small>
          </span>
        </summary>
        <p>Fusion 包内附带经过哈希校验的 Room 0.7.0、AgentTeams 0.1.26 与兼容 DSH 0.2 的 AgentBus 0.1.1；在 DSH 主机执行：</p>
        <pre><code>dsh-fusion-setup --profile web</code></pre>
        <small>命令会一次安装并校验四个 bundle，先备份 profile，失败时恢复；使用 `--dry-run` 可只查看安装计划。</small>
      </details>
    </section>
  );
}
