import { useId, useMemo, useState } from "react";
import { WhaleGlyph } from "./WhaleGlyph.js";
import { WHALE_STATUS_TEXT } from "./types.js";
import type { WhaleDashboardProps, WhaleHost, WhaleKrill } from "./types.js";
import "./whale-atlas.css";

const POD_PAGE_SIZE = 6;
const TASK_PAGE_SIZE = 3;
const POD_STATE = { running: "运行中", staged: "准备中", archived: "已归档" };
const ACTIVE_STATUSES = new Set(["claimed", "running", "verifying"]);
type TaskFilter = "all" | "active" | "attention";

function needsAttention(task: WhaleKrill) {
  return task.blocked === true || task.status === "failed";
}

function taskTone(task: WhaleKrill) {
  if (needsAttention(task)) return "alert";
  if (task.status === "completed") return "done";
  if (ACTIVE_STATUSES.has(task.status)) return "active";
  return "quiet";
}

function taskStatus(task: WhaleKrill) {
  const status = WHALE_STATUS_TEXT[task.status] ?? "状态未知";
  return task.blocked ? `${status} · 受阻` : status;
}

function reachability(host: WhaleHost | undefined, freshness: WhaleDashboardProps["model"]["freshness"]) {
  if (!host) return "主机记录缺失";
  if (freshness === "unobserved") return "在线状态未观测";
  const status = host.status === "online" ? "在线" : host.status === "offline" ? "离线" : host.status === "degraded" ? "异常" : "在线状态未知";
  return freshness === "stale" ? `上次记录：${status}` : status;
}

function OceanContours() {
  return <svg className="wha-contours" viewBox="0 0 900 420" preserveAspectRatio="none" fill="none" aria-hidden="true">
    <g stroke="currentColor" strokeWidth="1">
      <path d="M-100 94C67-20 203 118 366 52S641-14 763 72S936 97 1012 10" />
      <path d="M-95 114C64 1 212 140 372 74S636 10 754 94S924 120 1010 33" />
      <path d="M-88 137C76 26 224 162 381 99S629 34 743 117S923 146 1003 59" />
      <path d="M-84 161C85 51 241 183 391 126S622 59 734 143S917 173 1003 85" />
      <path d="M-76 188C92 75 245 213 405 155S619 89 724 172S904 206 1005 113" />
      <path d="M-64 217C101 103 257 244 419 185S605 119 714 202S887 239 1003 144" />
      <path d="M-54 251C119 133 274 278 433 217S596 154 701 237S874 271 1002 176" />
      <path d="M-51 289C133 166 289 313 450 254S579 187 690 273S859 313 997 216" />
      <path d="M-39 330C144 203 307 352 469 294S567 231 675 312S842 352 994 256" />
      <path d="M-29 376C154 246 329 397 489 337S551 274 665 359S821 399 993 303" />
      <path d="M-13 423C178 294 351 443 516 386S538 325 651 408S800 450 989 355" />
    </g>
  </svg>;
}

