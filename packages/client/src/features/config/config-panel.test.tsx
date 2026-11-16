import { act, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConfigSnapshot, NodeRecord } from "@dsh-fusion/core";
import { ConfigPanel } from "./ConfigPanel.js";

const node: NodeRecord = {
  id: "oracle",
  externalId: "oracle",
  providerId: "seekfleet",
  name: "Oracle Worker",
  platform: "linux",
  roles: ["worker"],
  status: "online",
  transports: ["seekfleet"],
  capabilities: ["linux", "config"],
  configHash: "old-hash",
  configState: "drift",
};

const snapshot: ConfigSnapshot = {
  revision: "new-revision",
  hash: "new-hash",
  desiredCommit: "abc123",
  appliedCommit: "def456",
  pluginVersions: { "dsh-fusion": "0.1.0" },
  nodeStates: { oracle: "drift" },
};

describe("ConfigPanel", () => {
  it("keeps recurrent drift and unknown authoritative after a successful apply", async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<ConfigPanel nodes={[node]} snapshot={snapshot} onApply={onApply} />);
    await userEvent.click(screen.getByRole("button", { name: "应用 Oracle Worker 配置" }));
    expect(screen.getByText("配置漂移")).toBeInTheDocument();
    rerender(<ConfigPanel nodes={[{ ...node, configState: "current" }]} snapshot={snapshot} onApply={onApply} />);
    expect(screen.getByText("已应用")).toBeInTheDocument();
    rerender(<ConfigPanel nodes={[{ ...node, configHash: "another-drift" }]} snapshot={snapshot} onApply={onApply} />);
    expect(screen.getByText("配置漂移")).toBeInTheDocument();
    rerender(<ConfigPanel nodes={[{ ...node, configState: "unknown" }]} snapshot={snapshot} onApply={onApply} />);
    expect(screen.getByText("配置未验证")).toBeInTheDocument();
    expect(screen.queryByText("已应用")).not.toBeInTheDocument();
  });

  it("does not claim an offline node is current or allow applying it", () => {
    render(<ConfigPanel nodes={[{ ...node, status: "offline", configState: "current" }]} snapshot={snapshot} onApply={vi.fn()} />);
    expect(screen.getByText("离线 · 配置未验证")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用 Oracle Worker 配置" })).toBeDisabled();
    expect(screen.queryByText("已应用")).not.toBeInTheDocument();
  });

  it("suppresses duplicate submissions and restores retry after rejection", async () => {
    let reject!: (error: Error) => void;
    const onApply = vi.fn(() => new Promise<void>((_resolve, rejectApply) => { reject = rejectApply; }));
    render(<ConfigPanel nodes={[node]} snapshot={snapshot} onApply={onApply} />);
    const button = screen.getByRole("button", { name: "应用 Oracle Worker 配置" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    await act(async () => { reject(new Error("denied")); });
    expect(screen.getByRole("alert")).toHaveTextContent("denied");
    expect(button).toBeEnabled();
    expect(screen.getByText("配置漂移")).toBeInTheDocument();
  });

  it("keeps one node failure visible while another node applies", async () => {
    const onApply = vi.fn().mockRejectedValueOnce(new Error("oracle denied")).mockResolvedValueOnce(undefined);
    render(<ConfigPanel nodes={[node, { ...node, id: "other", name: "Other Worker" }]} snapshot={snapshot} onApply={onApply} />);
    await userEvent.click(screen.getByRole("button", { name: "应用 Oracle Worker 配置" }));
    await userEvent.click(screen.getByRole("button", { name: "应用 Other Worker 配置" }));
    expect(screen.getByRole("alert")).toHaveTextContent("oracle denied");
    expect(screen.getAllByText("配置漂移")).toHaveLength(2);
  });
  it("shows drift and applies the desired revision", async () => {
    const onApply = vi.fn().mockRejectedValue(new Error("apply unavailable"));
    render(<ConfigPanel nodes={[node]} snapshot={snapshot} onApply={onApply} />);

    expect(screen.getByText("配置漂移")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "应用 Oracle Worker 配置" }));

    expect(onApply).toHaveBeenCalledWith("oracle");
    expect(screen.getByText("配置漂移")).toBeInTheDocument();
  });
});
