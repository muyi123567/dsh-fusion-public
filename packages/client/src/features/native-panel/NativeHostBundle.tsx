import { useState } from "react";
import { fusionBrowserUrl } from "../../routes.js";
import styles from "./native-panel.module.css";

const PATH = "/plugins/dsh-fusion/fleet/bundle";

interface BundleResult {
  hostId: string;
  digest: string;
  trusted: boolean;
  expectedPath?: string;
}

export function NativeHostBundle({ visible = true }: { visible?: boolean }) {
  const [pinTrust, setPinTrust] = useState(true);
  const [saveExpected, setSaveExpected] = useState(true);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const exportBundle = async () => {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(fusionBrowserUrl(PATH));
      if (!response.ok) {
        setNotice("导出失败，请检查本机密钥与环境状态。");
        return;
      }
      const value = await response.json() as { manifest?: { hostId?: unknown }; digest?: unknown };
      if (typeof value.digest !== "string" || typeof value.manifest?.hostId !== "string") {
        setNotice("加入包格式无效。");
        return;
      }
      const body = JSON.stringify(value, null, 2);
      if (typeof URL.createObjectURL === "function") {
        const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `dsh-host-${value.manifest.hostId.slice(7, 19)}.json`;
        anchor.click();
        URL.revokeObjectURL?.(url);
      }
      setNotice(`已导出加入包 · ${value.digest.slice(0, 19)}…`);
    } catch {
      setNotice("导出结果未确认，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const importBundle = async (file: File) => {
    setBusy(true);
    setNotice("");
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
      });
      const parsed: unknown = JSON.parse(text);
      const response = await fetch(fusionBrowserUrl(`${PATH}/import`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundle: parsed, pinTrust, saveExpected }),
      });
      if (!response.ok) {
        const value = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
        setNotice(typeof value?.error === "string" ? `导入失败：${value.error}` : "导入失败。");
        return;
      }
      const value = await response.json() as BundleResult;
      setNotice(`已导入 ${value.hostId.slice(0, 19)}… · 信任 ${value.trusted ? "已固定" : "未写入"}${value.expectedPath === undefined ? "" : " · 已设期望"}`);
    } catch {
      setNotice("导入结果未确认，请重试。");
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;
  return <section className={styles.cloud} aria-label="主机加入包">
    <div className={styles.cloudHeader}>
      <strong>主机加入包</strong>
      <button type="button" disabled={busy} onClick={() => void exportBundle()}>导出</button>
    </div>
    <ul className={styles.cloudList}>
      <li>
        <span>导入另一台主机的加入包</span>
        <label>
          <input
            type="file"
            accept="application/json,.json"
            aria-label="导入加入包"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void importBundle(file);
              event.target.value = "";
            }}
          />
        </label>
      </li>
      <li>
        <span>导入选项</span>
        <small>
          <label><input type="checkbox" checked={pinTrust} onChange={event => setPinTrust(event.target.checked)} /> 固定信任</label>
          {" "}
          <label><input type="checkbox" checked={saveExpected} onChange={event => setSaveExpected(event.target.checked)} /> 保存期望</label>
        </small>
      </li>
    </ul>
    {notice && <p className={styles.note} role="status">{notice}</p>}
  </section>;
}
