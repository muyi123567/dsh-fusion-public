import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionPreview, NodeRecord, TaskRecord } from "@dsh-fusion/core";
import { buildExecutionPreview } from "@dsh-fusion/core";
import { registerTaskView, unregisterTaskView, type FusionTaskViewProps } from "./task-view-registry.js";
import {
  TaskWorkspace,
  defaultTaskViewState,
  type TaskViewState,
} from "./TaskWorkspace.js";

function executionPreview(): ExecutionPreview {
  return { version: 1, checkedAt: Date.now(), expiresAt: Date.now() + 30_000,
    selectedNodeIds: [node.id, secondNode.id], ready: false, scope: "infrastructure-only", businessRequirements: "unverified",
    nodes: [{ nodeId: node.id, name: node.name, decision: "eligible", reasonCodes: [], observation: {
      nodeId: node.id, providerId: node.providerId, state: "supported", checkedAt: Date.now(), expiresAt: Date.now() + 30_000,
      source: "fixture", reasonCodes: [], checks: [{ id: "job-infrastructure", ok: true }],
    } },
      { nodeId: secondNode.id, name: secondNode.name, decision: "unknown", reasonCodes: ["OBSERVATION_MISSING"] }] };
}

const node: NodeRecord = {
  id: "huawei-hs-monitor-cn",
  externalId: "root@example-huawei",
  providerId: "huawei-ssh",
  name: "华为云 hs-monitor-cn",
  platform: "linux",
  roles: ["worker"],
  status: "online",
  transports: ["ssh"],
  capabilities: ["linux", "ssh"],
  configState: "unknown",
};

const secondNode: NodeRecord = {
  ...node,
  id: "instabox-test",
  externalId: "instabox-test",
  providerId: "instabox",
  name: "Instabox test",
  transports: ["dsh-fleet"],
};

const task: TaskRecord = {
  id: "HUAWEI-task-1",
  goal: "检查节点",
  targetNodeIds: [node.id],
  transport: "ssh",
  status: "running",
  evidence: [],
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
};

