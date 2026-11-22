import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskEvidence, TaskRecord } from "@dsh-fusion/core";
import {
  ArrowDown, ArrowLeft, ArrowUpRight, Check, ChevronDown, ChevronRight,
  Circle, CircleAlert, CircleCheck, CircleDashed, Clock3, Code2, FileCheck2, FileText,
  GitBranch, Layers2, ListFilter, MessageSquare, Monitor, Moon, PanelLeft, PanelRight,
  Pause, Play, Search, ShieldCheck, Sun, Terminal, Users, Waves, X,
} from "lucide-react";
import { PREVIEW_MODEL, PREVIEW_NODES, PREVIEW_TASKS, PREVIEW_TEAM, TASK_NOTES } from "./demo-data.js";
import { OceanPreviewBoundary } from "./OceanPreviewBoundary.js";
import "./workbench-preview.css";

const DEMO_PODS = PREVIEW_MODEL.pods.map(pod => ({ ...pod, observed: true }));
type Concept = "panorama" | "ocean" | "focus";
type Filter = "all" | "attention" | "active" | "completed";
type DetailTab = "overview" | "evidence";
const CONCEPTS: { id: Concept; number: string; label: string; short: string; note: string }[] = [
  { id: "panorama", number: "01", label: "横向全景", short: "全景", note: "团队全貌在上，任务与证据并列" },
  { id: "ocean", number: "02", label: "沉浸海域", short: "海域", note: "海域居中，任务托盘随手可达" },
  { id: "focus", number: "03", label: "任务优先", short: "任务", note: "以任务和证据为主，海域按需打开" },
];
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "全部" }, { id: "attention", label: "需关注" },
  { id: "active", label: "进行中" }, { id: "completed", label: "已回报完成" },
];

function initialConcept(): Concept {
  const query = new URLSearchParams(window.location.search).get("concept");
  return query === "panorama" || query === "ocean" ? query : "focus";
}
function isBlocked(task: TaskRecord) { return PREVIEW_MODEL.krill.find(item => item.id === task.id)?.blocked === true; }
function taskState(task: TaskRecord) {
  if (isBlocked(task)) return { label: "受阻", tone: "warning", Icon: CircleAlert };
  if (task.status === "verifying") return { label: "待验收", tone: "review", Icon: ShieldCheck };
  if (task.status === "failed") return { label: "失败", tone: "error", Icon: CircleAlert };
  if (task.status === "running" || task.status === "claimed") return { label: "进行中", tone: "active", Icon: CircleDashed };
  if (task.status === "completed") return { label: "已回报完成", tone: "done", Icon: CircleCheck };
  return { label: task.status === "cancelled" ? "已取消" : "等待中", tone: "muted", Icon: Clock3 };
}
function Status({ task, compact = false }: { task: TaskRecord; compact?: boolean }) {
  const { Icon, tone, label } = taskState(task);
  return <span className={`wb-status wb-status--${tone}`}><Icon size={compact ? 13 : 14} strokeWidth={1.65} /><span>{label}</span></span>;
}
function EvidenceIcon({ kind }: { kind: TaskEvidence["kind"] }) {
  const Icon = kind === "command" ? Terminal : kind === "git" ? GitBranch : kind === "artifact" ? FileCheck2 : FileText;
  return <Icon size={15} strokeWidth={1.6} />;
}

function PreviewToolbar({ concept, onConcept, light, onTheme }: { concept: Concept; onConcept: (value: Concept) => void; light: boolean; onTheme: () => void }) {
  return <header className="wb-preview-bar">
    <div className="wb-preview-identity"><Waves size={21} strokeWidth={1.7} /><span>鲸<span className="wb-preview-slash">/</span><span className="wb-preview-word">布局比选</span></span></div>
    <nav className="wb-concepts" aria-label="工作台布局方案">{CONCEPTS.map(item => <button type="button" key={item.id} onClick={() => onConcept(item.id)} className={concept === item.id ? "is-active" : ""} aria-pressed={concept === item.id} data-concept={item.id}><span className="wb-concept-number">{item.number}</span><span className="wb-concept-full">{item.label}</span><span className="wb-concept-short">{item.short}</span></button>)}</nav>
    <button type="button" className="wb-icon-button wb-theme-toggle" onClick={onTheme} aria-label={light ? "切换深色主题" : "切换浅色主题"} title={light ? "切换深色主题" : "切换浅色主题"}>{light ? <Moon size={17} /> : <Sun size={17} />}</button>
  </header>;
}

