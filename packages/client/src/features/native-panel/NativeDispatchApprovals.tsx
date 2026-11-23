import { useCallback, useEffect, useState } from "react";
import { fusionBrowserUrl } from "../../routes.js";
import styles from "./native-panel.module.css";

const PATH = "/plugins/dsh-fusion/fleet/dispatch-requests";

interface DispatchRequest {
  id: string;
  taskId: string;
  jobId: string;
  nodeId: string;
  requestedBy: string;
  source: string;
  status: string;
  environment?: { hostId?: string; requireDigest?: string; policy?: string };
}

export function NativeDispatchApprovals({ visible = true }: { visible?: boolean }) {
  const [rows, setRows] = useState<DispatchRequest[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      const response = await fetch(fusionBrowserUrl(PATH));
      if (!response.ok) throw new Error("load failed");
      const value: unknown = await response.json();
      if (value === null || typeof value !== "object") throw new Error("invalid response");
      const requests = (value as { requests?: unknown }).requests;
      if (!Array.isArray(requests)) throw new Error("invalid response");
      setRows(requests.filter((row): row is DispatchRequest =>
        row !== null && typeof row === "object"
        && typeof row.id === "string" && typeof row.taskId === "string"
        && typeof row.jobId === "string" && typeof row.nodeId === "string"
        && typeof row.requestedBy === "string" && typeof row.source === "string"
        && typeof row.status === "string" && row.status === "pending"));
    } catch {
      // Optional surface: a missing endpoint or a transient read failure must
      // not add a second status region to the host panel.
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    void load();
    const timer = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(timer);
  }, [visible, load]);

  const decide = async (row: DispatchRequest, action: "approve" | "reject") => {
    if (busy !== undefined) return;
    setBusy(row.id);
    setNotice("");
    try {
      const response = await fetch(fusionBrowserUrl(`${PATH}/${action}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: row.id, ...(action === "reject" ? { reason: "面板拒绝" } : {}) }),
      });
      if (!response.ok) {
        setNotice(action === "approve" ? "批准失败，请查看环境门禁与执行状态。" : "拒绝失败，请刷新后重试。");
        return;
      }
      setNotice(action === "approve" ? "已批准并提交执行。" : "已拒绝。");
      await load();
    } catch {
      setNotice("提交结果未确认，请刷新待审批列表。");
    } finally {
      setBusy(undefined);
    }
  };

  if (!visible || (rows.length === 0 && notice === "")) return null;
  return <section className={styles.approvals} aria-label="待审批派发">
    <div className={styles.approvalHeader}>
      <strong>待审批派发 · {rows.length}</strong>
      <button type="button" onClick={() => void load()} disabled={busy !== undefined}>刷新</button>
    </div>
    {notice && <p className={styles.note} role="status">{notice}</p>}
    <ul>
      {rows.map(row => <li key={row.id}>
        <div className={styles.approvalRow}>
          <span>{row.requestedBy} 请求在 <code>{row.nodeId}</code> 执行 <code>{row.jobId}</code></span>
          <span className={styles.note}>{row.environment?.policy ?? "exact"} · {row.environment?.requireDigest ?? "未指定环境摘要"}</span>
        </div>
        <div className={styles.approvalActions}>
          <button type="button" className={styles.primary} disabled={busy === row.id} onClick={() => void decide(row, "approve")}>批准并执行</button>
          <button type="button" disabled={busy === row.id} onClick={() => void decide(row, "reject")}>拒绝</button>
        </div>
      </li>)}
    </ul>
  </section>;
}
