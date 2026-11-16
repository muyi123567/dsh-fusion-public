import { useEffect, useState } from "react";
import type { ExecCapabilityCheck, ExecutionPreview, ExecutionPreviewNode } from "@dsh-fusion/core";
import "./DispatchPreview.css";

const reasonLabels: Readonly<Record<string, string>> = {
  NODE_NOT_FOUND: "当前快照未返回该节点",
  NODE_OFFLINE: "节点离线或处于降级状态",
  POLICY_BLOCKED: "当前策略不允许执行",
  PROBE_UNAVAILABLE: "尚无能力观察",
  PROBE_INCOMPLETE: "基础检查信息不完整",
  PROBE_FAILED: "基础检查未能取得确定结果",
  EXEC_PROBE_FAILED: "基础检查未能取得确定结果",
  EXEC_PROBE_UNAVAILABLE: "该节点尚未提供执行条件检查接口",
  EXEC_PROBE_TIMEOUT: "检查超时，当前结果未知，请稍后重试",
  EXEC_PROBE_BUSY: "检查资源繁忙，请稍后重试",
  EXEC_PROBE_IDENTITY_MISMATCH: "检查结果来源不匹配，未采用该结果",
  EXEC_PROBE_INVALID: "诊断结果不完整或格式异常，请重新检查",
  EXEC_PROC_UNAVAILABLE: "无法读取进程信息，请检查节点运行环境",
  EXEC_JOB_ROOT_UNWRITABLE: "任务目录的父目录权限不满足要求",
  EXEC_TOOL_MISSING: "缺少执行所需工具，请查看下方缺失项",
  OBSERVATION_EXPIRED: "能力观察已过期，需要重新诊断",
  PREVIEW_EXPIRED: "本组诊断已过期，需要重新诊断",
  PREREQUISITES_MISSING: "缺少执行所需的基础条件",
  BASIC_CHECKS_PASSED: "基础检查满足，不包含业务要求验证",
};

const decisionLabels: Record<ExecutionPreviewNode["decision"], string> = {
  eligible: "基础检查可用", blocked: "基础检查受阻", unknown: "基础检查未知",
};

const timestampFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  second: "2-digit", hour12: false, timeZoneName: "short",
});

function PreviewTime({ value }: { value: number }) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? <time dateTime={date.toISOString()}>{timestampFormat.format(date)}</time>
    : <span>时间不可用</span>;
}

function ObservationChecks({ checks }: { checks: readonly ExecCapabilityCheck[] }) {
  const missingTools = checks.filter((check) => !check.ok && /^tool_[a-z][a-z0-9_-]{0,63}$/u.test(check.id));
  if (checks.length === 0) return null;
  return (
    <>
      {missingTools.length === 0 ? null : (
        <p>缺少工具：{missingTools.map((check, index) => (
          <span key={check.id}>{index === 0 ? "" : "、"}<code>{check.id}</code></span>
        ))}</p>
      )}
      <details className="fusion-dispatch-preview-checks">
        <summary>查看基础检查项（{checks.filter((check) => !check.ok).length}/{checks.length} 项未满足）</summary>
        <ul>{checks.map((check) => (
          <li key={check.id} data-ok={check.ok}>
            <span>{check.id === "job_root" ? "任务目录父目录权限"
              : check.id === "proc" ? "进程信息读取"
                : /^tool_[a-z][a-z0-9_-]{0,63}$/u.test(check.id) ? `工具：${check.id.slice(5)}` : "其他基础检查"}</span>
            {" · "}<strong>{check.ok ? "满足" : "未满足"}</strong>（<code>{check.id}</code>）
          </li>
        ))}</ul>
        {checks.some((check) => check.id === "job_root")
          ? <p>仅检查父目录权限，未实际创建任务目录。</p> : null}
      </details>
    </>
  );
}