function HostSketch({ draft, setDraft }: { draft: string; setDraft: (value: string) => void }) {
  return <>
    <aside className="wb-host-rail" aria-label="宿主布局示意边栏"><div className="wb-host-mark"><Code2 size={19} /></div><span className="wb-rail-symbol is-current"><MessageSquare size={18} /></span><span className="wb-rail-symbol"><Layers2 size={18} /></span><span className="wb-rail-symbol"><GitBranch size={18} /></span><span className="wb-rail-bottom">DSH</span></aside>
    <section className="wb-host-sketch" aria-label="DSH 聊天布局示意，不是真实宿主">
      <header className="wb-host-top"><span><PanelLeft size={15} /> 原生聊天</span><span className="wb-sketch-label">宿主布局示意</span></header>
      <div className="wb-chat-heading"><span className="wb-chat-project">demo / workspace</span><h2>原生工作台设计</h2><span>本地草稿 · 不连接模型</span></div>
      <div className="wb-chat-body">
        <div className="wb-chat-message wb-chat-message--user"><span className="wb-message-speaker">示例用户</span><p>让任务更清楚，也保留聊天的空间。</p></div>
        <div className="wb-chat-message"><span className="wb-message-speaker"><span className="wb-tiny-mark"><Waves size={12} /></span>合成助手消息</span><p>把需要决策的任务放在前面，证据紧随其后。</p><p>选择右侧任务，查看负责人、依赖与检查收据。海域由你决定何时打开。</p><div className="wb-chat-reference"><FileCheck2 size={15} /><span>复核原生面板交互<small>合成任务 · 待验收</small></span><ArrowUpRight size={14} /></div></div>
        <p className="wb-chat-boundary">此区域仅用于比较停靠关系，<br />不是真实 DSH 会话。</p>
      </div>
      <div className="wb-composer"><label htmlFor="wb-chat-draft">聊天草稿</label><textarea id="wb-chat-draft" value={draft} onChange={event => setDraft(event.target.value)} placeholder="在这里写下想法…" rows={3} /><div className="wb-composer-footer"><span><Circle size={7} fill="currentColor" />仅保留在当前页面内存</span><span>不会发送</span></div></div>
    </section>
  </>;
}

function Ocean({ concept, onSelectTask, playing, onPlaying }: { concept: Concept; onSelectTask: (id: string) => void; playing: boolean; onPlaying: () => void }) {
  const [view, setView] = useState<"deep" | "surface">("deep");
  const [sceneState, setSceneState] = useState("loading");
  return <section className={`wb-ocean wb-ocean--${concept}`} aria-label="可选海域协作意象">
    <div className="wb-ocean-scene"><OceanPreviewBoundary activity={{ active: PREVIEW_MODEL.summary.active, blocked: PREVIEW_MODEL.krill.filter(task => task.blocked).length, completed: PREVIEW_MODEL.summary.completed, observed: true }} pods={DEMO_PODS} quality="eco" playing={playing} view={view} selectedPodId={PREVIEW_TEAM.id} onSelectPod={() => onSelectTask("demo-task-104")} onStateChange={setSceneState} />{(sceneState === "still" || sceneState === "error") && <div className="wb-ocean-static-note"><Waves size={24} /><span>{sceneState === "still" ? "系统已减少动态效果" : "海域暂时无法加载"}</span><small>任务与证据仍可正常查看</small></div>}</div>
    <div className="wb-ocean-caption"><span><Waves size={14} />协作意象</span><span>固定合成快照 · 动画不代表执行进展</span><div><button className="wb-ocean-action" type="button" onClick={() => setView(value => value === "deep" ? "surface" : "deep")} aria-label={view === "deep" ? "切换近海视角" : "切换深海视角"}>{view === "deep" ? "深海" : "近海"}<ChevronDown size={12} /></button><button type="button" className="wb-ocean-action" onClick={onPlaying} aria-label={playing ? "暂停海域动画" : "播放海域动画"}>{playing ? <Pause size={12} /> : <Play size={12} />}{playing ? "暂停" : "播放"}</button></div></div>
  </section>;
}

