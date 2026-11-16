import { useEffect, useMemo, useRef, useState } from "react";
import type { ExecutionPreview, NodeRecord, TaskRecord } from "@dsh-fusion/core";
import {
  actionBlockLabel,
  cancelActionAvailability,
} from "../actions/action-availability.js";
import {
  CircleAlert,
  FileCheck2,
  List,
  ListFilter,
  Play,
  Search,
  Send,
  Server,
  Square,
  Timer,
  X,
} from "lucide-react";
import { TaskDetails } from "./TaskDetails.js";
import { DispatchPreview } from "./DispatchPreview.js";
import { TaskCanvas } from "./TaskCanvas.js";
import { TaskViewErrorBoundary } from "./TaskViewErrorBoundary.js";
import { taskStatusLabel } from "./task-model.js";
import { buildTaskTopology } from "./task-topology.js";
import {
  activateTaskViewRegistry,
  disposeTaskViewRegistry,
  installBuiltinTaskViews,
  useTaskViewDefinitions,
} from "./task-view-registry.js";
import { defaultTaskViews } from "./default-task-views.js";
import "./task-view-visuals.css";
import "./task-workspace.css";

type TaskFilter = "all" | "active" | "completed" | "attention";
type TaskSort = "updated-desc" | "updated-asc" | "created-desc";

// The workspace (App) can own this state so query, filters
// and the active view survive page switches; without an
// owner the component keeps it internally as before.
export interface TaskViewState {
  query: string;
  filter: TaskFilter;
  nodeFilter: string;
  sort: TaskSort;
  view: string;
}

export const defaultTaskViewState: TaskViewState = {
  query: "",
  filter: "all",
  nodeFilter: "all",
  sort: "updated-desc",
  view: "bridge",
};

installBuiltinTaskViews(defaultTaskViews);

const activeStatuses = new Set<TaskRecord["status"]>([
  "queued",
  "claimed",
  "running",
  "verifying",
]);

function formatTaskTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function matchesTaskFilter(task: TaskRecord, filter: TaskFilter): boolean {
  if (filter === "active") return activeStatuses.has(task.status);
  if (filter === "completed") return task.status === "completed";
  if (filter === "attention") return task.status === "failed" || task.status === "cancelled";
  return true;
}

function newDispatchIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `fusion-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function TaskWorkspace({
  tasks,
  nodes,
  connectionStale = false,
  allowExtensionActions = false,
  onCancel,
  onDispatch,
  onPreview,
  previewSourceKey = "",
  viewState: viewStateProp,
  onViewStateChange,
  selectedTaskId,
  onSelectTask,
  onCloseTask,
}: {
  tasks: TaskRecord[];
  nodes: NodeRecord[];
  connectionStale?: boolean;
  allowExtensionActions?: boolean;
  selectedTaskId?: string;
  onSelectTask?: (taskId: string) => void;
  onCloseTask?: () => void;
  onCancel?: (taskId: string) => void | Promise<void>;
  onDispatch?: (input: {
    goal: string;
    command: string;
    nodeIds: string[];
    idempotencyKey?: string | undefined;
  }) => Promise<TaskRecord | void>;
  onPreview?: (nodeIds: string[]) => Promise<ExecutionPreview>;
  previewSourceKey?: string;
  viewState?: TaskViewState;
  onViewStateChange?: (next: TaskViewState) => void;
}) {
  const [notice, setNotice] = useState<string>();
  // In-flight cancels are tracked per task: with a single
  // shared flag, starting a second cancel re-enabled the
  // first task's button mid-request, and the second request
  // settling cleared the first one's in-flight state.
  const [cancellingIds, setCancellingIds] = useState<ReadonlySet<string>>(new Set());
  const [localTaskId, setLocalTaskId] = useState<string | undefined>(selectedTaskId);
  const [closedTaskId, setClosedTaskId] = useState<string>();
  const [internalViewState, setInternalViewState] = useState<TaskViewState>(defaultTaskViewState);
  const viewState = viewStateProp ?? internalViewState;
  // Patches must compose within one event (clearFilters resets
  // three fields back to back), so they merge against the
  // latest value, not the render-time snapshot.
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const updateViewState = (patch: Partial<TaskViewState>) => {
    const next = { ...viewStateRef.current, ...patch };
    viewStateRef.current = next;
    if (onViewStateChange === undefined) setInternalViewState(next);
    else onViewStateChange(next);
  };
  const query = viewState.query;
  const setQuery = (value: string) => updateViewState({ query: value });
  const filter = viewState.filter;
  const setFilter = (value: TaskFilter) => updateViewState({ filter: value });
  const nodeFilter = viewState.nodeFilter;
  const setNodeFilter = (value: string) => updateViewState({ nodeFilter: value });
  const sort = viewState.sort;
  const setSort = (value: TaskSort) => updateViewState({ sort: value });
  const view = viewState.view;
  const setView = (value: string) => updateViewState({ view: value });
  const searchRef = useRef<HTMLInputElement>(null);
  const viewDefinitions = useTaskViewDefinitions();
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  useEffect(() => {
    const registry = activateTaskViewRegistry();
    return () => disposeTaskViewRegistry(registry);
  }, []);
  useEffect(() => { setLocalTaskId(selectedTaskId); setClosedTaskId(undefined); }, [selectedTaskId]);
  useEffect(() => {
    const focusSearch = () => searchRef.current?.focus();
    window.addEventListener("dsh-fusion:focus-search", focusSearch);
    return () => window.removeEventListener("dsh-fusion:focus-search", focusSearch);
  }, []);
  const selection = localTaskId;
  const activeTaskId = selection === closedTaskId ? undefined : selection;
  const selectedTask = activeTaskId === undefined ? undefined : tasksById.get(activeTaskId);
  const filterCounts = useMemo(() => ({
    all: tasks.length,
    active: tasks.filter((task) => matchesTaskFilter(task, "active")).length,
    completed: tasks.filter((task) => matchesTaskFilter(task, "completed")).length,
    attention: tasks.filter((task) => matchesTaskFilter(task, "attention")).length,
  }), [tasks]);
  const visibleTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const filtered = tasks.filter((task) => {
      if (!matchesTaskFilter(task, filter)) return false;
      if (nodeFilter !== "all" && !task.targetNodeIds.includes(nodeFilter)) return false;
      if (normalizedQuery === "") return true;
      const searchable = [
        task.id,
        task.goal,
        task.status,
        taskStatusLabel(task.status),
        ...task.targetNodeIds,
        ...task.targetNodeIds.map((id) => nodesById.get(id)?.name ?? ""),
      ].join(" ").toLocaleLowerCase();
      return searchable.includes(normalizedQuery);
    });
    return [...filtered].sort((left, right) => {
      const updated = left.updatedAt.localeCompare(right.updatedAt);
      const created = left.createdAt.localeCompare(right.createdAt);
      const compared = sort === "created-desc"
        ? created
        : sort === "updated-asc"
          ? updated
          : -updated;
      return compared === 0 ? left.id.localeCompare(right.id) : compared;
    });
  }, [filter, nodeFilter, nodesById, query, sort, tasks]);
  // Views receive a topology built from the visible (filtered) tasks,
  // never the full set: satellite/radial render from the topology, so
  // building it from all tasks would silently drop the active filter
  // when the user switches layouts. Totals live in filterCounts.
  const topology = useMemo(() => buildTaskTopology(visibleTasks, nodes), [nodes, visibleTasks]);
  // The inspector resolves the selected task from the full snapshot,
  // so it can show a task the active filter excludes from every view.
  // That state must be explicit, not a silent divergence.
  const selectedTaskFilteredOut = selectedTask !== undefined
    && !visibleTasks.some((task) => task.id === selectedTask.id);
  const clearFilters = () => {
    setQuery("");
    setFilter("all");
    setNodeFilter("all");
  };
  const activeView = (view === "list" || viewDefinitions.some((definition) => definition.id === view)) ? view : "bridge";
  const activeViewDefinition = viewDefinitions.find((definition) => definition.id === activeView);
  const ActiveTaskView = activeViewDefinition?.Component;
  const activeViewActions = new Set(activeViewDefinition?.actions ?? []);
  const onlineNodeCount = nodes.filter((node) => node.status === "online").length;
  const evidenceTaskCount = tasks.filter((task) => task.evidence.length > 0).length;
  const configAttentionCount = nodes.filter(
    (node) => node.status !== "offline" && node.configState !== "current",
  ).length;
  const selectTask = (id: string) => {
    setClosedTaskId(undefined);
    setLocalTaskId(id);
    onSelectTask?.(id);
  };
  const closeTask = () => {
    setClosedTaskId(activeTaskId);
    setLocalTaskId(undefined);
    onCloseTask?.();
  };
  const [composerOpen, setComposerOpen] = useState(false);
  const [dispatchIdempotencyKey, setDispatchIdempotencyKey] = useState<string>();
  const [goal, setGoal] = useState("");
  const [command, setCommand] = useState("uname -a; uptime");
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(() => {
    const firstOnline = nodes.find((node) => node.status === "online");
    return firstOnline === undefined ? [] : [firstOnline.id];
  });
  const nodeSelectionInitialized = useRef(selectedNodeIds.length > 0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    // Initialize a late first snapshot once; subsequent snapshots never edit intent.
    if (nodeSelectionInitialized.current) return;
    const firstOnline = nodes.find((node) => node.status === "online");
    if (firstOnline !== undefined) {
      nodeSelectionInitialized.current = true;
      setSelectedNodeIds([firstOnline.id]);
    }
  }, [nodes]);
  const unavailableNodeIds = selectedNodeIds.filter((id) => nodesById.get(id)?.status !== "online");
  const nodeSelectionError = unavailableNodeIds.length === 0 ? undefined
    : `所选节点不可用：${unavailableNodeIds.map((id) => {
      const node = nodesById.get(id);
      return node === undefined ? `${id}（当前快照未返回）` : `${node.name}（${node.status}）`;
    }).join("、")}。请等待恢复或取消勾选后重新选择。`;
  const composerNodes = [...nodes, ...selectedNodeIds.filter((id) => !nodesById.has(id)).map((id) => ({
    id, name: id, status: "offline" as const,
  }))];
  const dispatchBlocked = connectionStale || submitting || goal.trim() === "" || command.trim() === ""
    || selectedNodeIds.length === 0 || unavailableNodeIds.length > 0;
  const previewIntent = JSON.stringify([composerOpen, goal, command, selectedNodeIds, connectionStale, previewSourceKey,
    selectedNodeIds.map((id) => {
      const node = nodesById.get(id);
      return node === undefined ? [id, null] : [id, node.providerId, node.externalId, node.status,
        node.platform, node.transports, node.capabilities, node.dshVersion, node.unavailableReason];
    }),
  ]);
  const previewContext = useMemo(() => ({}), [previewIntent, onPreview]);
  const previewContextRef = useRef(previewContext);
  previewContextRef.current = previewContext;
  const previewMounted = useRef(false);
  const previewRequest = useRef(0);
  const [previewState, setPreviewState] = useState<{
    context: object;
    loading: boolean;
    preview?: ExecutionPreview;
    error?: string;
  }>();
  const currentPreview = previewState?.context === previewContext ? previewState : undefined;
  useEffect(() => {
    previewMounted.current = true;
    return () => { previewMounted.current = false; previewRequest.current += 1; };
  }, []);
  useEffect(() => {
    const preview = currentPreview?.preview;
    if (preview === undefined) return;
    // The host owns the diagnostic display window; stale rows retain their reasons.
    const expiresAt = preview.expiresAt;
    const timer = window.setTimeout(() => {
      if (previewMounted.current && previewContextRef.current === previewContext) {
        setPreviewState({ context: previewContext, loading: false, error: "检查结果已过期，请重新检查" });
      }
    }, Math.min(Math.max(0, expiresAt - Date.now()), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [currentPreview?.preview, previewContext]);
  const checkExecutionConditions = async () => {
    if (onPreview === undefined || connectionStale || selectedNodeIds.length === 0 || currentPreview?.loading) return;
    const request = ++previewRequest.current;
    const isCurrent = () => previewMounted.current && previewContextRef.current === previewContext
      && previewRequest.current === request;
    setPreviewState({ context: previewContext, loading: true });
    try {
      const preview = await onPreview([...selectedNodeIds]);
      if (!isCurrent()) return;
      if (!Number.isFinite(preview.expiresAt) || preview.expiresAt <= Date.now()) {
        throw new Error("检查结果已过期，请重新检查");
      }
      setPreviewState({ context: previewContext, loading: false, preview });
    } catch (previewError) {
      if (isCurrent()) setPreviewState({ context: previewContext, loading: false,
        error: previewError instanceof Error ? previewError.message : String(previewError) });
    }
  };

  return (
    <section className="fusion-page fusion-task-workspace">
      <div className="fusion-page-head">
        <div><h1>多机任务</h1><p>统一创建、派发和追踪跨机任务证据。</p></div>
        <div className="fusion-task-head-actions">
          <div className="fusion-task-view-tabs" role="tablist" aria-label="任务视图">
            {viewDefinitions.map(({ id, label, Icon }) => (
              <button
                type="button"
                role="tab"
                aria-selected={activeView === id}
                key={id}
                onClick={() => setView(id)}
              >
                {Icon === undefined ? null : <Icon size={14} />} {label}
              </button>
            ))}
            <button
              type="button"
              role="tab"
              aria-selected={activeView === "list"}
              onClick={() => setView("list")}
            >
              <List size={14} /> 列表
            </button>
          </div>
          <button
            type="button"
            className="fusion-primary-button"
            disabled={connectionStale}
            title={connectionStale ? "实时状态不可用，禁止创建新任务" : undefined}
            onClick={() => {
              if (!connectionStale) {
                setComposerOpen(true);
                setDispatchIdempotencyKey(newDispatchIdempotencyKey());
              }
            }}
          >
            <Play size={14} /> 新建任务
          </button>
        </div>
      </div>
      <div className="fusion-task-summary" aria-label="任务概览">
        <span><ListFilter size={16} /><strong>{tasks.length}</strong><small>任务</small></span>
        <span><Server size={16} /><strong>{onlineNodeCount}</strong><small>在线节点</small></span>
        <span><FileCheck2 size={16} /><strong>{evidenceTaskCount}</strong><small>已有证据</small></span>
        <span className={configAttentionCount > 0 ? "is-attention" : ""}>
          <CircleAlert size={16} /><strong>{configAttentionCount}</strong><small>配置待关注</small>
        </span>
      </div>
      {notice === undefined ? null : <p className="fusion-inline-notice">{notice}</p>}
      {composerOpen ? (
        <form
          className="fusion-task-composer"
          onSubmit={async (event) => {
            event.preventDefault();
            if (dispatchBlocked) return;
            if (onDispatch === undefined) {
              setNotice("当前视图未连接任务派发接口");
              return;
            }
            setSubmitting(true);
            setError(undefined);
            try {
              await onDispatch({
                goal: goal.trim(),
                command: command.trim(),
                nodeIds: selectedNodeIds,
                ...(dispatchIdempotencyKey === undefined ? {} : { idempotencyKey: dispatchIdempotencyKey }),
              });
              setGoal("");
              setComposerOpen(false);
              setNotice("任务已派发，证据返回后会更新任务记录");
            } catch (submitError) {
              setError(submitError instanceof Error ? submitError.message : String(submitError));
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <fieldset className="fusion-task-node-choices">
            <legend>目标节点</legend>
            {composerNodes.map((node) => (
              <label key={node.id}>
                <input
                  type="checkbox"
                  checked={selectedNodeIds.includes(node.id)}
                  disabled={node.status !== "online" && !selectedNodeIds.includes(node.id)}
                  onChange={(event) => {
                    nodeSelectionInitialized.current = true;
                    setSelectedNodeIds((current) => event.target.checked
                      ? [...new Set([...current, node.id])]
                      : current.filter((nodeId) => nodeId !== node.id)
                    );
                  }}
                />
                <span>{node.name}</span>
                <small>{node.status}</small>
              </label>
            ))}
          </fieldset>
          {nodeSelectionError === undefined ? null : <p className="fusion-config-error" role="alert">{nodeSelectionError}</p>}
          <label>
            <span>任务目标</span>
            <input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="例如：检查节点内核与负载" required />
          </label>
          <label className="is-command">
            <span>远程命令</span>
            <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="uname -a; uptime" required />
          </label>
          <div className="fusion-task-composer-actions">
            <button type="button" onClick={() => setComposerOpen(false)}><X size={13} /> 取消</button>
            <button type="submit" className="primary" disabled={dispatchBlocked}>
              <Send size={13} /> {submitting ? "派发中" : "派发"}
            </button>
          </div>
          <div className="fusion-task-preview-controls">
            <p>现阶段仅为只读诊断，不验证业务要求，也不决定手工派发准入。</p>
            {onPreview === undefined ? <p>当前环境未连接执行条件检查；可继续使用手工派发。</p> : null}
            <button type="button" onClick={() => { void checkExecutionConditions(); }}
              disabled={onPreview === undefined || connectionStale || selectedNodeIds.length === 0 || currentPreview?.loading === true}>
              {currentPreview?.loading ? "检查中…" : "检查执行条件"}
            </button>
            {currentPreview?.error === undefined ? null : <p role="alert">执行条件检查失败：{currentPreview.error}</p>}
            {currentPreview?.preview === undefined ? null : <DispatchPreview preview={currentPreview.preview} />}
          </div>
        </form>
      ) : null}
      {error === undefined ? null : <p className="fusion-config-error" role="alert">任务操作异常：{error}</p>}
      <div className="fusion-task-toolbar">
        <label className="fusion-task-search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            aria-label="搜索任务"
            value={query}
            placeholder="搜索任务、节点或 ID"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <div className="fusion-task-filter-tabs" role="tablist" aria-label="任务状态">
          {([
            ["all", "全部"],
            ["active", "进行中"],
            ["completed", "已完成"],
            ["attention", "异常"],
          ] as const).map(([value, label]) => (
            <button
              type="button"
              role="tab"
              aria-selected={filter === value}
              key={value}
              onClick={() => setFilter(value)}
            >
              {label} {filterCounts[value]}
            </button>
          ))}
        </div>
        <label className="fusion-task-select">
          <span>节点</span>
          <select
            aria-label="按节点筛选"
            value={nodeFilter}
            onChange={(event) => setNodeFilter(event.currentTarget.value)}
          >
            <option value="all">全部节点</option>
            {nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="fusion-task-select">
          <span>排序</span>
          <select
            aria-label="任务排序"
            value={sort}
            onChange={(event) => setSort(event.currentTarget.value as TaskSort)}
          >
            <option value="updated-desc">最近更新</option>
            <option value="updated-asc">最早更新</option>
            <option value="created-desc">最近创建</option>
          </select>
        </label>
      </div>
      <div className={"fusion-task-workbench" + (activeTaskId === undefined ? "" : " has-detail")}>
        <div className="fusion-task-list-pane">
          {visibleTasks.length === 0 ? (
            <div className="fusion-task-empty">
              <ListFilter size={22} aria-hidden="true" />
              <strong>{tasks.length === 0 ? "当前没有任务记录" : "没有符合筛选条件的任务"}</strong>
              <span>{tasks.length === 0 ? "新建任务后，执行状态与证据会出现在这里。" : "调整搜索词、状态或节点筛选。"}</span>
            </div>
          ) : activeView === "list" ? (
            <div className="fusion-task-table" role="table" aria-label="任务列表">
              <div className="fusion-task-table-row fusion-task-table-head" role="row">
                <span role="columnheader">任务</span>
                <span role="columnheader">节点</span>
                <span role="columnheader">状态</span>
                <span role="columnheader">进度</span>
                <span role="columnheader">更新时间</span>
                <span role="columnheader">操作</span>
              </div>
              {visibleTasks.map((item) => {
                const progress = item.progress;
                return (
                  <div
                    className={"fusion-task-table-row" + (activeTaskId === item.id ? " is-selected" : "")}
                    data-status={item.status}
                    role="row"
                    key={item.id}
                  >
                    <span className="fusion-task-cell-main" role="cell">
                      <button type="button" aria-label={`查看任务 ${item.id}`} aria-pressed={activeTaskId === item.id} onClick={() => selectTask(item.id)}>
                        <strong>{item.goal}</strong>
                        <small>#{item.id}</small>
                      </button>
                    </span>
                    <span className="fusion-task-cell-node" role="cell">
                      <i className="fusion-node-dot online" aria-hidden="true" />
                      {item.targetNodeIds.map((id) => nodesById.get(id)?.name ?? id).join("、") || "未报告节点"}
                    </span>
                    <span role="cell"><span className={"fusion-status " + item.status}>{taskStatusLabel(item.status)}</span></span>
                    <span className="fusion-progress" role="cell">
                      <span className="fusion-task-progress-track" aria-hidden="true">
                        <i style={{ width: `${progress ?? 0}%` }} />
                      </span>
                      <b>{progress === undefined ? "未报告" : `${progress}%`}</b>
                    </span>
                    <span className="fusion-task-cell-time" role="cell">
                      <Timer size={13} /> {formatTaskTime(item.updatedAt)}
                    </span>
                    <span className="fusion-task-cell-actions" role="cell">
                      {(() => {
                        const availability = cancelActionAvailability({
                          status: item.status,
                          hasHandler: onCancel !== undefined,
                          pending: cancellingIds.has(item.id),
                          stale: connectionStale,
                        });
                        return (
                          <button type="button" className="fusion-ghost-button" onClick={async () => {
                            if (!availability.allowed) return;
                            setError(undefined);
                            setCancellingIds((current) => new Set(current).add(item.id));
                            try {
                              await onCancel?.(item.id);
                            } catch (cancelError) {
                              setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
                            } finally {
                              setCancellingIds((current) => {
                                const next = new Set(current);
                                next.delete(item.id);
                                return next;
                              });
                            }
                          }} disabled={!availability.allowed} title={availability.allowed ? undefined : actionBlockLabel(availability.reason)}>
                            <Square size={13} /> 取消
                          </button>
                        );
                      })()}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : ActiveTaskView === undefined ? (
            <div className="fusion-task-empty">当前视图不可用</div>
          ) : (
            <TaskViewErrorBoundary
              key={activeView}
              extensionId={activeView}
              onReset={() => setView("list")}
            >
              <ActiveTaskView
                topology={topology}
                tasks={visibleTasks}
                nodes={nodes}
                {...(activeTaskId === undefined ? {} : { selectedTaskId: activeTaskId })}
                onSelectTask={selectTask}
                onDispatchTask={allowExtensionActions && activeViewActions.has("dispatch") ? onDispatch : undefined}
                onCancelTask={allowExtensionActions && activeViewActions.has("cancel") ? onCancel : undefined}
              />
            </TaskViewErrorBoundary>
          )}
        </div>
        {activeTaskId === undefined ? null : (
          <aside className="fusion-task-inspector" aria-label="任务详情检查器">
            {selectedTask === undefined ? (
              <section className="fusion-task-details" aria-label="任务详情">
                <header>
                  <div><h2>任务暂不可见</h2><code>{activeTaskId}</code></div>
                  <button type="button" aria-label="关闭任务详情" onClick={closeTask}><X size={16} /></button>
                </header>
                <p>当前快照未返回此任务，无法确认状态或证据。</p>
              </section>
            ) : (
              <>
                {selectedTaskFilteredOut ? (
                  <p className="fusion-task-filter-note" role="note">
                    当前筛选未包含此任务，详情仍按当前快照显示。
                    <button type="button" onClick={clearFilters}>清除筛选</button>
                  </p>
                ) : null}
                <TaskDetails task={selectedTask} tasks={tasks} nodes={nodes} onSelectTask={selectTask} onClose={closeTask} />
              </>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
