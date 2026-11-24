import { useEffect, useState } from "react";
import { fusionBrowserUrl } from "../../routes.js";
import styles from "./native-panel.module.css";

const PATH = "/plugins/dsh-fusion/fleet/status";

interface Status {
  host: { displayName: string; overall: string; verified: boolean; trust: string };
  hosts: { total: number; drift: number; unknown: number; stale: number; untrusted: number };
  pending: { dispatch: number; alignment: number };
  systems: {
    connectors: { configured: number; invalid: number };
    notifications: { adapters: number; invalid: number; failed: number; unknown: number };
    presets: { installed: number };
    backups: { count: number };
    alignment: { failed: number };
  };
  nextActions: string[];
}

export function NativeFleetStatus({ visible = true }: { visible?: boolean }) {
  const [status, setStatus] = useState<Status>();

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(fusionBrowserUrl(PATH));
        if (!response.ok) return;
        const value = await response.json() as Status;
        if (!cancelled && value !== null && typeof value === "object" && value.host !== undefined) setStatus(value);
      } catch {
        // Optional surface.
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible]);

  if (!visible || status === undefined) return null;
  const chips = [
    `主机 ${status.hosts.total}`,
    `漂移 ${status.hosts.drift}`,
    `未知 ${status.hosts.unknown}`,
    `未信任 ${status.hosts.untrusted}`,
    `待批准 ${status.pending.dispatch + status.pending.alignment}`,
    `云盘 ${status.systems.connectors.configured}${status.systems.connectors.invalid > 0 ? `/${status.systems.connectors.invalid}异常` : ""}`,
    `通知 ${status.systems.notifications.adapters}${status.systems.notifications.failed > 0 ? "/失败" : ""}`,
    `预设 ${status.systems.presets.installed}`,
    `快照 ${status.systems.backups.count}`,
  ];
  return <section className={styles.cloud} aria-label="鲸群状态">
    <div className={styles.cloudHeader}>
      <strong>{status.host.displayName} · {status.host.trust === "verified" && status.host.verified ? "已验证" : status.host.overall}</strong>
      <small>{chips.slice(0, 4).join(" · ")}</small>
    </div>
    <ul className={styles.cloudList}>
      <li><span>{chips.slice(4).join(" · ")}</span></li>
      {status.nextActions.slice(0, 3).map(action => <li key={action}><span>{action}</span></li>)}
    </ul>
  </section>;
}
