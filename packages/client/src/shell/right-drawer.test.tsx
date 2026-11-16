import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BotRecord, NodeRecord, TaskRecord } from "@dsh-fusion/core";
import { RightDrawer } from "./RightDrawer.js";

const bot: BotRecord = {
  id: "bot-offline",
  providerId: "agent-teams",
  name: "Offline bot",
  role: "reviewer",
  model: "unknown",
  isMain: false,
  status: "offline",
};

const node: NodeRecord = {
  id: "node-unverified",
  externalId: "node-unverified",
  providerId: "huawei-ssh",
  name: "Unverified node",
  platform: "linux",
  roles: ["worker"],
  status: "degraded",
  transports: ["ssh"],
  capabilities: ["linux"],
  configState: "unknown",
};

const tasks: TaskRecord[] = [
  {
    id: "old-task",
    goal: "Old queued task",
    targetNodeIds: [node.id],
    transport: "ssh",
    status: "queued",
    evidence: [],
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
  },
  {
    id: "latest-task",
    goal: "Latest completed task",
    targetNodeIds: [node.id],
    transport: "ssh",
    status: "completed",
    progress: 100,
    evidence: [],
    createdAt: "2026-10-21T00:01:00.000Z",
    updatedAt: "2026-10-21T00:02:00.000Z",
  },
];

describe("RightDrawer", () => {
  it("shows reported bot, node, config, and metric states without inventing values", () => {
    render(
      <RightDrawer
        mode="bot"
        bot={bot}
        node={node}
        tasks={tasks}
        mobileOpen={false}
        onCloseMobile={() => {}}
      />,
    );

    expect(screen.getByText("离线 · unknown")).toBeInTheDocument();
    expect(screen.getByText("配置未验证")).toBeInTheDocument();
    expect(screen.getByText("CPU 未报告")).toBeInTheDocument();
    expect(screen.getByText("内存 未报告")).toBeInTheDocument();
    expect(screen.getByText("Latest completed task")).toBeInTheDocument();
    expect(screen.queryByText("Old queued task")).not.toBeInTheDocument();
  });

  it("gives the terminal path for SSH nodes and the capability reason otherwise", async () => {
    const sshNode: NodeRecord = { ...node, name: "节点一", status: "online", configState: "current" };
    const first = render(
      <RightDrawer mode="fleet" bot={bot} node={sshNode} tasks={[]} mobileOpen={false} onCloseMobile={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "打开终端" }));
    expect(screen.getByText("在终端页选择节点 节点一 打开终端")).toBeInTheDocument();
    first.unmount();
    render(
      <RightDrawer mode="fleet" bot={bot} node={{ ...sshNode, transports: ["dsh-fleet"] }} tasks={[]} mobileOpen={false} onCloseMobile={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "打开终端" }));
    expect(screen.getByText("终端入口需要 SSH transport")).toBeInTheDocument();
  });
});
