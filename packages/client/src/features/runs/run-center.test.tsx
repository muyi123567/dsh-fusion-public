import { useState } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "@testing-library/user-event";
import type {
  AgentFlowRecord,
  AgentTeamRecord,
  RoomRecord,
  TaskRecord,
} from "@dsh-fusion/core";
import { RunCenter, type RunViewState } from "./RunCenter.js";

const team: AgentTeamRecord = {
  id: "agent-teams:release",
  providerId: "agent-teams",
  name: "Release Team",
  workspace: "F:\\AI\\release",
  phase: "running",
  captainSessionId: "agent-teams:release:captain",
  memberIds: ["agent-teams:release:reviewer"],
  taskIds: ["agent-teams:release:review"],
};

const flow: AgentFlowRecord = {
  id: "agent-bus:release",
  providerId: "agent-bus",
  name: "Release Flow",
  workspacePath: "F:\\AI\\release",
  taskIds: ["agent-bus:review"],
  archived: false,
};

const room: RoomRecord = {
  id: "agent-room:release",
  providerId: "agent-room",
  name: "Release Room",
  status: "open",
  leaderSessionId: "agent-room:release:leader",
  memberIds: ["agent-room:release:reviewer"],
  activityCount: 2,
};

describe("RunCenter selection truthfulness", () => {
  it("reports a vanished selection as unobserved instead of silently showing another run", () => {
    const task: TaskRecord = { id: "agent-bus:review", goal: "Review", targetNodeIds: [], transport: "dsh-fleet", status: "running", evidence: [], createdAt: "2026-10-23", updatedAt: "2026-10-23" };
    const viewState: RunViewState = { tab: "running", selectedRunId: "agent-bus:vanished" };
    const { container } = render(
      <RunCenter agentFlows={[flow]} tasks={[task]} allowDemo={false} viewState={viewState} onViewStateChange={vi.fn()} />,
    );
    expect(screen.getByText(/所选运行当前未观测到/)).toBeInTheDocument();
    expect(screen.queryByLabelText("DAG 任务详情")).not.toBeInTheDocument();
    expect(container.querySelector(".fusion-run-list .is-selected")).toBeNull();
  });
});

