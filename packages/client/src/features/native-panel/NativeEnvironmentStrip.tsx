import { useState } from "react";
import type { NativeEnvironmentItem, NativeEnvironmentView } from "./types.js";
import styles from "./native-panel.module.css";

const severityLabel: Record<NativeEnvironmentItem["severity"], string> = {
  block: "阻塞",
  warn: "提醒",
  info: "信息",
};

function shortDigest(digest: string): string {
  return digest.length <= 22 ? digest : `${digest.slice(0, 7)}…${digest.slice(-6)}`;
}

function valueText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function NativeEnvironmentStrip({ environment }: { environment?: NativeEnvironmentView }) {
  const [open, setOpen] = useState(false);
  if (environment === undefined) return null;
  const { items } = environment;
  const summary = environment.overall === "match" ? "环境匹配"
    : environment.overall === "drift" ? `环境漂移 · ${items.length} 项`
    : "环境未知";
  const canExpand = items.length > 0;
  return <section className={styles.environment} data-severity={environment.overall === "unknown" ? "warn" : environment.overall}
    aria-label="环境一致性">
    <div className={styles.environmentSummary}>
      <span className={styles.environmentState} role="status">{summary}</span>
      <span className={styles.environmentDigest} title={environment.digest}>{shortDigest(environment.digest)}</span>
      <button type="button" aria-expanded={open} aria-controls="native-environment-items"
        disabled={!canExpand} onClick={() => setOpen(value => !value)}>环境详情</button>
    </div>
    {environment.overall === "unknown" && environment.reason !== undefined && <p className={styles.environmentReason}>{environment.reason}</p>}
    {open && canExpand && <ul id="native-environment-items" className={styles.environmentItems}>
      {items.map((item, index) => {
        const expected = valueText(item.expected);
        const actual = valueText(item.actual);
        return <li key={`${item.code}:${item.path}:${index}`} data-severity={item.severity}>
          <span className={styles.environmentSeverity}>{severityLabel[item.severity]}</span>
          <code>{item.path}</code>
          <span className={styles.environmentCode}>{item.code}</span>
          {expected !== undefined && <span className={styles.environmentValue}>期望 {expected}</span>}
          {actual !== undefined && <span className={styles.environmentValue}>实际 {actual}</span>}
          {item.remedy !== undefined && <span className={styles.environmentRemedy}>{item.remedy}</span>}
        </li>;
      })}
    </ul>}
  </section>;
}
