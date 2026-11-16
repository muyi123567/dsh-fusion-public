import { useMemo, useState } from "react";
import { Clock3, GitBranch, History, LayoutTemplate, RotateCcw } from "lucide-react";
import type {
  AgentFlowRecord,
  AgentTeamRecord,
  RoomRecord,
  TaskRecord,
} from "@dsh-fusion/core";
import { BridgeSources } from "../bridges/BridgeSources.js";
import type { FusionProviderStatusMap } from "../bridges/bridge-sources-model.js";
import { RunDag } from "./RunDag.js";
import type { DagRunViewInput } from "./run-view-model.js";
import { buildDependencyWaves, buildRunView } from "./run-view-model.js";
import "../tasks/task-details.css";

const demoRuns: DagRunViewInput[] = [
  {
    id: "run-20261020-01",
    specId: "release-check",
    status: "completed",
    order: [["plan"], ["build"], ["review"]],
    nodes: {
      plan: { nodeId: "plan", status: "completed", startedAt: "2026-10-20T04:20:00.000Z", finishedAt: "2026-10-20T04:20:08.000Z" },
      build: { nodeId: "build", status: "completed", dependsOn: ["plan"], startedAt: "2026-10-20T04:20:08.000Z", finishedAt: "2026-10-20T04:20:39.000Z" },
      review: { nodeId: "review", status: "completed", dependsOn: ["build"], startedAt: "2026-10-20T04:20:39.000Z", finishedAt: "2026-10-20T04:21:02.000Z" },
    },
    startedAt: "2026-10-20T04:20:00.000Z",
    finishedAt: "2026-10-20T04:21:02.000Z",
  },
  {
    id: "run-20261020-02",
    specId: "fleet-smoke",
    status: "running",
    order: [["prepare"], ["tencent", "oracle"], ["verify"]],
    nodes: {
      prepare: { nodeId: "prepare", status: "completed", startedAt: "2026-10-20T04:22:00.000Z", finishedAt: "2026-10-20T04:22:05.000Z" },
      tencent: { nodeId: "tencent", status: "running", dependsOn: ["prepare"], startedAt: "2026-10-20T04:22:05.000Z" },
      oracle: { nodeId: "oracle", status: "running", dependsOn: ["prepare"], startedAt: "2026-10-20T04:22:05.000Z" },
      verify: { nodeId: "verify", status: "pending", dependsOn: ["tencent", "oracle"] },
    },
    startedAt: "2026-10-20T04:22:00.000Z",
  },
];

function taskNodeStatus(task: TaskRecord): DagRunViewInput["nodes"][string]["status"] {
  if (task.status === "completed") return "completed";
  if (task.status === "failed") return "failed";
  if (task.status === "cancelled") return "skipped";
  if (task.status === "running" || task.status === "verifying") return "running";
  return "pending";
}

function buildFlowRuns(
  flows: readonly AgentFlowRecord[] | null | undefined,
  tasksById: ReadonlyMap<string, TaskRecord>,
): DagRunViewInput[] {
  return (flows ?? []).map((flow) => {
    const flowTasks = flow.taskIds.flatMap((taskId) => {
      const task = tasksById.get(taskId);
      return task === undefined ? [] : [task];
    });
    const flowTaskIds = new Set(flowTasks.map((task) => task.id));
    const missingTaskIds = flow.taskIds.filter((taskId) => !flowTaskIds.has(taskId));
    // Execution summary covers only what was observed: a
    // missing task must not relabel a known failure (or a
    // finished prefix) as "pending". Coverage is reported
    // separately via missingTaskIds, and a run with gaps
    // never counts as settled history.
    const status = flowTasks.length === 0
      ? "pending"
      : flowTasks.some((task) => task.status === "failed" || task.status === "cancelled")
        ? "failed"
        : flowTasks.every((task) => task.status === "completed")
          ? "completed"
          : "running";
    const startedAt = flowTasks.map((task) => task.createdAt).sort()[0] ?? new Date(0).toISOString();
    const finishedAt = status === "completed"
      ? flowTasks.map((task) => task.updatedAt).sort().at(-1)
      : undefined;
    return {
      id: flow.id,
      specId: flow.name,
      status,
      ...(missingTaskIds.length === 0 ? {} : { missingTaskIds }),
      order: buildDependencyWaves(flowTasks),
      nodes: Object.fromEntries(flowTasks.map((task) => [task.id, {
        nodeId: task.id,
        status: taskNodeStatus(task),
        ...(task.dependsOnTaskIds === undefined
          ? {}
          : { dependsOn: task.dependsOnTaskIds.filter((taskId) => flowTaskIds.has(taskId)) }),
        startedAt: task.createdAt,
        ...(task.status === "completed" || task.status === "failed" || task.status === "cancelled"
          ? { finishedAt: task.updatedAt }
          : {}),
        ...(task.error === undefined ? {} : { error: task.error }),
      }])),
      startedAt,
      ...(finishedAt === undefined ? {} : { finishedAt }),
    } satisfies DagRunViewInput;
  });
}

