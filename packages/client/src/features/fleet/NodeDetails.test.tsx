import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NodeRecord } from "@dsh-fusion/core";
import { NodeDetails } from "./NodeDetails.js";

const node: NodeRecord = {
  id: "node-1",
  externalId: "root@example",
  providerId: "huawei-ssh",
  name: "节点一",
  platform: "linux",
  roles: ["worker"],
  status: "online",
  transports: ["ssh"],
  capabilities: ["linux"],
  configState: "current",
  hostAccess: {
    ownerId: "team-alpha",
    sharingMode: "shared",
    maxConcurrentTasks: 3,
  },
};

describe("NodeDetails", () => {
  it("does not render a second, dead pair of drawer actions", () => {
    // The drawer (RightDrawer) owns the dispatch/terminal
    // actions with their notices; the duplicate pair that
    // used to live here had no handlers at all.
    render(<NodeDetails node={node} tasks={[]} />);
    expect(screen.queryByRole("button", { name: "派发任务" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开终端" })).not.toBeInTheDocument();
    expect(screen.getByText("节点一")).toBeInTheDocument();
  });

  it("shows the host owner, sharing mode and task quota", () => {
    render(<NodeDetails node={node} tasks={[]} />);
    expect(screen.getByText("team-alpha")).toBeInTheDocument();
    expect(screen.getByText("共享 Host")).toBeInTheDocument();
    expect(screen.getByText("3 个活动任务")).toBeInTheDocument();
  });
});
