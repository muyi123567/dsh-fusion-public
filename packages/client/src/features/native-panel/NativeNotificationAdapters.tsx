import { useCallback, useEffect, useState } from "react";
import { fusionBrowserUrl } from "../../routes.js";
import styles from "./native-panel.module.css";

const PATH = "/plugins/dsh-fusion/fleet/notifications";

interface Adapter {
  id: string;
  kind: string;
  label: string;
  enabled: boolean;
  state: string;
}

interface Receipt {
  adapterId: string;
  status: string;
  at?: string;
}

export function NativeNotificationAdapters({ visible = true }: { visible?: boolean }) {
  const [adapters, setAdapters] = useState<Adapter[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      const response = await fetch(fusionBrowserUrl(PATH));
      if (!response.ok) return;
      const value = await response.json() as { adapters?: unknown; receipts?: unknown };
      if (!Array.isArray(value.adapters)) return;
      setAdapters(value.adapters.filter((row): row is Adapter =>
        row !== null && typeof row === "object"
        && typeof row.id === "string" && typeof row.kind === "string"
        && typeof row.label === "string" && typeof row.enabled === "boolean"
        && typeof row.state === "string"));
      setReceipts(Array.isArray(value.receipts) ? value.receipts.filter((row): row is Receipt =>
        row !== null && typeof row === "object"
        && typeof row.adapterId === "string" && typeof row.status === "string") : []);
    } catch {
      // Optional surface: missing endpoints stay silent.
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void load();
  }, [visible, load]);

  const test = async (adapter: Adapter) => {
    setBusy(adapter.id);
    setNotice("");
    try {
      const response = await fetch(fusionBrowserUrl(`${PATH}/test`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapterId: adapter.id }),
      });
      if (!response.ok) {
        setNotice(response.status === 404 ? "适配器不存在。" : "测试失败，请检查地址与凭据。");
        return;
      }
      const value = await response.json() as { receipts?: Array<{ status?: unknown }> };
      const status = value.receipts?.[0]?.status;
      setNotice(typeof status === "string" ? `测试结果：${status}` : "测试已发送。");
      await load();
    } catch {
      setNotice("测试结果未确认，请稍后刷新回执。");
    } finally {
      setBusy(undefined);
    }
  };

  if (!visible || adapters.length === 0) return null;
  const latest = new Map<string, Receipt>();
  for (const receipt of receipts) latest.set(receipt.adapterId, receipt);
  return <section className={styles.cloud} aria-label="通知适配器">
    <div className={styles.cloudHeader}>
      <strong>通知适配器 · {adapters.length}</strong>
      <button type="button" onClick={() => void load()} disabled={busy !== undefined}>刷新</button>
    </div>
    <ul className={styles.cloudList}>
      {adapters.map(adapter => <li key={adapter.id}>
        <span>{adapter.label}</span>
        <small>
          {adapter.kind} · {adapter.state === "configured" ? "就绪" : adapter.state === "disabled" ? "已停用" : "配置无效"}
          {latest.get(adapter.id) === undefined ? "" : ` · 最近 ${latest.get(adapter.id)!.status}`}
        </small>
        <button type="button" disabled={!adapter.enabled || busy !== undefined} onClick={() => void test(adapter)}>
          测试
        </button>
      </li>)}
    </ul>
    {notice && <p className={styles.note} role="status">{notice}</p>}
  </section>;
}
