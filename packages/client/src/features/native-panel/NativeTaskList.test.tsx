import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentTeamRecord, TaskRecord } from "@dsh-fusion/core";
import { NativeTaskList } from "./NativeTaskList.js";

const task = (id: string, goal: string, status: TaskRecord["status"]): TaskRecord => ({
  id, goal, status, transport: "ssh", evidence: [], targetNodeIds: [], createdAt: "", updatedAt: "",
});
const team = (id: string, name: string, taskIds: string[]): AgentTeamRecord => ({
  id, name, taskIds, providerId: "fixture", workspace: "", phase: "running", captainSessionId: "", memberIds: [],
});
afterEach(cleanup);

it("puts unresolved work before routine and completed tasks and shows the reported failure", () => {
  const failed = { ...task("failed", "恢复补丁", "failed"), error: "工作区不可读取" };
  const waiting = task("waiting", "复核恢复结果", "verifying");
  const blocked = task("blocked", "准备证据清单", "queued");
  render(<NativeTaskList tasks={[task("done", "收尾", "completed"), failed, waiting, blocked, task("running", "检查界面", "running")]}
    nodes={[]} teams={[]} blockedTaskIds={new Set([blocked.id])} rowRefs={new Map()} onSelect={vi.fn()} />);

  const attention = screen.getByRole("region", { name: "需关注" });
  expect(screen.getAllByRole("region")[0]).toBe(attention);
  expect(within(attention).getByRole("button", { name: /恢复补丁.*失败.*工作区不可读取/ })).toBeVisible();
  expect(within(attention).getByRole("button", { name: /复核恢复结果.*待验收.*独立审查结论未提供/ })).toBeVisible();
  expect(within(attention).getByRole("button", { name: /准备证据清单.*受阻/ })).toBeVisible();
  expect(within(attention).queryByText("收尾")).toBeNull();
});

it("selects a task by its record ID and displays only declared team membership", async () => {
  const live = { ...task("record", "检查快照", "running"), agentTeamTask: {
    teamId: "unconfirmed", taskId: "not-a-record-id", ownerName: "陈汐", blockedBy: [], writeScopes: [],
  } };
  const onSelect = vi.fn();
  render(<NativeTaskList tasks={[live]} nodes={[]}
    teams={[team("unconfirmed", "未声明关联", []), team("team", "复核小组", [live.id])]} selectedId={live.id}
    rowRefs={new Map()} onSelect={onSelect} />);

  const row = screen.getByRole("button", { name: /检查快照.*陈汐.*复核小组/ });
  expect(row).toHaveAttribute("aria-current", "true");
  expect(within(row).queryByText(/未声明关联/)).toBeNull();
  await userEvent.setup().click(row);
  expect(onSelect).toHaveBeenCalledWith(live.id);
});
