import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { NativeTaskViews } from "./NativeTaskViews.js";
import { NativeTaskList } from "./NativeTaskList.js";
import { NativePanelDetails } from "./NativePanelDetails.js";
import { NativeOceanBoundary } from "./NativeOceanBoundary.js";
import { NativeEnvironmentStrip } from "./NativeEnvironmentStrip.js";
import { NativeDispatchApprovals } from "./NativeDispatchApprovals.js";
import { NativeCloudConnectors } from "./NativeCloudConnectors.js";
import { NativeNotificationAdapters } from "./NativeNotificationAdapters.js";
import { NativeHostTrust } from "./NativeHostTrust.js";
import { nativeTaskLabel, nativeTaskStatus } from "./native-task-status.js";
import { useNativeData } from "./use-native-data.js";
import type { NativePanelSelection, NativeWhalePanelProps } from "./types.js";
import styles from "./native-panel.module.css";

const labels: Record<string, string> = { online: "在线", offline: "离线", degraded: "降级", staged: "准备中", archived: "已归档" };
const tabs = [{ id: "task", label: "任务" }, { id: "host", label: "主机" }, { id: "team", label: "团队" }, { id: "ocean", label: "海域" }] as const;
const names = { task: "任务", host: "主机", team: "团队" };
const taskPriority: Record<string, number> = { blocked: 0, failed: 1, verifying: 2, running: 3, claimed: 4, queued: 5, completed: 6, cancelled: 7 };
const splitWidth = 800;

