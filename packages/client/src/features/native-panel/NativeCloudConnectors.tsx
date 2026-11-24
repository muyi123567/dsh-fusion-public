import { useCallback, useEffect, useState } from "react";
import { fusionBrowserUrl } from "../../routes.js";
import styles from "./native-panel.module.css";

const PATH = "/plugins/dsh-fusion/fleet/connectors";

interface ConnectorInstance {
  id: string;
  kind: string;
  label: string;
  enabled: boolean;
  state: string;
  root?: string;
}

interface CloudEntry {
  name: string;
  path: string;
  kind: "file" | "folder";
  size?: number;
  modifiedAt?: string;
}

interface LocalImport {
  name: string;
  path: string;
  bytes: number;
}

export function NativeCloudConnectors({ visible = true }: { visible?: boolean }) {
  const [instances, setInstances] = useState<ConnectorInstance[]>([]);
  const [active, setActive] = useState<ConnectorInstance>();
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<CloudEntry[]>([]);
  const [imports, setImports] = useState<LocalImport[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      const response = await fetch(fusionBrowserUrl(PATH));
      if (!response.ok) return;
      const value = await response.json() as { instances?: unknown };
      if (!Array.isArray(value.instances)) return;
      setInstances(value.instances.filter((row): row is ConnectorInstance =>
        row !== null && typeof row === "object"
        && typeof row.id === "string" && typeof row.kind === "string"
        && typeof row.label === "string" && typeof row.enabled === "boolean"
        && typeof row.state === "string"));
    } catch {
      // Optional surface: a missing endpoint must not add noise to the panel.
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void load();
  }, [visible, load]);

  const browse = async (instance: ConnectorInstance, nextPath = instance.root ?? "", query?: string) => {
    setBusy(instance.id);
    setNotice("");
    try {
      const params = new URLSearchParams({ id: instance.id });
      if (nextPath !== "") params.set("path", nextPath);
      if (query !== undefined && query !== "") params.set("query", query);
      const response = await fetch(fusionBrowserUrl(`${PATH}/list?${params.toString()}`));
      if (!response.ok) {
        setNotice(response.status === 404 ? "连接器不存在或未启用。" : "读取失败，请检查凭据与网络。");
        return;
      }
      const value = await response.json() as { entries?: unknown };
      if (!Array.isArray(value.entries)) {
        setNotice("连接器返回格式无效。");
        return;
      }
      setActive(instance);
      setPath(nextPath);
      setEntries(value.entries.filter((row): row is CloudEntry =>
        row !== null && typeof row === "object"
        && typeof row.name === "string" && typeof row.path === "string"
        && (row.kind === "file" || row.kind === "folder")));
      await loadImports();
    } catch {
      setNotice("读取结果未确认，请重试。");
    } finally {
      setBusy(undefined);
    }
  };

  const loadImports = async () => {
    try {
      const response = await fetch(fusionBrowserUrl(`${PATH}/imports`));
      if (!response.ok) return;
      const value = await response.json() as { imports?: unknown };
      if (Array.isArray(value.imports)) {
        setImports(value.imports.filter((row): row is LocalImport =>
          row !== null && typeof row === "object"
          && typeof row.name === "string" && typeof row.path === "string"
          && typeof row.bytes === "number"));
      }
    } catch {
      // Optional surface.
    }
  };

  const pull = async (entry: CloudEntry) => {
    if (active === undefined || entry.kind !== "file") return;
    setBusy(entry.path);
    setNotice("");
    try {
      const response = await fetch(fusionBrowserUrl(`${PATH}/pull`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: active.id, path: entry.path }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
        setNotice(typeof body?.error === "string" ? `拉取失败：${body.error}` : "拉取失败，请检查连接器配置。");
        return;
      }
      const value = await response.json() as { name?: unknown; bytes?: unknown; sha256?: unknown };
      const name = typeof value.name === "string" ? value.name : entry.name;
      const bytes = typeof value.bytes === "number" ? value.bytes : 0;
      const sha = typeof value.sha256 === "string" ? value.sha256.slice(0, 12) : "unknown";
      setNotice(`已保存 ${name} · ${bytes} B · sha256 ${sha}…`);
      await loadImports();
    } catch {
      setNotice("拉取结果未确认，请重试。");
    } finally {
      setBusy(undefined);
    }
  };

  const upload = async (file: LocalImport) => {
    if (active === undefined) return;
    setBusy(file.path);
    setNotice("");
    try {
      const remotePath = `exports/${file.name}`;
      const response = await fetch(fusionBrowserUrl(`${PATH}/upload`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: active.id,
          path: remotePath,
          sourcePath: file.path,
          overwrite,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
        setNotice(typeof body?.error === "string" ? `导出失败：${body.error}` : "导出失败。");
        return;
      }
      const value = await response.json() as { name?: unknown; path?: unknown; bytes?: unknown; sha256?: unknown };
      setNotice(`已导出 ${String(value.name ?? file.name)} → ${String(value.path ?? remotePath)} · ${String(value.bytes ?? file.bytes)} B · sha256 ${String(value.sha256 ?? "").slice(0, 12)}…`);
    } catch {
      setNotice("导出结果未确认，请重试。");
    } finally {
      setBusy(undefined);
    }
  };

  if (!visible || instances.length === 0) return null;
  return <section className={styles.cloud} aria-label="云盘连接器">
    <div className={styles.cloudHeader}>
      <strong>云盘连接器 · {instances.length}</strong>
      <button type="button" onClick={() => void load()} disabled={busy !== undefined}>刷新</button>
    </div>
    <ul className={styles.cloudList}>
      {instances.map(instance => <li key={instance.id}>
        <span>{instance.label}</span>
        <small>{instance.kind} · {instance.state === "configured" ? "就绪" : instance.state === "disabled" ? "已停用" : "配置无效"}</small>
        <button type="button" disabled={!instance.enabled || busy !== undefined} onClick={() => void browse(instance)}>
          浏览
        </button>
      </li>)}
    </ul>
    {notice && <p className={styles.note} role="status">{notice}</p>}
    {active !== undefined && <div className={styles.cloudBrowser}>
      <div className={styles.cloudHeader}>
        <strong>{active.label}{path === "" ? "" : ` / ${path}`}</strong>
        <button type="button" onClick={() => void browse(active)} disabled={busy !== undefined}>根目录</button>
      </div>
      {entries.length === 0
        ? <p className={styles.note}>目录为空。</p>
        : <ul className={styles.cloudList}>
          {entries.map(entry => <li key={entry.path}>
            <span>{entry.name}</span>
            <small>{entry.kind === "folder" ? "目录" : `${entry.size ?? 0} B`}</small>
            {entry.kind === "folder"
              ? <button type="button" disabled={busy !== undefined} onClick={() => void browse(active, entry.path)}>进入</button>
              : <button type="button" disabled={busy !== undefined} onClick={() => void pull(entry)}>拉取</button>}
          </li>)}
        </ul>}
      {imports.length > 0 && <div className={styles.cloudBrowser}>
        <div className={styles.cloudHeader}>
          <strong>本地材料 · {imports.length}</strong>
          <label><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.target.checked)} /> 覆盖同名</label>
        </div>
        <ul className={styles.cloudList}>
          {imports.map(file => <li key={file.path}>
            <span>{file.name}</span>
            <small>{file.bytes} B</small>
            <button type="button" disabled={busy !== undefined} onClick={() => void upload(file)}>导出</button>
          </li>)}
        </ul>
      </div>}
    </div>}
  </section>;
}
