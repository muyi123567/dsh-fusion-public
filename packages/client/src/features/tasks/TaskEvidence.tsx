import type { TaskRecord } from "@dsh-fusion/core";
import { FileCheck2, FileWarning, X } from "lucide-react";

export function TaskEvidence({ task, onClose }: { task: TaskRecord; onClose: () => void }) {
  return (
    <section className="fusion-task-evidence" aria-label="任务证据">
      <div className="fusion-task-evidence-head">
        <div><strong>任务证据</strong><small>#{task.id}</small></div>
        <button type="button" aria-label="关闭任务证据" onClick={onClose}><X size={14} /></button>
      </div>
      {task.evidence.length === 0 ? (
        <div className="fusion-task-evidence-empty">
          <FileWarning size={18} />
          <span>暂无任务证据，无法查看 stdout/stderr。</span>
        </div>
      ) : task.evidence.map((evidence, index) => (
        <div className="fusion-task-evidence-row" key={`${evidence.kind}:${evidence.label}:${index}`}>
          <FileCheck2 size={15} />
          <div><strong>{evidence.label}</strong><small>{evidence.kind}</small><pre>{evidence.value}</pre></div>
          {evidence.sha256 === undefined ? null : <code title={evidence.sha256}>{evidence.sha256}</code>}
        </div>
      ))}
    </section>
  );
}