export function NativeWhalePanel({ snapshotUrl = "/plugins/dsh-fusion/state", visible = true }: NativeWhalePanelProps) {
  const { data, refresh, refreshing, sourceWarning, sourceNotices } = useNativeData(snapshotUrl, visible);
  const [tab, setTab] = useState<(typeof tabs)[number]["id"]>("task");
  const [oceanVisited, setOceanVisited] = useState(false);
  const [taskView, setTaskView] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [history, setHistory] = useState<NativePanelSelection[]>([]);
  const [wide, setWide] = useState(false);
  const selection = history.at(-1);
  const split = wide && tab === "task";
  const root = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const tabsRef = useRef(new Map<string, HTMLButtonElement>());
  const rowsRef = useRef(new Map<string, HTMLButtonElement>());
  const originRow = useRef<string>();
  const listScroll = useRef(0);
  const focusPending = useRef(false);

  useLayoutEffect(() => {
    const panel = root.current;
    if (!panel) return;
    setWide(panel.clientWidth >= splitWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWide(entry.contentRect.width >= splitWidth);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const select = (next: NativePanelSelection, fromList = false) => {
    if (selection?.kind === next.kind && selection.id === next.id) return;
    focusPending.current = true;
    if (!selection || fromList) {
      originRow.current = next.id;
      listScroll.current = list.current?.scrollTop ?? 0;
    }
    setHistory(current => fromList ? [next] : [...current, next]);
  };
  const back = () => {
    focusPending.current = true;
    setHistory(current => current.slice(0, -1));
  };
  useLayoutEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    const panel = root.current;
    if (!visible || !panel) return;
    const active = panel.ownerDocument.activeElement;
    if (active && active !== panel.ownerDocument.body && !panel.contains(active)) return;
    if (selection && detail.current) {
      detail.current.scrollTop = 0;
      detail.current.focus({ preventScroll: true });
    } else {
      if (!split && list.current) list.current.scrollTop = listScroll.current;
      const row = tab !== "ocean" && originRow.current ? rowsRef.current.get(originRow.current) : undefined;
      (row ?? tabsRef.current.get(tab))?.focus({ preventScroll: true });
    }
  }, [history, selection, split, tab, visible]);

  const blockedTaskIds = useMemo(() => new Set(data.model.krill.filter(item => item.blocked).map(item => item.id)), [data.model.krill]);
  const taskRows = useMemo(() => {
    const nodes = new Map(data.nodes.map(node => [node.id, node.name]));
    const teamNames = new Map<string, Set<string>>();
    for (const team of data.teams) {
      for (const id of team.taskIds) {
        let names = teamNames.get(id);
        if (!names) teamNames.set(id, names = new Set());
        names.add(team.name);
      }
    }
    return data.tasks.map(task => {
      const state = nativeTaskStatus(task, blockedTaskIds.has(task.id));
      const team = task.agentTeamTask;
      return {
        task, id: task.id, title: task.goal, status: state,
        detail: [...(teamNames.get(task.id) ?? []), ...task.targetNodeIds.flatMap(id => [id, nodes.get(id)]), team?.ownerName, team?.ownerId, team?.taskId].filter(Boolean).join(" "),
      };
    }).sort((a, b) => (taskPriority[a.status] ?? 8) - (taskPriority[b.status] ?? 8));
  }, [data.nodes, data.teams, data.tasks, blockedTaskIds]);
  const collectionRows = tab === "host" ? data.nodes.map(node => ({ id: node.id, title: node.name, status: node.status, detail: node.platform, evidence: node.unavailableReason ?? node.transports.join(" · ") }))
    : tab === "team" ? data.teams.map(team => ({ id: team.id, title: team.name, status: team.phase, detail: team.workspace, evidence: team.taskIds.length + " 个任务" }))
    : [];
  const rows = tab === "task" ? taskRows : collectionRows;
  const effectiveStatus = rows.some(row => row.status === status) ? status : "";
  useEffect(() => { setHistory([]); setStatus(""); }, [snapshotUrl]);
  useEffect(() => { if (status && !effectiveStatus) setStatus(""); }, [status, effectiveStatus]);
  const search = query.trim().toLocaleLowerCase();
  const matches = (row: { title: string; detail: string; id: string; status: string }) =>
    (!effectiveStatus || row.status === effectiveStatus) && `${row.title} ${row.detail} ${row.id}`.toLocaleLowerCase().includes(search);
  const visibleTasks = tab === "task" ? taskRows.filter(matches).map(row => row.task) : [];
  const visibleRecords = tab === "task" ? [] : collectionRows.filter(matches);
  const filteredCount = tab === "task" ? visibleTasks.length : visibleRecords.length;

  const collectionNotice = sourceNotices?.[tab === "ocean" ? "team" : tab];
  const detailNotice = selection ? sourceNotices?.[selection.kind] ?? (selection.kind === "task" ? sourceWarning : undefined) : undefined;
  const sourceNotice = collectionNotice ?? ((tab === "task" || tab === "ocean") ? sourceWarning : undefined);
  const sourceBase = data.error ? (data.loaded ? "全局来源不可用 · 显示陈旧快照" : "全局来源不可用 · 请重试")
    : data.loaded ? "全局来源：DSH Fusion" : "正在读取来源…";
  const sourceText = (notice?: string) => [sourceBase, data.loaded && data.model.demo ? "演示数据" : "", !data.error ? notice : undefined].filter(Boolean).join(" · ");
  const emptyMessage = !data.loaded ? (data.error ? "读取失败，点击刷新重试。" : "正在加载…")
    : rows.length ? "没有符合筛选条件的记录。"
    : data.error ? "来源读取失败，最后快照中没有记录。"
    : collectionNotice ? collectionNotice + "，暂不能确认当前记录。" : "当前来源暂无记录。";
  const empty = <div className={styles.empty}><p>{emptyMessage}</p>{rows.length > 0 && <button type="button" onClick={() => { setQuery(""); setStatus(""); }}>清除搜索与筛选</button>}</div>;
  const refreshButton = <button className={styles.refresh} type="button" disabled={!visible || refreshing} onClick={refresh}>{refreshing ? "读取中…" : "刷新"}</button>;
  const showList = (!selection || split) && tab !== "ocean";

  return <section ref={root} className={styles.panel} aria-label="鲸" hidden={!visible} onKeyDown={event => {
    const target = event.target;
    const editing = target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']");
    if (event.key === "Escape" && selection && !event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229 && !editing) {
      event.preventDefault();
      event.stopPropagation();
      back();
    }
  }}>
    <NativeEnvironmentStrip {...(data.environment === undefined ? {} : { environment: data.environment })} />
    <NativeCloudConnectors visible={visible} />
    <NativeNotificationAdapters visible={visible} />
    <NativeHostTrust visible={visible} />
    {data.environment && <NativeDispatchApprovals visible={visible} />}
    {(!selection || split) && <nav className={styles.tabs} aria-label="面板视图">
      {tabs.map(item => <button type="button" key={item.id} ref={element => {
        if (element) tabsRef.current.set(item.id, element); else tabsRef.current.delete(item.id);
      }} aria-pressed={tab === item.id} onClick={() => {
        if (item.id === tab) return;
        setTab(item.id);
        if (item.id === "ocean") setOceanVisited(true);
        setStatus("");
        setHistory([]);
      }}>{item.label}</button>)}
    </nav>}
    <div className={styles.workspace} data-split={showList && split ? "true" : undefined}>
      {showList && <section className={styles.browser} aria-label={`${names[tab]}列表`}>
        <div className={styles.toolbar}>
          <span className={styles.source} role="status" data-warning={Boolean(data.error || sourceNotice) || undefined}>{sourceText(sourceNotice)}</span>
          {refreshButton}
        </div>
        <div className={styles.filters}>
          <label className={styles.search}>
            <Search size={15} aria-hidden="true" />
            <input aria-label="搜索名称或归属" placeholder={tab === "task" ? "搜索任务、负责人…" : "搜索名称或归属"} value={query} onChange={event => setQuery(event.currentTarget.value)} />
          </label>
          <select aria-label="状态筛选" value={effectiveStatus} onChange={event => setStatus(event.currentTarget.value)}>
            <option value="">全部状态</option>
            {[...new Set(rows.map(row => row.status))].map(value => <option key={value} value={value}>{tab === "task" ? nativeTaskLabel(value) : labels[value] ?? value}</option>)}
          </select>
        </div>
        <div className={styles.content} ref={list} aria-busy={refreshing}>
          {tab === "task" ? <NativeTaskViews view={taskView} onViewChange={setTaskView} tasks={visibleTasks} nodes={data.nodes}
            {...(selection?.kind === "task" ? { selectedTaskId: selection.id } : {})}
            connectionStale={!data.loaded || !!data.error || data.model.freshness !== "current"} onSelectTask={id => select({ kind: "task", id }, true)}>
            {data.loaded && filteredCount > 0 ? <NativeTaskList tasks={visibleTasks} nodes={data.nodes} teams={data.teams} blockedTaskIds={blockedTaskIds}
              {...(selection?.kind === "task" ? { selectedId: selection.id } : {})} onSelect={id => select({ kind: "task", id }, true)} rowRefs={rowsRef.current} /> : empty}
          </NativeTaskViews> : data.loaded && filteredCount > 0 ? <ul className={styles.list}>
            {visibleRecords.map(row => <li key={row.id}><button ref={element => {
              if (element) rowsRef.current.set(row.id, element); else rowsRef.current.delete(row.id);
            }} className={styles.row} type="button" onClick={() => select({ kind: tab, id: row.id })}>
              <span className={styles.heading}><span className={styles.title}>{row.title}</span><span className={styles.state}>{labels[row.status] ?? row.status}</span></span>
              <span className={styles.secondary} title={`${row.detail} · ${row.evidence}`}>{row.detail} · {row.evidence}</span>
            </button></li>)}
          </ul> : empty}
        </div>
      </section>}
      {selection ? <div ref={detail} tabIndex={-1} aria-label="详情导航" className={`${styles.content} ${styles.reader}`}>
        <NativePanelDetails key={`${selection.kind}:${selection.id}`} selection={selection} data={data} onBack={back} onSelect={select}
          source={sourceText(detailNotice)} sourceWarning={Boolean(data.error || detailNotice)} refreshControl={split ? null : refreshButton}
          backLabel={history.length > 1 ? `返回${names[history[history.length - 2]!.kind]}详情` : tab === "ocean" ? "返回海域" : `返回${names[tab]}列表`} />
      </div> : split ? <div className={`${styles.reader} ${styles.readerEmpty}`}><p>选择任务后，在这里阅读正文与证据。</p></div> : null}
      {oceanVisited && <div className={`${styles.content} ${styles.ocean}`} hidden={!visible || !!selection || tab !== "ocean"}>
        <div className={styles.toolbar}><span className={styles.source} role="status" data-warning={Boolean(data.error || sourceNotice) || undefined}>{sourceText(sourceNotice)}</span>{refreshButton}</div>
        <NativeOceanBoundary model={data.model} visible={visible && !selection && tab==="ocean"} onSelectTeam={(id: string) => select({kind: "team", id})} />
      </div>}
    </div>
  </section>;
}
