import { useRef, useState } from "react";
import { FileText, GitBranch, Package, ScrollText, Terminal } from "lucide-react";
import type { TaskEvidence, TaskRecord } from "@dsh-fusion/core";
import { sourceLabel, taskFact, taskTime, type StudyScenario } from "./design-fixture.js";
import { TaskStatus } from "./TaskStatus.js";

const EVIDENCE_ICONS = { summary: FileText, git: GitBranch, log: ScrollText, artifact: Package, command: Terminal };
const EVIDENCE_LABELS = { summary: "摘要", git: "变更", log: "日志", artifact: "产物", command: "命令" };

function EvidenceBody({ evidence, raw }: { evidence: TaskEvidence; raw: boolean }) {
  if (raw) return <pre>{evidence.value}</pre>;
  return <div className="study-evidence-reading">{evidence.value.split("\n\n").map((block, index) => {
    const lines = block.split("\n");
    if (lines.every(line => /^\d+\s+/.test(line))) return <ol key={index}>{lines.map((line, item) => <li key={item}>{line.replace(/^\d+\s+/, "")}</li>)}</ol>;
    if (index === 0 && lines.length === 1) return <h3 key={index}>{block}</h3>;
    return <p key={index}>{block}</p>;
  })}</div>;
}

export function DetailNavigation({ scenario, onBack }: { scenario: StudyScenario; onBack: () => void }) {
  return <div className="study-detail-nav" data-source-state={scenario}>
    <button className="study-back" onClick={onBack}>返回任务列表 <kbd>Esc</kbd></button>
    <span className={scenario === "stale" || scenario === "unavailable" || scenario === "not-configured" ? "study-source-warning" : ""}>{sourceLabel(scenario, true)}</span>
  </div>;
}

export function TaskDetail({ task, onBack, scenario, presentationStep = "idle" }: { task: TaskRecord; onBack: () => void; scenario: StudyScenario; presentationStep?: "idle" | "list" | "detail" | "gap" | "evidence" | "ending" }) {
  const [evidenceIndex, setEvidenceIndex] = useState(0);
  const [raw, setRaw] = useState(false);
  const evidenceRef = useRef<HTMLElement>(null);
  const evidence: TaskEvidence | undefined = task.evidence[evidenceIndex] ?? task.evidence[0];
  const projection = task.agentTeamTask;
  const owner = projection?.ownerName ?? projection?.ownerId ?? "负责人未知";
  const fact = taskFact(task);

  return <article className="study-task-detail" aria-label="任务详情">
    <DetailNavigation scenario={scenario} onBack={onBack} />
    {scenario === "unavailable" ? <p className="study-detail-source-notice" role="status">读取失败，保留 09:15 的旧快照；当前任务状态尚未确认。</p> : null}
    <header className="study-detail-header">
      <div className="study-detail-topline">
        <span className="study-task-id">{projection?.taskId ?? task.id}</span>
        <span className="study-detail-status"><span>来源状态：</span><TaskStatus task={task} sourceOnly /></span>
      </div>
      <h1 tabIndex={-1} data-detail-heading>{task.goal}</h1>
      <div className="study-current-fact" data-presentation-focus={presentationStep === "gap" ? "gap" : undefined}><strong>{fact.primary}</strong><span>{fact.secondary}</span></div>
      <div className="study-detail-action">
        {task.evidence.length > 0 ? <button className="study-primary" onClick={() => {
          evidenceRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
          evidenceRef.current?.focus({ preventScroll: true });
        }}>阅读证据 <span>{String(task.evidence.length).padStart(2, "0")}</span></button> : <span className="study-no-evidence">尚未提供证据</span>}
        <span className="study-updated">记录更新 {taskTime(task)}</span>
      </div>
    </header>

    <dl className="study-task-context">
      <div><dt>负责人</dt><dd className={owner === "负责人未知" ? "study-unknown" : ""}>{owner}</dd></div>
      <div><dt>主机</dt><dd>{task.targetNodeIds.join("、") || "未提供"}</dd></div>
      <div><dt>上游修订</dt><dd>{projection?.revision === undefined ? "未知" : <span className="study-revision">r{projection.revision}</span>}</dd></div>
    </dl>

    <section className="study-evidence" ref={evidenceRef} tabIndex={-1} aria-labelledby="study-evidence-heading" data-presentation-focus={presentationStep === "evidence" || presentationStep === "ending" ? "evidence" : undefined}>
      <div className="study-section-heading"><h2 id="study-evidence-heading">来源证据</h2><span>{task.evidence.length} 项记录</span></div>
      {task.evidence.length ? <>
        <div className="study-evidence-tabs" role="tablist" aria-label="选择证据">
          {task.evidence.map((item, index) => {
            const Icon = EVIDENCE_ICONS[item.kind];
            return <button key={`${item.kind}-${index}`} role="tab" id={`study-evidence-tab-${index}`} aria-selected={evidence === item}
              aria-controls="study-evidence-content" tabIndex={evidence === item ? 0 : -1}
              onClick={() => setEvidenceIndex(index)} onKeyDown={event => {
                let next: number | undefined;
                if (event.key === "ArrowRight") next = (index + 1) % task.evidence.length;
                if (event.key === "ArrowLeft") next = (index - 1 + task.evidence.length) % task.evidence.length;
                if (event.key === "Home") next = 0;
                if (event.key === "End") next = task.evidence.length - 1;
                if (next !== undefined) {
                  event.preventDefault(); setEvidenceIndex(next);
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
                }
              }}><Icon aria-hidden="true" size={14} strokeWidth={1.7} />{item.label}</button>;
          })}
        </div>
        {evidence ? <div className="study-evidence-content" id="study-evidence-content" role="tabpanel" aria-labelledby={`study-evidence-tab-${Math.max(0, task.evidence.indexOf(evidence))}`} tabIndex={0}>
          <div className="study-evidence-origin"><span>演示来源 · {EVIDENCE_LABELS[evidence.kind]}</span><div className="study-evidence-mode" role="group" aria-label="证据阅读方式">
            <button aria-pressed={!raw} onClick={() => setRaw(false)}>阅读版</button><button aria-pressed={raw} onClick={() => setRaw(true)}>原文</button>
          </div></div>
          <EvidenceBody evidence={evidence} raw={raw} />
          {evidence.sha256 ? <details className="study-evidence-digest"><summary>SHA-256</summary><code>{evidence.sha256}</code></details> : null}
        </div> : null}
      </> : <p className="study-evidence-empty">上游记录中暂时没有附带证据。缺少证据不能解释为通过。</p>}
      {task.expectedEvidence?.length ? <p className="study-evidence-requirements">来源要求：{task.expectedEvidence.map(kind => EVIDENCE_LABELS[kind]).join(" / ")}<span>尚未核验满足</span></p> : null}
    </section>

    {presentationStep === "ending" ? <p className="study-presentation-ending" role="note">演示结束：证据可读；独立审查未提供；未执行任务。</p> : null}

    <details className="study-description">
      <summary><span>任务正文</span><span className="study-description-closed">展开原文</span><span className="study-description-open">收起</span></summary>
      {task.description?.split("\n\n").map((paragraph, index) => <p key={index}>{paragraph}</p>) ?? <p>上游未提供任务正文。</p>}
      {projection?.blockedBy.length ? <p className="study-dependency">声明依赖：{projection.blockedBy.join("、")}。</p> : null}
    </details>
    <footer className="study-detail-footer">版本绑定回执尚未接入</footer>
  </article>;
}
