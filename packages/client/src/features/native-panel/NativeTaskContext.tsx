import type { TaskEvidenceKind, TaskRecord } from "@dsh-fusion/core";
import styles from "./native-task-context.module.css";

const evidenceLabels: Record<TaskEvidenceKind, string> = {
  command: "命令（command）",
  log: "日志（log）",
  artifact: "产物（artifact）",
  git: "Git 记录（git）",
  summary: "摘要（summary）",
};

export function NativeTaskContext({ task }: { task: TaskRecord }) {
  const context = task.agentTeamTask;
  const ready = context?.ready;
  const scopes = context?.writeScopes ?? [];
  const warnings = context?.writeScopeWarnings ?? [];
  const expectedEvidence = task.expectedEvidence ?? [];

  return <div className={styles.context}>
    {task.description === undefined && <section className={styles.section} aria-label="任务正文">
      <p className={styles.note}>任务正文未提供。</p>
    </section>}
    {task.description !== undefined && task.description !== "" && <details className={styles.description}>
      <summary>完整任务正文</summary>
      <section aria-label="任务正文"><p className={styles.body}>{task.description}</p></section>
    </details>}

    <section className={styles.section} aria-label="只读协作上下文">
      <h3>只读协作上下文</h3>
      <p className={styles.note}>{context ? "以下为上游记录的只读投影。" : "协作上下文未提供。"}就绪状态不代表执行或验收通过。</p>
      <dl className={styles.metadata}>
        <dt>负责人</dt><dd>{context?.ownerName || context?.ownerId || "未提供"}</dd>
        <dt>上游任务 ID</dt><dd><code>{context?.taskId || "未提供"}</code></dd>
        <dt>上游修订</dt><dd>{context?.revision ?? "未提供"}</dd>
        <dt>上游就绪（ready）</dt><dd>{ready === true ? "是（true）" : ready === false ? "否（false）" : "未提供"}</dd>
      </dl>
      <h4>声明的写入范围</h4>
      <p className={styles.note}>writeScopes 仅为协作提示，不是文件锁或执行授权。</p>
      {scopes.length > 0
        ? <ul className={styles.values}>{scopes.map((scope, index) => <li key={index}><code>{scope}</code></li>)}</ul>
        : <p className={styles.note}>{context ? "上游未声明写入范围。" : "写入范围未提供。"}</p>}
      {warnings.length > 0 && <>
        <h4>协作警告</h4>
        <ul className={styles.values}>{warnings.map((warning, index) => <li key={index}><p className={styles.body}>{warning}</p></li>)}</ul>
      </>}
    </section>

    <section className={styles.section} aria-label="预期证据">
      <h3>预期证据</h3>
      <p className={styles.note}>以下仅为证据要求，尚未核验是否满足。</p>
      {expectedEvidence.length > 0
        ? <ul className={styles.values}>{expectedEvidence.map((kind, index) => <li key={index}>{evidenceLabels[kind] ?? kind}</li>)}</ul>
        : <p className={styles.note}>{task.expectedEvidence === undefined ? "预期证据未提供。" : "上游未声明预期证据。"}</p>}
    </section>
  </div>;
}
