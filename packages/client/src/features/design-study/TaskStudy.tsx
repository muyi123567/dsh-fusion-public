import { useEffect, useRef, useState } from "react";
import type { TaskRecord } from "@dsh-fusion/core";
import { matchesFilter, sourceLabel, studyTasks, TASK_GROUPS, taskState, taskTime, type StudyScenario, type StudyTheme, type StudyWidth, type TaskFilter } from "./design-fixture.js";
import { DetailNavigation, TaskDetail } from "./TaskDetail.js";
import { TaskStatus } from "./TaskStatus.js";

export function TaskStudy({ scenario, initialView, width, theme, onRetrySource, presentationStep = "idle", reducedMotion = false, onPresentationInteraction }: {
  scenario: StudyScenario;
  initialView: "list" | "detail";
  width: StudyWidth;
  theme: StudyTheme;
  onRetrySource?: () => void;
  presentationStep?: "idle" | "list" | "detail" | "gap" | "evidence" | "ending";
  reducedMotion?: boolean;
  onPresentationInteraction?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [selectedId, setSelectedId] = useState("demo-voyage-104");
  const [view, setView] = useState(initialView);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const tasks = studyTasks(scenario);
  const selected = tasks.find(task => task.id === selectedId);
  const lastKnown = useRef<TaskRecord | undefined>(scenario === "missing" ? studyTasks("normal")[0] : selected);
  const search = query.trim().toLocaleLowerCase();
  const filtered = tasks.filter(task => matchesFilter(task, filter) && [task.goal, task.agentTeamTask?.taskId, task.agentTeamTask?.ownerName, task.targetNodeIds.join(" ")].join(" ").toLocaleLowerCase().includes(search));

  useEffect(() => { if (selected) lastKnown.current = selected; }, [selected]);

  useEffect(() => {
    if (presentationStep === "list") {
      setView("list");
      setSelectedId("demo-voyage-104");
      setQuery("");
      setFilter("all");
      const list = rootRef.current?.querySelector<HTMLElement>(".study-task-groups");
      if (list) list.scrollTop = 0;
    }
    if (presentationStep === "detail" || presentationStep === "gap" || presentationStep === "evidence" || presentationStep === "ending") setView("detail");
    if (presentationStep === "list" || presentationStep === "detail" || presentationStep === "gap") {
      const reader = rootRef.current?.querySelector<HTMLElement>(".study-task-reader");
      if (reader) {
        if (typeof reader.scrollTo === "function") reader.scrollTo({ top: 0, behavior: reducedMotion ? "instant" : "smooth" });
        else reader.scrollTop = 0;
      }
    }
    if (presentationStep === "evidence" || presentationStep === "ending") {
      const reader = rootRef.current?.querySelector<HTMLElement>(".study-task-reader");
      const evidence = rootRef.current?.querySelector<HTMLElement>(".study-evidence");
      if (reader && evidence) {
        const readerBounds = reader.getBoundingClientRect();
        const evidenceBounds = evidence.getBoundingClientRect();
        const fullyVisible = evidenceBounds.top >= readerBounds.top + 67 && evidenceBounds.bottom <= readerBounds.bottom - 12;
        if (!fullyVisible) {
          const top = evidenceBounds.top - readerBounds.top + reader.scrollTop - 67;
          if (typeof reader.scrollTo === "function") reader.scrollTo({ top, behavior: reducedMotion ? "instant" : "smooth" });
          else reader.scrollTop = top;
        }
      }
    }
  }, [presentationStep, reducedMotion]);

  const selectTask = (task: TaskRecord) => {
    setSelectedId(task.id); setView("detail");
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>("[data-detail-heading]")?.focus({ preventScroll: true }));
  };
  const back = () => {
    setView("list");
    requestAnimationFrame(() => (rowRefs.current.get(selectedId) ?? searchRef.current)?.focus({ preventScroll: true }));
  };

  return <div className="study-native-panel" ref={rootRef} data-design-pane data-width={width} data-theme={theme} data-view={view}
    data-presentation-step={presentationStep} data-reduced-motion={reducedMotion ? "true" : "false"}
    onPointerDown={() => presentationStep !== "idle" && onPresentationInteraction?.()}
    onClickCapture={() => presentationStep !== "idle" && onPresentationInteraction?.()}
    onInputCapture={() => presentationStep !== "idle" && onPresentationInteraction?.()}
    onWheel={() => presentationStep !== "idle" && onPresentationInteraction?.()}
    onTouchStart={() => presentationStep !== "idle" && onPresentationInteraction?.()}>
    <div className="study-task-workspace" data-view={view} onKeyDown={event => {
      if (presentationStep !== "idle") onPresentationInteraction?.();
      const editing = event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']");
      if (event.key === "Escape" && view === "detail" && !event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229 && !editing) {
        event.preventDefault(); event.stopPropagation(); back();
      }
    }}>
      <section className="study-task-browser" aria-label="任务列表">
        <header className="study-list-context">
          <strong>全局任务</strong><span className="study-context-divider" /><span>归属见各任务</span>
          <span className={`study-source ${scenario === "stale" || scenario === "unavailable" || scenario === "not-configured" ? "study-source--stale" : ""}`}>{sourceLabel(scenario)}</span>
        </header>
        <div className="study-list-tools">
          <label className="study-search"><span className="study-sr-only">搜索任务、负责人或主机</span>
            <input ref={searchRef} type="search" placeholder="搜索任务、负责人…" value={query} onChange={event => setQuery(event.currentTarget.value)} />
          </label>
          <select aria-label="按状态筛选" value={filter} onChange={event => setFilter(event.currentTarget.value as TaskFilter)}>
            <option value="all">全部状态</option><option value="attention">需关注</option><option value="running">进行中</option><option value="claimed">已认领</option><option value="queued">稍后</option><option value="completed">已回报完成</option><option value="cancelled">已取消</option>
          </select>
        </div>
        {scenario === "stale" ? <p className="study-stale-notice">保留 27 分钟前的快照，当前状态尚未确认。</p> : null}
        {scenario === "unavailable" ? <p className="study-stale-notice"><span>读取失败 · 保留旧快照</span>{onRetrySource ? <button className="study-source-retry" onClick={onRetrySource} aria-label="重读演示来源">演示重读</button> : null}</p> : null}
        <div className="study-task-groups">
          {TASK_GROUPS.map(group => {
            const groupTasks = filtered.filter(task => (group.keys as readonly string[]).includes(taskState(task).key));
            if (!groupTasks.length) return null;
            return <section className={`study-task-group study-task-group--${group.id}`} key={group.id} aria-label={group.label}>
              <h2>{group.label}<span>{groupTasks.length}</span></h2>
              {groupTasks.map(task => <button key={task.id} ref={element => { if (element) rowRefs.current.set(task.id, element); else rowRefs.current.delete(task.id); }}
                className={`study-task-row ${selected?.id === task.id ? "is-selected" : ""}`} aria-current={selected?.id === task.id ? "true" : undefined} data-task-id={task.id}
                data-presentation-focus={presentationStep === "list" && selected?.id === task.id ? "task" : undefined}
                onClick={() => selectTask(task)}>
                <span className="study-task-titleline"><span className="study-task-title">{task.goal}</span><TaskStatus task={task} /></span>
                <span className="study-task-reason">{taskState(task).reason}</span>
                <span className="study-task-row-meta"><span>{task.agentTeamTask?.ownerName ?? task.agentTeamTask?.ownerId ?? "负责人未知"}</span><span>{taskTime(task)}</span></span>
              </button>)}
            </section>;
          })}
          {!filtered.length ? <div className="study-list-empty">
            <span className="study-empty-rule" />
            <h2>{scenario === "unavailable" ? "来源暂时不可用" : scenario === "not-configured" ? "任务来源尚未配置" : tasks.length ? "没有匹配的任务" : "当前来源中没有任务"}</h2>
            <p>{scenario === "unavailable" ? "演示来源读取失败，不能确认当前是否有任务。" : scenario === "not-configured" ? "尚未提供任务来源，不能解释为没有任务。" : tasks.length ? "试试其他关键词，或放宽状态筛选。" : "这是已提供的合法空集合。任务到达后会出现在这里。"}</p>
            {tasks.length ? <button onClick={() => { setQuery(""); setFilter("all"); }}>清除搜索与筛选</button> : null}
          </div> : null}
        </div>
        <footer className="study-list-footer"><span>{scenario === "unavailable" ? "任务当前状态不可确认" : scenario === "not-configured" ? "来源未配置" : `${tasks.length} 条任务记录`}</span><span>{scenario === "not-configured" ? "演示来源" : scenario === "unavailable" || scenario === "stale" ? "快照 09:15" : "快照 09:42"}</span></footer>
      </section>
      <div className="study-task-reader">
        {selected ? <TaskDetail key={selected.id} task={selected} onBack={back} scenario={scenario} presentationStep={presentationStep} /> : lastKnown.current || view === "detail" ? <article className="study-task-detail study-missing-detail" aria-label="任务详情">
          <DetailNavigation scenario={scenario} onBack={back} />
          <header className="study-detail-header"><span className="study-task-id">{lastKnown.current?.agentTeamTask?.taskId ?? selectedId}</span><h1 tabIndex={-1} data-detail-heading>任务记录当前不可见</h1></header>
          {lastKnown.current ? <p className="study-missing-title">{lastKnown.current.goal}</p> : null}
          <p className="study-missing-copy">当前来源无法提供这条记录，原选择身份仍保留。请返回列表确认当前可读的任务。</p>
        </article> : <div className="study-reader-empty"><span>任务详情</span><p>选择任务后，在这里阅读正文与证据。</p></div>}
      </div>
    </div>
  </div>;
}
