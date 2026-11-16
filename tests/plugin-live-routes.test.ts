import { createServer } from "node:http";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as hostPlugin from "../packages/plugin/src/index.js";
import type { FusionStatus } from "../packages/plugin/src/index.js";
import { FleetRouter } from "../packages/plugin/src/fleet-router.js";

const requireFromPlugin = createRequire(
  new URL("../packages/plugin/package.json", import.meta.url),
);
const { WebSocket: PluginWebSocket } = requireFromPlugin("ws") as {
  WebSocket: new (url: string, options?: Record<string, unknown>) => {
    on: (event: string, listener: (...args: any[]) => void) => void;
    once: (event: string, listener: (...args: any[]) => void) => void;
    send: (data: string) => void;
    close: () => void;
    terminate: () => void;
  };
};

interface CapturedRoute {
  kind: string;
  path: string;
  handler: (
    request: {
      method?: string;
      url?: string;
      headers?: Record<string, string | string[] | undefined>;
      on?: (event: string, listener: () => void) => void;
      [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
    },
    response: {
      writeHead: (status: number, headers?: Record<string, string>) => void;
      end: (body?: string) => void;
      write?: (chunk: string) => boolean;
      on?: (event: string, listener: () => void) => void;
    },
  ) => void | Promise<void>;
}

interface CapturedUpgradeRoute {
  path: string;
  handler: (
    request: {
      method?: string;
      url?: string;
      headers?: Record<string, string | string[] | undefined>;
    },
    socket: {
      write: (chunk: string) => boolean;
      end: (chunk: string) => void;
      destroy: () => void;
    },
    head: Buffer,
  ) => void | Promise<void>;
}

interface Harness {
  routes: CapturedRoute[];
  upgrades: CapturedUpgradeRoute[];
  tools: Array<{ name: string }>;
  closeListeners: Array<() => void>;
  /** The disposers the plugin collected through `ctx.effect`. */
  disposers: Array<() => void>;
  events: Map<string, Set<(...args: unknown[]) => void>>;
}

async function applyPlugin(options: {
  rejection?: 401 | 403;
  harness?: Harness;
  sessionController?: {
    list: (
      request: Record<string, never>,
      signal: AbortSignal,
    ) => Promise<{ items: Array<Record<string, unknown>> }>;
    projections: (
      request: { sessionId: string },
      signal: AbortSignal,
    ) => Promise<{ asOfSeq: number; values: Record<string, unknown> } | null>;
    page: (
      request: {
        address: Record<string, unknown>;
        throughSeq: number;
        maxMessages?: number;
      },
      signal: AbortSignal,
    ) => Promise<{ records: Array<Record<string, unknown>>; hasMore: boolean }>;
    prompt: (
      request: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<{ accepted: true }>;
  };
  config?: Record<string, unknown>;
} = {}): Promise<Harness> {
  const harness: Harness = options.harness ?? {
    routes: [],
    upgrades: [],
    tools: [],
    closeListeners: [],
    disposers: [],
    events: new Map(),
  };
  const ctx = {
    tools: {
      register(tool: { name: string }) {
        harness.tools.push(tool);
        return () => {
          harness.tools = harness.tools.filter((entry) => entry !== tool);
        };
      },
      guard() {
        return () => {};
      },
    },
    get(name: string) {
      if (name === "webServer") {
        return {
          register(route: CapturedRoute) {
            harness.routes.push(route);
            return () => {
              harness.routes = harness.routes.filter((entry) => entry !== route);
            };
          },
          registerUpgrade(route: CapturedUpgradeRoute) {
            harness.upgrades.push(route);
            return () => {
              harness.upgrades = harness.upgrades.filter((entry) => entry !== route);
            };
          },
        };
      }
      if (name === "connection") {
        return {
          requestRejection: () => options.rejection,
        };
      }
      if (name === "sessionController") {
        return options.sessionController;
      }
      return undefined;
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      const listeners = harness.events.get(event) ?? new Set();
      listeners.add(listener);
      harness.events.set(event, listeners);
      return () => {
        listeners.delete(listener);
      };
    },
    effect(callback: () => unknown) {
      const disposer = callback();
      if (typeof disposer === "function") {
        const run = disposer as () => void;
        harness.disposers.push(run);
        return () => {
          harness.disposers = harness.disposers.filter((entry) => entry !== run);
          run();
        };
      }
      return () => {};
    },
  } as unknown as Parameters<typeof hostPlugin.apply>[0];

  await hostPlugin.apply(ctx, {
    dshVersion: "0.2.0-rc.2",
    standalone: false,
    ...options.config,
  });
  return harness;
}

function createResponse(harness: Harness) {
  const state = {
    status: 0,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    body: "",
    endCalls: 0,
  };
  return {
    state,
    response: {
      writeHead(nextStatus: number, nextHeaders: Record<string, string> = {}) {
        state.status = nextStatus;
        state.headers = nextHeaders;
      },
      end(nextBody?: string) {
        state.endCalls += 1;
        state.body = nextBody ?? "";
      },
      write(chunk: string) {
        state.chunks.push(chunk);
        return true;
      },
      on(event: string, listener: () => void) {
        if (event === "close") harness.closeListeners.push(listener);
      },
    },
  };
}

function jsonRequest(
  body: unknown,
  headers: Record<string, string> = {},
) {
  const encoded = JSON.stringify(body);
  return {
    method: "POST",
    headers: {
      host: "127.0.0.1:8787",
      origin: "http://127.0.0.1:8787",
      "content-type": "application/json",
      ...headers,
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(encoded);
    },
  };
}

function fakePtyService() {
  const listeners = new Set<(event: unknown) => void>();
  const terminal = {
    id: "pty-test-1",
    state: "connected" as const,
    sequence: 0,
    snapshot: () => ({
      sequence: 0,
      data: Buffer.alloc(0),
      truncated: false,
      state: "connected" as const,
    }),
    subscribe: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
  };
  return {
    terminal,
    emit(event: unknown) {
      for (const listener of listeners) listener(event);
    },
    service: {
      create: vi.fn(async () => terminal),
      get: vi.fn((terminalId: string) => terminalId === terminal.id ? terminal : undefined),
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
      dispose: vi.fn(),
      activeCount: 1,
    },
  };
}

function upgradeSocket() {
  const writes: string[] = [];
  return {
    writes,
    socket: {
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
      end(chunk: string) {
        writes.push(chunk);
      },
      destroy: vi.fn(),
    },
  };
}

function fakePtyWebSocketServer() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn((_code?: number, _reason?: string) => {
      socket.readyState = 3;
      emit("close");
    }),
    terminate: vi.fn(() => {
      socket.readyState = 3;
      emit("close");
    }),
    on(event: string, listener: (...args: any[]) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    once(event: string, listener: (...args: any[]) => void) {
      const wrapped = (...args: any[]) => {
        listeners.get(event)?.delete(wrapped);
        listener(...args);
      };
      const set = listeners.get(event) ?? new Set();
      set.add(wrapped);
      listeners.set(event, set);
    },
  };
  const emit = (event: string, ...args: any[]) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
  };
  let accepted: typeof socket | undefined;
  const server = {
    handleUpgrade: vi.fn((
      _request: unknown,
      _networkSocket: unknown,
      _head: Buffer,
      callback: (webSocket: typeof socket) => void,
    ) => {
      accepted = socket;
      callback(socket);
    }),
  };
  return {
    server,
    socket,
    get accepted() {
      return accepted;
    },
    emitMessage(value: unknown) {
      emit("message", Buffer.from(JSON.stringify(value)), false);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DSH Fusion execution preview route", () => {
  let harness: Harness | undefined;
  afterEach(() => {
    harness?.disposers.forEach((dispose) => dispose());
    harness = undefined;
    vi.restoreAllMocks();
  });

  async function setup(rejection?: 401 | 403) {
    vi.useFakeTimers();
    const nodes = ["n1", "n2"].map((id) => ({ id, externalId: id, providerId: `huawei-ssh:${id}`, name: id,
      platform: "linux" as const, roles: ["worker" as const], status: "online" as const,
      transports: ["ssh" as const], capabilities: [], configState: "unknown" as const }));
    const listNodes = vi.spyOn(FleetRouter.prototype, "listNodes").mockResolvedValue(nodes);
    vi.spyOn(FleetRouter.prototype, "health").mockResolvedValue({ state: "connected", checkedAt: Date.now() });
    vi.spyOn(FleetRouter.prototype, "providerHealth").mockResolvedValue({});
    vi.spyOn(FleetRouter.prototype, "readLiveTasks").mockResolvedValue([]);
    const probe = vi.spyOn(FleetRouter.prototype, "probeExecCapabilities").mockImplementation(async (ids) =>
      ids.map((nodeId) => ({ nodeId, providerId: `huawei-ssh:${nodeId}`, state: "supported" as const,
        checkedAt: Date.now(), expiresAt: Date.now() + 30_000, source: "fixture",
        checks: [{ id: "bash", ok: true }], reasonCodes: [] })));
    const dispatch = vi.spyOn(FleetRouter.prototype, "dispatch");
    harness = await applyPlugin({ ...(rejection === undefined ? {} : { rejection }), config: {
      sshNodes: ["n1", "n2"].map((nodeId) => ({ nodeId, host: "fixture.invalid", keyPath: "fixture-key",
        knownHostsPath: "fixture-known-hosts" })),
    } });
    const route = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/tasks/preview");
    expect(route, "preview route must be registered").toBeDefined();
    listNodes.mockClear();
    return { route: route!, harness, probe, dispatch, listNodes };
  }

  it.each([401, 403] as const)("preserves authentication rejection %s without diagnostics", async (code) => {
    const f = await setup(code);
    const reply = createResponse(f.harness);
    await f.route.handler(jsonRequest({ nodeIds: ["n1"] }), reply.response);
    expect(reply.state.status).toBe(code);
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.listNodes).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { method: "GET", headers: {}, status: 405 },
    { method: "POST", headers: { origin: "https://cross-site.invalid" }, status: 403 },
    { method: "POST", headers: { "content-type": "text/plain" }, status: 415 },
  ])("rejects method/origin/content type before diagnostics: %j", async ({ method, headers, status }) => {
    const f = await setup();
    const reply = createResponse(f.harness);
    await f.route.handler({ ...jsonRequest({ nodeIds: ["n1"] }, headers as Record<string, string>), method }, reply.response);
    expect(reply.state.status).toBe(status);
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.listNodes).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it.each([{}, { nodeIds: [] }, { nodeIds: ["n1", 3] }, { nodeIds: [""] },
    { nodeIds: ["n1", "unknown"] }, { nodeIds: ["a".repeat(201)] },
    { nodeIds: Array(101).fill("n1") }, { nodeIds: ["n1"], command: "uname -a" },
  ])("rejects invalid preview payload without diagnostics: %j", async (body) => {
    const f = await setup();
    const reply = createResponse(f.harness);
    await f.route.handler(jsonRequest(body), reply.response);
    expect(reply.state.status).toBe(400);
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.listNodes).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it.each(["{invalid", JSON.stringify({ nodeIds: ["n1"], padding: "a".repeat(65_536) })])(
    "rejects malformed or oversized JSON before diagnostics", async (raw) => {
      const f = await setup();
      const reply = createResponse(f.harness);
      await f.route.handler({ ...jsonRequest({}), async *[Symbol.asyncIterator]() { yield Buffer.from(raw); } }, reply.response);
      expect(reply.state.status).toBe(400);
      expect(f.probe).not.toHaveBeenCalled();
      expect(f.listNodes).not.toHaveBeenCalled();
      expect(f.dispatch).not.toHaveBeenCalled();
    });

  it("returns a deduplicated infrastructure diagnostic and never dispatches", async () => {
    const f = await setup();
    const reply = createResponse(f.harness);
    await f.route.handler(jsonRequest({ nodeIds: ["n2", "n1", "n2"] }), reply.response);
    expect(reply.state.status).toBe(200);
    expect(JSON.parse(reply.state.body)).toMatchObject({ version: 1, selectedNodeIds: ["n2", "n1"], ready: true,
      scope: "infrastructure-only", businessRequirements: "unverified" });
    expect(f.probe).toHaveBeenCalledExactlyOnceWith(["n2", "n1"]);
    expect(f.listNodes).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("returns mixed readiness without narrowing the selection or dispatching", async () => {
    const f = await setup();
    f.probe.mockResolvedValue([{
      nodeId: "n1", providerId: "huawei-ssh:n1", state: "unsupported", checkedAt: Date.now(),
      expiresAt: Date.now() + 30_000, source: "fixture", reasonCodes: ["MISSING_TOOL"], checks: [{ id: "bash", ok: false }],
    }]);
    const reply = createResponse(f.harness);
    await f.route.handler(jsonRequest({ nodeIds: ["n1", "n2"] }), reply.response);
    expect(reply.state.status).toBe(200);
    const body = JSON.parse(reply.state.body);
    expect(body.ready).toBe(false);
    expect(body.selectedNodeIds).toEqual(["n1", "n2"]);
    expect(body.nodes.map((node: { decision: string }) => node.decision)).toEqual(["blocked", "unknown"]);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});

describe("DSH Fusion live routes", () => {
  it("adds local Session Hub data to /state while preserving bridge sessions", async () => {
    const harness = await applyPlugin({
      sessionController: {
        list: async () => ({
          items: [{
            sessionId: "local-1",
            running: false,
            agentAvailable: false,
            blank: true,
            updatedAt: 1_760_000_000_000,
            cwd: "F:\\AI",
            projections: {
              kind: "cached",
              asOfSeq: 3,
              values: {},
            },
          }],
        }),
        projections: async () => null,
        page: async () => ({ records: [], hasMore: false }),
      },
    });
    const stateRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/state");
    if (stateRoute === undefined) throw new Error("state route missing");

    const response = createResponse(harness);
    await stateRoute.handler({ method: "GET", headers: {} }, response.response);
    const body = JSON.parse(response.state.body) as {
      sessions: unknown[];
      sessionHub: {
        provider: string;
        sessions: Array<{
          id: string;
          title: string;
          parentNativeId?: string;
          subagentMode?: string;
        }>;
      };
    };

    expect(response.state.status).toBe(200);
    expect(body.sessions).toEqual(expect.any(Array));
    expect(body.sessionHub.provider).toBe("available");
    expect(body.sessionHub.sessions).toContainEqual(expect.objectContaining({
      id: "dsh-local:local-1",
      title: "未命名会话 · AI",
    }));
  });

  it("serves a standalone Session Hub snapshot and marks a missing DSH service unavailable", async () => {
    const enabled = await applyPlugin({
      sessionController: {
        list: async () => ({ items: [] }),
        projections: async () => null,
        page: async () => ({ records: [], hasMore: false }),
      },
    });
    const enabledRoute = enabled.routes.find((route) => route.path === "/plugins/dsh-fusion/session-hub");
    if (enabledRoute === undefined) throw new Error("session hub route missing");
    const enabledResponse = createResponse(enabled);
    await enabledRoute.handler({ method: "GET", headers: {} }, enabledResponse.response);
    expect(JSON.parse(enabledResponse.state.body)).toMatchObject({
      provider: "available",
      sessions: [],
    });

    const disabled = await applyPlugin();
    const disabledRoute = disabled.routes.find((route) => route.path === "/plugins/dsh-fusion/session-hub");
    if (disabledRoute === undefined) throw new Error("session hub route missing");
    const disabledResponse = createResponse(disabled);
    await disabledRoute.handler({ method: "GET", headers: {} }, disabledResponse.response);
    expect(JSON.parse(disabledResponse.state.body)).toMatchObject({
      provider: "unavailable",
      sessions: [],
    });
  });

  it("maps bounded subagent history without exposing unknown tool payloads", async () => {
    const page = vi.fn(async () => ({
      hasMore: false,
      records: [
        {
          type: "event",
          event: {
            type: "tool/call",
            seq: 8,
            time: 1_760_000_008_000,
            data: {
              arguments: "{\"secret\":\"tool-args\"}",
              message: {
                role: "user",
                content: [{ type: "text", text: "未知事件不得输出" }],
              },
            },
          },
        },
        {
          type: "event",
          event: {
            type: "user/message",
            seq: 9,
            time: 1_760_000_009_000,
            data: {
              message: {
                role: "assistant",
                content: [{ type: "text", text: "继续" }],
              },
            },
          },
        },
        {
          type: "event",
          event: {
            type: "assistant/message",
            seq: 10,
            time: 1_760_000_010_000,
            data: {
              message: {
                role: "user",
                content: [{ type: "text", text: "完成" }],
              },
            },
          },
        },
      ],
    }));
    const harness = await applyPlugin({
      sessionController: {
        list: async () => ({
          items: [{
            sessionId: "child-1",
            parentSessionId: "parent-1",
            origin: "subagent",
            running: true,
            agentAvailable: true,
            blank: false,
            updatedAt: 1_760_000_010_000,
            projections: { kind: "sequenced", asOfSeq: 10, values: {} },
          }],
        }),
        projections: async () => ({ asOfSeq: 10, values: {} }),
        page,
      },
    });
    const route = harness.routes.find((item) => item.path === "/plugins/dsh-fusion/session-hub/history");
    if (route === undefined) throw new Error("session history route missing");

    const response = createResponse(harness);
    await route.handler({
      method: "GET",
      url: "/plugins/dsh-fusion/session-hub/history?sourceId=dsh-local&sessionId=child-1&maxMessages=2",
      headers: {},
    }, response.response);
    const text = response.state.body;

    expect(response.state.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      messages: [
        { role: "user", text: "继续", seq: 9, time: 1_760_000_009_000 },
        { role: "assistant", text: "完成", seq: 10, time: 1_760_000_010_000 },
      ],
      hasMore: false,
      asOfSeq: 10,
    });
    expect(text).not.toContain("tool-args");
    expect(text).not.toContain("未知事件不得输出");
    expect(page).toHaveBeenCalledWith({
      address: {
        kind: "subagent",
        parentSessionId: "parent-1",
        childSessionId: "child-1",
        mode: "unknown",
      },
      throughSeq: 10,
      maxMessages: 2,
    }, expect.any(AbortSignal));
  });

  it("counts the read fan-out of state, session-hub, and history GETs on the state payload", async () => {
    const hits = new Map<string, number>();
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
      response.writeHead(200, { "content-type": "application/json" });
      if (url.pathname === "/plugins/dsh-agent-teams/state" && url.search === "?archived=1") {
        response.end(JSON.stringify({ teams: [] }));
      } else if (url.pathname === "/plugins/dsh-agent-teams/state") {
        response.end(JSON.stringify({
          teams: [{
            teamId: "release",
            name: "Release Team",
            captainSessionId: "session-cap",
            phase: "running",
            members: [],
            tasks: [],
          }],
        }));
      } else if (url.pathname === "/plugins/dsh-agent-bus/state") {
        response.end(JSON.stringify({ sessions: [], tasks: [], flows: [] }));
      } else if (url.pathname === "/agent-team-room/api/session/session-cap") {
        response.end(JSON.stringify({ rooms: [] }));
      } else {
        response.writeHead(404);
        response.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("listen address missing");
    try {
      // The bridge round cache runs on an injected clock:
      // this scenario asserts one shared round across four
      // GETs and must not depend on the real 2s TTL elapsing
      // (or not) while the test machine is loaded.
      let fakeNow = 1_700_000_000_000;
      const harness = await applyPlugin({
        config: {
          webBaseUrl: `http://127.0.0.1:${address.port}`,
          bridgeRoundCache: { ttlMs: 2_000, now: () => fakeNow },
        },
        sessionController: {
          list: async () => ({
            items: [{
              sessionId: "local-1",
              running: true,
              agentAvailable: true,
              blank: false,
              updatedAt: 1_760_000_000_000,
              projections: { kind: "sequenced", asOfSeq: 10, values: {} },
            }],
          }),
          projections: async () => ({ asOfSeq: 10, values: {} }),
          page: async () => ({ records: [], hasMore: false }),
          prompt: async () => ({ accepted: true }),
        },
      });
      const route = (path: string) => {
        const found = harness.routes.find((item) => item.path === path);
        if (found === undefined) throw new Error(`route missing: ${path}`);
        return found;
      };
      const get = async (path: string, url = path) => {
        const response = createResponse(harness);
        await route(path).handler({ method: "GET", url, headers: {} }, response.response);
        return response;
      };

      const first = await get("/plugins/dsh-fusion/state");
      expect(first.state.status).toBe(200);
      expect(JSON.parse(first.state.body).reads).toEqual({
        routes: { state: 1, sessionHub: 0, history: 0 },
        loaders: { agentTeams: 1, agentBus: 1, room: 1 },
        bridgeHttp: {
          total: 4,
          byTemplate: {
            "/plugins/dsh-agent-teams/state": 2,
            "/plugins/dsh-agent-bus/state": 1,
            "/agent-team-room/api/session/{sessionId}": 1,
          },
        },
        controller: { list: 2, projections: 0, page: 0 },
      });

      const firstState = await get("/plugins/dsh-fusion/state");
      const firstProviders = JSON.parse(firstState.state.body).providers;
      expect(firstProviders.agentTeams.checkedAt).toBe(1_700_000_000_000);
      const hub = await get("/plugins/dsh-fusion/session-hub");
      // The hub list carries each session's history version
      // (from its sequenced projections) so clients can gate
      // history reads on it...
      const hubBody = JSON.parse(hub.state.body) as {
        sessions: Array<{ id: string; historySeq?: number }>;
      };
      expect(hubBody.sessions.find((session) => session.id === "dsh-local:local-1")?.historySeq)
        .toBe(10);
      const history = await get(
        "/plugins/dsh-fusion/session-hub/history",
        "/plugins/dsh-fusion/session-hub/history?sourceId=dsh-local&sessionId=local-1&maxMessages=2",
      );
      expect(history.state.status).toBe(200);
      // ...and the history read reports the version it is
      // consistent with.
      expect((JSON.parse(history.state.body) as { asOfSeq?: number }).asOfSeq).toBe(10);

      // Still inside the injected TTL, but 1.5s later: the
      // round is re-served from cache, and the providers'
      // checkedAt must stay at the round's actual fetch time
      // instead of being refreshed to the re-serve moment.
      fakeNow += 1_500;
      const third = await get("/plugins/dsh-fusion/state");
      expect(third.state.status).toBe(200);
      const thirdProviders = JSON.parse(third.state.body).providers;
      expect(thirdProviders.agentTeams.checkedAt).toBe(1_700_000_000_000);
      expect(thirdProviders.agentBus.checkedAt).toBe(1_700_000_000_000);
      expect(thirdProviders.room.checkedAt).toBe(1_700_000_000_000);
      const reads = JSON.parse(third.state.body).reads;
      // The four snapshots above all run inside one bridge
      // round's freshness window: the loaders are still invoked
      // per snapshot, but only the first round reaches the
      // bridges — the whole-round cache serves the rest.
      expect(reads).toEqual({
        routes: { state: 3, sessionHub: 1, history: 1 },
        loaders: { agentTeams: 4, agentBus: 4, room: 4 },
        bridgeHttp: {
          total: 4,
          byTemplate: {
            "/plugins/dsh-agent-teams/state": 2,
            "/plugins/dsh-agent-bus/state": 1,
            "/agent-team-room/api/session/{sessionId}": 1,
          },
        },
        controller: { list: 6, projections: 1, page: 1 },
      });
      // The server's own hit log is the ground truth for the HTTP layer.
      const serverHits = [...hits.values()].reduce((sum, count) => sum + count, 0);
      expect(serverHits).toBe(reads.bridgeHttp.total);
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });

  it("never serves one caller's bridge round to a caller with different credentials", async () => {
    const hits = new Map<string, number>();
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
      const tenant = request.headers.cookie?.includes("beta") ? "beta" : "alpha";
      response.writeHead(200, { "content-type": "application/json" });
      if (url.pathname === "/plugins/dsh-agent-teams/state" && url.search === "?archived=1") {
        response.end(JSON.stringify({ teams: [] }));
      } else if (url.pathname === "/plugins/dsh-agent-teams/state") {
        response.end(JSON.stringify({
          teams: [{
            teamId: `team-${tenant}`,
            name: `Team ${tenant}`,
            captainSessionId: "session-cap",
            phase: "running",
            members: [],
            tasks: [],
          }],
        }));
      } else if (url.pathname === "/plugins/dsh-agent-bus/state") {
        response.end(JSON.stringify({ sessions: [], tasks: [], flows: [] }));
      } else if (url.pathname === "/agent-team-room/api/session/session-cap") {
        response.end(JSON.stringify({ rooms: [] }));
      } else {
        response.writeHead(404);
        response.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("listen address missing");
    try {
      const harness = await applyPlugin({
        config: {
          webBaseUrl: `http://127.0.0.1:${address.port}`,
          // Frozen injected clock: cache behaviour in this
          // scenario must not depend on the real 2s TTL.
          bridgeRoundCache: { ttlMs: 2_000, now: () => 1_700_000_000_000 },
        },
      });
      const stateRoute = harness.routes.find((item) => item.path === "/plugins/dsh-fusion/state");
      if (stateRoute === undefined) throw new Error("state route missing");
      const getState = async (cookie: string) => {
        const response = createResponse(harness);
        await stateRoute.handler(
          { method: "GET", url: "/plugins/dsh-fusion/state", headers: { cookie } },
          response.response,
        );
        return response;
      };
      const totalHits = () => [...hits.values()].reduce((sum, count) => sum + count, 0);

      const alpha = await getState("session=alpha");
      expect(alpha.state.status).toBe(200);
      expect(JSON.stringify(JSON.parse(alpha.state.body).agentTeams)).toContain("team-alpha");
      expect(totalHits()).toBe(4);

      // A different credential must not be served alpha's round:
      // it fetches its own, and its payload carries only its own
      // tenant's data.
      const beta = await getState("session=beta");
      expect(beta.state.status).toBe(200);
      const betaTeams = JSON.stringify(JSON.parse(beta.state.body).agentTeams);
      expect(betaTeams).toContain("team-beta");
      expect(betaTeams).not.toContain("team-alpha");
      expect(totalHits()).toBe(8);

      // Repeating alpha inside the freshness window is served
      // alpha's own cached round — no new fetches, no beta data.
      const alphaAgain = await getState("session=alpha");
      const alphaTeams = JSON.stringify(JSON.parse(alphaAgain.state.body).agentTeams);
      expect(alphaTeams).toContain("team-alpha");
      expect(alphaTeams).not.toContain("team-beta");
      expect(totalHits()).toBe(8);
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });

  it("bypasses the bridge round cache for the doctor route without polluting it", async () => {
    const hits = new Map<string, number>();
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
      response.writeHead(200, { "content-type": "application/json" });
      if (url.pathname === "/plugins/dsh-agent-teams/state" && url.search === "?archived=1") {
        response.end(JSON.stringify({ teams: [] }));
      } else if (url.pathname === "/plugins/dsh-agent-teams/state") {
        response.end(JSON.stringify({
          teams: [{
            teamId: "release",
            name: "Release Team",
            captainSessionId: "session-cap",
            phase: "running",
            members: [],
            tasks: [],
          }],
        }));
      } else if (url.pathname === "/plugins/dsh-agent-bus/state") {
        response.end(JSON.stringify({ sessions: [], tasks: [], flows: [] }));
      } else if (url.pathname === "/agent-team-room/api/session/session-cap") {
        response.end(JSON.stringify({ rooms: [] }));
      } else {
        response.writeHead(404);
        response.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("listen address missing");
    try {
      const harness = await applyPlugin({
        config: {
          webBaseUrl: `http://127.0.0.1:${address.port}`,
          // Frozen injected clock: cache behaviour in this
          // scenario must not depend on the real 2s TTL.
          bridgeRoundCache: { ttlMs: 2_000, now: () => 1_700_000_000_000 },
        },
      });
      const call = async (path: string) => {
        const route = harness.routes.find((item) => item.path === path);
        if (route === undefined) throw new Error(`route missing: ${path}`);
        const response = createResponse(harness);
        await route.handler({ method: "GET", url: path, headers: {} }, response.response);
        return response;
      };
      const totalHits = () => [...hits.values()].reduce((sum, count) => sum + count, 0);

      await call("/plugins/dsh-fusion/state");
      expect(totalHits()).toBe(4);
      // Doctor always probes live: it refetches a full round
      // instead of reading the cached one...
      const doctor = await call("/plugins/dsh-fusion/doctor");
      expect(doctor.state.status).toBe(200);
      expect(totalHits()).toBe(8);
      // ...and it does not write through either: the panel's
      // cached round is still the one being served.
      await call("/plugins/dsh-fusion/state");
      expect(totalHits()).toBe(8);
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });

  it("surfaces the per-action write capability snapshot through fusion_status", async () => {
    const harness = await applyPlugin();
    // The tool output is validated against the PUBLIC
    // FusionStatus type — a hand-written shadow shape here
    // previously let the public type drift behind the
    // runtime (it lacked writeCapabilities entirely while
    // the tool's own output schema required the field).
    const status = harness.tools.find((tool) => tool.name === "fusion_status") as unknown as {
      execute: () => Promise<FusionStatus>;
    };
    expect(status).toBeDefined();
    const result = await status.execute();
    const capabilities = result.writeCapabilities;
    expect(typeof capabilities.checkedAt).toBe("number");
    // This harness has no execute capability, no approval service,
    // and writes default off: every action must say exactly why it
    // is unavailable instead of silently vanishing.
    const teams = Object.fromEntries(
      capabilities.families["agentTeams"]!.actions.map((action) => [action.action, action]),
    );
    expect(teams["fusion_team_approve"]).toMatchObject({
      state: "unavailable",
      reasons: ["WRITES_DISABLED", "UPSTREAM_EXECUTE_UNAVAILABLE", "APPROVAL_UNAVAILABLE"],
    });
    expect(teams["fusion_team_send_message"]).toMatchObject({
      state: "unavailable",
      reasons: ["WRITES_DISABLED", "UPSTREAM_EXECUTE_UNAVAILABLE"],
    });
    expect(capabilities.families["agentBus"]!.approvalService).toBeNull();
    const totalActions = Object.values(capabilities.families)
      .reduce((sum, family) => sum + family.actions.length, 0);
    expect(totalActions).toBe(15);
  });

  it("returns 404 for unknown history sessions and rejects non-GET methods", async () => {
    const harness = await applyPlugin({
      sessionController: {
        list: async () => ({ items: [] }),
        projections: async () => null,
        page: async () => ({ records: [], hasMore: false }),
      },
    });
    const route = harness.routes.find((item) => item.path === "/plugins/dsh-fusion/session-hub/history");
    const snapshotRoute = harness.routes.find((item) => item.path === "/plugins/dsh-fusion/session-hub");
    if (route === undefined || snapshotRoute === undefined) throw new Error("session hub routes missing");

    const missing = createResponse(harness);
    await route.handler({
      method: "GET",
      url: "/plugins/dsh-fusion/session-hub/history?sourceId=dsh-local&sessionId=missing",
      headers: {},
    }, missing.response);
    expect(missing.state.status).toBe(404);

    const post = createResponse(harness);
    await snapshotRoute.handler({ method: "POST", headers: {} }, post.response);
    expect(post.state.status).toBe(405);
    expect(post.state.headers.allow).toBe("GET");
  });

  it("admits a same-origin Session prompt only for an available local Agent", async () => {
    const prompt = vi.fn(async () => ({ accepted: true as const }));
    const harness = await applyPlugin({
      sessionController: {
        list: async () => ({
          items: [{
            sessionId: "local-1",
            running: true,
            agentAvailable: true,
            blank: false,
            updatedAt: 1_760_000_000_000,
            projections: {
              kind: "cached",
              asOfSeq: 2,
              values: {},
            },
          }],
        }),
        projections: async () => ({ asOfSeq: 2, values: {} }),
        page: async () => ({ records: [], hasMore: false }),
        prompt,
      },
    });
    const route = harness.routes.find(
      (item) => item.path === "/plugins/dsh-fusion/session-hub/prompt",
    );
    if (route === undefined) throw new Error("session prompt route missing");

    const request = jsonRequest({
      sourceId: "dsh-local",
      sessionId: "local-1",
      text: "continue",
      mode: "queue",
    });
    const response = createResponse(harness);
    await route.handler(request, response.response);

    expect(response.state.status).toBe(202);
    expect(JSON.parse(response.state.body)).toEqual({ accepted: true });
    expect(prompt).toHaveBeenCalledWith({
      requestId: expect.any(String),
      sessionId: "local-1",
      mode: "queue",
      content: [{ type: "text", text: "continue" }],
    }, expect.any(AbortSignal));
  });

  it.each([
    "2junk",
    "1.5",
    "0",
    "-1",
    "201",
    "9007199254740992",
  ])("rejects invalid maxMessages=%s before reading history", async (maxMessages) => {
    const page = vi.fn(async () => ({ records: [], hasMore: false }));
    const harness = await applyPlugin({
      sessionController: {
        list: async () => ({ items: [] }),
        projections: async () => ({ asOfSeq: 1, values: {} }),
        page,
      },
    });
    const route = harness.routes.find((item) => item.path === "/plugins/dsh-fusion/session-hub/history");
    if (route === undefined) throw new Error("session history route missing");

    const response = createResponse(harness);
    await route.handler({
      method: "GET",
      url: `/plugins/dsh-fusion/session-hub/history?sourceId=dsh-local&sessionId=session-1&maxMessages=${encodeURIComponent(maxMessages)}`,
      headers: {},
    }, response.response);

    expect(response.state.status).toBe(400);
    expect(JSON.parse(response.state.body)).toEqual({
      error: "maxMessages must be an integer between 1 and 200",
    });
    expect(page).not.toHaveBeenCalled();
  });

  it("passes the maximum allowed maxMessages value through to history paging", async () => {
    const page = vi.fn(async () => ({ records: [], hasMore: false }));
    const harness = await applyPlugin({
      sessionController: {
        list: async () => ({
          items: [{
            sessionId: "session-1",
            running: false,
            agentAvailable: false,
            blank: false,
            updatedAt: 1_760_000_000_000,
            projections: { kind: "sequenced", asOfSeq: 1, values: {} },
          }],
        }),
        projections: async () => ({ asOfSeq: 1, values: {} }),
        page,
      },
    });
    const route = harness.routes.find((item) => item.path === "/plugins/dsh-fusion/session-hub/history");
    if (route === undefined) throw new Error("session history route missing");

    const response = createResponse(harness);
    await route.handler({
      method: "GET",
      url: "/plugins/dsh-fusion/session-hub/history?sourceId=dsh-local&sessionId=session-1&maxMessages=200",
      headers: {},
    }, response.response);

    expect(response.state.status).toBe(200);
    expect(page).toHaveBeenCalledWith(
      expect.objectContaining({ maxMessages: 200 }),
      expect.any(AbortSignal),
    );
  });

  it("authenticates Session Hub routes before reading state", async () => {
    const harness = await applyPlugin({ rejection: 401 });
    const route = harness.routes.find((item) => item.path === "/plugins/dsh-fusion/session-hub");
    if (route === undefined) throw new Error("session hub route missing");

    const response = createResponse(harness);
    await route.handler({ method: "GET", headers: {} }, response.response);

    expect(response.state.status).toBe(401);
    expect(JSON.parse(response.state.body)).toEqual({
      error: "AUTHENTICATION_REQUIRED",
    });
  });

  it("debounces api-session events into session and state stream notifications", async () => {
    const harness = await applyPlugin();
    const eventsRoute = harness.routes.find((item) => item.path === "/plugins/dsh-fusion/events");
    if (eventsRoute === undefined) throw new Error("events route missing");
    const stream = createResponse(harness);
    eventsRoute.handler({ method: "GET", headers: {} }, stream.response);

    const added = [...(harness.events.get("api-session/added") ?? [])][0];
    const status = [...(harness.events.get("api-session/status") ?? [])][0];
    if (added === undefined || status === undefined) throw new Error("session listeners missing");
    added({
      sessionId: "local-1",
      running: false,
      agentAvailable: false,
      blank: false,
      updatedAt: 1,
    });
    status("local-1", true);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const payloads = stream.state.chunks
      .filter((chunk) => chunk.startsWith("id: "))
      .map((chunk) => JSON.parse(
        chunk.slice(chunk.indexOf("data: ") + "data: ".length),
      ) as { type: string; sessionId?: string; scope?: string });
    expect(payloads.filter((payload) => payload.type === "session.updated")).toEqual([
      expect.objectContaining({ sessionId: "dsh-local:local-1" }),
    ]);
    expect(payloads.filter((payload) => payload.type === "state.updated")).toEqual([
      expect.objectContaining({ scope: "sessionHub" }),
    ]);

    for (const dispose of harness.disposers) dispose();
    expect(harness.events.get("api-session/added")?.size ?? 0).toBe(0);
    expect(harness.events.get("api-session/status")?.size ?? 0).toBe(0);
  });

  it("streams events with monotonic ids and replays after Last-Event-ID", async () => {
    const harness = await applyPlugin();
    const stateRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/state");
    const eventsRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/events");
    if (stateRoute === undefined || eventsRoute === undefined) {
      throw new Error("live routes missing");
    }

    const stateResponse = createResponse(harness);
    await stateRoute.handler({ method: "GET", headers: {} }, stateResponse.response);
    expect(stateResponse.state.status).toBe(200);

    const stream = createResponse(harness);
    eventsRoute.handler({ method: "GET", headers: { "last-event-id": "0" } }, stream.response);

    expect(stream.state.status).toBe(200);
    expect(stream.state.headers["content-type"]).toContain("text/event-stream");
    expect(stream.state.headers["cache-control"]).toBe("no-cache");
    expect(stream.state.chunks[0]).toBe(": connected\n\n");
    const frame = stream.state.chunks.find((chunk) => chunk.startsWith("id: "));
    expect(frame).toBeDefined();
    expect(frame).toMatch(/^id: \d+\ndata: \{/);
    const payload = JSON.parse(
      frame!.slice(frame!.indexOf("data: ") + "data: ".length),
    ) as { seq: number; type: string };
    expect(payload.seq).toBeGreaterThan(0);
    expect(payload.type).toBe("state.updated");
  });

  it("emits one fusion.gap frame when Last-Event-ID is ahead of the bus", async () => {
    const harness = await applyPlugin();
    const stateRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/state");
    const eventsRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/events");
    if (stateRoute === undefined || eventsRoute === undefined) {
      throw new Error("live routes missing");
    }

    const stateResponse = createResponse(harness);
    await stateRoute.handler({ method: "GET", headers: {} }, stateResponse.response);
    expect(stateResponse.state.status).toBe(200);

    const stream = createResponse(harness);
    eventsRoute.handler({ method: "GET", headers: { "last-event-id": "9999" } }, stream.response);

    const gapFrames = stream.state.chunks.filter((chunk) => chunk.startsWith("event: fusion.gap"));
    expect(gapFrames).toHaveLength(1);
    const frame = gapFrames[0]!;
    expect(frame.split("\n")[0]).toBe("event: fusion.gap");
    const payload = JSON.parse(
      frame.slice(frame.indexOf("data: ") + "data: ".length),
    ) as {
      afterSeq: number;
      firstAvailableSeq: number;
      lastSeq: number;
      missingFrom: number;
      missingTo: number;
      reason: string;
    };
    expect(payload).toEqual({
      afterSeq: 9999,
      firstAvailableSeq: 1,
      lastSeq: expect.any(Number),
      missingFrom: expect.any(Number),
      missingTo: 9999,
      reason: "sequence-reset",
    });
    expect(frame).toContain(`id: ${payload.lastSeq}\n`);
    expect(stream.state.chunks.filter((chunk) => chunk.startsWith("id: "))).toHaveLength(0);
  });

  it("rejects the event stream before DSH Connection authentication", async () => {
    const harness = await applyPlugin({ rejection: 401 });
    const eventsRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/events");
    if (eventsRoute === undefined) throw new Error("events route missing");

    const stream = createResponse(harness);
    eventsRoute.handler({ method: "GET", headers: {} }, stream.response);

    expect(stream.state.status).toBe(401);
    expect(stream.state.chunks).toHaveLength(0);
  });

  it("does not replay history to a first connection without Last-Event-ID", async () => {
    const harness = await applyPlugin();
    const eventsRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/events");
    if (eventsRoute === undefined) throw new Error("events route missing");

    const stream = createResponse(harness);
    eventsRoute.handler({ method: "GET", headers: {} }, stream.response);

    expect(stream.state.status).toBe(200);
    // Only the greeting frame: a first connection has nothing to resume from,
    // and re-delivering the whole buffer would make every new panel refetch
    // the snapshot once per historical event.
    expect(stream.state.chunks.filter((chunk) => chunk.startsWith("id: "))).toHaveLength(0);
  });

  it("closes the live event streams when the plugin unloads", async () => {
    const harness = await applyPlugin();
    const eventsRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/events");
    if (eventsRoute === undefined) throw new Error("events route missing");

    const stream = createResponse(harness);
    eventsRoute.handler({ method: "GET", headers: {} }, stream.response);
    expect(harness.closeListeners.length).toBeGreaterThan(0);

    // Unloading the plugin has to tear the streams down, not leave them
    // writing heartbeats into a plugin that no longer exists.
    for (const close of harness.closeListeners) close();
    for (const dispose of harness.disposers) dispose();
    expect(harness.closeListeners.length).toBeGreaterThan(0);
    expect(stream.state.endCalls).toBe(1);
  });

  it("rejects non-GET requests on the event stream", async () => {
    const harness = await applyPlugin();
    const eventsRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/events");
    if (eventsRoute === undefined) throw new Error("events route missing");

    const stream = createResponse(harness);
    eventsRoute.handler({ method: "POST", headers: {} }, stream.response);

    expect(stream.state.status).toBe(405);
    expect(stream.state.headers.allow).toBe("GET, HEAD");
  });

  it("returns a structured doctor report", async () => {
    const harness = await applyPlugin();
    const doctorRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/doctor");
    if (doctorRoute === undefined) throw new Error("doctor route missing");

    const doctor = createResponse(harness);
    await doctorRoute.handler({ method: "GET", headers: {} }, doctor.response);

    const report = JSON.parse(doctor.state.body) as {
      status: string;
      checkedAt: string;
      checks: Array<{ id: string; status: string }>;
      summary: { total: number };
    };
    expect(["ok", "degraded", "failed"]).toContain(report.status);
    expect(report.checks.some((check) => check.id === "plugin.dsh-version")).toBe(true);
    expect(report.checks.some((check) => check.id === "provider.nodes")).toBe(true);
    expect(report.summary.total).toBe(report.checks.length);
  });

  it("registers a doctor tool with a readable summary", async () => {
    const harness = await applyPlugin();
    expect(harness.tools.map((tool) => tool.name)).toContain("fusion_doctor");
  });

  it("surfaces fleet observability through both the doctor tool and the doctor route", async () => {
    // A configured fleet (one SSH node whose probe cannot
    // succeed in this environment — the node reports offline,
    // which is fine: the observability check describes the
    // fleet READ, and both doctor chains must carry it, not
    // just the host report builder's unit tests).
    const harness = await applyPlugin({
      config: {
        sshNodes: [{
          host: "root@127.0.0.1",
          keyPath: "unused",
          knownHostsPath: "unused-known-hosts",
          nodeId: "huawei-doctor-test",
        }],
      },
    });
    type DoctorCheck = {
      id: string;
      status: string;
      details?: { checkedAt?: string; stale?: boolean };
    };
    const expectFleetCheck = (checks: DoctorCheck[]) => {
      const fleetCheck = checks.find((check) => check.id === "fleet.observability");
      expect(fleetCheck).toBeDefined();
      expect(fleetCheck!.status).toBe("ok");
      expect(typeof fleetCheck!.details?.checkedAt).toBe("string");
      expect(fleetCheck!.details?.stale).toBe(false);
    };

    const doctorTool = harness.tools.find((tool) => tool.name === "fusion_doctor") as unknown as {
      execute: () => Promise<{ checks: DoctorCheck[] }>;
    };
    expect(doctorTool).toBeDefined();
    expectFleetCheck((await doctorTool.execute()).checks);

    const doctorRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/doctor");
    if (doctorRoute === undefined) throw new Error("doctor route missing");
    const doctor = createResponse(harness);
    await doctorRoute.handler({ method: "GET", headers: {} }, doctor.response);
    const routeReport = JSON.parse(doctor.state.body) as {
      status: string;
      checks: DoctorCheck[];
    };
    // The route maps a failed report to 503 (this scenario's
    // unreachable node fails it); the body is the report
    // either way, and the fleet check must be in it.
    expect(doctor.state.status).toBe(routeReport.status === "failed" ? 503 : 200);
    expectFleetCheck(routeReport.checks);
  }, 60_000);

  it("denies PTY HTTP and upgrade attempts unless FUSION_ALLOW_REMOTE_PTY is enabled", async () => {
    vi.useFakeTimers();
    const harness = await applyPlugin();
    const createRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/pty/create");
    const upgrade = harness.upgrades.find((route) => route.path === "/plugins/dsh-fusion/pty/ws");
    if (createRoute === undefined || upgrade === undefined) throw new Error("PTY routes missing");

    const create = createResponse(harness);
    await createRoute.handler(jsonRequest({
      nodeId: "huawei-hs-monitor-cn",
      cols: 100,
      rows: 30,
    }), create.response);
    expect(create.state.status).toBe(403);
    expect(JSON.parse(create.state.body)).toEqual({ error: "REMOTE_PTY_DISABLED" });

    const { socket, writes } = upgradeSocket();
    await upgrade.handler({
      method: "GET",
      url: "/plugins/dsh-fusion/pty/ws",
      headers: {
        host: "127.0.0.1:8787",
        origin: "http://127.0.0.1:8787",
      },
    }, socket, Buffer.alloc(0));
    expect(writes.join("")).toContain("HTTP/1.1 403 Forbidden");
    expect(writes.join("")).toContain("REMOTE_PTY_DISABLED");
    expect(socket.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it("authenticates PTY HTTP routes before creating a terminal", async () => {
    const fake = fakePtyService();
    const harness = await applyPlugin({
      rejection: 401,
      config: {
        allowRemotePty: true,
        ptyService: fake.service,
        huaweiSsh: { nodeId: "huawei-hs-monitor-cn" },
      },
    });
    const createRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/pty/create");
    if (createRoute === undefined) throw new Error("PTY create route missing");

    const response = createResponse(harness);
    await createRoute.handler(jsonRequest({
      nodeId: "huawei-hs-monitor-cn",
      cols: 100,
      rows: 30,
    }), response.response);

    expect(response.state.status).toBe(401);
    expect(fake.service.create).not.toHaveBeenCalled();
  });

  it("rejects unsupported nodes, cross-site JSON, and a missing PTY service", async () => {
    const fake = fakePtyService();
    const harness = await applyPlugin({
      config: {
        allowRemotePty: true,
        ptyService: fake.service,
        huaweiSsh: { nodeId: "huawei-hs-monitor-cn" },
      },
    });
    const createRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/pty/create");
    if (createRoute === undefined) throw new Error("PTY create route missing");

    const unknown = createResponse(harness);
    await createRoute.handler(jsonRequest({
      nodeId: "tencent-worker",
      cols: 100,
      rows: 30,
    }), unknown.response);
    expect(unknown.state.status).toBe(403);
    expect(JSON.parse(unknown.state.body)).toEqual({ error: "UNKNOWN_PTY_NODE" });
    expect(fake.service.create).not.toHaveBeenCalled();

    const crossSite = createResponse(harness);
    await createRoute.handler(jsonRequest({
      nodeId: "huawei-hs-monitor-cn",
      cols: 100,
      rows: 30,
    }, {
      origin: "https://evil.example",
    }), crossSite.response);
    expect(crossSite.state.status).toBe(403);
    expect(JSON.parse(crossSite.state.body)).toEqual({ error: "CROSS_SITE_MUTATION_REJECTED" });

    const missingService = await applyPlugin({
      config: {
        allowRemotePty: true,
        huaweiSsh: { nodeId: "huawei-hs-monitor-cn" },
      },
    });
    const missingRoute = missingService.routes.find((route) => route.path === "/plugins/dsh-fusion/pty/create");
    if (missingRoute === undefined) throw new Error("PTY create route missing");
    const missing = createResponse(missingService);
    await missingRoute.handler(jsonRequest({
      nodeId: "huawei-hs-monitor-cn",
      cols: 100,
      rows: 30,
    }), missing.response);
    expect(missing.state.status).toBe(503);
    expect(JSON.parse(missing.state.body)).toEqual({ error: "REMOTE_PTY_NOT_CONFIGURED" });
  });

  it("routes PTY creation to the selected configured SSH node", async () => {
    const first = fakePtyService();
    const second = fakePtyService();
    const harness = await applyPlugin({
      config: {
        allowRemotePty: true,
        sshNodes: [{
          nodeId: "node-a",
          host: "node-a.example",
          keyPath: "/keys/node-a",
          knownHostsPath: "/keys/known_hosts",
        }, {
          nodeId: "node-b",
          host: "node-b.example",
          keyPath: "/keys/node-b",
          knownHostsPath: "/keys/known_hosts",
        }],
        ptyServices: {
          "node-a": first.service,
          "node-b": second.service,
        },
      },
    });
    const createRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/pty/create");
    if (createRoute === undefined) throw new Error("PTY create route missing");

    const created = createResponse(harness);
    await createRoute.handler(jsonRequest({
      nodeId: "node-b",
      cols: 100,
      rows: 30,
    }), created.response);

    expect(created.state.status).toBe(201);
    expect(first.service.create).not.toHaveBeenCalled();
    expect(second.service.create).toHaveBeenCalledOnce();
  });

  it("creates and closes a terminal only for the configured Huawei node", async () => {
    const fake = fakePtyService();
    const harness = await applyPlugin({
      config: {
        allowRemotePty: true,
        ptyService: fake.service,
        huaweiSsh: { nodeId: "huawei-hs-monitor-cn" },
      },
    });
    const createRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/pty/create");
    const closeRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/pty/close");
    if (createRoute === undefined || closeRoute === undefined) throw new Error("PTY routes missing");

    const create = createResponse(harness);
    await createRoute.handler(jsonRequest({
      nodeId: "huawei-hs-monitor-cn",
      cols: 132,
      rows: 43,
    }), create.response);
    expect(create.state.status).toBe(201);
    const created = JSON.parse(create.state.body) as {
      terminalId: string;
      terminalToken: string;
    };
    expect(created).toMatchObject({
      terminalId: "pty-test-1",
      nodeId: "huawei-hs-monitor-cn",
      cols: 132,
      rows: 43,
      state: "connected",
      snapshot: {
        sequence: 0,
        data: "",
        truncated: false,
      },
    });
    expect(created.terminalToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fake.service.create).toHaveBeenCalledWith({ cols: 132, rows: 43 });

    const missingToken = createResponse(harness);
    await closeRoute.handler(jsonRequest({
      terminalId: "pty-test-1",
    }), missingToken.response);
    expect(missingToken.state.status).toBe(400);
    expect(fake.service.close).not.toHaveBeenCalled();

    const wrongToken = createResponse(harness);
    await closeRoute.handler(jsonRequest({
      terminalId: "pty-test-1",
      terminalToken: "B".repeat(43),
    }), wrongToken.response);
    expect(wrongToken.state.status).toBe(403);
    expect(fake.service.close).not.toHaveBeenCalled();

    const close = createResponse(harness);
    await closeRoute.handler(jsonRequest({
      terminalId: "pty-test-1",
      terminalToken: created.terminalToken,
    }), close.response);
    expect(close.state.status).toBe(200);
    expect(JSON.parse(close.state.body)).toEqual({
      terminalId: "pty-test-1",
      closed: true,
    });
    expect(fake.service.close).toHaveBeenCalledWith("pty-test-1");
  });

  it("terminates an unattached terminal when its capability idle TTL expires", async () => {
    vi.useFakeTimers();
    const fake = fakePtyService();
    const harness = await applyPlugin({
      config: {
        allowRemotePty: true,
        ptyIdleTtlMs: 50,
        ptyService: fake.service,
        huaweiSsh: { nodeId: "huawei-hs-monitor-cn" },
      },
    });
    const createRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/pty/create");
    if (createRoute === undefined) throw new Error("PTY create route missing");

    const response = createResponse(harness);
    await createRoute.handler(jsonRequest({
      nodeId: "huawei-hs-monitor-cn",
      cols: 100,
      rows: 30,
    }), response.response);
    expect(response.state.status).toBe(201);
    expect(fake.service.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fake.service.terminate).toHaveBeenCalledWith("pty-test-1");
  });

  it("requires a WS auth first frame and rejects missing, unknown, and timed-out capabilities", async () => {
    const fake = fakePtyService();
    const harness = await applyPlugin({
      config: {
        allowRemotePty: true,
        ptyAuthTimeoutMs: 40,
        ptyService: fake.service,
        huaweiSsh: { nodeId: "huawei-hs-monitor-cn" },
      },
    });
    const createRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/pty/create");
    const upgrade = harness.upgrades.find((route) => route.path === "/plugins/dsh-fusion/pty/ws");
    if (createRoute === undefined || upgrade === undefined) throw new Error("PTY routes missing");

    const create = createResponse(harness);
    await createRoute.handler(jsonRequest({
      nodeId: "huawei-hs-monitor-cn",
      cols: 100,
      rows: 30,
    }), create.response);
    const capability = JSON.parse(create.state.body) as {
      terminalId: string;
      terminalToken: string;
    };

    const server = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    server.on("upgrade", (request, socket, head) => {
      void upgrade.handler(request, socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("listen address missing");
    const wsUrl = `ws://127.0.0.1:${address.port}/plugins/dsh-fusion/pty/ws`;
    const origin = `http://127.0.0.1:${address.port}`;
    const openClient = async () => {
      const client = new PluginWebSocket(wsUrl, { headers: { origin } });
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
      return client;
    };
    const waitFor = <T,>(register: (resolve: (value: T) => void) => void): Promise<T> => (
      new Promise<T>((resolve) => register(resolve))
    );

    const successful = await openClient();
    const messages: Array<Record<string, unknown>> = [];
    successful.on("message", (data: Buffer) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(messages).toHaveLength(0);
    successful.send(JSON.stringify({
      type: "auth",
      terminalId: capability.terminalId,
      terminalToken: capability.terminalToken,
    }));
    await waitFor<void>((resolve) => {
      const timer = setInterval(() => {
        if (messages.some((message) => message.type === "state")) {
          clearInterval(timer);
          resolve();
        }
      }, 2);
    });
    expect(messages[0]).toMatchObject({ type: "state", state: "connected" });
    successful.send(JSON.stringify({
      type: "input",
      data: Buffer.from("whoami\n").toString("base64"),
    }));
    await waitFor<void>((resolve) => {
      const timer = setInterval(() => {
        if (fake.terminal.write.mock.calls.length > 0) {
          clearInterval(timer);
          resolve();
        }
      }, 2);
    });
    expect(fake.terminal.write).toHaveBeenCalledWith(Buffer.from("whoami\n"));
    successful.close();

    const invalid = await openClient();
    const invalidClose = waitFor<number>((resolve) => {
      invalid.once("close", (code: number) => resolve(code));
    });
    invalid.send(JSON.stringify({
      type: "auth",
      terminalId: "pty-missing",
      terminalToken: "B".repeat(43),
    }));
    expect(await invalidClose).toBe(4404);

    const timedOut = await openClient();
    const timeoutClose = waitFor<number>((resolve) => {
      timedOut.once("close", (code: number) => resolve(code));
    });
    expect(await timeoutClose).toBe(4401);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("terminates the SSH PTY immediately when a websocket is no longer open during send", async () => {
    const fake = fakePtyService();
    const fakeWs = fakePtyWebSocketServer();
    const harness = await applyPlugin({
      config: {
        allowRemotePty: true,
        ptyService: fake.service,
        ptyWebSocketServer: fakeWs.server,
        huaweiSsh: { nodeId: "huawei-hs-monitor-cn" },
      },
    });
    const createRoute = harness.routes.find((route) => route.path === "/plugins/dsh-fusion/pty/create");
    const upgrade = harness.upgrades.find((route) => route.path === "/plugins/dsh-fusion/pty/ws");
    if (createRoute === undefined || upgrade === undefined) throw new Error("PTY routes missing");
    const create = createResponse(harness);
    await createRoute.handler(jsonRequest({
      nodeId: "huawei-hs-monitor-cn",
      cols: 100,
      rows: 30,
    }), create.response);
    const capability = JSON.parse(create.state.body) as {
      terminalId: string;
      terminalToken: string;
    };

    const network = upgradeSocket();
    await upgrade.handler({
      method: "GET",
      url: "/plugins/dsh-fusion/pty/ws",
      headers: {
        host: "127.0.0.1:8787",
        origin: "http://127.0.0.1:8787",
      },
    }, network.socket, Buffer.alloc(0));
    fakeWs.emitMessage({
      type: "auth",
      terminalId: capability.terminalId,
      terminalToken: capability.terminalToken,
    });
    fakeWs.socket.readyState = 3;
    fake.emit({
      type: "output",
      terminalId: capability.terminalId,
      sequence: 1,
      data: Buffer.from("after-close"),
    });

    expect(fake.service.terminate).toHaveBeenCalledWith(capability.terminalId);
    expect(fakeWs.socket.terminate).toHaveBeenCalled();
  });

  it("requires authentication and a same-origin WS upgrade before attaching", async () => {
    const fake = fakePtyService();
    const unauthenticated = await applyPlugin({
      rejection: 401,
      config: {
        allowRemotePty: true,
        ptyService: fake.service,
        huaweiSsh: { nodeId: "huawei-hs-monitor-cn" },
      },
    });
    const authUpgrade = unauthenticated.upgrades.find((route) => route.path === "/plugins/dsh-fusion/pty/ws");
    if (authUpgrade === undefined) throw new Error("PTY upgrade route missing");
    const authSocket = upgradeSocket();
    await authUpgrade.handler({
      method: "GET",
      url: "/plugins/dsh-fusion/pty/ws",
      headers: {
        host: "127.0.0.1:8787",
        "x-forwarded-proto": "http",
        origin: "http://127.0.0.1:8787",
      },
    }, authSocket.socket, Buffer.alloc(0));
    expect(authSocket.writes.join("")).toContain("HTTP/1.1 401 Unauthorized");

    const missingOrigin = await applyPlugin({
      config: {
        allowRemotePty: true,
        ptyService: fake.service,
        huaweiSsh: { nodeId: "huawei-hs-monitor-cn" },
      },
    });
    const originUpgrade = missingOrigin.upgrades.find((route) => route.path === "/plugins/dsh-fusion/pty/ws");
    if (originUpgrade === undefined) throw new Error("PTY upgrade route missing");
    const originSocket = upgradeSocket();
    await originUpgrade.handler({
      method: "GET",
      url: "/plugins/dsh-fusion/pty/ws",
      headers: {
        host: "127.0.0.1:8787",
        "x-forwarded-proto": "https",
        origin: "http://127.0.0.1:8787",
      },
    }, originSocket.socket, Buffer.alloc(0));
    expect(originSocket.writes.join("")).toContain("HTTP/1.1 403 Forbidden");
    expect(originSocket.writes.join("")).toContain("TRUSTED_ORIGIN_REQUIRED");
  });
});
