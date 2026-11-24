import { useCallback, useEffect, useState } from "react";
import { fusionBrowserUrl } from "../../routes.js";
import styles from "./native-panel.module.css";

const BASE = "/plugins/dsh-fusion/fleet/alignment";

interface Step {
  id: string;
  action: string;
  target: string;
  risk: string;
  reason: string;
  exec: "auto" | "manual";
  manualReason?: string;
}

interface Plan {
  hostId: string;
  planDigest: string;
  overall: string;
  steps: Step[];
}

interface Request {
  id: string;
  status: string;
  hostId: string;
  steps: Step[];
  results?: Array<{ stepId: string; status: string; detail?: string }>;
}

export function NativeAlignment({ visible = true }: { visible?: boolean }) {
  const [hostId, setHostId] = useState("");
  const [plan, setPlan] = useState<Plan>();
  const [requests, setRequests] = useState<Request[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [environment, alignment] = await Promise.all([
        fetch(fusionBrowserUrl("/plugins/dsh-fusion/fleet/environment")),
        fetch(fusionBrowserUrl(BASE)),
      ]);
      if (environment.ok) {
        const value = await environment.json() as { hostId?: unknown };
        if (typeof value.hostId === "string") setHostId(value.hostId);
      }
      if (alignment.ok) {
        const value = await alignment.json() as { requests?: unknown };
        if (Array.isArray(value.requests)) {
          setRequests(value.requests.filter((row): row is Request =>
            row !== null && typeof row === "object"
            && typeof row.id === "string" && typeof row.status === "string"
            && typeof row.hostId === "string" && Array.isArray(row.steps)));
        }
      }
    } catch {
      // Optional surface.
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void load();
  }, [visible, load]);

  const post = async (path: string, body: Record<string, unknown>, success: string) => {
    setBusy(path);
    setNotice("");
    try {
      const response = await fetch(fusionBrowserUrl(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const value = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
        setNotice(typeof value?.error === "string" ? `失败：${value.error}` : "操作失败。");
        return undefined;
      }
      const value = await response.json() as { request?: Request } & Plan;
      setNotice(success);
      await load();
      return value;
    } catch {
      setNotice("操作结果未确认，请刷新。");
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  const build = async () => {
    if (hostId === "") return;
    const value = await post(`${BASE}/plan`, { hostId }, "已生成对齐计划。");
    if (value !== undefined && Array.isArray(value.steps)) setPlan(value);
  };

  if (!visible || hostId === "") return null;
  return <section className={styles.cloud} aria-label="环境对齐">
    <div className={styles.cloudHeader}>
      <strong>环境对齐</strong>
      <button type="button" onClick={() => void build()} disabled={busy !== undefined}>生成计划</button>
    </div>
    {plan && <ul className={styles.cloudList}>
      {plan.steps.length === 0
        ? <li><span>当前没有可生成的步骤</span><small>{plan.overall}</small></li>
        : plan.steps.map(step => <li key={step.id}>
          <span>{step.action} · {step.target}</span>
          <small>{step.exec === "auto" ? "可执行" : step.manualReason ?? "需人工"} · {step.risk}</small>
        </li>)}
    </ul>}
    {plan && plan.steps.length > 0 && <div className={styles.cloudHeader}>
      <button
        type="button"
        disabled={busy !== undefined}
        onClick={() => void post(`${BASE}/request`, { hostId, requestedBy: "面板" }, "已创建待批准请求。")}
      >
        请求执行
      </button>
    </div>}
    {requests.length > 0 && <ul className={styles.cloudList}>
      {requests.slice(-4).map(request => <li key={request.id}>
        <span>{request.status} · {request.id.slice(0, 8)}</span>
        <small>{request.results?.map(result => result.status).join(",") ?? `${request.steps.length} 步`}</small>
        {request.status === "pending" && <>
          <button
            type="button"
            disabled={busy !== undefined}
            onClick={() => void post(`${BASE}/approve`, { id: request.id }, "已批准并执行。")}
          >
            批准
          </button>
          <button
            type="button"
            disabled={busy !== undefined}
            onClick={() => void post(`${BASE}/cancel`, { id: request.id }, "已取消。")}
          >
            取消
          </button>
        </>}
      </li>)}
    </ul>}
    {notice && <p className={styles.note} role="status">{notice}</p>}
  </section>;
}