function TaskList({ tasks, selectedId, onSelect, filter, setFilter, query, setQuery, compact }: { tasks: TaskRecord[]; selectedId: string; onSelect: (id: string) => void; filter: Filter; setFilter: (value: Filter) => void; query: string; setQuery: (value: string) => void; compact: boolean }) {
  return <section className={`wb-task-column${compact ? " wb-task-column--tray" : ""}`} aria-label="合成任务列表">
    <div className="wb-task-list-heading"><div><h2>任务</h2><span>{String(PREVIEW_TASKS.length).padStart(2, "0")}</span></div><label className="wb-search"><Search size={14} /><input aria-label="搜索任务或负责人" placeholder="搜索任务或负责人" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="清空搜索" onClick={() => setQuery("")}><X size={12} /></button>}</label></div>
    <div className="wb-filter-row"><ListFilter size={13} /><div>{FILTERS.map(item => <button type="button" key={item.id} className={filter === item.id ? "is-active" : ""} onClick={() => setFilter(item.id)} aria-pressed={filter === item.id}>{item.label}</button>)}</div></div>
    <div className="wb-task-rows">{tasks.length ? tasks.map(task => <button type="button" key={task.id} className={`wb-task-row${task.id === selectedId ? " is-selected" : ""}`} onClick={() => onSelect(task.id)} aria-pressed={task.id === selectedId} data-task-id={task.id}>
      <div className="wb-task-row-line"><span className="wb-task-number">{task.id.replace("demo-task-", "T-")}</span><Status task={task} compact /><span className="wb-task-time">{TASK_NOTES[task.id]?.time}</span></div>
      <h3>{task.goal}<ChevronRight size={14} /></h3>
      <div className="wb-task-row-meta"><span className="wb-owner-initial">{task.agentTeamTask?.ownerName?.slice(0, 1)}</span><span>{task.agentTeamTask?.ownerName}</span><span className="wb-task-row-evidence"><FileText size={12} />{task.evidence.length} 份证据</span></div>
    </button>) : <div className="wb-empty"><Search size={24} /><h3>没有匹配的任务</h3><p>试试其它关键词或状态。</p><button type="button" onClick={() => { setQuery(""); setFilter("all"); }}>重置筛选</button></div>}</div>
    <footer className="wb-list-footer"><span>{tasks.length} / {PREVIEW_TASKS.length} 条合成任务</span><span>固定快照</span></footer>
  </section>;
}

