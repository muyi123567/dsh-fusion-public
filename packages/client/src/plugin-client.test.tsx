import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FusionLauncher, FusionOverlay } from "../../plugin/src/client.js";
import { FusionApp } from "./app.js";

const stream = vi.hoisted(() => ({ onChange: () => {} }));
vi.mock("./stream/use-fusion-stream.js", () => ({
  useFusionStream: (options: { onChange: () => void }) => {
    stream.onChange = options.onChange;
    return { status: "disabled" };
  },
}));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); });

function state(name = "真实节点") {
  return {
    demo: false, bots: [], groups: [], sessions: [], tasks: [],
    nodes: [{ id: "node", externalId: "node", providerId: "test", name, platform: "linux", roles: ["worker"], status: "online", transports: [], capabilities: [], configState: "unknown" }],
    sessionHub: { provider: "available", sessions: [], sources: [], checkedAt: 1 },
  };
}

function previewResponse() {
  return { version: 1, checkedAt: Date.now(), expiresAt: Date.now() + 30_000,
    selectedNodeIds: ["node"], ready: false, scope: "infrastructure-only", businessRequirements: "unverified",
    nodes: [{ nodeId: "node", name: "真实节点", decision: "unknown", reasonCodes: ["PROBE_UNAVAILABLE"] }] };
}

