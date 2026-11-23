import { useState } from "react";
import { fusionBrowserUrl } from "../../routes.js";
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

interface DoctorCheck { id: string; status: "ok" | "warn" | "fail"; summary: string; remedy?: string }
interface DoctorReport {
  overall: "ok" | "warn" | "fail";
  checks: DoctorCheck[];
  nextActions: string[];
}

interface PlanStep { id: string; action: string; target: string; risk: "low" | "medium" | "high"; requiresRestart: boolean; reason: string }
interface PlanReport { overall: "ready" | "plan" | "unknown"; steps: PlanStep[]; note?: string }

export function NativeEnvironmentStrip({ environment }: { environment?: NativeEnvironmentView }) {
  const [open, setOpen] = useState(false);
  const [doctor, setDoctor] = useState<DoctorReport>();
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [doctorBusy, setDoctorBusy] = useState(false);
  const [plan, setPlan] = useState<PlanReport>();
  const [planOpen, setPlanOpen] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  if (environment === undefined) return null;
  const { items } = environment;
  const summary = environment.overall === "match" ? "环境匹配"
    : environment.overall === "drift" ? `环境漂移 · ${items.length} 项`
    : "环境未知";
  const canExpand = items.length > 0;
  const diagnose = async () => {
    if (doctorBusy) return;
    setDoctorBusy(true);
    try {
      const response = await fetch(fusionBrowserUrl("/plugins/dsh-fusion/fleet/doctor"));
      if (!response.ok) throw new Error("doctor unavailable");
      const value: unknown = await response.json();
      if (value === null || typeof value !== "object") throw new Error("doctor invalid");
      const report = value as DoctorReport;
      if (report.overall !== "ok" && report.overall !== "warn" && report.overall !== "fail") throw new Error("doctor invalid");
      setDoctor(report);
      setDoctorOpen(true);
    } catch {
      setDoctor({ overall: "fail", checks: [{ id: "doctor.fetch", status: "fail", summary: "诊断读取失败" }], nextActions: ["刷新后重试"] });
      setDoctorOpen(true);
    } finally {
      setDoctorBusy(false);
    }
  };
  const loadPlan = async () => {
    if (planBusy) return;
    setPlanBusy(true);
    try {
      const response = await fetch(fusionBrowserUrl(`/plugins/dsh-fusion/fleet/plan?hostId=${encodeURIComponent(environment.hostId)}`));
      if (!response.ok) throw new Error("plan unavailable");
      const value: unknown = await response.json();
      if (value === null || typeof value !== "object") throw new Error("plan invalid");
      const report = value as PlanReport;
      if (report.overall !== "ready" && report.overall !== "plan" && report.overall !== "unknown") throw new Error("plan invalid");
      setPlan(report);
      setPlanOpen(true);
    } catch {
      setPlan({ overall: "unknown", steps: [], note: "对齐计划读取失败" });
      setPlanOpen(true);
    } finally {
      setPlanBusy(false);
    }
  };
  return <section className={styles.environment} data-severity={environment.overall === "unknown" ? "warn" : environment.overall}
    aria-label="环境一致性">
    <div className={styles.environmentSummary}>
      <span className={styles.environmentState} role="status">{summary}</span>
      <span className={styles.environmentDigest} title={environment.digest}>{shortDigest(environment.digest)}</span>
      <button type="button" aria-expanded={open} aria-controls="native-environment-items"
        disabled={!canExpand} onClick={() => setOpen(value => !value)}>环境详情</button>
      <button type="button" aria-expanded={doctorOpen} onClick={() => void diagnose()} disabled={doctorBusy}>{doctorBusy ? "诊断中…" : "诊断"}</button>
      <button type="button" aria-expanded={planOpen} onClick={() => void loadPlan()} disabled={planBusy}>{planBusy ? "计划中…" : "对齐计划"}</button>
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
    {doctorOpen && doctor && <div className={styles.environmentDoctor}>
      <p role="status" data-status={doctor.overall}>{doctor.overall === "ok" ? "诊断通过" : doctor.overall === "warn" ? "诊断有提醒" : "诊断有阻塞"}</p>
      <ul>
        {doctor.checks.filter(check => check.status !== "ok").map(check => <li key={check.id} data-status={check.status}>
          <strong>{check.status === "fail" ? "失败" : "提醒"}</strong> <code>{check.id}</code> {check.summary}
          {check.remedy !== undefined && <span>{check.remedy}</span>}
        </li>)}
      </ul>
      {doctor.nextActions.length > 0 && <ol>{doctor.nextActions.map(action => <li key={action}>{action}</li>)}</ol>}
    </div>}
    {planOpen && plan && <div className={styles.environmentDoctor}>
      <p role="status" data-status={plan.overall === "ready" ? "ok" : plan.overall === "plan" ? "warn" : "fail"}>
        {plan.overall === "ready" ? "环境已对齐" : plan.overall === "plan" ? `对齐计划 · ${plan.steps.length} 步` : "对齐计划未知"}
      </p>
      {plan.note !== undefined && <p>{plan.note}</p>}
      {plan.steps.length > 0 && <ol>
        {plan.steps.map(step => <li key={step.id} data-status={step.risk === "high" ? "fail" : step.risk === "medium" ? "warn" : "ok"}>
          <strong>{step.action}</strong> <code>{step.target}</code> {step.reason}
          {step.requiresRestart && <span>需要重启 profile</span>}
        </li>)}
      </ol>}
    </div>}
  </section>;
}