function TaskInspector({ task, tab, setTab, selectedEvidence, setSelectedEvidence, onSelectTask, mobileList, onMobileList }: { task: TaskRecord; tab: DetailTab; setTab: (value: DetailTab) => void; selectedEvidence: number; setSelectedEvidence: (value: number) => void; onSelectTask: (id: string) => void; mobileList: boolean; onMobileList: () => void }) {
  const note = TASK_NOTES[task.id];
  const node = PREVIEW_NODES.find(item => item.id === task.targetNodeIds[0]);
  const evidence = task.evidence[selectedEvidence] ?? task.evidence[0];
  const deps = PREVIEW_TASKS.filter(item => task.dependsOnTaskIds?.includes(item.id));
  const StateIcon = taskState(task).Icon;
  return <section className={`wb-inspector${mobileList ? " is-mobile-hidden" : ""}`} aria-label="合成任务详情" data-selected-task={task.id} onKeyDown={event => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
    event.preventDefault(); event.stopPropagation(); setTab("overview"); onMobileList();
  }}>
    <button type="button" className="wb-mobile-back" onClick={onMobileList}><ArrowLeft size={15} />返回任务列表</button>
    <header className="wb-detail-heading"><div><span className="wb-task-number">{task.id.replace("demo-task-", "T-")}</span><span className="wb-detail-separator">/</span><span>任务详情</span><span className="wb-demo-tag">合成</span></div><Status task={task} /><h2 tabIndex={-1}>{task.goal}</h2><p>{note?.description}</p></header>
    <div className="wb-detail-tabs" role="tablist" aria-label="任务详情视图"><button type="button" role="tab" aria-selected={tab === "overview"} className={tab === "overview" ? "is-active" : ""} onClick={() => setTab("overview")}>概览</button><button type="button" role="tab" aria-selected={tab === "evidence"} className={tab === "evidence" ? "is-active" : ""} onClick={() => setTab("evidence")}>证据<span>{task.evidence.length}</span></button></div>
    <div className="wb-detail-scroll">
      {tab === "overview" ? <>
        <dl className="wb-properties"><div><dt><Users size={14} />负责人</dt><dd><span className="wb-owner-initial">{task.agentTeamTask?.ownerName?.slice(0, 1)}</span>{task.agentTeamTask?.ownerName}</dd></div><div><dt><Layers2 size={14} />归属团队</dt><dd>{PREVIEW_TEAM.name}<span className="wb-text-note">演示</span></dd></div><div><dt><Monitor size={14} />执行节点</dt><dd>{node?.name ?? "未提供"}<span className="wb-node-dot" /></dd></div></dl>
        <section className="wb-next-step"><div><span className={`wb-next-mark wb-status--${taskState(task).tone}`}><StateIcon size={15} strokeWidth={1.7} /></span><h3>下一步</h3></div><p>{note?.next}</p>{task.error && <p className="wb-inline-warning">{task.error}</p>}</section>
        {deps.length > 0 && <section className="wb-dependencies"><h3>前置依赖</h3>{deps.map(dependency => <button type="button" key={dependency.id} onClick={() => onSelectTask(dependency.id)}><GitBranch size={14} /><span>{dependency.goal}</span><Status task={dependency} compact /><ChevronRight size={14} /></button>)}</section>}
        <section className="wb-evidence-section"><div className="wb-section-heading"><h3>检查证据</h3><span>{task.evidence.length} 份</span>{task.evidence.length > 0 && <button type="button" onClick={() => { setSelectedEvidence(0); setTab("evidence"); }}>查看全部<ArrowUpRight size={13} /></button>}</div>{task.evidence.length > 0 ? task.evidence.slice(0, 2).map((item, index) => <button className="wb-evidence-row" type="button" key={`${item.kind}-${index}`} onClick={() => { setSelectedEvidence(index); setTab("evidence"); }}><span className="wb-file-icon"><EvidenceIcon kind={item.kind} /></span><span>{item.label}<small>合成演示 · {item.kind}</small></span><ChevronRight size={14} /></button>) : <p className="wb-no-evidence">尚未提供证据。缺少证据不能解释为通过。</p>}</section>
        <div className="wb-detail-footnote"><ShieldCheck size={14} /><p>任务回报、执行证据与独立验收分别呈现。<br />此预览没有真实执行或验收能力。</p></div>
      </> : <section className="wb-evidence-reader"><div className="wb-section-heading"><h3>本地证据查看器</h3><span>只读演示</span></div>{task.evidence.length ? <><div className="wb-evidence-picker">{task.evidence.map((item, index) => <button type="button" key={`${item.kind}-${index}`} className={index === selectedEvidence ? "is-active" : ""} onClick={() => setSelectedEvidence(index)}><EvidenceIcon kind={item.kind} /><span>{item.label}</span>{index === selectedEvidence && <Check size={13} />}</button>)}</div>{evidence && <div className="wb-evidence-document"><div><EvidenceIcon kind={evidence.kind} /><span>{evidence.label}</span><span>DEMO</span></div><pre>{evidence.value}</pre></div>}</> : <div className="wb-empty"><FileText size={25} /><h3>尚未提供证据</h3><p>等待依赖任务完成后，再核对交付内容。</p></div>}</section>}
    </div>
  </section>;
}