describe("Fusion shared snapshots", () => {
  it.each(["json", "text"])("posts only selected node IDs and retries native HTTP failures (%s)", async (format) => {
    vi.stubEnv("MODE", "development");
    let checks = 0;
    const fetcher = vi.fn(async (url: string, _options?: RequestInit) => {
      if (url.endsWith("/tasks/preview")) {
        return checks++ === 0 ? new Response(format === "json" ? JSON.stringify({ error: "诊断 HTTP 503" }) : "unavailable", { status: 503 })
          : new Response(JSON.stringify(previewResponse()));
      }
      return new Response(JSON.stringify(state()));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<FusionApp initialMode="tasks" snapshotUrl="/plugins/dsh-fusion/state" />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await screen.findByRole("checkbox", { name: /真实节点/ });
    await userEvent.type(screen.getByLabelText("任务目标"), "不发送此目标");
    await userEvent.type(screen.getByLabelText("远程命令"), " PRIVATE-COMMAND");
    expect(checks).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "检查执行条件" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 503");
    await userEvent.click(screen.getByRole("button", { name: "检查执行条件" }));
    await screen.findByRole("region", { name: "执行基础检查预览" });
    const calls = fetcher.mock.calls.filter(([url]) => url.endsWith("/tasks/preview"));
    expect(calls).toHaveLength(2);
    for (const [url, options] of calls) {
      expect(url).toBe("plugins/dsh-fusion/tasks/preview");
      expect(options).toEqual({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeIds: ["node"] }) });
    }
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/tasks"))).toBe(false);
  });

  it("does not offer real capability diagnostics in standalone mode", async () => {
    render(<FusionApp initialMode="tasks" />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    expect(screen.getByRole("button", { name: "检查执行条件" })).toBeDisabled();
    expect(screen.getByText(/当前环境未连接执行条件检查/)).toBeInTheDocument();
  });

  it.each(["health", "error", "version", "generation"])("retains healthy provider clock updates but invalidates source %s changes", async (change) => {
    vi.stubEnv("MODE", "development");
    const source: { state: string; checkedAt: number; version: string; generation: number; error?: { code: string } } = {
      state: "connected", checkedAt: 1, version: "1", generation: 1,
    };
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/tasks/preview") ? previewResponse()
      : { ...state(), providers: { test: source } })));
    vi.stubGlobal("fetch", fetcher);
    render(<FusionApp initialMode="tasks" snapshotUrl="/plugins/dsh-fusion/state" />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await screen.findByRole("checkbox", { name: /真实节点/ });
    await userEvent.click(screen.getByRole("button", { name: "检查执行条件" }));
    await screen.findByRole("region", { name: "执行基础检查预览" });
    source.checkedAt = 2;
    await act(async () => { stream.onChange(); });
    expect(screen.getByRole("region", { name: "执行基础检查预览" })).toBeInTheDocument();
    if (change === "health") source.state = "offline";
    if (change === "error") source.error = { code: "PROVIDER_DISCONNECTED" };
    if (change === "version") source.version = "2";
    if (change === "generation") source.generation = 2;
    act(() => { stream.onChange(); });
    await waitFor(() => expect(screen.queryByRole("region", { name: "执行基础检查预览" })).not.toBeInTheDocument());
  });

  it("ignores a diagnostic response after changing snapshot scope", async () => {
    vi.stubEnv("MODE", "development");
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/tasks/preview")
      ? new Promise<Response>((yes) => { resolve = yes; }) : Promise.resolve(new Response(JSON.stringify(state())))));
    const view = render(<FusionApp initialMode="tasks" snapshotUrl="/plugins/dsh-fusion/state" />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    await screen.findByRole("checkbox", { name: /真实节点/ });
    await userEvent.click(screen.getByRole("button", { name: "检查执行条件" }));
    view.rerender(<FusionApp initialMode="tasks" snapshotUrl="/plugins/other/state" />);
    await act(async () => { resolve(new Response(JSON.stringify(previewResponse()))); });
    expect(screen.queryByRole("region", { name: "执行基础检查预览" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Workspace changed/)).not.toBeInTheDocument();
  });

  it("opens Bot task evidence in the central task workspace", async () => {
    render(<FusionApp />);
    await userEvent.click(screen.getByRole("button", { name: "任务证据" }));
    expect(screen.getByRole("heading", { name: "多机任务" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "任务详情" })).toHaveTextContent("T-demo-002");
  });

  it("keeps task details closed when leaving and returning to the task workspace", async () => {
    render(<FusionApp />);
    await userEvent.click(screen.getByRole("button", { name: "任务证据" }));
    await userEvent.click(screen.getByRole("button", { name: "关闭任务详情" }));
    await userEvent.click(screen.getByRole("button", { name: "节点" }));
    await userEvent.click(screen.getByRole("button", { name: "多机任务" }));
    expect(screen.queryByRole("region", { name: "任务详情" })).not.toBeInTheDocument();
  });

  it("shares the polling request with stream invalidations", async () => {
    vi.stubEnv("MODE", "development");
    vi.useFakeTimers();
    let resolvePoll!: (response: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state())))
      .mockReturnValueOnce(new Promise<Response>((yes) => { resolvePoll = yes; }))
      .mockResolvedValueOnce(new Response(JSON.stringify(state("轮询后刷新"))));
    vi.stubGlobal("fetch", fetcher);
    render(<FusionApp initialMode="fleet" snapshotUrl="/plugins/dsh-fusion/state" />);
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    act(() => { stream.onChange(); stream.onChange(); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => { resolvePoll(new Response(JSON.stringify(state()))); });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(screen.getAllByText("轮询后刷新").length).toBeGreaterThan(0);
  });

  it("presents the payload fleet block in the radar and clears it when the block disappears", async () => {
    vi.stubEnv("MODE", "development");
    let withFleet = true;
    const fleet = {
      checkedAt: Date.now(),
      stale: true,
      inspect: {
        totals: { attempts: 9, failures: 2 },
        lastRound: {
          round: 3, attempts: 5, failures: 2, peakQueueDepth: 3, startedAt: 0, durationMs: 45,
        },
      },
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(
      withFleet ? { ...state(), fleet } : state(),
    )));
    vi.stubGlobal("fetch", fetcher);
    render(<FusionApp initialMode="fleet" snapshotUrl="/plugins/dsh-fusion/state" />);
    expect(await screen.findByText(/快照已过期/)).toBeInTheDocument();
    expect(screen.getByText(/巡检累计 9 次 · 失败 2 次/)).toBeInTheDocument();

    withFleet = false;
    act(() => { stream.onChange(); });
    await waitFor(() => {
      expect(screen.queryByText(/快照已过期/)).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/巡检累计/)).not.toBeInTheDocument();
  });

  it("awaits a post-check snapshot when a pre-check read is still in flight", async () => {
    vi.stubEnv("MODE", "development");
    let resolveOld!: (response: Response) => void;
    let resolveNew!: (response: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state())))
      .mockReturnValueOnce(new Promise<Response>((yes) => { resolveOld = yes; }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" })))
      .mockReturnValueOnce(new Promise<Response>((yes) => { resolveNew = yes; }));
    vi.stubGlobal("fetch", fetcher);
    render(<FusionApp initialMode="fleet" snapshotUrl="/plugins/dsh-fusion/state" />);
    await screen.findAllByText("真实节点");
    act(() => { stream.onChange(); });
    await userEvent.click(screen.getByRole("button", { name: "配置检查" }));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "检查中…" })).toBeDisabled();
    await act(async () => { resolveOld(new Response(JSON.stringify(state("检查前读数")))); });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(screen.getByRole("button", { name: "检查中…" })).toBeDisabled();
    await act(async () => { resolveNew(new Response(JSON.stringify(state("检查后读数")))); });
    expect(screen.getByRole("button", { name: "配置检查" })).toBeEnabled();
    expect(screen.getAllByText("检查后读数").length).toBeGreaterThan(0);
  });

  it("opens a RunCenter task in the central task workspace", async () => {
    vi.stubEnv("MODE", "development");
    const task = { id: "bus:task", goal: "上游检查", targetNodeIds: ["node"], transport: "dsh-fleet", status: "running", evidence: [], createdAt: "2026-10-23", updatedAt: "2026-10-23" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...state(), tasks: [task],
      agentFlows: [{ id: "bus:flow", providerId: "agent-bus", name: "运行检查", workspacePath: "workspace", taskIds: [task.id], archived: false }],
    }))));
    render(<FusionApp initialMode="runs" snapshotUrl="/plugins/dsh-fusion/state" />);
    await userEvent.click(await screen.findByRole("button", { name: "查看任务 bus:task" }));
    expect(screen.getByRole("heading", { name: "多机任务" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "任务详情" })).toHaveTextContent("上游检查");
  });

  it("returns from an opened task to the same Run Center tab and flow", async () => {
    vi.stubEnv("MODE", "development");
    const task = { id: "bus:task", goal: "上游检查", targetNodeIds: ["node"], transport: "dsh-fleet", status: "completed", evidence: [], createdAt: "2026-10-23", updatedAt: "2026-10-23" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...state(), tasks: [task],
      agentFlows: [{ id: "bus:flow", providerId: "agent-bus", name: "运行检查", workspacePath: "workspace", taskIds: [task.id], archived: false }],
    }))));
    render(<FusionApp initialMode="runs" snapshotUrl="/plugins/dsh-fusion/state" />);
    // The completed run lives in history; open its task from there.
    await userEvent.click(await screen.findByRole("tab", { name: "历史" }));
    await userEvent.click(await screen.findByRole("button", { name: "查看任务 bus:task" }));
    expect(screen.getByRole("heading", { name: "多机任务" })).toBeInTheDocument();
    // The way back restores the origin page with its tab and flow.
    await userEvent.click(screen.getByRole("button", { name: /返回 Run Center/ }));
    expect(screen.getByRole("tab", { name: "历史" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".fusion-run-detail-head strong")).toHaveTextContent("运行检查");
    // The return affordance is spent: it does not linger.
    expect(screen.queryByRole("button", { name: /返回 Run Center/ })).not.toBeInTheDocument();
  });

  it("exposes the details drawer state and closes it with Escape", async () => {
    render(<FusionApp initialMode="bot" />);
    const toggle = screen.getByRole("button", { name: "打开详情" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "fusion-right-drawer");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(".fusion-drawer")).toHaveClass("is-mobile-open");
    await userEvent.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".fusion-drawer")).not.toHaveClass("is-mobile-open");
  });

  it("coalesces stream invalidations into one trailing authoritative snapshot", async () => {
    vi.stubEnv("MODE", "development");
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>((yes) => { resolve = yes; }))
      .mockResolvedValue(new Response(JSON.stringify(state("新快照"))));
    vi.stubGlobal("fetch", fetcher);
    render(<FusionApp initialMode="fleet" snapshotUrl="/plugins/dsh-fusion/state" />);
    act(() => { for (let index = 0; index < 10; index += 1) stream.onChange(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(new Response(JSON.stringify(state()))); });
    await waitFor(() => expect(screen.getAllByText("新快照").length).toBeGreaterThan(0));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("shares state.sessionHub with MissionControl without a second hub GET", async () => {
    vi.stubEnv("MODE", "development");
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/state") ? state() : state().sessionHub)));
    vi.stubGlobal("fetch", fetcher);
    render(<FusionApp initialMode="sessions" snapshotUrl="/plugins/dsh-fusion/state" />);
    await waitFor(() => expect(screen.getAllByText("真实节点").length).toBeGreaterThan(0));
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["plugins/dsh-fusion/state"]);
  });

  it("retains the session pane but disables prompt after shared snapshot failure", async () => {
    vi.stubEnv("MODE", "development");
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (!url.endsWith("/state")) return new Response(JSON.stringify({ messages: [], hasMore: false }));
      if (reads++ > 0) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({
        ...state(),
        sessionHub: { provider: "available", checkedAt: 1,
          sources: [{ sourceId: "dsh-local", state: "available", sessionCount: 1 }],
          sessions: [{ id: "dsh-local:native", sourceId: "dsh-local", nativeSessionId: "native", title: "共享会话", running: true, agentAvailable: true, blank: false, updatedAt: 1 }],
        },
      }));
    }));
    render(<FusionApp initialMode="sessions" snapshotUrl="/plugins/dsh-fusion/state" />);
    await userEvent.click(await screen.findByRole("button", { name: "共享会话" }));
    const input = screen.getByRole("textbox", { name: "输入 共享会话" });
    await userEvent.type(input, "保持草稿");
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    const layout = localStorage.getItem("dsh-fusion:mission-control:panes");
    expect(layout).toContain("dsh-local:native");
    act(() => { stream.onChange(); });
    await screen.findByText(/实时状态刷新失败/);
    expect(screen.getByRole("region", { name: "会话 共享会话" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "输入 共享会话" })).toHaveAttribute("readonly"));
    expect(screen.getByRole("textbox", { name: "输入 共享会话" })).toHaveValue("保持草稿");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(localStorage.getItem("dsh-fusion:mission-control:panes")).toBe(layout);
  });

  it("keeps last-known node state when a refresh fails instead of reporting it offline", async () => {
    vi.stubEnv("MODE", "development");
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (!url.endsWith("/state")) return new Response(JSON.stringify({ messages: [], hasMore: false }));
      if (reads++ > 0) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify(state()));
    }));
    render(<FusionApp initialMode="fleet" snapshotUrl="/plugins/dsh-fusion/state" />);
    await screen.findAllByText("真实节点");
    expect(screen.getAllByText("在线").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("离线")).toHaveLength(0);
    act(() => { stream.onChange(); });
    await screen.findByText(/实时状态刷新失败/);
    // The banner already promises the last data is retained;
    // unobservable must not be rewritten as proven offline.
    expect(screen.getByText(/保留的上次数据已标记为不可用/)).toBeInTheDocument();
    expect(screen.getAllByText("在线").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("离线")).toHaveLength(0);
  });

  it("checks real fleet health then refreshes and retains the last snapshot on refresh failure", async () => {
    vi.stubEnv("MODE", "development");
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state())))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" })))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    render(<FusionApp initialMode="fleet" snapshotUrl="/plugins/dsh-fusion/state" />);
    await screen.findAllByText("真实节点");
    await userEvent.click(screen.getByRole("button", { name: "配置检查" }));
    await screen.findByText(/实时状态刷新失败/);
    expect(screen.getAllByText("真实节点").length).toBeGreaterThan(0);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "plugins/dsh-fusion/state", "plugins/dsh-fusion/doctor", "plugins/dsh-fusion/state",
    ]);
  });

  it("shows the setup prompt when the authoritative snapshot has no bot or node", async () => {
    vi.stubEnv("MODE", "development");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ...state(),
        bots: [],
        nodes: [],
        config: {
          revision: "rev-1",
          hash: "sha256:config",
          pluginVersions: { "dsh-fusion": "0.2.0-beta.8" },
          nodeStates: {},
        },
      })),
    ));

    render(<FusionApp initialMode="bot" snapshotUrl="/plugins/dsh-fusion/state" />);
    const setupPrompt = await screen.findByRole("button", { name: "打开开箱检查" });
    await userEvent.click(setupPrompt);

    expect(screen.getByRole("heading", { name: "开箱检查" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加执行节点" })).toBeInTheDocument();
  });

  it("reports a degraded doctor response as a failed setup check", async () => {
    vi.stubEnv("MODE", "development");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(state())))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "degraded" })))
      .mockResolvedValueOnce(new Response(JSON.stringify(state())));
    vi.stubGlobal("fetch", fetcher);

    render(<FusionApp initialMode="setup" snapshotUrl="/plugins/dsh-fusion/state" />);
    await screen.findByRole("heading", { name: "开箱检查" });
    await userEvent.click(screen.getByRole("button", { name: "运行环境检查" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("fleet doctor degraded");
    expect(screen.queryByText("刚刚完成检查")).not.toBeInTheDocument();
  });

  it("aborts the prior URL and ignores its late response", async () => {
    vi.stubEnv("MODE", "development");
    let resolveOld!: (response: Response) => void;
    const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>((yes) => { resolveOld = yes; }))
      .mockResolvedValueOnce(new Response(JSON.stringify(state("新 URL 节点"))));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<FusionApp initialMode="fleet" snapshotUrl="/plugins/dsh-fusion/state" />);
    const signal = (fetcher.mock.calls[0]?.[1] as RequestInit).signal;
    view.rerender(<FusionApp initialMode="fleet" snapshotUrl="/plugins/other/state" />);
    expect(signal?.aborted).toBe(true);
    await screen.findAllByText("新 URL 节点");
    await act(async () => { resolveOld(new Response(JSON.stringify(state("旧 URL 节点")))); });
    expect(screen.queryByText("旧 URL 节点")).not.toBeInTheDocument();
  });
});

