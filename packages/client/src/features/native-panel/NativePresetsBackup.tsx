import { useCallback, useEffect, useState } from "react";
import { fusionBrowserUrl } from "../../routes.js";
import styles from "./native-panel.module.css";

const PRESETS = "/plugins/dsh-fusion/fleet/presets";
const BACKUPS = "/plugins/dsh-fusion/fleet/backups";

interface Preset {
  id: string;
  kind: "skill" | "config" | "plugins";
  title: string;
  description: string;
  tags: string[];
  status?: { state: string };
  plugins?: Array<{ name: string; spec: string; why: string }>;
}

interface Backup {
  id: string;
  createdAt: string;
  reason: string;
  files: number;
  bytes: number;
}

export function NativePresetsBackup({ visible = true }: { visible?: boolean }) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [presetResponse, backupResponse] = await Promise.all([
        fetch(fusionBrowserUrl(PRESETS)),
        fetch(fusionBrowserUrl(BACKUPS)),
      ]);
      if (presetResponse.ok) {
        const value = await presetResponse.json() as { presets?: unknown };
        if (Array.isArray(value.presets)) {
          setPresets(value.presets.filter((row): row is Preset =>
            row !== null && typeof row === "object"
            && typeof row.id === "string" && typeof row.kind === "string"
            && typeof row.title === "string" && typeof row.description === "string"
            && Array.isArray(row.tags)));
        }
      }
      if (backupResponse.ok) {
        const value = await backupResponse.json() as { backups?: unknown };
        if (Array.isArray(value.backups)) {
          setBackups(value.backups.filter((row): row is Backup =>
            row !== null && typeof row === "object"
            && typeof row.id === "string" && typeof row.createdAt === "string"
            && typeof row.reason === "string" && typeof row.files === "number"));
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

  const act = async (id: string, path: string, body: Record<string, unknown>, success: string) => {
    setBusy(id);
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
        return;
      }
      setNotice(success);
      await load();
    } catch {
      setNotice("操作结果未确认，请刷新。");
    } finally {
      setBusy(undefined);
    }
  };

  const skill = presets.find(preset => preset.kind === "skill");
  const others = presets.filter(preset => preset.kind !== "skill");
  if (!visible || presets.length === 0) return null;
  return <section className={styles.cloud} aria-label="预设与热备">
    <div className={styles.cloudHeader}>
      <strong>预设与热备 · {presets.length}</strong>
      <button type="button" onClick={() => void load()} disabled={busy !== undefined}>刷新</button>
    </div>
    {skill && <ul className={styles.cloudList}>
      <li>
        <span>{skill.title}</span>
        <small>{skill.status?.state === "installed" ? "已安装" : "未安装"}</small>
        <button
          type="button"
          disabled={busy !== undefined}
          onClick={() => void act(
            skill.id,
            `${PRESETS}/skills/${skill.status?.state === "installed" ? "uninstall" : "install"}`,
            { id: skill.id },
            skill.status?.state === "installed" ? "已卸载 Skill。" : "已安装 Skill。",
          )}
        >
          {skill.status?.state === "installed" ? "卸载" : "安装"}
        </button>
      </li>
    </ul>}
    <ul className={styles.cloudList}>
      {others.map(preset => <li key={preset.id}>
        <span>{preset.title}</span>
        <small>{preset.kind === "plugins" ? preset.plugins?.map(item => item.spec).join(" · ") : preset.tags.join(" · ")}</small>
      </li>)}
    </ul>
    <div className={styles.cloudHeader}>
      <strong>配置快照 · {backups.length}</strong>
      <button
        type="button"
        disabled={busy !== undefined}
        onClick={() => void act("snapshot", `${BACKUPS}/create`, { reason: "panel" }, "已创建配置快照。")}
      >
        立即快照
      </button>
    </div>
    <ul className={styles.cloudList}>
      {backups.slice(0, 5).map(backup => <li key={backup.id}>
        <span>{backup.reason} · {backup.files} 文件</span>
        <small>{backup.createdAt}</small>
        <button
          type="button"
          disabled={busy !== undefined}
          onClick={() => void act(backup.id, `${BACKUPS}/verify`, { id: backup.id }, "快照校验通过。")}
        >
          校验
        </button>
      </li>)}
    </ul>
    {notice && <p className={styles.note} role="status">{notice}</p>}
  </section>;
}
