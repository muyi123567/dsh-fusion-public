import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeEnvironmentStrip } from "./NativeEnvironmentStrip.js";
import type { NativeEnvironmentView } from "./types.js";

const base: NativeEnvironmentView = {
  hostId: `sha256:${"a".repeat(64)}`,
  displayName: "worker-b",
  observedAt: "2026-11-22T10:00:00Z",
  digest: `sha256:${"a".repeat(64)}`,
  overall: "match",
  signed: true,
  stale: false,
  items: [],
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows a compact match state and the environment digest", () => {
  render(<NativeEnvironmentStrip environment={base} />);
  expect(screen.getByRole("status")).toHaveTextContent("环境匹配");
  expect(screen.getByTitle(base.digest)).toBeVisible();
});

it("expands drift items with severity, path and remedy", async () => {
  const user = userEvent.setup();
  render(<NativeEnvironmentStrip environment={{
    ...base,
    overall: "drift",
    items: [
      { code: "bundle.version", severity: "block", path: "bundles[dsh-fusion].version", expected: "0.2.0-beta.15", actual: "0.2.0-beta.14", remedy: "升级并重启" },
      { code: "provider.extra", severity: "warn", path: "providers", expected: ["deepseek"], actual: ["deepseek", "openai"] },
    ],
  }} />);
  expect(screen.getByRole("status")).toHaveTextContent("2 项");
  const toggle = screen.getByRole("button", { name: /环境/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("bundles[dsh-fusion].version")).toBeVisible();
  expect(screen.getByText("升级并重启")).toBeVisible();
  expect(screen.getByText("阻塞")).toBeVisible();
  expect(screen.getByText("提醒")).toBeVisible();
});

it("keeps unknown honest instead of rendering it as a match", () => {
  render(<NativeEnvironmentStrip environment={{ ...base, overall: "unknown", reason: "未配置期望环境" }} />);
  expect(screen.getByRole("status")).toHaveTextContent("环境未知");
  expect(screen.getByText("未配置期望环境")).toBeVisible();
  expect(screen.queryByText("环境匹配")).toBeNull();
});

it("runs the ecosystem doctor and shows blocking checks", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    overall: "fail",
    checks: [{ id: "mcp.endpoint", status: "fail", summary: "MCP 已启用但未监听", remedy: "检查端口占用" }],
    nextActions: ["检查端口占用"],
  }), { status: 200 })));
  render(<NativeEnvironmentStrip environment={base} />);
  await user.click(screen.getByRole("button", { name: "诊断" }));
  expect(await screen.findByText("诊断有阻塞")).toBeVisible();
  expect(screen.getByText("mcp.endpoint")).toBeVisible();
  expect(screen.getAllByText("检查端口占用").length).toBeGreaterThan(0);
});

it("loads an alignment plan without executing it", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    overall: "plan",
    steps: [{ id: "update:dsh-fusion", action: "update", target: "dsh-fusion", risk: "medium", requiresRestart: true, reason: "更新到 0.2.0-beta.15" }],
  }), { status: 200 })));
  render(<NativeEnvironmentStrip environment={base} />);
  await user.click(screen.getByRole("button", { name: "对齐计划" }));
  expect(await screen.findByText("对齐计划 · 1 步")).toBeVisible();
  expect(screen.getByText("dsh-fusion")).toBeVisible();
  expect(screen.getByText("更新到 0.2.0-beta.15")).toBeVisible();
  expect(screen.getByText("需要重启 profile")).toBeVisible();
});

it("saves the current environment as the expected baseline", async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
    hostId: base.hostId, digest: base.digest, path: "/tmp/expected-manifest.json",
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  render(<NativeEnvironmentStrip environment={base} />);
  await user.click(screen.getByRole("button", { name: "保存为期望" }));
  expect(await screen.findByText("已保存期望环境。")).toBeVisible();
  expect(fetcher.mock.calls[0]?.[0]).toContain("/fleet/expected");
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ hostId: base.hostId });
});
