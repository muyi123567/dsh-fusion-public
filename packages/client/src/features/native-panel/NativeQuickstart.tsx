import { useCallback, useEffect, useState } from "react";
import { fusionBrowserUrl } from "../../routes.js";
import styles from "./native-panel.module.css";

interface Status {
  host: { hostId: string; overall: string; verified: boolean };
  systems: { backups: { count: number } };
}

interface Preset {
  id: string;
  kind: "skill" | "config" | "plugins";
  title: string;
  status?: { state: string };
}

export function NativeQuickstart({ visible = true }: { visible?: boolean }) {
  const [status, setStatus] = useState<Status>();
  const [skill, setSkill] = useState<Preset>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [statusResponse, presetResponse] = await Promise.all([
        fetch(fusionBrowserUrl("/plugins/dsh-fusion/fleet/status")),
        fetch(fusionBrowserUrl("/plugins/dsh-fusion/fleet/presets")),
      ]);
      if (statusResponse.ok) {
        const value = await statusResponse.json() as Status;
        if (value !== null && typeof value === "object" && typeof value.host?.hostId === "string") setStatus(value);
      }
      if (presetResponse.ok) {
        const value = await presetResponse.json() as { presets?: unknown };
        if (Array.isArray(value.presets)) {
          setSkill(value.presets.find((row): row is Preset =>
            row !== null && typeof row === "object"
            && (row as { kind?: unknown }).kind === "skill"
            && typeof (row as { id?: unknown }).id === "string"
            && typeof (row as { title?: unknown }).title === "string"));
        }
      }
    } catch {
      // Optional onboarding surface.
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void load();
  }, [visible, load]);

  const act = async (key: string, path: string, body: Record<string, unknown>, success: string) => {
    setBusy(key);
    setNotice("");
    try {
      const response = await fetch(fusionBrowserUrl(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setNotice("操作失败，请检查环境与权限。");
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

  if (!visible || status === undefined) return null;
  const expectedDone = status.host.overall !== "unknown";
  const skillDone = skill?.status?.state === "installed";
  const backupDone = status.systems.backups.count > 0;
  const incomplete = Number(!expectedDone) + Number(!skillDone) + Number(!backupDone);
  if (incomplete === 0 && notice === "") return null;
  return <section className={styles.cloud} aria-label="快速开始">
    <div className={styles.cloudHeader}>
      <strong>快速开始 · {incomplete === 0 ? "已完成" : `${incomplete} 项待完成`}</strong>
      <button type="button" onClick={() => void load()} disabled={busy !== undefined}>刷新</button>
    </div>
    {incomplete === 0
      ? <p className={styles.note} role="status">{notice}</p>
      : <ul className={styles.cloudList}>
        {!expectedDone && <li>
          <span>保存期望环境</span>
          <small>没有期望清单时只能看到 unknown</small>
          <button
            type="button"
            disabled={busy !== undefined}
            onClick={() => void act("expected", "/plugins/dsh-fusion/fleet/expected", { hostId: status.host.hostId }, "已保存当前环境为期望。")}
          >
            保存期望
          </button>
        </li>}
        {!skillDone && skill !== undefined && <li>
          <span>{skill.title}</span>
          <small>安装多机运维 Skill</small>
          <button
            type="button"
            disabled={busy !== undefined}
            onClick={() => void act("skill", "/plugins/dsh-fusion/fleet/presets/skills/install", { id: skill.id }, "已安装鲸群 Skill。")}
          >
            安装
          </button>
        </li>}
        {!backupDone && <li>
          <span>创建第一份配置快照</span>
          <small>改坏配置时可恢复</small>
          <button
            type="button"
            disabled={busy !== undefined}
            onClick={() => void act("backup", "/plugins/dsh-fusion/fleet/backups/create", { reason: "quickstart" }, "已创建配置快照。")}
          >
            创建快照
          </button>
        </li>}
      </ul>}
    {incomplete > 0 && notice && <p className={styles.note} role="status">{notice}</p>}
  </section>;
}
