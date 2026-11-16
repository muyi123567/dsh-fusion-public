import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RemotePtySocket,
  closeRemotePty,
  createRemotePty,
  parsePtyServerMessage,
  ptyWebSocketUrl,
  type PtySocketLike,
} from "./pty-client.js";

const TOKEN = "A".repeat(43);

class FakeWebSocket implements PtySocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code, reason });
  });
  readonly send = vi.fn((data: string) => {
    this.sent.push(data);
  });
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  message(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  disconnect(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.querySelector("base[data-fusion-pty-test]")?.remove();
});

describe("PTY client protocol", () => {
  it("resolves terminal HTTP and WebSocket routes under the DSH document base", async () => {
    const base = document.createElement("base");
    base.dataset.fusionPtyTest = "true";
    base.href = "/dsh/";
    document.head.append(base);
    const input = { nodeId: "worker-1", cols: 100, rows: 30 };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        terminalId: "pty-prefix-1",
        terminalToken: TOKEN,
        ...input,
        state: "connected",
        snapshot: { sequence: 0, data: "", truncated: false },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await createRemotePty(input, fetchImpl);
    await closeRemotePty("pty-prefix-1", TOKEN, fetchImpl);
    expect(new URL(fetchImpl.mock.calls[0]![0], document.baseURI).pathname)
      .toBe("/dsh/plugins/dsh-fusion/pty/create");
    expect(new URL(fetchImpl.mock.calls[1]![0], document.baseURI).pathname)
      .toBe("/dsh/plugins/dsh-fusion/pty/close");
    const wsUrl = new URL(ptyWebSocketUrl());
    expect(wsUrl.pathname).toBe("/dsh/plugins/dsh-fusion/pty/ws");
    expect(wsUrl.host).toBe(window.location.host);
  });

  it("creates a terminal with the configured node and reports a 403 reason", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        terminalId: "pty-test-1",
        terminalToken: TOKEN,
        nodeId: "huawei-hs-monitor-cn",
        cols: 120,
        rows: 35,
        state: "connected",
        snapshot: { sequence: 0, data: "", truncated: false },
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "UNKNOWN_PTY_NODE" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }));

    await expect(createRemotePty({
      nodeId: "huawei-hs-monitor-cn",
      cols: 120,
      rows: 35,
    }, fetchImpl)).resolves.toMatchObject({
      terminalId: "pty-test-1",
      state: "connected",
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "plugins/dsh-fusion/pty/create", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: "huawei-hs-monitor-cn",
        cols: 120,
        rows: 35,
      }),
    });

    await expect(createRemotePty({
      nodeId: "tencent-worker",
      cols: 120,
      rows: 35,
    }, fetchImpl)).rejects.toMatchObject({
      code: "UNKNOWN_PTY_NODE",
      status: 403,
      userMessage: "该节点不支持远程终端，仅配置的华为云节点可用。",
    });
  });

  it.each([
    [401, "当前 DSH 会话未通过认证，请重新登录。"],
    [403, "当前请求被拒绝，无法访问远程终端。"],
    [404, "远程终端或接口不存在。"],
  ])("keeps HTTP %s terminal rejection distinct", async (status, userMessage) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "" }), {
      status,
      headers: { "content-type": "application/json" },
    }));
    await expect(createRemotePty({
      nodeId: "huawei-hs-monitor-cn",
      cols: 100,
      rows: 30,
    }, fetchImpl)).rejects.toMatchObject({
      status,
      userMessage,
    });
  });

  it("closes the host terminal with JSON and the same-origin credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      terminalId: "pty-test-1",
      closed: true,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await closeRemotePty("pty-test-1", TOKEN, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("plugins/dsh-fusion/pty/close", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminalId: "pty-test-1", terminalToken: TOKEN }),
    });
  });

  it("reassembles bounded snapshot chunks and forwards output bytes", () => {
    const socket = new FakeWebSocket();
    const snapshots: Array<{ data: Uint8Array; truncated: boolean }> = [];
    const outputs: Uint8Array[] = [];
    const client = new RemotePtySocket("pty-test-1", TOKEN, {
      socketFactory: () => socket,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onOutput: (data) => outputs.push(data),
    });
    client.connect();
    socket.open();

    socket.message({
      type: "snapshot",
      terminalId: "pty-test-1",
      sequence: 4,
      data: Buffer.from("hello ").toString("base64"),
      offset: 0,
      total: 11,
      final: false,
      truncated: false,
    });
    socket.message({
      type: "snapshot",
      terminalId: "pty-test-1",
      sequence: 4,
      data: Buffer.from("world").toString("base64"),
      offset: 6,
      total: 11,
      final: true,
      truncated: false,
    });
    socket.message({
      type: "output",
      terminalId: "pty-test-1",
      sequence: 5,
      data: Buffer.from("!").toString("base64"),
      offset: 0,
      total: 1,
      final: true,
    });

    expect(new TextDecoder().decode(snapshots[0]?.data)).toBe("hello world");
    expect(snapshots[0]?.truncated).toBe(false);
    expect(outputs.map((value) => new TextDecoder().decode(value))).toEqual(["!"]);
  });

  it("sends input, resize, and close as bounded JSON text frames", () => {
    const socket = new FakeWebSocket();
    const client = new RemotePtySocket("pty-test-1", TOKEN, {
      socketFactory: () => socket,
    });
    client.connect();
    socket.open();

    client.sendInput(Buffer.from("hostname\n"));
    client.sendResize(132, 43);
    client.sendClose();

    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "auth", terminalId: "pty-test-1", terminalToken: TOKEN },
      { type: "input", data: Buffer.from("hostname\n").toString("base64") },
      { type: "resize", cols: 132, rows: 43 },
      { type: "close", terminalToken: TOKEN },
    ]);
  });

  it("reconnects after an unexpected close and can be disposed cleanly", () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const states: string[] = [];
    const client = new RemotePtySocket("pty-test-1", TOKEN, {
      socketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      onState: (state) => states.push(state),
    });
    client.connect();
    sockets[0]?.open();
    sockets[0]?.disconnect();
    expect(states.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    expect(states.at(-1)).toBe("connected");

    client.dispose();
    expect(sockets[1]?.close).toHaveBeenCalledWith(1000, "PTY_CLIENT_DISPOSED");
    expect(states.at(-1)).toBe("closed");
  });

  it("turns 4401/4403/4404 rejection closes into fatal errors without reconnecting", () => {
    vi.useFakeTimers();
    for (const code of [4401, 4403, 4404]) {
      const sockets: FakeWebSocket[] = [];
      const states: string[] = [];
      const errors: string[] = [];
      const client = new RemotePtySocket("pty-test-1", TOKEN, {
        socketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
        onState: (state) => states.push(state),
        onError: (errorCode) => errors.push(errorCode),
      });
      client.connect();
      sockets[0]?.open();
      sockets[0]?.disconnect(code);
      expect(states.at(-1)).toBe("error");
      expect(errors.at(-1)).toMatch(/AUTHENTICATION|CAPABILITY|UNKNOWN/);
      vi.advanceTimersByTime(10_000);
      expect(sockets).toHaveLength(1);
    }
  });

  it("builds a same-origin WebSocket URL and rejects malformed server frames", () => {
    expect(ptyWebSocketUrl({
      protocol: "https:",
      host: "fusion.example:8443",
    })).toBe("wss://fusion.example:8443/plugins/dsh-fusion/pty/ws");

    expect(() => parsePtyServerMessage(JSON.stringify({
      type: "output",
      terminalId: "other",
      sequence: 1,
      data: "",
      offset: 0,
      total: 1,
      final: true,
    }))).toThrow("PTY_SERVER_MESSAGE_INVALID");
  });
});