// The workspace (App) can own the tab and flow selection so
// leaving for a task and coming back restores the same view;
// without an owner they stay internal as before.
export interface RunViewState {
  tab: "running" | "history" | "templates";
  selectedRunId?: string;
}

export interface RunCenterProps {
  agentTeams?: readonly AgentTeamRecord[] | null;
  agentFlows?: readonly AgentFlowRecord[] | null;
  rooms?: readonly RoomRecord[] | null;
  providers?: FusionProviderStatusMap;
  allowDemo?: boolean;
  tasks?: readonly TaskRecord[];
  onOpenTask?: (taskId: string) => void;
  viewState?: RunViewState;
  onViewStateChange?: (next: RunViewState) => void;
}

export function RunCenter({
  agentTeams,
  agentFlows,
  rooms,
  providers,
  allowDemo,
  tasks = [],
  onOpenTask,
  viewState: viewStateProp,
  onViewStateChange,
}: RunCenterProps) {
  const [internalTab, setInternalTab] = useState<RunViewState["tab"]>("running");
  const tab = viewStateProp?.tab ?? internalTab;
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const flowsById = useMemo(() => new Map((agentFlows ?? []).map((flow) => [flow.id, flow])), [agentFlows]);
  const liveRuns = useMemo(() => buildFlowRuns(agentFlows, tasksById), [agentFlows, tasksById]);
  const runs = liveRuns.length > 0
    ? liveRuns
    : allowDemo === false
      ? []
      : demoRuns;
  const [internalSelectedRunId, setInternalSelectedRunId] = useState(runs[0]?.id ?? "");
  const selectedRunId = viewStateProp === undefined
    ? internalSelectedRunId
    : viewStateProp.selectedRunId ?? "";
  const setSelectedRunId = (runId: string) => {
    if (onViewStateChange === undefined) setInternalSelectedRunId(runId);
    else onViewStateChange({ tab, selectedRunId: runId });
  };
  const setTab = (nextTab: RunViewState["tab"]) => {
    if (onViewStateChange === undefined) setInternalTab(nextTab);
    else onViewStateChange({
      tab: nextTab,
      ...(selectedRunId === "" ? {} : { selectedRunId }),
    });
  };
  // History means settled AND fully observed; a run whose
  // coverage has gaps stays with the active classification
  // however its observed tasks ended.
  const visibleRuns = runs.filter((run) => {
    const settled = (run.status === "completed" || run.status === "failed")
      && (run.missingTaskIds?.length ?? 0) === 0;
    return tab === "history" ? settled : !settled;
  });
  // A selection whose run has vanished from the data
  // entirely is reported as unobserved below — the detail
  // never silently retargets to another run. A selection
  // that merely sits in the other classification keeps
  // the within-tab fallback: the detail never leaves the
  // current tab.
  const selectionUnobserved = selectedRunId !== ""
    && runs.length > 0
    && !runs.some((run) => run.id === selectedRunId);
  const selectedRun = selectionUnobserved
    ? undefined
    : visibleRuns.find((run) => run.id === selectedRunId) ?? visibleRuns[0];
  const selectedFlow = selectedRun === undefined ? undefined : flowsById.get(selectedRun.id);
  const missingTaskIds = selectedFlow?.taskIds.filter((id) => !tasksById.has(id)) ?? [];
  const templates = allowDemo === false
    ? (agentFlows ?? []).map((flow) => flow.name)
    : ["release-check", "fleet-smoke", "config-rollout"];

  return (
    <section className="fusion-page fusion-run-center">
      <div className="fusion-page-head">
        <div><h1>Run Center</h1><p>上游运行的只读投影：查看依赖、状态与任务证据；执行由上游管理。</p></div>
      </div>
      <BridgeSources
        {...(agentTeams === undefined ? {} : { agentTeams })}
        {...(agentFlows === undefined ? {} : { agentFlows })}
        {...(rooms === undefined ? {} : { rooms })}
        {...(providers === undefined ? {} : { providers })}
        {...(allowDemo === undefined ? {} : { allowDemo })}
      />
      <div className="fusion-run-tabs" role="tablist" aria-label="运行视图">
        <button type="button" role="tab" aria-selected={tab === "running"} onClick={() => setTab("running")}><GitBranch size={14} /> 运行中</button>
        <button type="button" role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}><History size={14} /> 历史</button>
        <button type="button" role="tab" aria-selected={tab === "templates"} onClick={() => setTab("templates")}><LayoutTemplate size={14} /> 模板</button>
      </div>
      {tab === "templates" ? (
        <div className="fusion-run-template-grid">
          {templates.map((template) => (
            <article key={template}>
              <LayoutTemplate size={17} />
              <div><strong>{template}</strong><small>{allowDemo === false ? "Agent Bus flow · 只读参考" : "演示模板 · 只读参考"}</small></div>
            </article>
          ))}
          {templates.length === 0 ? <div className="fusion-run-list-empty">当前没有可用的 Agent Bus flow 模板</div> : null}
        </div>
      ) : (
        <div className="fusion-run-layout">
          <div className="fusion-run-list" aria-label="运行列表">
            {visibleRuns.map((run) => (
              <button type="button" className={run.id === selectedRun?.id ? "is-selected" : ""} key={run.id} onClick={() => setSelectedRunId(run.id)}>
                <span className={`fusion-run-state ${run.status}`} />
                <div><strong>{run.specId}</strong><small>{run.id}</small></div>
                <span><Clock3 size={12} /> {run.status}</span>
                {(run.missingTaskIds?.length ?? 0) === 0 ? null : (
                  <span className="fusion-run-incomplete">结果不完整 · 缺失 {run.missingTaskIds?.length}</span>
                )}
              </button>
            ))}
            {visibleRuns.length === 0 ? (
              <div className="fusion-run-list-empty">当前没有运行记录</div>
            ) : null}
          </div>
          <div className="fusion-run-detail">
            {selectedRun === undefined ? (
              <div className="fusion-run-list-empty">{selectionUnobserved ? `所选运行当前未观测到（${selectedRunId}，可能已从上游移除）` : "当前分类没有可展示的运行"}</div>
            ) : (
              <>
                <div className="fusion-run-detail-head">
                  <div><strong>{selectedRun.specId}</strong><small>{selectedRun.id}</small></div>
                  <button
                    type="button"
                    disabled
                    title="只读视图，当前未连接运行重跑适配器"
                  >
                    <RotateCcw size={13} /> 重跑
                  </button>
                </div>
                <RunDag nodes={buildRunView(selectedRun)} />
                {missingTaskIds.length === 0 ? null : <p className="fusion-inline-notice">部分任务未观测（{missingTaskIds.length} 个），无法确认完整运行状态。</p>}
                <nav className="fusion-run-task-links" aria-label="DAG 任务详情">
                  {(flowsById.get(selectedRun.id)?.taskIds ?? []).map((taskId) => (
                    <button type="button" key={taskId} aria-label={`查看任务 ${taskId}`} disabled={onOpenTask === undefined} title={onOpenTask === undefined ? "当前视图未连接任务详情导航" : undefined} onClick={() => {
                      // Leaving for a task freezes the run the
                      // user is actually looking at: with only
                      // an implicit (first-item) selection, a
                      // re-sort while away would silently
                      // retarget the detail on return. An
                      // explicit selection is already recorded;
                      // only the implicit one needs pinning.
                      if (selectedRunId === "" && selectedRun !== undefined) {
                        setSelectedRunId(selectedRun.id);
                      }
                      onOpenTask?.(taskId);
                    }}>
                      {tasksById.get(taskId)?.goal ?? taskId}{tasksById.has(taskId) ? " · 任务详情" : " · 未观测"}
                    </button>
                  ))}
                </nav>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