export function WorkbenchPreview() {
  const [concept, setConcept] = useState<Concept>(initialConcept);
  const [light, setLight] = useState(false);
  const [draft, setDraft] = useState("先看任务与证据的阅读顺序，再比较海域占比。");
  const [selectedId, setSelectedId] = useState("demo-task-104");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<DetailTab>("overview");
  const [selectedEvidence, setSelectedEvidence] = useState(0);
  const [oceanEnabled, setOceanEnabled] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [mobileList, setMobileList] = useState(true);
  const [sketchExpanded, setSketchExpanded] = useState(false);
  const taskWorkspace = useRef<HTMLDivElement>(null);
  const selected = PREVIEW_TASKS.find(item => item.id === selectedId) ?? PREVIEW_TASKS[0]!;
  const activeConcept = CONCEPTS.find(item => item.id === concept)!;
  const hasOcean = concept !== "focus" || oceanEnabled;
  const visibleTasks = useMemo(() => PREVIEW_TASKS.filter(task => {
    const stateMatches = filter === "all" || (filter === "attention" && (isBlocked(task) || task.status === "failed" || task.status === "verifying")) || (filter === "active" && (task.status === "running" || task.status === "claimed")) || (filter === "completed" && task.status === "completed");
    const search = `${task.goal} ${task.agentTeamTask?.ownerName ?? ""} ${task.id}`.toLowerCase();
    return stateMatches && search.includes(query.trim().toLowerCase());
  }), [filter, query]);
  function selectTask(id: string) {
    setSelectedId(id); setTab("overview"); setSelectedEvidence(0); setMobileList(false);
    if (window.matchMedia("(max-width: 700px)").matches) requestAnimationFrame(() => taskWorkspace.current?.querySelector<HTMLHeadingElement>(".wb-detail-heading h2")?.focus());
  }
  function showList() {
    setMobileList(true);
    if (window.matchMedia("(max-width: 700px)").matches) requestAnimationFrame(() => taskWorkspace.current?.querySelector<HTMLButtonElement>(`[data-task-id="${selectedId}"]`)?.focus());
  }
  function changeConcept(value: Concept) {
    setConcept(value);
    const url = new URL(window.location.href); url.searchParams.set("concept", value); window.history.replaceState(null, "", url);
  }
  useEffect(() => {
    const onPop = () => setConcept(initialConcept());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return <div className={`wb-preview${light ? " wb-light" : ""}`} data-preview-concept={concept}>
    <PreviewToolbar concept={concept} onConcept={changeConcept} light={light} onTheme={() => setLight(value => !value)} />
    <div className="wb-demo-disclosure"><span><CircleAlert size={13} />全部为合成演示 · 无执行后端</span><span className="wb-disclosure-long">三个方案共用同一固定数据与本地草稿</span><span className="wb-host-hidden-label">宿主示意隐藏</span></div>
    <main className={`wb-shell wb-shell--${concept}`}>
      <HostSketch draft={draft} setDraft={setDraft} />
      <section className="wb-workbench" aria-label={`${activeConcept.label}工作台方案`}>
        <header className="wb-workbench-header"><div><span className="wb-product-icon"><Waves size={18} strokeWidth={1.7} /></span><strong>鲸</strong><span className="wb-header-rule" /><span>工作台</span></div><span className="wb-dock-label"><PanelRight size={14} />停靠面板示意</span></header>
        <div className="wb-workspace-heading"><div><span className="wb-workspace-breadcrumb">远航团队<ChevronRight size={12} />设计工作区</span><h1>原生工作台<span className="wb-title-dot" /></h1><p>{activeConcept.note}</p></div><div className="wb-workspace-side"><span className="wb-snapshot"><span />固定快照 · 09:32</span><button type="button" className={`wb-ocean-toggle${hasOcean ? " is-active" : ""}`} onClick={() => { if (concept === "focus") setOceanEnabled(value => !value); else changeConcept("focus"); }}><Waves size={14} />{concept === "focus" ? oceanEnabled ? "收起海域" : "打开海域" : "回到任务"}{hasOcean && concept === "focus" ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button></div></div>
        {hasOcean && <Ocean concept={concept} onSelectTask={selectTask} playing={playing} onPlaying={() => setPlaying(value => !value)} />}
        {concept === "panorama" && <div className="wb-team-line"><span><Users size={14} /><strong>{PREVIEW_TEAM.name}</strong><small>合成团队</small></span><span>{PREVIEW_TEAM.memberIds.length} 位成员<span className="wb-line-separator" />{PREVIEW_NODES.length} 个节点<span className="wb-line-separator" />任务归属已声明</span><button type="button" onClick={() => setFilter(filter === "attention" ? "all" : "attention")}><CircleAlert size={13} />{filter === "attention" ? "查看全部任务" : "聚焦需关注任务"}<ArrowDown size={12} /></button></div>}
        <div ref={taskWorkspace} className={`wb-task-workspace${!mobileList ? " wb-mobile-detail-open" : ""}`}><TaskList tasks={visibleTasks} selectedId={selectedId} onSelect={selectTask} filter={filter} setFilter={setFilter} query={query} setQuery={setQuery} compact={concept === "ocean"} /><TaskInspector task={selected} tab={tab} setTab={setTab} selectedEvidence={selectedEvidence} setSelectedEvidence={setSelectedEvidence} onSelectTask={selectTask} mobileList={mobileList} onMobileList={showList} /></div>
        <div className="wb-mobile-draft"><button type="button" onClick={() => setSketchExpanded(value => !value)} aria-expanded={sketchExpanded}><MessageSquare size={14} />本地聊天草稿<span>{sketchExpanded ? "收起" : "展开"}<ChevronDown size={13} /></span></button>{sketchExpanded && <div><p>宿主示意已隐藏。以下草稿与桌面示意共用，仅保留在本页内存，不会发送。</p><textarea aria-label="窄屏本地聊天草稿" value={draft} onChange={event => setDraft(event.target.value)} rows={3} /></div>}</div>
        <footer className="wb-workbench-footer"><span><Code2 size={12} />独立前端原型</span><span>无连接 · 无派发 · 无写入</span><span className="wb-footer-key">Esc 返回任务</span></footer>
      </section>
    </main>
  </div>;
}
