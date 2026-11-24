import { useCallback, useEffect, useState } from "react";
import { fusionBrowserUrl } from "../../routes.js";
import styles from "./native-panel.module.css";

const PATH = "/plugins/dsh-fusion/fleet/trust";

interface TrustHost {
  hostId: string;
  displayName: string;
  trust: string;
  verified: boolean;
  trusted: boolean;
  candidateKeyAvailable: boolean;
}

const LABEL: Record<string, string> = {
  verified: "已验证",
  untrusted: "未信任",
  invalid: "签名无效",
  "key-mismatch": "公钥不匹配",
  unknown: "未验证",
};

export function NativeHostTrust({ visible = true }: { visible?: boolean }) {
  const [hosts, setHosts] = useState<TrustHost[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      const response = await fetch(fusionBrowserUrl(PATH));
      if (!response.ok) return;
      const value = await response.json() as { hosts?: unknown };
      if (!Array.isArray(value.hosts)) return;
      setHosts(value.hosts.filter((row): row is TrustHost =>
        row !== null && typeof row === "object"
        && typeof row.hostId === "string" && typeof row.displayName === "string"
        && typeof row.trust === "string" && typeof row.verified === "boolean"
        && typeof row.trusted === "boolean"
        && typeof row.candidateKeyAvailable === "boolean"));
    } catch {
      // Optional surface: missing trust endpoints stay silent.
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void load();
  }, [visible, load]);

  const act = async (host: TrustHost, action: "trust" | "revoke") => {
    setBusy(host.hostId);
    setNotice("");
    try {
      const response = await fetch(fusionBrowserUrl(action === "trust" ? PATH : `${PATH}/revoke`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId: host.hostId }),
      });
      if (!response.ok) {
        setNotice(action === "trust" ? "信任失败：需要可用的主机公钥。" : "撤销失败，请稍后重试。");
        return;
      }
      setNotice(action === "trust" ? "已信任该主机。" : "已撤销信任。");
      await load();
    } catch {
      setNotice("操作结果未确认，请刷新后重试。");
    } finally {
      setBusy(undefined);
    }
  };

  const remote = hosts.filter(host => host.trusted || !host.verified);
  if (!visible || remote.length === 0) return null;
  return <section className={styles.cloud} aria-label="主机信任">
    <div className={styles.cloudHeader}>
      <strong>主机信任 · {remote.length}</strong>
      <button type="button" onClick={() => void load()} disabled={busy !== undefined}>刷新</button>
    </div>
    <ul className={styles.cloudList}>
      {remote.map(host => <li key={host.hostId}>
        <span>{host.displayName}</span>
        <small>{LABEL[host.trust] ?? host.trust} · {host.hostId.slice(0, 19)}…</small>
        {host.trusted
          ? <button type="button" disabled={busy !== undefined} onClick={() => void act(host, "revoke")}>撤销</button>
          : host.candidateKeyAvailable
            ? <button type="button" disabled={busy !== undefined} onClick={() => void act(host, "trust")}>信任</button>
            : <small>需公钥</small>}
      </li>)}
    </ul>
    {notice && <p className={styles.note} role="status">{notice}</p>}
  </section>;
}