export function WhaleAtlas({ model, onOpenTask, onOpenHost, onNavigate }: WhaleDashboardProps) {
  const instanceId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(() => model.pods[0]?.id ?? null);
  const [podFilter, setPodFilter] = useState<"all" | "attention">("all");
  const [podPage, setPodPage] = useState(0);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [taskPage, setTaskPage] = useState(0);
  const [query, setQuery] = useState("");
  const selected = model.pods.find(pod => pod.id === selectedId);
  const hostById = useMemo(() => new Map(model.hosts.map(host => [host.id, host])), [model.hosts]);
  const taskById = useMemo(() => new Map(model.krill.map(task => [task.id, task])), [model.krill]);
  const tasksByPod = useMemo(() => new Map(model.pods.map(pod => [pod.id,
    [...new Set(pod.taskIds)].map(id => taskById.get(id)).filter((task): task is WhaleKrill => task !== undefined),
  ])), [model.pods, taskById]);
  const podNamesByTask = useMemo(() => {
    const names = new Map<string, string[]>();
    for (const pod of model.pods) for (const id of new Set(pod.taskIds)) {
      names.set(id, [...(names.get(id) ?? []), pod.name]);
    }
    return names;
  }, [model.pods]);
  const attentionPodIds = useMemo(() => new Set(model.pods.filter(pod => {
    const taskIds = new Set(pod.taskIds);
    const hostIds = new Set(pod.hostIds);
    return pod.blocked > 0 || (tasksByPod.get(pod.id) ?? []).some(needsAttention)
      || pod.hostIds.some(id => { const host = hostById.get(id); return host && (host.status !== "online" || host.configState === "drift"); })
      || model.attention.some(item => (item.taskId && taskIds.has(item.taskId)) || (item.hostId && hostIds.has(item.hostId)));
  }).map(pod => pod.id)), [model.pods, model.attention, tasksByPod, hostById]);
  const visiblePods = podFilter === "all" ? model.pods : model.pods.filter(pod => attentionPodIds.has(pod.id));
  const podPages = Math.max(1, Math.ceil(visiblePods.length / POD_PAGE_SIZE));
  const currentPodPage = Math.min(podPage, podPages - 1);
  const pagePods = visiblePods.slice(currentPodPage * POD_PAGE_SIZE, (currentPodPage + 1) * POD_PAGE_SIZE);
  const selectedTasks = selected ? tasksByPod.get(selected.id) ?? [] : model.krill;
  const selectedHostIds = selected ? [...new Set(selected.hostIds)] : [];
  const missingTasks = selected ? new Set(selected.taskIds).size - selectedTasks.length : 0;
  const unknownOwnership = model.krill.filter(task => !podNamesByTask.has(task.id)).length;
  const selectedAttention = selected ? model.attention.filter(item =>
    (item.taskId && selected.taskIds.includes(item.taskId)) || (item.hostId && selected.hostIds.includes(item.hostId))) : [];
  const filteredTasks = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return selectedTasks.filter(task => {
      if (taskFilter === "active" && !ACTIVE_STATUSES.has(task.status)) return false;
      if (taskFilter === "attention" && !needsAttention(task) && !model.attention.some(item => item.taskId === task.id)) return false;
      return !needle || [task.title, task.id, ...(podNamesByTask.get(task.id) ?? []),
        ...task.hostIds.map(id => hostById.get(id)?.name ?? id)].join(" ").toLocaleLowerCase().includes(needle);
    });
  }, [selectedTasks, taskFilter, query, hostById, podNamesByTask, model.attention]);
  const taskPages = Math.max(1, Math.ceil(filteredTasks.length / TASK_PAGE_SIZE));
  const currentTaskPage = Math.min(taskPage, taskPages - 1);
  const pageTasks = filteredTasks.slice(currentTaskPage * TASK_PAGE_SIZE, (currentTaskPage + 1) * TASK_PAGE_SIZE);
  const alertFreshness = model.freshness !== "current";

  function selectPod(id: string | null) {
    setSelectedId(id);
    setTaskPage(0);
    setTaskFilter("all");
    setQuery("");
  }

  return <section className="whale-atlas" aria-label="鲸群航图工作面板">
    <header className="wha-header">
      <div className="wha-brand"><WhaleGlyph size={56} /><div><div className="wha-eyebrow">鲸 / WHALE ATLAS</div><h1>鲸群航图</h1></div><span className="wha-design-tag">A</span></div>
      <div className="wha-header-actions">
        {model.demo ? <span className="wha-demo">演示数据</span> : null}
        <button type="button" className="wha-button wha-subtle" onClick={() => onNavigate("fleet")}>主机列表 <span aria-hidden="true">↗</span></button>
        <button type="button" className="wha-button wha-primary" onClick={() => onNavigate("tasks")}>任务中心 <span aria-hidden="true">↗</span></button>
      </div>
    </header>

    <div className={`wha-observation ${alertFreshness ? "is-unconfirmed" : ""}`} role="status">
      <span className="wha-observation-label"><span className="wha-signal" aria-hidden="true" />{model.freshness === "current" ? "当前观测" : model.freshness === "stale" ? "观测已陈旧" : "来源未观测"}</span>
      <span className="wha-observation-detail">{model.freshness === "current" ? `${model.pods.length} 个团队 · ${model.hosts.length} 台主机 · ${model.krill.length} 条任务` : model.freshness === "stale" ? "显示上次记录；当前在线状态与执行状态待确认。" : "尚不能确认运行状态；已有记录仍可查看。"}</span>
      {alertFreshness ? <button type="button" className="wha-inline-button" onClick={() => onNavigate("setup")}>检查来源 <span aria-hidden="true">↗</span></button> : <span className="wha-observation-note">团队与主机各自独立</span>}
    </div>

    <div className="wha-main">
      <section className="wha-map" aria-labelledby={`${instanceId}-map-title`}>
        <header className="wha-panel-header">
          <div className="wha-heading"><span className="wha-section-index">01</span><h2 id={`${instanceId}-map-title`}>协作海域</h2><span className="wha-muted">{visiblePods.length} 群</span></div>
          <div className="wha-segmented" role="group" aria-label="海图团队筛选">
            <button type="button" aria-pressed={podFilter === "all"} onClick={() => { setPodFilter("all"); setPodPage(0); }}>全部</button>
            <button type="button" aria-pressed={podFilter === "attention"} onClick={() => { setPodFilter("attention"); setPodPage(0); }}>需关注 {attentionPodIds.size}</button>
          </div>
        </header>
        <div className="wha-sea">
          <OceanContours />
          <div className="wha-sea-caption" aria-hidden="true">TEAMS / KRILL</div>
          {pagePods.length ? <div className="wha-pod-grid">
            {pagePods.map(pod => {
              const tasks = tasksByPod.get(pod.id) ?? [];
              const isSelected = selected?.id === pod.id;
              return <div key={pod.id} className={`wha-pod-cluster ${isSelected ? "is-selected" : ""}`}>
                <button type="button" className="wha-pod" aria-pressed={isSelected} aria-label={`选择团队 ${pod.name}，${pod.memberCount} 位成员，${tasks.length} 条已知关联任务${attentionPodIds.has(pod.id) ? "，有待关注事项" : ""}`} onClick={() => selectPod(pod.id)}>
                  <span className="wha-whale-wrap"><span className="wha-whale-orbit" /><WhaleGlyph size={100} />{attentionPodIds.has(pod.id) ? <span className="wha-pod-alert" aria-hidden="true">!</span> : null}</span>
                  <span className="wha-pod-name" title={pod.name}>{pod.name}</span>
                  <span className="wha-pod-meta">{POD_STATE[pod.state] ?? "状态未知"} <span aria-hidden="true">·</span> {pod.memberCount} 位成员</span>
                </button>
                <div className="wha-krill" role="group" aria-label={`${pod.name} 的关联任务`}>
                  {tasks.slice(0, 4).map(task => <button key={task.id} type="button" className={`wha-krill-dot is-${taskTone(task)}`} aria-label={`${task.title}，${taskStatus(task)}，打开任务`} title={`${task.title} · ${taskStatus(task)}`} onClick={() => onOpenTask(task.id)}><span aria-hidden="true" /></button>)}
                  {tasks.length > 4 ? <button type="button" className="wha-krill-more" aria-label={`查看 ${pod.name} 的全部 ${tasks.length} 条任务`} onClick={() => selectPod(pod.id)}>+{tasks.length - 4}</button> : null}
                  {tasks.length === 0 ? <span className="wha-no-krill">{pod.taskIds.length ? "关联任务待同步" : "暂无关联任务"}</span> : null}
                </div>
              </div>;
            })}
          </div> : <div className="wha-empty wha-map-empty"><WhaleGlyph size={112} /><h3>{model.pods.length ? "没有需关注的鲸群" : model.freshness === "unobserved" ? "等待团队来源" : "这片海域暂无团队"}</h3><p>{model.pods.length ? "切回全部，继续查看团队与任务。" : model.krill.length ? "已有任务保留在下方任务流，暂不推断团队归属。" : "连接团队后，鲸与关联任务会出现在这里。"}</p><button type="button" className="wha-button wha-subtle" onClick={() => model.pods.length ? setPodFilter("all") : onNavigate("setup")}>{model.pods.length ? "查看全部鲸群" : "查看连接配置"}</button></div>}
        </div>
        <footer className="wha-map-footer">
          <span className="wha-map-explanation">位置为示意 · 磷虾为关联任务 · 无跨团队连线</span>
          <div className="wha-pagination" aria-label="海图分页"><button type="button" aria-label="上一组团队" disabled={currentPodPage === 0} onClick={() => setPodPage(currentPodPage - 1)}>‹</button><span>{currentPodPage + 1} / {podPages}</span><button type="button" aria-label="下一组团队" disabled={currentPodPage + 1 >= podPages} onClick={() => setPodPage(currentPodPage + 1)}>›</button></div>
        </footer>
      </section>

      <aside className="wha-inspector" aria-labelledby={`${instanceId}-detail-title`}>
        <header className="wha-panel-header"><div className="wha-heading"><span className="wha-section-index">02</span><h2 id={`${instanceId}-detail-title`}>团队详情</h2></div>{selected ? <button type="button" className="wha-icon-button" aria-label="清除团队选择，显示全部任务" onClick={() => selectPod(null)}>×</button> : null}</header>
        {selected ? <>
          <div className="wha-inspector-body">
            <div className="wha-selected-heading"><div className="wha-eyebrow">SELECTED POD</div><h3 title={selected.name}>{selected.name}</h3><span className="wha-team-state">{POD_STATE[selected.state] ?? "状态未知"}</span></div>
            <dl className="wha-team-facts"><div><dt>成员</dt><dd>{selected.memberCount} 位</dd></div><div><dt>关联任务</dt><dd>{selectedTasks.length} 条</dd></div><div className="wha-wide-fact"><dt>来源</dt><dd title={selected.providerId}>{selected.providerId || "来源未知"}</dd></div><div className="wha-wide-fact"><dt>工作区</dt><dd title={selected.workspace}>{selected.workspace || "工作区未知"}</dd></div></dl>
            {missingTasks > 0 ? <p className="wha-data-note">{missingTasks} 条关联任务记录缺失，未补造磷虾点。</p> : null}
            <div className="wha-list-heading"><h4>关联主机</h4><span>{selectedHostIds.length} 台</span></div>
            {selectedHostIds.length ? <ul className="wha-host-list">{selectedHostIds.map(id => {
              const host = hostById.get(id);
              const alert = host && (host.status === "offline" || host.status === "degraded" || host.configState === "drift");
              const content = <><span className={`wha-host-glyph ${alert ? "is-alert" : ""}`} aria-hidden="true">▤</span><span className="wha-host-copy"><strong title={host?.name ?? id}>{host?.name ?? id}</strong><span className={alert ? "wha-alert-text" : ""}>{reachability(host, model.freshness)}{host?.configState === "drift" ? " · 配置漂移" : host?.configState === "unknown" ? " · 配置未知" : ""}</span></span>{host ? <span className="wha-host-arrow" aria-hidden="true">↗</span> : null}</>;
              return <li key={id}>{host ? <button type="button" className="wha-host-row" onClick={() => onOpenHost(host.id)} aria-label={`打开主机 ${host.name}，${reachability(host, model.freshness)}`}>{content}</button> : <div className="wha-host-row wha-missing-host">{content}</div>}</li>;
            })}</ul> : <p className="wha-data-note">未关联主机，在线状态未知。</p>}
            {selectedAttention.length ? <div className="wha-attention-list"><div className="wha-list-heading"><h4>待关注</h4><span>{selectedAttention.length} 项</span></div>{selectedAttention.map(item => <div className="wha-attention-item" key={item.id}><strong>{item.title}</strong><p>{item.detail}</p>{item.taskId || item.hostId ? <button type="button" className="wha-inline-button" onClick={() => { if (item.taskId) onOpenTask(item.taskId); else if (item.hostId) onOpenHost(item.hostId); }}>查看{item.taskId ? "任务" : "主机"} <span aria-hidden="true">↗</span></button> : null}</div>)}</div> : null}
          </div>
          <footer className="wha-inspector-footer"><span>下方任务流已关联此鲸群</span><button type="button" className="wha-inline-button" onClick={() => onNavigate("fleet")}>主机总览 ↗</button></footer>
        </> : <div className="wha-empty wha-detail-empty"><WhaleGlyph size={88} /><h3>选择一头鲸</h3><p>查看团队来源、关联任务和主机在线状态。<br />下方当前显示全部任务。</p><button type="button" className="wha-button wha-subtle" onClick={() => onNavigate("fleet")}>查看主机列表 ↗</button></div>}
      </aside>
    </div>

    <section className="wha-stream" aria-labelledby={`${instanceId}-stream-title`}>
      <header className="wha-stream-header">
        <div className="wha-heading"><span className="wha-section-index">03</span><h2 id={`${instanceId}-stream-title`}>磷虾任务流</h2><span className="wha-task-scope" title={selected?.name ?? "全部任务"}>{selected?.name ?? "全部任务"}</span><span className="wha-muted" aria-live="polite">{filteredTasks.length} 条</span></div>
        <div className="wha-stream-controls"><div className="wha-segmented" role="group" aria-label="任务状态筛选">{([["all", "全部"], ["active", "进行中"], ["attention", "需关注"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={taskFilter === value} onClick={() => { setTaskFilter(value); setTaskPage(0); }}>{label}</button>)}</div><label className="wha-search"><span className="wha-sr-only">搜索任务名称、编号、团队或主机</span><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.5" /></svg><input type="search" placeholder="搜索任务 / 主机" value={query} onChange={event => { setQuery(event.target.value); setTaskPage(0); }} /></label></div>
      </header>
      <div className="wha-table-wrap">
        {pageTasks.length ? <table className="wha-task-table"><thead><tr><th scope="col">任务 / 团队</th><th scope="col">状态</th><th scope="col" className="wha-host-column">关联主机</th><th scope="col" className="wha-evidence-column">证据</th><th scope="col" className="wha-open-column"><span className="wha-sr-only">操作</span></th></tr></thead><tbody>{pageTasks.map(task => {
          const firstHostId = task.hostIds[0];
          const host = firstHostId ? hostById.get(firstHostId) : undefined;
          const teamNames = podNamesByTask.get(task.id)?.join("、") ?? "归属未确认";
          return <tr key={task.id}><td><button type="button" className="wha-task-link" onClick={() => onOpenTask(task.id)} title={`${task.title}\n${task.id}\n${teamNames}`}><span className={`wha-task-marker is-${taskTone(task)}`} aria-hidden="true" /><span className="wha-task-copy"><strong>{task.title || "未命名任务"}</strong><span>{teamNames}<span className="wha-task-extra"> · {task.dependencies} 个依赖</span><span className="wha-mobile-evidence"> · {task.evidenceCount} 份证据</span></span></span></button></td><td><span className={`wha-task-status is-${taskTone(task)}`}>{taskStatus(task)}</span></td><td className="wha-host-column">{host ? <button type="button" className="wha-table-host" title={task.hostIds.map(id => hostById.get(id)?.name ?? id).join("、")} onClick={() => onOpenHost(host.id)}><span>{host.name}</span>{task.hostIds.length > 1 ? <small>+{task.hostIds.length - 1}</small> : null}<span aria-hidden="true">↗</span></button> : <span className="wha-muted">{firstHostId ? "主机记录缺失" : "主机未指定"}</span>}</td><td className="wha-evidence-column"><span className="wha-evidence">{task.evidenceCount}<span> 份</span></span></td><td className="wha-open-column"><button type="button" className="wha-icon-button" aria-label={`打开任务 ${task.title}`} onClick={() => onOpenTask(task.id)}>↗</button></td></tr>;
        })}</tbody></table> : <div className="wha-stream-empty"><span className="wha-empty-ring" aria-hidden="true" /><div><h3>{selectedTasks.length ? "没有符合筛选的任务" : selected ? "此鲸群暂无已知任务" : model.freshness === "unobserved" ? "等待任务来源" : "暂无任务记录"}</h3><p>{selectedTasks.length ? "调整状态筛选或搜索词，继续定位任务。" : missingTasks > 0 ? "团队存在任务引用，但任务记录尚未同步。" : "已知空数据保留为空，不推断执行结果。"}</p></div>{selectedTasks.length ? <button type="button" className="wha-button wha-subtle" onClick={() => { setTaskFilter("all"); setQuery(""); setTaskPage(0); }}>清除筛选</button> : <button type="button" className="wha-button wha-subtle" onClick={() => onNavigate(model.freshness === "unobserved" ? "setup" : "tasks")}>{model.freshness === "unobserved" ? "检查来源" : "打开任务中心"} ↗</button>}</div>}
      </div>
      <footer className="wha-stream-footer"><div className="wha-stream-footer-copy"><span className="wha-legend"><i className="is-active" />进行中<i className="is-done" />完成<i className="is-alert" />受阻 / 异常</span>{selected ? <button type="button" className="wha-inline-button" onClick={() => selectPod(null)}>全部任务{unknownOwnership > 0 ? ` · ${unknownOwnership} 条归属未确认` : ""}</button> : <span className="wha-muted">{unknownOwnership > 0 ? `${unknownOwnership} 条归属未确认` : "按记录顺序展示"}</span>}</div><div className="wha-pagination" aria-label="任务分页"><span>{filteredTasks.length ? `${currentTaskPage * TASK_PAGE_SIZE + 1}–${Math.min((currentTaskPage + 1) * TASK_PAGE_SIZE, filteredTasks.length)} / ${filteredTasks.length}` : "0 条"}</span><button type="button" aria-label="上一页任务" disabled={currentTaskPage === 0} onClick={() => setTaskPage(currentTaskPage - 1)}>‹</button><button type="button" aria-label="下一页任务" disabled={currentTaskPage + 1 >= taskPages} onClick={() => setTaskPage(currentTaskPage + 1)}>›</button></div></footer>
    </section>
  </section>;
}
