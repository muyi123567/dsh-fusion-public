import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalTabs } from "./TerminalTabs.js";

const xterm = vi.hoisted(() => ({
  terminals: [] as Array<{
    options: Record<string, unknown> | undefined;
    cols: number;
    rows: number;
    writes: Uint8Array[];
    disposed: boolean;
    dataHandler: ((data: string) => void) | undefined;
    resizeHandler: ((size: { cols: number; rows: number }) => void) | undefined;
    open: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    onResize: ReturnType<typeof vi.fn>;
  }>,
  fits: [] as Array<{ fit: ReturnType<typeof vi.fn> }>,
}));
const TOKEN = "A".repeat(43);

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown> | undefined;
    cols = 100;
    rows = 30;
    writes: Uint8Array[] = [];
    disposed = false;
    dataHandler: ((data: string) => void) | undefined = undefined;
    resizeHandler: ((size: { cols: number; rows: number }) => void) | undefined = undefined;
    readonly open = vi.fn();
    readonly loadAddon = vi.fn();
    readonly focus = vi.fn();
    readonly write = vi.fn((data: Uint8Array | string) => {
      this.writes.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
    });
    readonly reset = vi.fn();
    readonly dispose = vi.fn(() => {
      this.disposed = true;
    });
    readonly onData = vi.fn((handler: (data: string) => void) => {
      this.dataHandler = handler;
      return {
        dispose: () => {
          this.dataHandler = undefined;
        },
      };
    });
    readonly onResize = vi.fn((handler: (size: { cols: number; rows: number }) => void) => {
      this.resizeHandler = handler;
      return {
        dispose: () => {
          this.resizeHandler = undefined;
        },
      };
    });

    constructor(options?: Record<string, unknown>) {
      this.options = options;
      xterm.terminals.push(this);
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    readonly fit = vi.fn();
    constructor() {
      xterm.fits.push(this);
    }
  },
}));

class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  readonly close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = 3;
    this.emit("close", {});
  });

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  disconnect(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function createdTerminal(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    terminalId: "pty-test-1",
    terminalToken: TOKEN,
    nodeId: "huawei-hs-monitor-cn",
    cols: 100,
    rows: 30,
    state: "connected",
    snapshot: { sequence: 0, data: "", truncated: false },
    ...overrides,
  }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  xterm.terminals.length = 0;
  xterm.fits.length = 0;
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TerminalTabs", () => {
  it("creates the xterm with screen reader mode so terminal output is announced", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pty/create")) return createdTerminal();
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(
      <TerminalTabs
        remotePtyEnabled
        servers={[{
          id: "huawei-hs-monitor-cn",
          name: "华为云",
          status: "online",
          username: "root",
        }]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "打开 华为云 终端" }));
    expect(await screen.findByRole("tab", { name: "华为云" })).toBeInTheDocument();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0]?.open();
    FakeWebSocket.instances[0]?.message({
      type: "state",
      terminalId: "pty-test-1",
      sequence: 0,
      state: "connected",
    });
    await waitFor(() => expect(xterm.terminals).toHaveLength(1));
    expect(xterm.terminals[0]?.options?.screenReaderMode).toBe(true);
  });

  it("creates a PTY, drives xterm input/resize, and closes the host session", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pty/create")) return createdTerminal();
      if (url.endsWith("/pty/close")) {
        return new Response(JSON.stringify({ terminalId: "pty-test-1", closed: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(
      <TerminalTabs
        remotePtyEnabled
        servers={[{
          id: "huawei-hs-monitor-cn",
          name: "华为云",
          status: "online",
          username: "root",
        }]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "打开 华为云 终端" }));
    expect(await screen.findByRole("tab", { name: "华为云" })).toHaveAttribute("aria-selected", "true");
    expect(fetchImpl).toHaveBeenCalledWith("plugins/dsh-fusion/pty/create", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
    }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(FakeWebSocket.instances[0]?.url).toBe(
      "ws://localhost:3000/plugins/dsh-fusion/pty/ws",
    );

    FakeWebSocket.instances[0]?.open();
    FakeWebSocket.instances[0]?.message({
      type: "state",
      terminalId: "pty-test-1",
      sequence: 0,
      state: "connected",
    });
    await waitFor(() => expect(screen.getByText("已连接")).toBeInTheDocument());
    const terminal = xterm.terminals[0]!;
    FakeWebSocket.instances[0]?.message({
      type: "snapshot",
      terminalId: "pty-test-1",
      sequence: 2,
      data: btoa("root@host:~# "),
      offset: 0,
      total: 13,
      final: true,
      truncated: false,
    });
    await waitFor(() => expect(terminal.writes.length).toBeGreaterThan(0));

    terminal.dataHandler?.("whoami\n");
    terminal.resizeHandler?.({ cols: 132, rows: 43 });
    expect(FakeWebSocket.instances[0]?.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "auth", terminalId: "pty-test-1", terminalToken: TOKEN },
      { type: "resize", cols: 100, rows: 30 },
      { type: "input", data: btoa("whoami\n") },
      { type: "resize", cols: 132, rows: 43 },
    ]);

    await userEvent.click(screen.getByRole("button", { name: "关闭 华为云" }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledWith(
      "plugins/dsh-fusion/pty/close",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ terminalId: "pty-test-1", terminalToken: TOKEN }),
      }),
    ));
    await waitFor(() => expect(terminal.disposed).toBe(true));
  });

  it("shows the explicit 403 reason for an unsupported node", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "UNKNOWN_PTY_NODE",
    }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })));
    render(
      <TerminalTabs
        remotePtyEnabled
        servers={[{ id: "tencent", name: "腾讯 Worker", status: "online" }]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "打开 腾讯 Worker 终端" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "该节点不支持远程终端，仅配置的华为云节点可用。",
    );
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("reconnects the WebSocket without creating another PTY", async () => {
    const fetchImpl = vi.fn(async () => createdTerminal());
    vi.stubGlobal("fetch", fetchImpl);
    render(
      <TerminalTabs
        remotePtyEnabled
        servers={[{
          id: "huawei-hs-monitor-cn",
          name: "华为云",
          status: "online",
          username: "root",
        }]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "打开 华为云 终端" }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0]?.open();
    FakeWebSocket.instances[0]?.message({
      type: "state",
      terminalId: "pty-test-1",
      sequence: 0,
      state: "connected",
    });
    FakeWebSocket.instances[0]?.disconnect();
    expect(await screen.findByText("重新连接中")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新连接" }));

    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("closes every created PTY when the terminal page unmounts", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/pty/create")) return createdTerminal();
      return new Response(JSON.stringify({ terminalId: "pty-test-1", closed: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const view = render(
      <TerminalTabs
        remotePtyEnabled
        servers={[{
          id: "huawei-hs-monitor-cn",
          name: "华为云",
          status: "online",
          username: "root",
        }]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "打开 华为云 终端" }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const terminal = xterm.terminals[0]!;
    const socket = FakeWebSocket.instances[0]!;

    view.unmount();

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledWith(
      "plugins/dsh-fusion/pty/close",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ terminalId: "pty-test-1", terminalToken: TOKEN }),
      }),
    ));
    expect(terminal.disposed).toBe(true);
    expect(socket.close).toHaveBeenCalled();
  });
});
