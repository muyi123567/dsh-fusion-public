import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigSnapshot, NodeRecord } from "@dsh-fusion/core";
import { ConfigWorkspace } from "./ConfigWorkspace.js";

const node: NodeRecord = {
  id: "huawei",
  externalId: "huawei",
  providerId: "seekfleet",
  name: "Huawei Worker",
  platform: "linux",
  roles: ["worker"],
  status: "online",
  transports: ["ssh"],
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
  nodeStates: { huawei: "drift" },
};

async function submitApplyError(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);

  render(
    <ConfigWorkspace
      nodes={[node]}
      snapshot={snapshot}
      pluginMode={true}
    />,
  );

  await userEvent.click(
    screen.getByRole("button", { name: "应用 Huawei Worker 配置" }),
  );

  return {
    alert: await screen.findByRole("alert"),
    fetchMock,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConfigWorkspace", () => {
  it.each(["doctor-failed", "apply-failed", "unreachable", "unknown"])("rejects an HTTP 200 failed doctor report: %s", async (state) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, state, message: "runtime rejected manifest" }), { status: 200 })));
    const onRefresh = vi.fn();
    render(<ConfigWorkspace nodes={[node]} snapshot={snapshot} pluginMode={true} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: "检查漂移" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("runtime rejected manifest");
    expect(screen.getByRole("button", { name: "检查漂移" })).toBeEnabled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.getByText("配置漂移")).toBeInTheDocument();
  });
  it("does not refresh or report check success when the real check rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "doctor unavailable" }), { status: 503 })));
    const onRefresh = vi.fn();
    render(<ConfigWorkspace nodes={[node]} snapshot={snapshot} pluginMode={true} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: "检查漂移" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("doctor unavailable");
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "检查漂移" })).toBeEnabled();
  });
  it.each(["check", "apply"])("refreshes after a real %s and exposes refresh failure without claiming current", async (action) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: "current" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onRefresh = vi.fn().mockRejectedValue(new Error("snapshot unavailable"));
    render(<ConfigWorkspace nodes={[node]} snapshot={snapshot} pluginMode={true} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: action === "check" ? "检查漂移" : "应用 Huawei Worker 配置" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("刷新失败：snapshot unavailable");
    expect(screen.getByText("配置漂移")).toBeInTheDocument();
    expect(screen.queryByText("已应用")).not.toBeInTheDocument();
    expect(screen.queryByText(/current已检查/)).not.toBeInTheDocument();
  });

  it.each(["current", "drift"])("waits for check and refresh before showing check success: %s", async (state) => {
    const order: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => { order.push("check"); return new Response(JSON.stringify({ ok: state === "current", state }), { status: 200 }); }));
    const onRefresh = vi.fn(async () => { order.push("refresh"); });
    render(<ConfigWorkspace nodes={[node]} snapshot={snapshot} pluginMode={true} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: "检查漂移" }));
    expect(await screen.findByRole("button", { name: "已检查" })).toBeEnabled();
    expect(order).toEqual(["check", "refresh"]);
  });

  it("shows complete rollback failure details for a 409 apply response", async () => {
    const { alert, fetchMock } = await submitApplyError(409, {
      error: "doctor rejected config",
      applied: false,
      rolledBack: false,
      rollbackAttempted: true,
      rollbackError: "restore denied",
      doctor: { message: "doctor rejected config" },
    });

    expect(alert).toHaveTextContent(
      "配置应用失败：HTTP 409 请求失败；主 apply 错误：doctor rejected config；"
        + "回滚失败：restore denied；当前配置状态未知",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "plugins/dsh-fusion/config/apply",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not show a rollback conclusion for a preflight 409", async () => {
    const { alert } = await submitApplyError(409, {
      error: "preflight failed",
      applied: false,
      rolledBack: false,
      rollbackAttempted: false,
    });

    expect(alert).toHaveTextContent(
      "配置应用失败：HTTP 409 请求失败；主 apply 错误：preflight failed",
    );
    expect(alert).not.toHaveTextContent("回滚");
  });

  it.each([403, 415, 400])(
    "shows only the request error for HTTP %i",
    async (status) => {
      const { alert } = await submitApplyError(status, {
        error: "request rejected",
      });

      expect(alert).toHaveTextContent(
        `配置应用失败：HTTP ${status} 请求失败；主 apply 错误：request rejected`,
      );
      expect(alert).not.toHaveTextContent("回滚");
    },
  );
});