export function DispatchPreview({ preview }: { preview: ExecutionPreview }) {
  const [clock, setClock] = useState(() => Date.now());
  const now = Math.max(clock, Date.now());
  // Expiry only changes this read-only presentation, never the dispatch policy.
  useEffect(() => {
    const current = Date.now();
    const deadlines = [preview.expiresAt, ...preview.nodes.map((node) => node.observation?.expiresAt ?? 0)]
      .filter((value) => Number.isFinite(value) && value > current);
    if (deadlines.length === 0) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.min(Math.min(...deadlines) - current, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [preview, clock]);

  const expired = !Number.isFinite(preview.expiresAt) || preview.expiresAt <= now;
  const rows = preview.nodes.map((node) => {
    const observationExpired = node.observation !== undefined
      && (!Number.isFinite(node.observation.expiresAt) || node.observation.expiresAt <= now);
    const stale = expired || observationExpired;
    const decision = node.decision === "eligible" && (stale || node.observation === undefined)
      ? "unknown" : node.decision;
    const reasonCodes = stale ? [
      ...node.reasonCodes.filter((code) => code !== "BASIC_CHECKS_PASSED"),
      observationExpired ? "OBSERVATION_EXPIRED" : "PREVIEW_EXPIRED",
    ]
      : node.decision === "eligible" && node.observation === undefined ? ["PROBE_UNAVAILABLE"] : node.reasonCodes;
    return { node, decision, reasonCodes, observationExpired };
  });
  const ready = preview.ready && !expired && preview.selectedNodeIds.length > 0
    && preview.selectedNodeIds.every((id) => rows.some((row) => row.node.nodeId === id && row.decision === "eligible"));

  return (
    <section className="fusion-dispatch-preview" aria-label="执行基础检查预览">
      <header>
        <h3>执行基础检查</h3>
        <p role="status" className="fusion-dispatch-preview-summary" data-ready={ready}>
          全组基础检查：{ready ? "就绪" : "未就绪"}
        </p>
      </header>
      <p className="fusion-dispatch-preview-boundary">只读诊断，不代表任务或目标已通过</p>
      <p>检查范围：执行基础设施；可用仅表示基础检查满足，不保证命令可执行。</p>
      <p><strong>业务要求：未验证</strong>；此诊断不决定任务派发准入。</p>
      <dl className="fusion-dispatch-preview-times">
        <div><dt>诊断时间</dt><dd><PreviewTime value={preview.checkedAt} /></dd></div>
        <div><dt>有效期至{expired ? "（已过期）" : ""}</dt><dd><PreviewTime value={preview.expiresAt} /></dd></div>
      </dl>
      {preview.selectedNodeIds.length === 0 ? <p>尚未选择目标节点</p> : null}
      <div className="fusion-dispatch-preview-nodes">
        {rows.map(({ node, decision, reasonCodes, observationExpired }) => (
          <article key={node.nodeId} aria-label={node.name} data-decision={decision}>
            <div className="fusion-dispatch-preview-node-head">
              <strong>{node.name}</strong><span>{decisionLabels[decision]}</span>
            </div>
            <code>{node.nodeId}</code>
            {reasonCodes.length === 0 ? <p>未提供原因说明</p> : (
              <ul>{[...new Set(reasonCodes)].map((code) => (
                <li key={code}>{reasonLabels[code] ?? "未识别的原因"}（<code>{code}</code>）</li>
              ))}</ul>
            )}
            <p>观察来源：{node.observation?.source || "未提供"}</p>
            {node.observation === undefined ? <p>尚无观察时间与有效期</p> : (
              <>
                <p>提供方：{node.observation.providerId}</p>
                <dl className="fusion-dispatch-preview-times">
                  <div><dt>观察时间</dt><dd><PreviewTime value={node.observation.checkedAt} /></dd></div>
                  <div><dt>观察有效期至{observationExpired ? "（已过期）" : ""}</dt><dd><PreviewTime value={node.observation.expiresAt} /></dd></div>
                </dl>
                <ObservationChecks checks={node.observation.checks} />
              </>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
