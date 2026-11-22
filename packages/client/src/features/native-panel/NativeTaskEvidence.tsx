import type { TaskEvidence, TaskEvidenceKind, TaskRecord } from "@dsh-fusion/core";
import { FileText, GitBranch, Package, ScrollText, Terminal } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent, type Ref } from "react";
import styles from "./native-task-evidence.module.css";

const kinds = new Map<TaskEvidenceKind, { label: string; icon: typeof FileText }>([
  ["summary", { label: "摘要", icon: FileText }],
  ["git", { label: "变更", icon: GitBranch }],
  ["log", { label: "日志", icon: ScrollText }],
  ["artifact", { label: "产物", icon: Package }],
  ["command", { label: "命令", icon: Terminal }],
]);

export function safeEvidenceUrl(value: string): string | undefined {
  // Only turn a complete, absolute web URL into a navigable link.
  if (!/^https?:\/\/[^/]/i.test(value) || /[\\\x00-\x1f\x7f]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.username || url.password ? undefined : url.href;
  } catch {
    return undefined;
  }
}

interface NativeTaskEvidenceProps {
  task: TaskRecord;
  sectionRef?: Ref<HTMLElement>;
  demo?: boolean;
}

function ReadingText({ value }: { value: string }) {
  const blocks = value.split(/(?:\r?\n){2,}/);
  return <div className={styles.reading}>{blocks.map((block, index) => {
    const lines = block.trimEnd().split(/\r?\n/);
    const numbered = lines.length > 1 ? lines.map(line => /^([1-9]\d{0,5})(?:[.)])?[ \t]+(.+)$/u.exec(line)) : [];
    if (numbered.length > 0 && numbered.every(item => item !== null)) {
      return <ol key={index}>{numbered.map(([, number, text], item) => <li key={item} value={Number(number)}>{text}</li>)}</ol>;
    }
    if (index === 0 && lines.length === 1 && blocks.length > 1) {
      return <p className={styles.lead} key={index}>{block}</p>;
    }
    return <p key={index}>{block}</p>;
  })}</div>;
}

function EvidenceRecord({ evidence, demo }: { evidence: TaskEvidence; demo: boolean }) {
  const [raw, setRaw] = useState(false);
  const href = safeEvidenceUrl(evidence.value);
  const canRead = !!href || evidence.kind === "summary";
  const label = kinds.get(evidence.kind)?.label;
  return <>
    <div className={styles.origin}>
      <span>{demo ? "演示来源" : "来源记录"} · {label ? `${label}（${evidence.kind}）` : evidence.kind}</span>
      {canRead && <div className={styles.mode} role="group" aria-label="证据阅读方式">
        <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>阅读版</button>
        <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>原文</button>
      </div>}
    </div>
    {raw || !canRead ? <pre className={styles.raw}>{evidence.value}</pre> : href ? (
      <a className={styles.link} href={href} target="_blank" rel="noreferrer noopener">{evidence.value}</a>
    ) : <ReadingText value={evidence.value} />}
    {evidence.sha256 && <details className={styles.digest}>
      <summary>SHA-256</summary>
      <code>{evidence.sha256}</code>
    </details>}
  </>;
}

function EvidenceTabs({ evidence, demo }: { evidence: TaskEvidence[]; demo: boolean }) {
  const id = useId();
  const [index, setIndex] = useState(0);
  const selected = index < evidence.length ? index : 0;
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, current: number) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
    let next: number;
    switch (event.key) {
      case "ArrowRight": next = (current + 1) % evidence.length; break;
      case "ArrowLeft": next = (current - 1 + evidence.length) % evidence.length; break;
      case "Home": next = 0; break;
      case "End": next = evidence.length - 1; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    setIndex(next);
    tabs.current[next]?.focus();
  }

  return <>
    <div className={styles.tabs} role="tablist" aria-label="选择证据">
      {evidence.map((item, index) => {
        const Icon = kinds.get(item.kind)?.icon ?? FileText;
        const label = item.label || kinds.get(item.kind)?.label || "证据";
        return <button key={index} type="button" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`}
          ref={element => { tabs.current[index] = element; }}
          aria-selected={selected === index} tabIndex={selected === index ? 0 : -1}
          onClick={() => setIndex(index)} onKeyDown={event => onTabKey(event, index)} title={label}>
          <Icon aria-hidden="true" size={14} strokeWidth={1.7} /><span>{label}</span>
        </button>;
      })}
    </div>
    {evidence.map((item, index) => <div className={styles.content} key={index} id={`${id}-panel-${index}`}
      role="tabpanel" aria-labelledby={`${id}-tab-${index}`} tabIndex={0} hidden={index !== selected}>
      {index === selected && <EvidenceRecord evidence={item} demo={demo} />}
    </div>)}
  </>;
}

export function NativeTaskEvidence({ task, sectionRef, demo = false }: NativeTaskEvidenceProps) {
  const id = useId();
  const evidence = task.evidence ?? [];
  return <section ref={sectionRef} tabIndex={-1} className={styles.section} aria-labelledby={id}>
    <div className={styles.heading}><h3 id={id}>来源证据</h3><span>{evidence.length} 项记录</span></div>
    {evidence.length > 0 ? <>
      <EvidenceTabs key={task.id} evidence={evidence} demo={demo} />
      <p className={styles.note}>来源记录本身不代表独立验收通过。</p>
    </> : <p className={styles.empty}>来源未附带证据，无法据此确认结果。</p>}
  </section>;
}