describe("RunCenter bridge sources", () => {
  it("labels upstream views read-only and exposes real task navigation without runnable templates", async () => {
    const task: TaskRecord = { id: "agent-bus:review", goal: "Review", targetNodeIds: [], transport: "dsh-fleet", status: "running", evidence: [], createdAt: "2026-10-23", updatedAt: "2026-10-23" };
    const onOpenTask = vi.fn();
    render(<RunCenter agentFlows={[flow]} tasks={[task]} allowDemo={false} onOpenTask={onOpenTask} />);
    expect(screen.getByText(/上游运行的只读投影/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "运行模板" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重跑" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: `查看任务 ${task.id}` }));
    expect(onOpenTask).toHaveBeenCalledWith(task.id);
    await userEvent.click(screen.getByRole("tab", { name: "模板" }));
    expect(screen.queryByRole("button", { name: /选择模板/ })).not.toBeInTheDocument();
  });

  it("does not claim a complete run when a referenced task has not been observed", async () => {
    const completed: TaskRecord = { id: "agent-bus:review", goal: "Review", targetNodeIds: [], transport: "dsh-fleet", status: "completed", evidence: [], createdAt: "2026-10-23", updatedAt: "2026-10-23" };
    const onOpenTask = vi.fn();
    render(<RunCenter agentFlows={[{ ...flow, taskIds: [completed.id, "missing-task"] }]} tasks={[completed]} allowDemo={false} onOpenTask={onOpenTask} />);
    expect(screen.getByText("部分任务未观测（1 个），无法确认完整运行状态。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "查看任务 missing-task" }));
    expect(onOpenTask).toHaveBeenCalledWith("missing-task");
    await userEvent.click(screen.getByRole("tab", { name: "历史" }));
    expect(screen.getByText("当前没有运行记录")).toBeInTheDocument();
  });
  it("keeps an observed failure visible when other flow tasks are unobserved", async () => {
    const failed: TaskRecord = { id: "agent-bus:review", goal: "Review", targetNodeIds: [], transport: "dsh-fleet", status: "failed", evidence: [], createdAt: "2026-10-23", updatedAt: "2026-10-23" };
    render(<RunCenter agentFlows={[{ ...flow, taskIds: [failed.id, "missing-task"] }]} tasks={[failed]} allowDemo={false} />);
    // The known failure is the headline state; the missing task
    // is reported as incomplete coverage, not used to relabel
    // the whole run as pending.
    const listItem = screen.getByRole("button", { name: /Release Flow/ });
    expect(listItem).toHaveTextContent("failed");
    expect(listItem).toHaveTextContent("结果不完整 · 缺失 1");
    expect(listItem).not.toHaveTextContent("pending");
    expect(screen.getByText(/部分任务未观测（1 个），无法确认完整运行状态。/)).toBeInTheDocument();
    // An incompletely observed run never lands in history: its
    // final result is unconfirmable.
    await userEvent.click(screen.getByRole("tab", { name: "历史" }));
    expect(screen.getByText("当前没有运行记录")).toBeInTheDocument();
  });

  it("keeps the detail inside the current tab's classification", async () => {
    const doneFlow: AgentFlowRecord = { ...flow, id: "agent-bus:done", name: "Done Flow", taskIds: ["agent-bus:done-task"] };
    const liveFlow: AgentFlowRecord = { ...flow, id: "agent-bus:live", name: "Live Flow", taskIds: ["agent-bus:live-task"] };
    const doneTask: TaskRecord = { id: "agent-bus:done-task", goal: "Done", targetNodeIds: [], transport: "dsh-fleet", status: "completed", evidence: [], createdAt: "2026-10-23", updatedAt: "2026-10-23" };
    const liveTask: TaskRecord = { id: "agent-bus:live-task", goal: "Live", targetNodeIds: [], transport: "dsh-fleet", status: "running", evidence: [], createdAt: "2026-10-23", updatedAt: "2026-10-23" };
    render(<RunCenter agentFlows={[doneFlow, liveFlow]} tasks={[doneTask, liveTask]} allowDemo={false} />);
    // Default tab is 运行中: even though the completed run is
    // first in the array, the detail must be the visible one.
    expect(screen.getByRole("button", { name: /Live Flow/ })).toBeInTheDocument();
    expect(document.querySelector(".fusion-run-detail-head strong")).toHaveTextContent("Live Flow");
    // Select the completed run in history, then switch back:
    // the detail must not keep showing the other tab's run.
    await userEvent.click(screen.getByRole("tab", { name: "历史" }));
    await userEvent.click(screen.getByRole("button", { name: /Done Flow/ }));
    expect(document.querySelector(".fusion-run-detail-head strong")).toHaveTextContent("Done Flow");
    await userEvent.click(screen.getByRole("tab", { name: "运行中" }));
    expect(document.querySelector(".fusion-run-detail-head strong")).toHaveTextContent("Live Flow");
  });

  it("keeps tab and flow selection across unmounts when the workspace owns them", async () => {
    const doneFlow: AgentFlowRecord = { ...flow, id: "agent-bus:done", name: "Done Flow", taskIds: ["agent-bus:done-task"] };
    const liveFlow: AgentFlowRecord = { ...flow, id: "agent-bus:live", name: "Live Flow", taskIds: ["agent-bus:live-task"] };
    const doneTask: TaskRecord = { id: "agent-bus:done-task", goal: "Done", targetNodeIds: [], transport: "dsh-fleet", status: "completed", evidence: [], createdAt: "2026-10-23", updatedAt: "2026-10-23" };
    const liveTask: TaskRecord = { id: "agent-bus:live-task", goal: "Live", targetNodeIds: [], transport: "dsh-fleet", status: "running", evidence: [], createdAt: "2026-10-23", updatedAt: "2026-10-23" };
    function Harness() {
      const [viewState, setViewState] = useState<RunViewState>({ tab: "running" });
      const [show, setShow] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShow((current) => !current)}>切换页面</button>
          {show ? (
            <RunCenter agentFlows={[doneFlow, liveFlow]} tasks={[doneTask, liveTask]} allowDemo={false} viewState={viewState} onViewStateChange={setViewState} />
          ) : null}
        </>
      );
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole("tab", { name: "历史" }));
    await userEvent.click(screen.getByRole("button", { name: /Done Flow/ }));
    expect(document.querySelector(".fusion-run-detail-head strong")).toHaveTextContent("Done Flow");
    await userEvent.click(screen.getByRole("button", { name: "切换页面" }));
    await userEvent.click(screen.getByRole("button", { name: "切换页面" }));
    expect(screen.getByRole("tab", { name: "历史" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".fusion-run-detail-head strong")).toHaveTextContent("Done Flow");
  });

  it("shows live AgentTeams, AgentBus, and Room records", () => {
    render(
      <RunCenter
        agentTeams={[team]}
        agentFlows={[flow]}
        rooms={[room]}
        providers={{
          agentTeams: { state: "connected", checkedAt: 1 },
          agentBus: { state: "connected", checkedAt: 2 },
          room: { state: "degraded", checkedAt: 3, message: "slow refresh" },
        }}
      />,
    );

    expect(screen.getByText("Release Team")).toBeInTheDocument();
    expect(screen.getAllByText("Release Flow").length).toBeGreaterThan(0);
    expect(screen.getByText("Release Room")).toBeInTheDocument();
    expect(screen.getByText("3/3 实时来源")).toBeInTheDocument();
    expect(screen.queryByText("演示回退")).not.toBeInTheDocument();
    expect(screen.getByText("降级")).toBeInTheDocument();
  });

  it("labels demo fallback when source arrays are absent", () => {
    render(<RunCenter />);

    expect(screen.getAllByText("演示回退")).toHaveLength(3);
    expect(screen.getAllByText("接口未返回 · 演示回退")).toHaveLength(3);
    expect(screen.getByText("发布验收小组")).toBeInTheDocument();
  });

  it("does not show fixed demo runs in live-only mode", () => {
    render(
      <RunCenter
        agentFlows={[]}
        tasks={[]}
        providers={{
          agentBus: { state: "connected", checkedAt: 1 },
        }}
        allowDemo={false}
      />,
    );

    expect(screen.queryByText("fleet-smoke")).not.toBeInTheDocument();
    expect(screen.getByText("当前没有运行记录")).toBeInTheDocument();
  });

  it("renders only real task dependencies and keeps verification running", () => {
    const tasks: TaskRecord[] = [
      {
        id: "agent-bus:plan",
        goal: "Plan",
        targetNodeIds: [],
        transport: "dsh-fleet",
        status: "completed",
        evidence: [],
        createdAt: "2026-10-21T00:00:00.000Z",
        updatedAt: "2026-10-21T00:01:00.000Z",
      },
      {
        id: "agent-bus:review",
        goal: "Review",
        targetNodeIds: [],
        dependsOnTaskIds: ["agent-bus:plan"],
        transport: "dsh-fleet",
        status: "verifying",
        evidence: [],
        createdAt: "2026-10-21T00:01:00.000Z",
        updatedAt: "2026-10-21T00:02:00.000Z",
      },
    ];
    const { container } = render(
      <RunCenter
        agentFlows={[{ ...flow, taskIds: ["agent-bus:plan", "agent-bus:review"] }]}
        tasks={tasks}
        providers={{
          agentBus: { state: "connected", checkedAt: 1 },
        }}
        allowDemo={false}
      />,
    );

    expect(container.querySelectorAll(".fusion-run-dag svg path")).toHaveLength(1);
    expect(screen.getByText("agent-bus:review").closest("article")).toHaveClass("running");
  });
});

describe("RunCenter selection stability across navigation", () => {
  it("records the implicitly shown run before jumping to a task so a re-sorted return keeps it", async () => {
    const flowA: AgentFlowRecord = { ...flow, id: "agent-bus:alpha", name: "Alpha Flow", taskIds: ["task-alpha"] };
    const flowB: AgentFlowRecord = { ...flow, id: "agent-bus:beta", name: "Beta Flow", taskIds: ["task-beta"] };
    const taskAlpha: TaskRecord = { id: "task-alpha", goal: "Alpha", targetNodeIds: [], transport: "dsh-fleet", status: "running", evidence: [], createdAt: "2026-10-23", updatedAt: "2026-10-23" };
    const taskBeta: TaskRecord = { ...taskAlpha, id: "task-beta", goal: "Beta" };
    const onOpenTask = vi.fn();
    function Harness({ flows }: { flows: AgentFlowRecord[] }) {
      const [viewState, setViewState] = useState<RunViewState>({ tab: "running" });
      return (
        <RunCenter
          agentFlows={flows}
          tasks={[taskAlpha, taskBeta]}
          allowDemo={false}
          viewState={viewState}
          onViewStateChange={setViewState}
          onOpenTask={onOpenTask}
        />
      );
    }
    const { container, rerender } = render(<Harness flows={[flowA, flowB]} />);
    const detailRunId = () => container.querySelector(".fusion-run-detail-head small")?.textContent;
    // No explicit selection exists yet: the detail implicitly
    // shows the first run.
    expect(detailRunId()).toBe("agent-bus:alpha");
    await userEvent.click(screen.getByRole("button", { name: "查看任务 task-alpha" }));
    expect(onOpenTask).toHaveBeenCalledWith("task-alpha");
    // While the user is on the task page, upstream ordering
    // flips. Returning must land on the run they actually
    // left — the implicit first selection must have been
    // recorded as an identity, not re-derived from order.
    rerender(<Harness flows={[flowB, flowA]} />);
    expect(detailRunId()).toBe("agent-bus:alpha");
  });
});