describe("DSH client slot components", () => {
  it("renders a valid launcher component", async () => {
    render(<FusionLauncher />);

    await userEvent.click(screen.getByRole("button", { name: "打开鲸插件" }));
    expect(screen.getByRole("button", { name: "打开鲸插件" })).toBeInTheDocument();
  });

  it("mounts and unmounts the overlay on the native toggle event", async () => {
    render(<FusionOverlay loadWorkspace={() => import("../../plugin/src/client.workspace.js")} />);
    expect(screen.queryByText("鲸")).not.toBeInTheDocument();

    window.dispatchEvent(new CustomEvent("dsh-fusion:toggle"));
    expect(await screen.findByText("鲸")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭鲸插件" }));
    expect(screen.queryByText("鲸")).not.toBeInTheDocument();
  });

  it("closes the overlay with Escape", async () => {
    render(<FusionOverlay loadWorkspace={() => import("../../plugin/src/client.workspace.js")} />);

    window.dispatchEvent(new CustomEvent("dsh-fusion:toggle"));
    expect(await screen.findByText("鲸")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("鲸")).not.toBeInTheDocument();
  });

  it("presents the overlay as a modal dialog and restores focus on close", async () => {
    render(
      <>
        <button type="button">宿主按钮</button>
        <FusionOverlay loadWorkspace={() => import("../../plugin/src/client.workspace.js")} />
      </>,
    );
    const hostButton = screen.getByRole("button", { name: "宿主按钮" });
    hostButton.focus();
    expect(hostButton).toHaveFocus();
    window.dispatchEvent(new CustomEvent("dsh-fusion:toggle"));
    expect(await screen.findByText("鲸")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "关闭鲸插件" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "关闭鲸插件" }));
    expect(screen.queryByText("鲸")).not.toBeInTheDocument();
    expect(hostButton).toHaveFocus();
  });

  it("keeps Tab focus inside the modal overlay", async () => {
    render(<FusionOverlay loadWorkspace={() => import("../../plugin/src/client.workspace.js")} />);
    window.dispatchEvent(new CustomEvent("dsh-fusion:toggle"));
    expect(await screen.findByText("鲸")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    const focusables = [...dialog.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")]
      .filter((element) => !element.hasAttribute("disabled"));
    expect(focusables.length).toBeGreaterThan(1);
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    expect(first).toHaveFocus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(last).toHaveFocus();
    await userEvent.keyboard("{Tab}");
    expect(first).toHaveFocus();
  });

  it("keeps non-tabbable elements out of the overlay trap cycle", async () => {
    render(<FusionOverlay loadWorkspace={() => import("../../plugin/src/client.workspace.js")} />);
    window.dispatchEvent(new CustomEvent("dsh-fusion:toggle"));
    expect(await screen.findByText("鲸")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    const realFocusables = [...dialog.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")]
      .filter((element) => !element.hasAttribute("disabled"));
    const first = realFocusables[0]!;
    const last = realFocusables[realFocusables.length - 1]!;

    // Elements that must never join the cycle, appended
    // after the real last element in DOM order.
    const ariaHiddenWrap = document.createElement("span");
    ariaHiddenWrap.setAttribute("aria-hidden", "true");
    ariaHiddenWrap.innerHTML = "<button type='button'>aria 隐藏</button>";
    const inertWrap = document.createElement("span");
    inertWrap.setAttribute("inert", "");
    inertWrap.innerHTML = "<button type='button'>inert</button>";
    const fieldset = document.createElement("fieldset");
    fieldset.disabled = true;
    fieldset.innerHTML = "<button type='button'>字段集</button>";
    const hiddenButton = document.createElement("button");
    hiddenButton.type = "button";
    hiddenButton.hidden = true;
    hiddenButton.textContent = "隐藏";
    dialog.append(ariaHiddenWrap, inertWrap, fieldset, hiddenButton);

    // Tab from the real last element still wraps to the
    // first: the injected elements do not count as the end
    // of the cycle.
    last.focus();
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
    expect(first).toHaveFocus();
    // And Shift+Tab from the first wraps to the real last,
    // not to an injected non-tabbable element.
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(last).toHaveFocus();
  });
});

describe("鲸群总览真实快照", () => {
  it("保留未配置来源的显式提示，不将HTTP200当作健康空板", async () => {
    vi.stubEnv("MODE", "development");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...state(), agentTeams: [],
      providers: {nodes:{state:"offline",checkedAt:1}, agentTeams:{state:"not-configured",checkedAt:1}},
    }))));
    render(<FusionApp initialMode="ocean" snapshotUrl="/plugins/dsh-fusion/state" />);
    await screen.findByText("团队来源未配置；请核对来源与权限。");
    expect(screen.getByText("主机来源不可达；请核对来源与权限。")).toBeInTheDocument();
    expect(screen.getByText(/来源未就绪/)).toBeInTheDocument();
  });

  it("从总览打开真实任务并可返回鲸群总览", async () => {
    vi.stubEnv("MODE", "development");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...state(), agentTeams: [],
      providers: {nodes:{state:"connected",checkedAt:1}, agentTeams:{state:"connected",checkedAt:1}},
      tasks: [{id:"whale-task-1",goal:"复核跨机证据",targetNodeIds:["node"],transport:"ssh",
        status:"verifying",evidence:[],expectedEvidence:[],createdAt:"2026-11-16T00:00:00Z",updatedAt:"2026-11-16T00:00:00Z"}],
    }))));
    render(<FusionApp initialMode="ocean" snapshotUrl="/plugins/dsh-fusion/state" />);
    await userEvent.click(await screen.findByRole("button",{name:"打开任务 复核跨机证据"}));
    const back=await screen.findByRole("button",{name:"← 返回 鲸群总览"});
    await userEvent.click(back);
    expect(await screen.findByRole("heading",{name:"深海舰桥"})).toBeInTheDocument();
  });
});

describe("鲸工作区嵌套浮层Escape",()=>{
  it("先保留主工作区供嵌套导航处理，再允许下一次Escape关闭",async()=>{
    const Workspace=()=> <div className="fusion-sidebar is-mobile-open">嵌套导航</div>;
    render(<><FusionLauncher/><FusionOverlay loadWorkspace={async()=>({FusionWorkspace:Workspace})}/></>);
    await userEvent.click(screen.getByRole("button",{name:"打开鲸插件"}));
    const nested=await screen.findByText("嵌套导航");
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog",{name:"鲸 · 深海工作区"})).toBeInTheDocument();
    nested.classList.remove("is-mobile-open");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog",{name:"鲸 · 深海工作区"})).not.toBeInTheDocument();
  });
});
