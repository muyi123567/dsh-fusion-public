import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConfigSnapshot, NodeRecord } from "@dsh-fusion/core";
import { SetupWorkspace } from "./SetupWorkspace.js";

const config: ConfigSnapshot = {
  revision: "rev-1",
  hash: "sha256:config",
  pluginVersions: { "dsh-fusion": "0.2.0-beta.8" },
  nodeStates: {},
};

const node: NodeRecord = {
  id: "worker-a",
  externalId: "worker-a",
  providerId: "huawei-ssh",
  name: "Worker A",
  platform: "linux",
  roles: ["worker"],
  status: "online",
  transports: ["ssh"],
  capabilities: ["config"],
  configState: "current",
};

describe("SetupWorkspace", () => {
  it("routes the next setup action to the requested workspace", async () => {
    const onOpenConfig = vi.fn();
    render(
      <SetupWorkspace
        snapshotLoaded
        pluginMode
        allowDemo={false}
        nodes={[]}
        providers={{}}
        config={config}
        onOpenConfig={onOpenConfig}
        onOpenFleet={vi.fn()}
        onOpenTasks={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "添加执行节点" }));

    expect(onOpenConfig).toHaveBeenCalledOnce();
  });

  it("runs the real environment check and exposes failures", async () => {
    const onCheck = vi.fn()
      .mockRejectedValueOnce(new Error("doctor failed"))
      .mockResolvedValueOnce(undefined);
    render(
      <SetupWorkspace
        snapshotLoaded
        pluginMode
        allowDemo={false}
        nodes={[node]}
        providers={{}}
        config={{ ...config, nodeStates: { "worker-a": "current" } }}
        onCheck={onCheck}
        onOpenConfig={vi.fn()}
        onOpenFleet={vi.fn()}
        onOpenTasks={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "运行环境检查" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("环境检查失败：doctor failed");

    await userEvent.click(screen.getByRole("button", { name: "运行环境检查" }));
    expect(onCheck).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("刚刚完成检查")).toBeInTheDocument();
  });

  it("shows provider health and the verified companion installer", () => {
    render(
      <SetupWorkspace
        snapshotLoaded
        pluginMode
        allowDemo={false}
        nodes={[node]}
        providers={{
          nodes: { state: "connected", checkedAt: 1, message: "2 nodes online" },
          room: { state: "not-configured", checkedAt: 1 },
        }}
        config={{ ...config, nodeStates: { "worker-a": "current" } }}
        onOpenConfig={vi.fn()}
        onOpenFleet={vi.fn()}
        onOpenTasks={vi.fn()}
      />,
    );

    expect(screen.getByText("2 nodes online")).toBeInTheDocument();
    expect(screen.getByText("未配置")).toBeInTheDocument();
    expect(screen.getByText("dsh-fusion-setup --profile web")).toBeInTheDocument();
  });
});
