import { useId, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { WhaleGlyph } from "./WhaleGlyph.js";
import { WHALE_STATUS_TEXT } from "./types.js";
import type { WhaleDashboardProps, WhaleKrill, WhalePod } from "./types.js";
import "./whale-current.css";

type CurrentStatus = WhaleKrill["status"];
type CurrentFilter = "all" | CurrentStatus;
type CurrentLane = { key: string; pod: WhalePod | null; tasks: WhaleKrill[] };

const CURRENT_STATUSES: CurrentStatus[] = [
  "queued", "claimed", "running", "verifying", "completed", "failed", "cancelled",
];
const CURRENT_POD_TEXT = { running: "运行中", staged: "已暂存", archived: "已归档" };
const CURRENT_HOST_TEXT = { online: "在线", offline: "离线", degraded: "降级" };
const CURRENT_CONFIG_TEXT = { current: "配置一致", drift: "配置漂移", unknown: "配置未知" };
const CURRENT_FRESHNESS_TEXT = {
  current: "当前快照", stale: "快照已陈旧", unobserved: "来源未连接",
};

function CurrentTask({
  task, orphan, onOpenTask,
}: {
  task: WhaleKrill; orphan: boolean; onOpenTask: WhaleDashboardProps["onOpenTask"];
}) {
  const evidence = task.evidenceCount > 0 ? `证据 ${task.evidenceCount}` : "暂无证据";
  return (
    <button
      type="button"
      className="wc-task"
      data-state={task.status}
      data-blocked={task.blocked === true}
      onClick={() => onOpenTask(task.id)}
      aria-label={`${task.title || task.id}，${WHALE_STATUS_TEXT[task.status]}，${task.blocked ? "受阻，" : ""}${evidence}，依赖 ${task.dependencies}，打开任务详情`}
    >
      <span className="wc-task-topline">
        <span className="wc-task-id" title={task.id}>{task.id}</span>
        <span aria-hidden="true" className="wc-open-arrow">↗</span>
      </span>
      <span className="wc-task-title">{task.title || "未命名任务"}</span>
      <span className="wc-task-meta">
        <span className={task.evidenceCount > 0 ? "wc-evidence" : ""}>{evidence}</span>
        <span>依赖 {task.dependencies}</span>
        {task.blocked ? <span className="wc-blocked-label">受阻</span> : null}
      </span>
      {orphan ? (
        <span className="wc-task-assignment">
          {task.teamId ? `团队 ${task.teamId} 不在快照中` : "未提供团队身份"}
        </span>
      ) : null}
      {task.revision !== undefined ? <span className="wc-task-revision">revision {task.revision}</span> : null}
    </button>
  );
}

export function WhaleCurrent({ model, onOpenTask, onOpenHost, onNavigate }: WhaleDashboardProps) {
  const id = useId();
  const [teamChoice, setTeamChoice] = useState("");
  const [statusFilter, setStatusFilter] = useState<CurrentFilter>("all");
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [query, setQuery] = useState("");

  const source = useMemo(() => {
    const byTeam = new Map<string, CurrentLane>(
      model.pods.map((pod) => [pod.id, { key: `team:${pod.id}`, pod, tasks: [] }]),
    );
    const unassigned: CurrentLane = { key: "unassigned", pod: null, tasks: [] };
    const counts = new Map<CurrentStatus, number>(CURRENT_STATUSES.map((status) => [status, 0]));
    let blocked = 0;
    let evidence = 0;
    let inFlight = 0;
    for (const task of model.krill) {
      const lane = task.teamId ? byTeam.get(task.teamId) : undefined;
      (lane ?? unassigned).tasks.push(task);
      counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
      if (task.blocked) blocked += 1;
      evidence += task.evidenceCount;
      if (task.status === "claimed" || task.status === "running" || task.status === "verifying") inFlight += 1;
    }
    return { lanes: [...byTeam.values()], unassigned, counts, blocked, evidence, inFlight };
  }, [model.pods, model.krill]);

  // A team may disappear between snapshots; fall back to the complete view.
  const selection = teamChoice === "unassigned" || source.lanes.some((lane) => lane.key === teamChoice)
    ? teamChoice : "";
  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const lanes = selection === "unassigned"
      ? [source.unassigned]
      : source.lanes.filter((lane) => !selection || lane.key === selection);
    // Tasks with no resolvable team remain visible for every team selection.
    const included = selection !== "unassigned" && source.unassigned.tasks.length > 0
      ? [...lanes, source.unassigned] : lanes;
    const counts = new Map<CurrentStatus, number>(CURRENT_STATUSES.map((status) => [status, 0]));
    let total = 0;
    const filtered = included.map((lane) => {
      const buckets = new Map<CurrentStatus, WhaleKrill[]>(CURRENT_STATUSES.map((status) => [status, []]));
      let matches = 0;
      for (const task of lane.tasks) {
        if (statusFilter !== "all" && task.status !== statusFilter) continue;
        if (blockedOnly && !task.blocked) continue;
        if (normalizedQuery && !`${task.title} ${task.id}`.toLocaleLowerCase().includes(normalizedQuery)) continue;
        buckets.get(task.status)?.push(task);
        counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
        matches += 1;
      }
      total += matches;
      return { ...lane, buckets, matches };
    });
    return { lanes: filtered, total, counts };
  }, [source, selection, statusFilter, blockedOnly, query]);

  const columns = statusFilter === "all" ? CURRENT_STATUSES : [statusFilter];
  const hasFilters = selection !== "" || statusFilter !== "all" || blockedOnly || query !== "";
  const connectedEmpty = model.freshness === "current" && model.krill.length === 0;
  const matrixStyle = { "--wc-columns": columns.length } as CSSProperties;

  function resetFilters() {
    setTeamChoice("");
    setStatusFilter("all");
    setBlockedOnly(false);
    setQuery("");
  }

  return (
    <div className="whale-current" style={matrixStyle}>
      <header className="wc-header">
        <div className="wc-brand">
          <span className="wc-brand-glyph"><WhaleGlyph size={76} /></span>
          <div>
            <p className="wc-eyebrow">鲸 / CURRENT MATRIX</p>
            <h1>洋流矩阵</h1>
            <p className="wc-intro">团队横向展开，任务按状态归位。</p>
          </div>
        </div>
        <div className="wc-header-actions">
          <div className="wc-source-labels">
            {model.demo ? <span className="wc-source-badge">演示数据 · DEMO</span> : null}
            <span className="wc-freshness" data-freshness={model.freshness}>
              <span aria-hidden="true" />{CURRENT_FRESHNESS_TEXT[model.freshness]}
            </span>
          </div>
          <button type="button" className="wc-primary-button" onClick={() => onNavigate("tasks")}>
            打开任务板 <span aria-hidden="true">↗</span>
          </button>
        </div>
      </header>

      {model.freshness !== "current" ? (
        <aside className="wc-source-notice" role="status">
          <div>
            <strong>{model.freshness === "stale" ? "这是一份陈旧快照" : "尚未观察到来源数据"}</strong>
            <p>{model.freshness === "stale"
              ? "任务、证据和 Host 状态可能已变化，请到详情核实。"
              : "当前连接状态未知；已有条目仅供查看，空白不代表零任务。"}</p>
          </div>
          <button type="button" className="wc-text-button" onClick={() => onNavigate("setup")}>查看来源配置 ↗</button>
        </aside>
      ) : null}

      <dl className="wc-overview" aria-label="当前展示窗口统计">
        <div><dt>已观察任务</dt><dd>{model.krill.length}<span>项</span></dd></div>
        <div><dt>已领取 / 执行 / 待验收</dt><dd>{source.inFlight}<span>项</span></dd></div>
        <div data-alert={source.blocked > 0}><dt>标记受阻</dt><dd>{source.blocked}<span>项</span></dd></div>
        <div><dt>已记录证据</dt><dd>{source.evidence}<span>条</span></dd></div>
      </dl>

      <section className="wc-workspace" aria-labelledby={`${id}-matrix-title`}>
        <div className="wc-section-heading">
          <div>
            <p className="wc-eyebrow">TEAM × STATUS</p>
            <h2 id={`${id}-matrix-title`}>团队泳道</h2>
          </div>
          <p className="wc-view-count" role="status" aria-live="polite" aria-atomic="true">
            显示 <strong>{visible.total}</strong> / {model.krill.length} 项任务
            <span> · {visible.lanes.length} 条泳道</span>
          </p>
        </div>

        <div className="wc-toolbar">
          <label className="wc-field">
            <span>团队</span>
            <select value={selection} onChange={(event) => setTeamChoice(event.target.value)}>
              <option value="">全部团队</option>
              {source.lanes.map((lane) => (
                <option key={lane.key} value={lane.key}>{lane.pod?.name || lane.pod?.id}</option>
              ))}
              <option value="unassigned">归属待确认（{source.unassigned.tasks.length}）</option>
            </select>
          </label>
          <label className="wc-field">
            <span>状态</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as CurrentFilter)}>
              <option value="all">全部状态</option>
              {CURRENT_STATUSES.map((status) => (
                <option key={status} value={status}>{WHALE_STATUS_TEXT[status]}（{source.counts.get(status) ?? 0}）</option>
              ))}
            </select>
          </label>
          <label className="wc-field wc-search">
            <span>定位任务</span>
            <input type="search" placeholder="搜索名称或 ID" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button
            type="button" className="wc-filter-button" aria-pressed={blockedOnly}
            onClick={() => setBlockedOnly((previous) => !previous)}
          >
            仅看受阻 <span>{source.blocked}</span>
          </button>
          {hasFilters ? <button type="button" className="wc-text-button" onClick={resetFilters}>清除筛选</button> : null}
        </div>

        {source.unassigned.tasks.length > 0 ? (
          <p className="wc-orphan-note">
            {source.unassigned.tasks.length} 项任务归属待确认，选择团队时仍保留。
          </p>
        ) : null}

        <p id={`${id}-matrix-help`} className="wc-matrix-help">每列对应当前任务状态；选择任务可查看详情与证据。</p>
        {model.krill.length === 0 || visible.total === 0 ? (
          <div className="wc-empty" role="status">
            <strong>{model.krill.length === 0
              ? connectedEmpty ? "当前来源暂无任务" : model.freshness === "stale" ? "陈旧快照中没有任务" : "等待来源数据"
              : "当前筛选没有匹配任务"}</strong>
            <p>{model.krill.length === 0
              ? connectedEmpty ? "团队与 Host 仍在下方保留，任务出现后将按真实状态归位。" : "连接与新鲜度确认前，无法判断实际任务数量。"
              : "调整状态、团队或关键词，查看其余任务。"}</p>
            {hasFilters ? <button type="button" className="wc-text-button" onClick={resetFilters}>显示全部任务</button> : null}
          </div>
        ) : null}

        {visible.lanes.length > 0 ? (
          <div
            className="wc-matrix-scroll" role="region" aria-label="团队与任务状态矩阵，可横向滚动"
            aria-describedby={`${id}-matrix-help`} tabIndex={0}
          >
            <div className="wc-matrix">
              <div className="wc-column-headings" aria-hidden="true">
                <div className="wc-team-column-label">团队身份 <span>{visible.lanes.length}</span></div>
                {columns.map((status) => (
                  <div key={status} className="wc-status-heading" data-state={status}>
                    <span className="wc-state-mark" /><span>{WHALE_STATUS_TEXT[status]}</span>
                    <strong>{visible.counts.get(status) ?? 0}</strong>
                  </div>
                ))}
              </div>
              {visible.lanes.map((lane) => (
                <section className="wc-lane" key={lane.key} aria-label={lane.pod?.name || "归属待确认"}>
                  <header className="wc-lane-identity" data-orphan={lane.pod === null}>
                    <div className="wc-lane-label">
                      {lane.pod ? <WhaleGlyph size={48} /> : <span className="wc-unassigned-mark" aria-hidden="true">?</span>}
                      <span>{lane.pod ? CURRENT_POD_TEXT[lane.pod.state] : "身份未确认"}</span>
                    </div>
                    <h3>{lane.pod?.name || (lane.pod ? lane.pod.id : "归属待确认")}</h3>
                    <p className="wc-lane-summary">{lane.matches} / {lane.tasks.length} 项任务</p>
                    {lane.pod ? (
                      <>
                        <p className="wc-lane-source">{lane.pod.providerId || "来源未知"} · {lane.pod.memberCount} 位成员</p>
                        <p className="wc-lane-workspace">{lane.pod.workspace || "工作区未知"}</p>
                      </>
                    ) : <p className="wc-lane-source">尚无可确认的团队身份。<br />任务保留，可直接打开。</p>}
                  </header>
                  {columns.map((status) => {
                    const tasks = lane.buckets.get(status) ?? [];
                    return (
                      <div key={status} className="wc-cell" data-empty={tasks.length === 0} data-state={status}>
                        <h4 className="wc-cell-heading">
                          <span className="wc-state-mark" /><span>{WHALE_STATUS_TEXT[status]}</span><span>{tasks.length}</span>
                        </h4>
                        <div className="wc-cell-list">
                          {tasks.map((task) => <CurrentTask key={task.id} task={task} orphan={lane.pod === null} onOpenTask={onOpenTask} />)}
                        </div>
                        {tasks.length === 0 ? <span className="wc-cell-empty" aria-hidden="true">—</span> : null}
                      </div>
                    );
                  })}
                  {lane.matches === 0 ? <p className="wc-lane-empty">此泳道暂无匹配任务</p> : null}
                </section>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {model.attention.length > 0 ? (
        <details className="wc-attention">
          <summary><span className="wc-attention-mark" aria-hidden="true">!</span>需要关注 <strong>{model.attention.length}</strong><span className="wc-attention-hint">展开查看</span></summary>
          <ul>
            {model.attention.map((item) => (
              <li key={item.id}>
                <div><strong>{item.title}</strong><p>{item.detail}</p></div>
                <div className="wc-attention-actions">
                  {item.taskId ? <button type="button" className="wc-text-button" onClick={() => onOpenTask(item.taskId!)}>打开任务 ↗</button> : null}
                  {item.hostId ? <button type="button" className="wc-text-button" onClick={() => onOpenHost(item.hostId!)}>打开 Host ↗</button> : null}
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <section className="wc-host-section" aria-labelledby={`${id}-hosts-title`}>
        <div className="wc-section-heading">
          <div><p className="wc-eyebrow">HOSTS / RESOURCE ROW</p><h2 id={`${id}-hosts-title`}>Host 资源 <span className="wc-heading-count">{model.hosts.length}</span></h2></div>
          <button type="button" className="wc-text-button" onClick={() => onNavigate("fleet")}>打开 Host 列表 ↗</button>
        </div>
        <p className="wc-host-intro">独立资源视图，当前窗口内的 Host；团队筛选仅作用于上方泳道。</p>
        {model.hosts.length > 0 ? (
          <ul className="wc-host-list">
            {model.hosts.map((host) => (
              <li key={host.id}>
                <button type="button" className="wc-host" data-status={host.status} onClick={() => onOpenHost(host.id)}>
                  <span className="wc-host-topline"><span className="wc-host-name">{host.name || host.id}</span><span aria-hidden="true">↗</span></span>
                  <span className="wc-host-state"><span className="wc-host-status">{CURRENT_HOST_TEXT[host.status] || "状态未知"}</span><span>{CURRENT_CONFIG_TEXT[host.configState] || "配置未知"}</span></span>
                  <span className="wc-host-work">{host.active} 活动任务<span>{host.capacity === undefined ? "配额未知" : `配额 ${host.capacity}`}</span></span>
                  <span className="wc-host-owner">{host.owner ? `所有者 ${host.owner}` : "所有者未知"}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="wc-host-empty">{model.freshness === "unobserved" ? "Host 来源尚未连接，资源数量未知。" : "这份快照中暂无 Host 记录。"}
            {model.summary.unknownHosts > 0 ? ` 另有 ${model.summary.unknownHosts} 个 Host 身份未确认。` : ""}
          </p>
        )}
        {model.hosts.length > 0 && model.summary.unknownHosts > 0 ? <p className="wc-host-intro">另有 {model.summary.unknownHosts} 个 Host 身份未确认，详情请查看 Host 列表。</p> : null}
      </section>
      <footer className="wc-footer"><span>鲸 · 洋流矩阵</span><span>{model.demo ? "演示数据" : "来源快照"} · {CURRENT_FRESHNESS_TEXT[model.freshness]}</span></footer>
    </div>
  );
}
