import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskRecord, TaskStatus } from "@dsh-fusion/core";
import { matchesFilter, studyTasks, taskFact, taskState, taskTime } from "./design-fixture.js";
import { TaskDetail } from "./TaskDetail.js";
import { TaskStudy } from "./TaskStudy.js";

const base = studyTasks("normal")[0]!;
const paneProps = { initialView: "detail" as const, width: "420" as const, theme: "light" as const };
const statusTask = (status: TaskStatus): TaskRecord => ({ ...base, status });

describe("design study source semantics", () => {
  it("preserves terminal states even when old blockers remain", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const task = { ...statusTask(status), agentTeamTask: { ...base.agentTeamTask!, blockedBy: ["TASK-OTHER"] } };
      expect(taskState(task).key).toBe(status);
    }
    expect(matchesFilter(statusTask("cancelled"), "completed")).toBe(false);
    expect(matchesFilter(statusTask("cancelled"), "cancelled")).toBe(true);
  });

  it("keeps claimed distinct and never invents running activity from evidence", () => {
    expect(taskState(statusTask("claimed")).label).toBe("已认领");
    expect(matchesFilter(statusTask("claimed"), "running")).toBe(false);
    expect(taskFact(statusTask("running")).primary).toBe(taskFact({ ...statusTask("running"), evidence: [] }).primary);
    expect(taskFact(statusTask("verifying")).primary).toBe("独立审查结论未提供");
  });

  it("shows the original queued status separately from its declared blocker", () => {
    const task = studyTasks("normal").find(item => item.id === "demo-voyage-106")!;
    render(<TaskDetail task={task} scenario="normal" onBack={() => {}} />);
    expect(screen.getByText("排队")).toBeInTheDocument();
    expect(screen.getAllByText(/TASK-104/).length).toBeGreaterThan(0);
  });

  it("formats source times and keeps failed retained data distinct from a legal empty set", () => {
    expect(taskTime(base)).toBe("09:42");
    expect(taskTime({ ...base, updatedAt: "unknown" })).toBe("时间未提供");
    expect(studyTasks("empty")).toHaveLength(0);
    expect(studyTasks("not-configured")).toHaveLength(0);
    expect(studyTasks("unavailable").length).toBeGreaterThan(0);
    expect(taskTime(studyTasks("unavailable")[0]!)).toBe("09:15");
  });
});

describe("design study local reading", () => {
  it("exposes structured evidence while preserving its exact raw text", () => {
    const { container } = render(<TaskDetail task={base} scenario="normal" onBack={() => {}} />);
    expect(within(screen.getByRole("tabpanel")).getByRole("list").children).toHaveLength(3);
    expect(container.querySelector("details.study-description")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "原文" }));
    expect(screen.getByRole("tabpanel").querySelector("pre")?.textContent).toBe(base.evidence[0]!.value);
    fireEvent.keyDown(screen.getByRole("tab", { name: "检查摘要" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "变更说明" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps stale context visible in detail and makes retry explicitly local", () => {
    const retry = vi.fn();
    const { rerender } = render(<TaskStudy {...paneProps} scenario="stale" onRetrySource={retry} />);
    expect(screen.getByText("演示 · 全局 · 陈旧 09:15")).toBeInTheDocument();
    expect(screen.getByText("记录更新 09:15")).toBeInTheDocument();
    rerender(<TaskStudy {...paneProps} scenario="unavailable" onRetrySource={retry} />);
    expect(screen.getByRole("status")).toHaveTextContent("读取失败，保留 09:15 的旧快照；当前任务状态尚未确认。");
    fireEvent.click(screen.getByRole("button", { name: "重读演示来源" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByText("当前来源中没有任务")).not.toBeInTheDocument();
  });

  it("preserves a missing selection and returns focus to a usable list control", async () => {
    const { rerender, container } = render(<TaskStudy {...paneProps} scenario="normal" />);
    rerender(<TaskStudy {...paneProps} scenario="missing" />);
    expect(screen.getByText("任务记录当前不可见")).toBeInTheDocument();
    expect(screen.getByText("TASK-104")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "任务详情" })).not.toHaveTextContent("核对跨会话的来源映射");
    fireEvent.click(screen.getByRole("button", { name: /返回任务列表/ }));
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
    expect(container.querySelector("[data-design-pane]")).toHaveAttribute("data-view", "list");
  });

  it("ignores handled, composing and editing Escape; handles detail Escape locally", async () => {
    const outside = vi.fn();
    const { container } = render(<div onKeyDown={outside}><TaskStudy {...paneProps} scenario="normal" /></div>);
    const detail = screen.getByRole("article", { name: "任务详情" });
    const pane = container.querySelector("[data-design-pane]")!;
    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault(); fireEvent(detail, handled);
    fireEvent.keyDown(detail, { key: "Escape", isComposing: true });
    fireEvent.keyDown(detail, { key: "Escape", keyCode: 229 });
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(pane).toHaveAttribute("data-view", "detail");
    outside.mockClear();
    fireEvent.keyDown(detail, { key: "Escape" });
    expect(pane).toHaveAttribute("data-view", "list");
    expect(outside).not.toHaveBeenCalled();
    await waitFor(() => expect(container.querySelector('[data-task-id="demo-voyage-104"]')).toHaveFocus());
  });
});