describe("TaskWorkspace", () => {
  it("explicitly previews mixed conditions without dispatching or requiring user commands", async () => {
    const onPreview = vi.fn(async () => executionPreview());
    const onDispatch = vi.fn(async () => task);
    render(<TaskWorkspace tasks={[]} nodes={[node, secondNode]} onPreview={onPreview} onDispatch={onDispatch} />);
    expect(onPreview).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Instabox test/ }));
    await userEvent.clear(screen.getByLabelText("远程命令"));
    await userEvent.click(screen.getByRole("button", { name: "检查执行条件" }));
    expect(onPreview).toHaveBeenCalledExactlyOnceWith([node.id, secondNode.id]);
    expect(await screen.findByRole("region", { name: "执行基础检查预览" })).toHaveTextContent("基础检查未知");
    expect(screen.getByRole("region", { name: "执行基础检查预览" })).toHaveTextContent("基础检查可用");
    expect(screen.getByText(/现阶段仅为只读诊断/)).toBeInTheDocument();
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it.each(["selection", "goal", "command", "node status", "node source", "node error", "source generation"] as const)("ignores late preview after changing %s and permits a fresh check", async (change) => {
    let resolve!: (result: ExecutionPreview) => void;
    const onPreview = vi.fn().mockReturnValueOnce(new Promise<ExecutionPreview>((yes) => { resolve = yes; }))
      .mockResolvedValueOnce(executionPreview());
    const { rerender } = render(<TaskWorkspace tasks={[]} nodes={[node, secondNode]} onPreview={onPreview} previewSourceKey="1" />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.click(screen.getByRole("button", { name: "检查执行条件" }));
    expect(screen.getByRole("button", { name: "检查中…" })).toBeDisabled();
    if (change === "selection") await userEvent.click(screen.getByRole("checkbox", { name: /Instabox test/ }));
    else if (change === "goal") await userEvent.type(screen.getByLabelText("任务目标"), "新目标");
    else if (change === "command") await userEvent.type(screen.getByLabelText("远程命令"), " changed");
    else rerender(<TaskWorkspace tasks={[]} nodes={[{ ...node,
      ...(change === "node status" ? { status: "offline" as const } : {}),
      ...(change === "node source" ? { providerId: "new-source" } : {}),
      ...(change === "node error" ? { unavailableReason: "source disconnected" } : {}),
    }, secondNode]} onPreview={onPreview} previewSourceKey={change === "source generation" ? "2" : "1"} />);
    await act(async () => { resolve(executionPreview()); });
    expect(screen.queryByRole("region", { name: "执行基础检查预览" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查执行条件" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "检查执行条件" }));
    expect(await screen.findByRole("region", { name: "执行基础检查预览" })).toBeInTheDocument();
  });

  it("retains a real diagnostic while healthy heartbeats advance", async () => {
    const onPreview = vi.fn(async () => executionPreview());
    const { rerender } = render(<TaskWorkspace tasks={[]} nodes={[node, secondNode]} onPreview={onPreview} />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.click(screen.getByRole("button", { name: "检查执行条件" }));
    await screen.findByRole("region", { name: "执行基础检查预览" });
    rerender(<TaskWorkspace tasks={[]} nodes={[{ ...node, lastHeartbeat: "2026-10-30T00:00:01Z" }, secondNode]} onPreview={onPreview} />);
    expect(screen.getByRole("region", { name: "执行基础检查预览" })).toBeInTheDocument();
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("expires a displayed preview and invalidates it when input changes", async () => {
    const onPreview = vi.fn(async () => executionPreview());
    render(<TaskWorkspace tasks={[]} nodes={[node, secondNode]} onPreview={onPreview} />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.click(screen.getByRole("button", { name: "检查执行条件" }));
    expect(await screen.findByRole("region", { name: "执行基础检查预览" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("任务目标"), "新意图");
    expect(screen.queryByRole("region", { name: "执行基础检查预览" })).not.toBeInTheDocument();
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "检查执行条件" })); });
      expect(screen.getByRole("region", { name: "执行基础检查预览" })).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(30_001); });
      expect(screen.queryByRole("region", { name: "执行基础检查预览" })).not.toBeInTheDocument();
      expect(screen.getByText(/检查结果已过期/)).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it("keeps a new result when an older request completes after restoring the original input", async () => {
    let resolveOld!: (preview: ExecutionPreview) => void;
    const latest = executionPreview();
    latest.nodes[1]!.reasonCodes = ["NEW_RESULT"];
    const onPreview = vi.fn().mockReturnValueOnce(new Promise<ExecutionPreview>((yes) => { resolveOld = yes; }))
      .mockResolvedValueOnce(latest);
    render(<TaskWorkspace tasks={[]} nodes={[node, secondNode]} onPreview={onPreview} />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.click(screen.getByRole("button", { name: "检查执行条件" }));
    await userEvent.type(screen.getByLabelText("任务目标"), "临时改变");
    await userEvent.clear(screen.getByLabelText("任务目标"));
    await userEvent.click(screen.getByRole("button", { name: "检查执行条件" }));
    expect(await screen.findByRole("region", { name: "执行基础检查预览" })).toHaveTextContent("NEW_RESULT");
    const old = executionPreview();
    old.nodes[1]!.reasonCodes = ["OLD_RESULT"];
    await act(async () => { resolveOld(old); });
    expect(screen.getByRole("region", { name: "执行基础检查预览" })).toHaveTextContent("NEW_RESULT");
    expect(screen.queryByText(/OLD_RESULT/)).not.toBeInTheDocument();
  });

  it("keeps negative diagnostics with expired observations until the top-level preview expires", async () => {
    vi.useFakeTimers();
    try {
      const preview = buildExecutionPreview({ nodes: [node, secondNode], nodeIds: [node.id, secondNode.id], now: Date.now(),
        observations: [executionPreview().nodes[0]!.observation!, {
          nodeId: secondNode.id, providerId: secondNode.providerId, state: "supported", source: "old-probe",
          checkedAt: Date.now() - 31_000, expiresAt: Date.now() - 1_000, reasonCodes: [], checks: [{ id: "job-infrastructure", ok: true }],
        }],
      });
      const onDispatch = vi.fn(async () => task);
      render(<TaskWorkspace tasks={[]} nodes={[node, secondNode]} onPreview={async () => preview} onDispatch={onDispatch} />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "新建任务" })); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "检查执行条件" })); });
      await act(async () => { vi.advanceTimersByTime(1); });
      const region = screen.getByRole("region", { name: "执行基础检查预览" });
      expect(region).toHaveTextContent("OBSERVATION_EXPIRED");
      expect(within(region).getByRole("article", { name: secondNode.name })).toHaveAttribute("data-decision", "unknown");
      await act(async () => { vi.advanceTimersByTime(29_998); });
      expect(screen.getByRole("region", { name: "执行基础检查预览" })).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(screen.queryByRole("region", { name: "执行基础检查预览" })).not.toBeInTheDocument();
      expect(screen.getByText(/检查结果已过期/)).toBeInTheDocument();
      expect(onDispatch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("shows preview failure, allows retry, and does not gate manual dispatch on ready", async () => {
    const onPreview = vi.fn().mockRejectedValueOnce(new Error("HTTP 503"))
      .mockResolvedValueOnce(executionPreview());
    const onDispatch = vi.fn(async () => task);
    render(<TaskWorkspace tasks={[]} nodes={[node, secondNode]} onPreview={onPreview} onDispatch={onDispatch} />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.type(screen.getByLabelText("任务目标"), "手工任务");
    await userEvent.click(screen.getByRole("button", { name: "检查执行条件" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 503");
    await userEvent.click(screen.getByRole("button", { name: "检查执行条件" }));
    await screen.findByRole("region", { name: "执行基础检查预览" });
    expect(screen.queryByText(/HTTP 503/)).not.toBeInTheDocument();
    expect(onDispatch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "派发" }));
    expect(onDispatch).toHaveBeenCalledOnce();
  });

  it("degrades honestly without preview callback and ignores preview after unmount", async () => {
    const first = render(<TaskWorkspace tasks={[]} nodes={[node]} />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    expect(screen.getByRole("button", { name: "检查执行条件" })).toBeDisabled();
    expect(screen.getByText(/当前环境未连接执行条件检查/)).toBeInTheDocument();
    first.unmount();
    let resolve!: (result: ExecutionPreview) => void;
    const second = render(<TaskWorkspace tasks={[]} nodes={[node]} onPreview={() => new Promise((yes) => { resolve = yes; })} />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.click(screen.getByRole("button", { name: "检查执行条件" }));
    second.unmount();
    await act(async () => { resolve(executionPreview()); });
    expect(screen.queryByRole("region", { name: "执行基础检查预览" })).not.toBeInTheDocument();
  });

  it("keeps query and filter across unmounts when the workspace owns the view state", async () => {
    function Harness() {
      const [viewState, setViewState] = useState<TaskViewState>(defaultTaskViewState);
      const [show, setShow] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShow((current) => !current)}>切换页面</button>
          {show ? (
            <TaskWorkspace tasks={[task]} nodes={[node]} viewState={viewState} onViewStateChange={setViewState} />
          ) : null}
        </>
      );
    }
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("搜索任务"), "不存在的任务");
    await userEvent.click(screen.getByRole("tab", { name: /异常/ }));
    expect(screen.getByText("没有符合筛选条件的任务")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "切换页面" }));
    await userEvent.click(screen.getByRole("button", { name: "切换页面" }));
    expect(screen.getByLabelText("搜索任务")).toHaveValue("不存在的任务");
    expect(screen.getByRole("tab", { name: /异常/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("没有符合筛选条件的任务")).toBeInTheDocument();
  });

  it("disables list cancel when the snapshot is stale, unwired, or already in flight", async () => {
    const stale = render(<TaskWorkspace tasks={[task]} nodes={[node]} onCancel={async () => {}} connectionStale />);
    await userEvent.click(screen.getByRole("tab", { name: "列表" }));
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    stale.unmount();

    const unwired = render(<TaskWorkspace tasks={[task]} nodes={[node]} />);
    await userEvent.click(screen.getByRole("tab", { name: "列表" }));
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    unwired.unmount();

    let release!: () => void;
    const onCancel = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    render(<TaskWorkspace tasks={[task]} nodes={[node]} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("tab", { name: "列表" }));
    const button = screen.getByRole("button", { name: "取消" });
    await userEvent.click(button);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    await act(async () => { release(); });
    expect(button).not.toBeDisabled();
  });

  it("does not offer cancel for a failed task", async () => {
    const failedTask: TaskRecord = { ...task, status: "failed" };
    render(<TaskWorkspace tasks={[failedTask]} nodes={[node]} onCancel={async () => {}} />);
    await userEvent.click(screen.getByRole("tab", { name: "列表" }));
    const button = screen.getByRole("button", { name: "取消" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "任务已结束");
  });

  it("tracks concurrent cancels per task so one settling never re-enables another", async () => {
    const taskA: TaskRecord = { ...task, id: "HUAWEI-task-a", goal: "任务甲" };
    const taskB: TaskRecord = { ...task, id: "HUAWEI-task-b", goal: "任务乙" };
    const releases = new Map<string, () => void>();
    const onCancel = vi.fn((taskId: string) => new Promise<void>((resolve) => {
      releases.set(taskId, resolve);
    }));
    render(<TaskWorkspace tasks={[taskA, taskB]} nodes={[node]} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("tab", { name: "列表" }));
    const cancelInRow = (goal: string) => {
      const row = screen.getByText(goal).closest('[role="row"]');
      if (row === null) throw new Error(`row missing for ${goal}`);
      return within(row as HTMLElement).getByRole("button", { name: "取消" });
    };
    const buttonA = cancelInRow("任务甲");
    const buttonB = cancelInRow("任务乙");
    await userEvent.click(buttonA);
    await userEvent.click(buttonB);
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(buttonA).toBeDisabled();
    expect(buttonB).toBeDisabled();
    // B settles first (out of order): its own button
    // re-enables, A's request is still in flight and its
    // button must stay disabled.
    await act(async () => { releases.get("HUAWEI-task-b")?.(); });
    expect(buttonB).not.toBeDisabled();
    expect(buttonA).toBeDisabled();
    await act(async () => { releases.get("HUAWEI-task-a")?.(); });
    expect(buttonA).not.toBeDisabled();
  });

  it("does not mislabel an action refresh error as a dispatch failure", async () => {
    render(<TaskWorkspace tasks={[task]} nodes={[node]} onCancel={async () => { throw new Error("快照刷新失败：HTTP 503"); }} />);
    await userEvent.click(screen.getByRole("tab", { name: "列表" }));
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("alert")).toHaveTextContent("任务操作异常：快照刷新失败：HTTP 503");
  });

  it("opens ordinary browser task output and keeps the selection fresh across snapshots", async () => {
    const onSelectTask = vi.fn();
    const observed: TaskRecord = { ...task, sessionId: "session-exact", evidence: [
      { kind: "command", label: "job:stdout", value: "Linux\nworker ready" },
      { kind: "log", label: "job:stderr", value: "warning: partial" },
    ] };
    const { rerender } = render(<TaskWorkspace tasks={[observed]} nodes={[node]} onSelectTask={onSelectTask} />);
    await userEvent.click(screen.getByRole("button", { name: `查看任务 ${task.id}` }));
    expect(onSelectTask).toHaveBeenCalledWith(task.id);
    const details = screen.getByRole("region", { name: "任务详情" });
    expect(within(details).getByText("Linux worker ready")).toHaveProperty("textContent", "Linux\nworker ready");
    expect(within(details).getByText("warning: partial")).toBeInTheDocument();
    expect(within(details).getByText("session-exact")).toBeInTheDocument();
    expect(within(details).getByText("huawei-ssh")).toBeInTheDocument();
    rerender(<TaskWorkspace tasks={[{ ...observed, status: "failed", error: "remote job lost" }]} nodes={[node]} onSelectTask={onSelectTask} />);
    expect(within(details).getByText("remote job lost")).toBeInTheDocument();
    expect(within(details).getByText("失败")).toBeInTheDocument();
  });

  it("honors external selection and reports missing selected tasks without stale details", () => {
    const { rerender } = render(<TaskWorkspace tasks={[task]} nodes={[node]} selectedTaskId={task.id} />);
    expect(screen.getByRole("region", { name: "任务详情" })).toBeInTheDocument();
    rerender(<TaskWorkspace tasks={[]} nodes={[node]} selectedTaskId={task.id} />);
    expect(screen.getByText("当前快照未返回此任务，无法确认状态或证据。")).toBeInTheDocument();
    expect(screen.queryByText("检查节点")).not.toBeInTheDocument();
  });

  it("switches an external selection after an earlier selection was closed", async () => {
    const second = { ...task, id: "second-task", goal: "Second execution" };
    const { rerender } = render(<TaskWorkspace tasks={[task, second]} nodes={[node]} selectedTaskId={task.id} />);
    await userEvent.click(screen.getByRole("button", { name: "关闭任务详情" }));
    expect(screen.queryByRole("region", { name: "任务详情" })).not.toBeInTheDocument();
    rerender(<TaskWorkspace tasks={[task, second]} nodes={[node]} selectedTaskId={second.id} />);
    expect(screen.getByRole("region", { name: "任务详情" })).toHaveTextContent(second.goal);
  });

  it.each(["details", "evidence", "missing"])("notifies the selection owner when closing %s", async (view) => {
    const onCloseTask = vi.fn();
    render(<TaskWorkspace tasks={view === "missing" ? [] : [task]} nodes={[node]} selectedTaskId={task.id} onCloseTask={onCloseTask} />);
    await userEvent.click(screen.getByRole("button", { name: view === "evidence" ? "关闭任务证据" : "关闭任务详情" }));
    expect(onCloseTask).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "任务详情" })).not.toBeInTheDocument();
  });

  it("shows cancellation, empty evidence and child references without inventing child state", async () => {
    const aggregate: TaskRecord = { ...task, status: "cancelled", error: "cancelled by owner", childTaskRefs: [
      { id: "observed-child", targetNodeIds: [node.id], status: "failed" },
      { id: "unobserved-child", targetNodeIds: ["unknown-node"] },
    ] };
    render(<TaskWorkspace tasks={[aggregate]} nodes={[node]} selectedTaskId={task.id} />);
    const details = screen.getByRole("region", { name: "任务详情" });
    expect(within(details).getByText("已取消")).toBeInTheDocument();
    expect(within(details).getByText("cancelled by owner")).toBeInTheDocument();
    expect(within(details).getByText("暂无任务证据，无法查看 stdout/stderr。")).toBeInTheDocument();
    expect(within(details).getByText("失败")).toBeInTheDocument();
    expect(within(details).getByText("未观测")).toBeInTheDocument();
    await userEvent.click(within(details).getByRole("button", { name: "查看子任务 unobserved-child" }));
    expect(screen.getByText("当前快照未返回此任务，无法确认状态或证据。")).toBeInTheDocument();
  });

  it("uses the actual child record when an aggregate reference is stale", async () => {
    const child = { ...task, id: "child", status: "failed" as const, error: "child failed", evidence: [{ kind: "log" as const, label: "child:stderr", value: "child process error" }] };
    render(<TaskWorkspace tasks={[{ ...task, childTaskRefs: [{ id: child.id, targetNodeIds: [node.id], status: "running" }] }, child]} nodes={[node]} selectedTaskId={task.id} />);
    const details = screen.getByRole("region", { name: "任务详情" });
    expect(within(details).getByText("失败")).toBeInTheDocument();
    expect(within(details).getByText("child failed")).toBeInTheDocument();
    await userEvent.click(within(details).getByRole("button", { name: "查看子任务 child" }));
    expect(screen.getByRole("region", { name: "任务详情" })).toHaveTextContent("child process error");
  });

  it("dispatches a real task through the configured node", async () => {
    const onDispatch = vi.fn(async () => task);
    render(
      <TaskWorkspace
        tasks={[]}
        nodes={[node, secondNode]}
        onDispatch={onDispatch}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.type(screen.getByLabelText("任务目标"), "检查内核");
    await userEvent.click(screen.getByRole("checkbox", { name: /Instabox test/ }));
    const command = screen.getByLabelText("远程命令");
    await userEvent.clear(command);
    await userEvent.type(command, "uname -r");
    await userEvent.click(screen.getByRole("button", { name: "派发" }));

    expect(onDispatch).toHaveBeenCalledWith({
      goal: "检查内核",
      command: "uname -r",
      nodeIds: [node.id, secondNode.id],
      idempotencyKey: expect.any(String),
    });
  });

  it.each([
    { label: "selected node offline while the other stays online", bothSelected: false, nextNodes: [{ ...node, status: "offline" as const }, secondNode] },
    { label: "one of two selected nodes offline", bothSelected: true, nextNodes: [{ ...node, status: "offline" as const }, secondNode] },
    { label: "both selected nodes offline", bothSelected: true, nextNodes: [{ ...node, status: "offline" as const }, { ...secondNode, status: "offline" as const }] },
    { label: "selected node missing from snapshot", bothSelected: false, nextNodes: [secondNode] },
  ])("preserves explicit targets and blocks dispatch with $label", async ({ bothSelected, nextNodes }) => {
    const onDispatch = vi.fn(async () => task);
    const { rerender } = render(<TaskWorkspace tasks={[]} nodes={[node, secondNode]} onDispatch={onDispatch} />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    // Make A an explicit selection, rather than relying on the initial default.
    await userEvent.click(screen.getByRole("checkbox", { name: /华为云/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /华为云/ }));
    if (bothSelected) await userEvent.click(screen.getByRole("checkbox", { name: /Instabox test/ }));
    await userEvent.type(screen.getByLabelText("任务目标"), "保持目标范围");
    rerender(<TaskWorkspace tasks={[]} nodes={nextNodes} onDispatch={onDispatch} />);

    const submit = screen.getByRole("button", { name: "派发" });
    await userEvent.click(submit);
    // A submit event must also be rejected if it bypasses the disabled button.
    fireEvent.submit(submit.closest("form")!);
    expect(onDispatch).not.toHaveBeenCalled();
    expect(submit).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/所选节点不可用/);
    expect(screen.getByRole("alert")).toHaveTextContent(nextNodes.some((item) => item.id === node.id) ? node.name : node.id);
    if (nextNodes.some((item) => item.id === node.id)) {
      expect(screen.getByRole("checkbox", { name: /华为云/ })).toBeChecked();
    }
    expect(screen.getByRole("checkbox", { name: /Instabox test/ }).matches(":checked")).toBe(bothSelected);
  });

  it.each(["unchanged", "other offline", "reordered"] as const)("dispatches only explicit targets after %s snapshot", async (change) => {
    const onDispatch = vi.fn(async () => task);
    const { rerender } = render(<TaskWorkspace tasks={[]} nodes={[node, secondNode]} onDispatch={onDispatch} />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /华为云/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /华为云/ }));
    await userEvent.type(screen.getByLabelText("任务目标"), "只派发 A");
    const nextNodes = change === "other offline" ? [node, { ...secondNode, status: "offline" as const }]
      : change === "reordered" ? [{ ...secondNode }, { ...node }] : [{ ...node }, { ...secondNode }];
    rerender(<TaskWorkspace tasks={[]} nodes={nextNodes} onDispatch={onDispatch} />);
    await userEvent.click(screen.getByRole("button", { name: "派发" }));
    expect(onDispatch).toHaveBeenCalledOnce();
    expect(onDispatch).toHaveBeenCalledWith(expect.objectContaining({ nodeIds: [node.id] }));
  });

  it("does not repopulate an explicitly empty selection on refresh", async () => {
    const onDispatch = vi.fn(async () => task);
    const { rerender } = render(<TaskWorkspace tasks={[]} nodes={[node, secondNode]} onDispatch={onDispatch} />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.type(screen.getByLabelText("任务目标"), "暂不派发");
    await userEvent.click(screen.getByRole("checkbox", { name: /华为云/ }));
    rerender(<TaskWorkspace tasks={[]} nodes={[{ ...node }, { ...secondNode }]} onDispatch={onDispatch} />);
    expect(screen.getByRole("checkbox", { name: /华为云/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Instabox test/ })).not.toBeChecked();
    const submit = screen.getByRole("button", { name: "派发" });
    expect(submit).toBeDisabled();
    fireEvent.submit(submit.closest("form")!);
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it("initializes a late default once and never replaces it when it goes offline", async () => {
    const onDispatch = vi.fn(async () => task);
    const { rerender } = render(<TaskWorkspace tasks={[]} nodes={[]} onDispatch={onDispatch} />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.type(screen.getByLabelText("任务目标"), "等待首次节点");
    expect(screen.getByRole("button", { name: "派发" })).toBeDisabled();
    rerender(<TaskWorkspace tasks={[]} nodes={[node, secondNode]} onDispatch={onDispatch} />);
    expect(screen.getByRole("checkbox", { name: /华为云/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "派发" })).toBeEnabled();
    rerender(<TaskWorkspace tasks={[]} nodes={[{ ...node, status: "offline" }, secondNode]} onDispatch={onDispatch} />);
    expect(screen.getByRole("checkbox", { name: /华为云/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Instabox test/ })).not.toBeChecked();
    const submit = screen.getByRole("button", { name: "派发" });
    expect(submit).toBeDisabled();
    fireEvent.submit(submit.closest("form")!);
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it("restores dispatch to the same targets when selected nodes return online", async () => {
    const onDispatch = vi.fn(async () => task);
    const { rerender } = render(<TaskWorkspace tasks={[]} nodes={[node, secondNode]} onDispatch={onDispatch} />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.type(screen.getByLabelText("任务目标"), "等待原目标恢复");
    await userEvent.click(screen.getByRole("checkbox", { name: /Instabox test/ }));
    rerender(<TaskWorkspace tasks={[]} nodes={[{ ...node, status: "offline" }, { ...secondNode, status: "offline" }]} onDispatch={onDispatch} />);
    expect(screen.getByRole("button", { name: "派发" })).toBeDisabled();
    rerender(<TaskWorkspace tasks={[]} nodes={[node, secondNode]} onDispatch={onDispatch} />);
    expect(screen.queryByText(/所选节点不可用/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "派发" }));
    expect(onDispatch).toHaveBeenCalledOnce();
    expect(onDispatch).toHaveBeenCalledWith(expect.objectContaining({ nodeIds: [node.id, secondNode.id] }));
  });

  it.each(["offline", "missing"] as const)("allows explicit replacement of an unavailable %s target", async (state) => {
    const onDispatch = vi.fn(async () => task);
    const { rerender } = render(<TaskWorkspace tasks={[]} nodes={[node, secondNode]} onDispatch={onDispatch} />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.type(screen.getByLabelText("任务目标"), "明确改选 B");
    rerender(<TaskWorkspace tasks={[]} nodes={state === "missing" ? [secondNode] : [{ ...node, status: "offline" }, secondNode]} onDispatch={onDispatch} />);
    expect(screen.getByRole("button", { name: "派发" })).toBeDisabled();
    const selected = screen.getAllByRole("checkbox").find((checkbox) => (checkbox as HTMLInputElement).checked)!;
    await userEvent.click(selected);
    await userEvent.click(screen.getByRole("checkbox", { name: /Instabox test/ }));
    expect(screen.queryByText(/所选节点不可用/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "派发" }));
    expect(onDispatch).toHaveBeenCalledOnce();
    expect(onDispatch).toHaveBeenCalledWith(expect.objectContaining({ nodeIds: [secondNode.id] }));
  });

  it("reuses the composer idempotency key when a failed dispatch is retried", async () => {
    const onDispatch = vi.fn<(input: { idempotencyKey?: string | undefined }) => Promise<TaskRecord>>()
      .mockRejectedValueOnce(new Error("temporary dispatch failure"))
      .mockResolvedValueOnce(task);
    render(
      <TaskWorkspace tasks={[]} nodes={[node]} onDispatch={onDispatch} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await userEvent.type(screen.getByLabelText("任务目标"), "重试安全");
    await userEvent.click(screen.getByRole("button", { name: "派发" }));
    expect(screen.getByRole("alert")).toHaveTextContent("temporary dispatch failure");
    const firstKey = onDispatch.mock.calls[0]?.[0]?.idempotencyKey;
    expect(firstKey).toBeTypeOf("string");

    await userEvent.click(screen.getByRole("button", { name: "派发" }));
    expect(onDispatch).toHaveBeenCalledTimes(2);
    expect(onDispatch.mock.calls[1]?.[0]?.idempotencyKey).toBe(firstKey);
  });

  it("does not invent progress when the upstream omits it", () => {
    render(<TaskWorkspace tasks={[task]} nodes={[node]} />);

    expect(screen.getByText("未报告")).toBeInTheDocument();
  });

  it("searches and filters the task workbench without losing the selected inspector", async () => {
    const completed: TaskRecord = {
      ...task,
      id: "completed-task",
      goal: "Latest completed run",
      status: "completed",
      progress: 100,
      updatedAt: "2026-10-21T00:02:00.000Z",
    };
    const failed: TaskRecord = {
      ...task,
      id: "failed-task",
      goal: "Older failed run",
      status: "failed",
      updatedAt: "2026-10-21T00:01:00.000Z",
    };
    render(
      <TaskWorkspace
        tasks={[failed, completed]}
        nodes={[node, secondNode]}
        selectedTaskId={completed.id}
      />,
    );

    expect(screen.getByLabelText("任务概览")).toHaveTextContent(/2\s*任务/u);
    expect(screen.getByLabelText("任务概览")).toHaveTextContent(/2\s*在线节点/u);
    const search = screen.getByRole("searchbox", { name: "搜索任务" });
    await userEvent.type(search, "Older");
    expect(screen.queryByRole("button", { name: "查看任务 completed-task" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看任务 failed-task" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "任务详情" })).toHaveTextContent("Latest completed run");

    await userEvent.clear(search);
    await userEvent.click(screen.getByRole("tab", { name: /异常 1/u }));
    expect(screen.getByRole("button", { name: "查看任务 failed-task" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看任务 completed-task" })).not.toBeInTheDocument();
  });

  it("orders tasks by latest update and exposes the compact status controls", () => {
    const completed: TaskRecord = {
      ...task,
      id: "completed-task",
      goal: "Latest completed run",
      status: "completed",
      updatedAt: "2026-10-21T00:02:00.000Z",
    };
    const queued: TaskRecord = {
      ...task,
      id: "queued-task",
      goal: "Queued run",
      status: "queued",
      updatedAt: "2026-10-21T00:03:00.000Z",
    };
    render(<TaskWorkspace tasks={[completed, queued]} nodes={[node]} />);

    const rows = screen.getAllByRole("button", { name: /^查看任务 /u });
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "查看任务 queued-task",
      "查看任务 completed-task",
    ]);
    expect(screen.getByRole("combobox", { name: "按节点筛选" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "任务排序" })).toHaveValue("updated-desc");
  });

  it("routes the topbar search action to the task search field", async () => {
    render(<TaskWorkspace tasks={[task]} nodes={[node]} />);

    window.dispatchEvent(new CustomEvent("dsh-fusion:focus-search"));
    expect(screen.getByRole("searchbox", { name: "搜索任务" })).toHaveFocus();
  });

  it("opens the ownership canvas by default and keeps list and canvas selections linked", async () => {
    const onSelectTask = vi.fn();
    render(
      <TaskWorkspace
        tasks={[task]}
        nodes={[node, secondNode]}
        onSelectTask={onSelectTask}
      />,
    );

    expect(screen.getByRole("tab", { name: "鹊桥画布" })).toHaveAttribute("aria-selected", "true");
    const canvas = screen.getByRole("region", { name: "任务归属画布" });
    expect(within(canvas).getByText("发起者")).toBeInTheDocument();
    expect(within(canvas).getByText("任务")).toBeInTheDocument();
    expect(within(canvas).getByText("执行节点")).toBeInTheDocument();
    expect(within(canvas).getByText("证据")).toBeInTheDocument();
    await userEvent.click(within(canvas).getByRole("button", { name: `查看任务 ${task.id}` }));
    expect(onSelectTask).toHaveBeenCalledWith(task.id);
    expect(screen.getByRole("region", { name: "任务详情" })).toHaveTextContent("检查节点");

    await userEvent.click(screen.getByRole("tab", { name: "列表" }));
    expect(screen.getByRole("table", { name: "任务列表" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `查看任务 ${task.id}` })).toHaveAttribute("aria-pressed", "true");
  });

  it("switches the same selection across satellite and radial layouts", async () => {
    const onSelectTask = vi.fn();
    render(
      <TaskWorkspace
        tasks={[task]}
        nodes={[node]}
        onSelectTask={onSelectTask}
      />,
    );

    await userEvent.click(screen.getByRole("tab", { name: "卫星视图" }));
    const satellite = screen.getByRole("region", { name: "卫星拓扑视图" });
    await userEvent.click(within(satellite).getByRole("button", { name: `查看任务 ${task.id}` }));
    expect(onSelectTask).toHaveBeenCalledWith(task.id);

    await userEvent.click(screen.getByRole("tab", { name: "放射树" }));
    const radial = screen.getByRole("region", { name: "放射树视图" });
    await userEvent.click(within(radial).getByRole("button", { name: `查看任务 ${task.id}` }));
    expect(onSelectTask).toHaveBeenCalledWith(task.id);
  });

  it("blocks new dispatches when live state refresh is stale", () => {
    render(
      <TaskWorkspace
        tasks={[]}
        nodes={[node]}
        connectionStale
      />,
    );

    expect(screen.getByRole("button", { name: "新建任务" })).toBeDisabled();
  });

  it("passes host action callbacks only to extensions that declare them", async () => {
    let observed: FusionTaskViewProps | undefined;
    registerTaskView({
      id: "action-extension",
      label: "扩展动作",
      priority: 300,
      actions: ["cancel", "dispatch"],
      Component: (props) => {
        observed = props;
        return (
          <section aria-label="扩展动作视图">
            <button type="button" onClick={() => void props.onDispatchTask?.({ goal: "扩展派发", command: "true", nodeIds: [node.id] })}>扩展派发</button>
            <button type="button" onClick={() => void props.onCancelTask?.(task.id)}>扩展取消</button>
          </section>
        );
      },
    });
    const onDispatch = vi.fn(async () => task);
    const onCancel = vi.fn();
    try {
      render(
        <TaskWorkspace
          tasks={[task]}
          nodes={[node]}
          allowExtensionActions
          onDispatch={onDispatch}
          onCancel={onCancel}
        />,
      );
      await userEvent.click(screen.getByRole("tab", { name: "扩展动作" }));
      expect(observed?.onDispatchTask).toBeTypeOf("function");
      expect(observed?.onCancelTask).toBeTypeOf("function");
      await userEvent.click(screen.getByRole("button", { name: "扩展派发" }));
      await userEvent.click(screen.getByRole("button", { name: "扩展取消" }));
      expect(onDispatch).toHaveBeenCalledWith({ goal: "扩展派发", command: "true", nodeIds: [node.id] });
      expect(onCancel).toHaveBeenCalledWith(task.id);
    } finally {
      unregisterTaskView("action-extension");
    }
  });

  it("keeps undeclared action callbacks away from extension views", async () => {
    let observed: FusionTaskViewProps | undefined;
    registerTaskView({
      id: "readonly-extension",
      label: "只读扩展",
      priority: 300,
      Component: (props) => {
        observed = props;
        return <section aria-label="只读扩展视图" />;
      },
    });
    try {
      render(
        <TaskWorkspace
          tasks={[task]}
          nodes={[node]}
          allowExtensionActions
          onDispatch={async () => task}
          onCancel={vi.fn()}
        />,
      );
      await userEvent.click(screen.getByRole("tab", { name: "只读扩展" }));
      expect(observed?.onDispatchTask).toBeUndefined();
      expect(observed?.onCancelTask).toBeUndefined();
    } finally {
      unregisterTaskView("readonly-extension");
    }
  });

  it("withholds action callbacks even from a declared extension unless the host allows extension actions", async () => {
    let observed: FusionTaskViewProps | undefined;
    registerTaskView({
      id: "unauthorized-extension",
      label: "未授权扩展",
      priority: 300,
      actions: ["dispatch", "cancel"],
      Component: (props) => {
        observed = props;
        return <section aria-label="未授权扩展视图" />;
      },
    });
    try {
      render(
        <TaskWorkspace
          tasks={[task]}
          nodes={[node]}
          onDispatch={async () => task}
          onCancel={vi.fn()}
        />,
      );
      await userEvent.click(screen.getByRole("tab", { name: "未授权扩展" }));
      expect(observed?.onDispatchTask).toBeUndefined();
      expect(observed?.onCancelTask).toBeUndefined();
    } finally {
      unregisterTaskView("unauthorized-extension");
    }
  });

  it("keeps the filtered task set identical across bridge, satellite, and radial views", async () => {
    const alpha: TaskRecord = { ...task, id: "TASK-alpha", goal: "Alpha 巡检", status: "running" };
    const beta: TaskRecord = { ...task, id: "TASK-beta", goal: "Beta 巡检", status: "completed" };
    render(<TaskWorkspace tasks={[alpha, beta]} nodes={[node]} />);

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索任务" }), "Alpha");

    // The same filter must yield the same clickable task set in every
    // view: satellite and radial used to render the unfiltered
    // topology, so switching layouts silently changed the filter.
    for (const viewLabel of ["鹊桥画布", "卫星视图", "放射树"]) {
      await userEvent.click(screen.getByRole("tab", { name: viewLabel }));
      expect(screen.getByRole("button", { name: "查看任务 TASK-alpha" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "查看任务 TASK-beta" })).not.toBeInTheDocument();
    }
  });

  it("hints when the inspected task is filtered out and offers to clear the filters", async () => {
    const alpha: TaskRecord = { ...task, id: "TASK-alpha", goal: "Alpha 巡检", status: "running" };
    const beta: TaskRecord = { ...task, id: "TASK-beta", goal: "Beta 巡检", status: "completed" };
    render(<TaskWorkspace tasks={[alpha, beta]} nodes={[node]} selectedTaskId="TASK-beta" />);

    // While beta matches the (empty) filter, no hint is shown.
    expect(screen.queryByText(/当前筛选未包含此任务/)).not.toBeInTheDocument();

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索任务" }), "Alpha");

    // Beta disappears from the views but its details stay open; the
    // inspector must say so explicitly instead of diverging silently.
    expect(screen.queryByRole("button", { name: "查看任务 TASK-beta" })).not.toBeInTheDocument();
    expect(screen.getByText(/当前筛选未包含此任务/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("button", { name: "查看任务 TASK-beta" })).toBeInTheDocument();
    expect(screen.queryByText(/当前筛选未包含此任务/)).not.toBeInTheDocument();
  });

  it("contains a broken extension and returns to the built-in task list", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    registerTaskView({
      id: "broken-extension",
      label: "故障扩展",
      priority: 300,
      Component: () => {
        throw new Error("extension exploded");
      },
    });
    try {
      render(<TaskWorkspace tasks={[task]} nodes={[node]} />);
      await userEvent.click(screen.getByRole("tab", { name: "故障扩展" }));
      expect(screen.getByRole("alert")).toHaveTextContent("扩展视图不可用");
      expect(screen.getByRole("searchbox", { name: "搜索任务" })).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "返回任务列表" }));
      expect(screen.getByRole("table", { name: "任务列表" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `查看任务 ${task.id}` })).toBeInTheDocument();
    } finally {
      unregisterTaskView("broken-extension");
      consoleError.mockRestore();
    }
  });
});
