import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NodeRecord, TaskRecord } from "@dsh-fusion/core";
import { TaskCard } from "./TaskCard.js";

const task: TaskRecord = {
  id: "T-demo-001",
  goal: "运行全量测试",
  targetNodeIds: ["tencent", "oracle"],
  transport: "seekfleet",
  status: "running",
  progress: 62,
  sessionId: "session-tencent",
  evidence: [{ kind: "command", label: "test.log", value: "42 passed" }],
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:01:00.000Z",
};

const nodes: NodeRecord[] = [
  {
    id: "tencent",
    externalId: "tencent",
    providerId: "seekfleet",
    name: "腾讯 Worker",
    platform: "linux",
    roles: ["worker"],
    status: "online",
    transports: ["seekfleet"],
    capabilities: ["linux", "build"],
    configState: "current",
  },
  {
    id: "oracle",
    externalId: "oracle",
    providerId: "seekfleet",
    name: "Oracle Worker",
    platform: "linux",
    roles: ["worker"],
    status: "online",
    transports: ["seekfleet"],
    capabilities: ["linux", "database"],
    configState: "current",
  },
];

describe("TaskCard", () => {
  it("shows observed child state and does not copy aggregate status into an unobserved child", () => {
    render(<TaskCard task={{ ...task, childTaskRefs: [
      { id: "child-tencent", targetNodeIds: ["tencent"], status: "failed" },
      { id: "child-oracle", targetNodeIds: ["oracle"] },
    ] }} nodes={nodes} onOpenSession={vi.fn()} onOpenEvidence={vi.fn()} />);
    expect(screen.getByText("节点在线 · 失败")).toBeInTheDocument();
    expect(screen.getByText("节点在线 · 子任务状态未报告")).toBeInTheDocument();
  });

  it("shows assigned nodes with unavailable child state and opens session or evidence", async () => {
    const onOpenSession = vi.fn();
    const onOpenEvidence = vi.fn();

    render(
      <TaskCard
        task={task}
        nodes={nodes}
        onOpenSession={onOpenSession}
        onOpenEvidence={onOpenEvidence}
      />,
    );

    expect(screen.getByText("腾讯 Worker")).toBeInTheDocument();
    expect(screen.getByText("Oracle Worker")).toBeInTheDocument();
    expect(screen.getAllByText("62%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("节点在线 · 子任务状态未报告")).toHaveLength(2);
    expect(screen.queryByText("环境准备完成")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "查看会话" }));
    await userEvent.click(screen.getByRole("button", { name: "任务证据" }));

    expect(onOpenSession).toHaveBeenCalledWith("session-tencent");
    expect(onOpenEvidence).toHaveBeenCalledOnce();
  });
});
