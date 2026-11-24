import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NativeFleetStatus } from "./NativeFleetStatus.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows the fleet summary and next actions", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    host: { displayName: "alpha-check", overall: "drift", verified: true, trust: "verified" },
    hosts: { total: 2, drift: 1, unknown: 1, stale: 0, untrusted: 1 },
    pending: { dispatch: 1, alignment: 1 },
    systems: {
      connectors: { configured: 1, invalid: 0 },
      notifications: { adapters: 2, invalid: 0, failed: 1, unknown: 0 },
      presets: { installed: 1 },
      backups: { count: 2 },
      alignment: { failed: 0 },
    },
    nextActions: ["处理未信任或签名无效的远端清单", "等待人工批准待处理请求"],
  }), { status: 200 })));
  render(<NativeFleetStatus />);
  expect(await screen.findByText(/alpha-check · 已验证/u)).toBeVisible();
  expect(screen.getByText(/主机 2 · 漂移 1 · 未知 1 · 未信任 1/u)).toBeVisible();
  expect(screen.getByText(/待批准 2 · 云盘 1 · 通知 2\/失败 · 预设 1 · 快照 2/u)).toBeVisible();
  expect(screen.getByText("处理未信任或签名无效的远端清单")).toBeVisible();
  expect(screen.getByText("等待人工批准待处理请求")).toBeVisible();
});
