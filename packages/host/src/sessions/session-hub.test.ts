import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "@dsh-fusion/core";
import {
  SessionHub,
  SessionHubError,
  type SessionControllerLike,
} from "./session-hub.js";

function bridgeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "shared-id",
    providerId: "agent-teams",
    title: "同名会话",
    status: "live",
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...overrides,
  };
}

function localController(
  overrides: Partial<SessionControllerLike> = {},
): SessionControllerLike {
  return {
    list: vi.fn(async () => ({
      items: [{
        sessionId: "local-1",
        running: false,
        agentAvailable: false,
        blank: false,
        updatedAt: 1_760_000_000_000,
        cwd: "F:\\AI\\demo",
        projections: {
          kind: "cached" as const,
          asOfSeq: 7,
          values: { title: "本地会话" },
        },
      }],
    })),
    projections: vi.fn(async () => ({ asOfSeq: 12, values: {} })),
    page: vi.fn(async () => ({ records: [], hasMore: false })),
    prompt: vi.fn(async () => ({ accepted: true as const })),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionHub", () => {
  it("derives fallback titles from Windows and POSIX paths on every platform", async () => {
    const controller = localController({
      list: vi.fn(async () => ({
        items: [{
          sessionId: "windows",
          running: false,
          agentAvailable: false,
          blank: true,
          updatedAt: 1_760_000_000_000,
          cwd: "F:\\AI",
          projections: {
            kind: "cached" as const,
            asOfSeq: 1,
            values: {},
          },
        }, {
          sessionId: "posix",
          running: false,
          agentAvailable: false,
          blank: true,
          updatedAt: 1_760_000_000_001,
          cwd: "/srv/projects/dsh-fusion/",
          projections: {
            kind: "cached" as const,
            asOfSeq: 1,
            values: {},
          },
        }],
      })),
    });
    const hub = new SessionHub({ getSessionController: () => controller });

    const snapshot = await hub.snapshot();

    expect(snapshot.sessions.map((session) => session.title)).toEqual([
      "未命名会话 · AI",
      "未命名会话 · dsh-fusion",
    ]);
  });

  it("uses source plus native id as the key and never deduplicates equal titles", async () => {
    const hub = new SessionHub({
      getSessionController: () => localController(),
      now: () => 1_760_000_100_000,
    });
    hub.setBridgeSources([{
      sourceId: "agent-teams",
      state: "available",
      sessions: [bridgeSession()],
    }]);

    const snapshot = await hub.snapshot(new AbortController().signal);

    expect(snapshot.sessions.map((session) => session.id)).toEqual([
      "dsh-local:local-1",
      "agent-teams:shared-id",
    ]);
    expect(snapshot.sessions.map((session) => session.title)).toEqual([
      "本地会话",
      "同名会话",
    ]);
  });

  it("lists cold sessions without reading projections or activating an agent", async () => {
    const controller = localController();
    const hub = new SessionHub({ getSessionController: () => controller });

    const snapshot = await hub.snapshot();

    expect(snapshot.sessions[0]).toMatchObject({
      sourceId: "dsh-local",
      nativeSessionId: "local-1",
      running: false,
      agentAvailable: false,
      blank: false,
    });
    expect(controller.list).toHaveBeenCalledWith({}, expect.any(AbortSignal));
    expect(controller.projections).not.toHaveBeenCalled();
    expect(controller.page).not.toHaveBeenCalled();
  });

  it("exposes the projection sequence as historySeq and returns it from history reads", async () => {
    const controller = localController();
    const hub = new SessionHub({ getSessionController: () => controller });

    const snapshot = await hub.snapshot();
    expect(snapshot.sessions[0]?.historySeq).toBe(7);

    const history = await hub.history("dsh-local", "local-1", 50);
    expect(history.asOfSeq).toBe(12);
  });

  it("omits historySeq when the summary carries no projections", async () => {
    const controller = localController({
      list: vi.fn(async () => ({
        items: [{
          sessionId: "local-1",
          running: false,
          agentAvailable: false,
          blank: false,
          updatedAt: 1_760_000_000_000,
          cwd: "F:\\AI\\demo",
        }],
      })),
    });
    const hub = new SessionHub({ getSessionController: () => controller });

    const snapshot = await hub.snapshot();
    expect(snapshot.sessions[0]).not.toHaveProperty("historySeq");
  });

  it("keeps successful bridge sessions when the local source fails", async () => {
    const controller = localController({
      list: vi.fn(async () => {
        throw new Error("local list failed");
      }),
    });
    const hub = new SessionHub({ getSessionController: () => controller });
    hub.setBridgeSources([{
      sourceId: "agent-bus",
      state: "available",
      sessions: [bridgeSession({ id: "bridge-1", providerId: "agent-bus" })],
    }]);

    const snapshot = await hub.snapshot();

    expect(snapshot.provider).toBe("partial");
    expect(snapshot.sessions.map((session) => session.id)).toEqual([
      "agent-bus:bridge-1",
    ]);
    expect(snapshot.sources).toContainEqual(expect.objectContaining({
      sourceId: "dsh-local",
      state: "failed",
    }));
  });

  it("reports failed only when every attempted source failed", async () => {
    const controller = localController({
      list: vi.fn(async () => {
        throw new Error("local list failed");
      }),
    });
    const hub = new SessionHub({ getSessionController: () => controller });
    hub.setBridgeSources([{
      sourceId: "agent-room",
      state: "failed",
      sessions: [],
      error: "room failed",
    }]);

    const snapshot = await hub.snapshot();

    expect(snapshot.provider).toBe("failed");
    expect(snapshot.sessions).toEqual([]);
  });

  it("reports unavailable when DSH exposes no session controller", async () => {
    const hub = new SessionHub({ getSessionController: () => undefined });

    const snapshot = await hub.snapshot();

    expect(snapshot.provider).toBe("unavailable");
    expect(snapshot.sources).toEqual([expect.objectContaining({
      sourceId: "dsh-local",
      state: "unavailable",
    })]);
  });

  it("maps bounded subagent history and drops unknown event payloads", async () => {
    const controller = localController({
      list: vi.fn(async () => ({
        items: [{
          sessionId: "child-1",
          parentSessionId: "parent-1",
          origin: "subagent" as const,
          running: true,
          agentAvailable: true,
          blank: false,
          updatedAt: 1_760_000_200_000,
          projections: {
            kind: "sequenced" as const,
            asOfSeq: 30,
            values: {},
          },
        }],
      })),
      projections: vi.fn(async () => ({ asOfSeq: 41, values: {} })),
      page: vi.fn(async () => ({
        hasMore: true,
        records: [
          {
            type: "event" as const,
            event: {
              type: "tool/call",
              seq: 38,
              time: 1_760_000_190_000,
              data: { name: "shell", arguments: "{\"secret\":\"must-not-leak\"}" },
            },
          },
          {
            type: "event" as const,
            event: {
              type: "tool/result",
              seq: 38,
              time: 1_760_000_190_500,
              data: {
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "工具结果不得输出" }],
                },
              },
            },
          },
          {
            type: "event" as const,
            event: {
              type: "user/message",
              seq: 39,
              time: 1_760_000_191_000,
              data: {
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "检查当前状态" }],
                },
              },
            },
          },
          {
            type: "event" as const,
            event: {
              type: "assistant/message",
              seq: 40,
              time: 1_760_000_192_000,
              data: {
                message: {
                  role: "user",
                  content: [
                    { type: "reasoning", text: "hidden" },
                    { type: "text", text: "状态正常" },
                  ],
                },
              },
            },
          },
        ],
      })),
    });
    const hub = new SessionHub({ getSessionController: () => controller });

    const history = await hub.history("dsh-local", "child-1", 50);

    expect(history.messages).toEqual([
      { role: "user", text: "检查当前状态", seq: 39, time: 1_760_000_191_000 },
      { role: "assistant", text: "状态正常", seq: 40, time: 1_760_000_192_000 },
    ]);
    expect(JSON.stringify(history)).not.toContain("must-not-leak");
    expect(JSON.stringify(history)).not.toContain("工具结果不得输出");
    expect(controller.projections).toHaveBeenCalledWith(
      { sessionId: "child-1" },
      expect.any(AbortSignal),
    );
    expect(controller.page).toHaveBeenCalledWith(
      {
        address: {
          kind: "subagent",
          parentSessionId: "parent-1",
          childSessionId: "child-1",
          mode: "unknown",
        },
        throughSeq: 41,
        maxMessages: 50,
      },
      expect.any(AbortSignal),
    );
  });

  it("admits a queue prompt only for an available local Agent", async () => {
    const controller = localController({
      list: vi.fn(async () => ({
        items: [{
          sessionId: "local-1",
          running: true,
          agentAvailable: true,
          blank: false,
          updatedAt: 1_760_000_000_000,
          projections: {
            kind: "cached" as const,
            asOfSeq: 7,
            values: {},
          },
        }],
      })),
    });
    const hub = new SessionHub({ getSessionController: () => controller });

    await expect(hub.prompt("dsh-local", "local-1", "  continue  ", "queue"))
      .resolves.toEqual({ accepted: true });
    expect(controller.prompt).toHaveBeenCalledWith({
      requestId: expect.any(String),
      sessionId: "local-1",
      mode: "queue",
      content: [{ type: "text", text: "continue" }],
    }, expect.any(AbortSignal));
  });

  it("rejects bridge, cold, and blank prompts before calling the controller", async () => {
    const controller = localController();
    const hub = new SessionHub({ getSessionController: () => controller });

    await expect(hub.prompt("agent-room", "remote-only", "hello"))
      .rejects.toMatchObject({ code: "UNKNOWN_SOURCE", status: 404 });
    await expect(hub.prompt("dsh-local", "local-1", "   "))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT", status: 400 });
    await expect(hub.prompt("dsh-local", "local-1", "hello"))
      .rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(controller.prompt).not.toHaveBeenCalled();
  });

  it("resolves a bridge source to an available local Session for prompt and history", async () => {
    const controller = localController({
      list: vi.fn(async () => ({
        items: [{
          sessionId: "shared-native",
          running: true,
          agentAvailable: true,
          blank: false,
          updatedAt: 1_760_000_000_000,
          projections: {
            kind: "cached" as const,
            asOfSeq: 4,
            values: {},
          },
        }],
      })),
    });
    const hub = new SessionHub({ getSessionController: () => controller });
    hub.setBridgeSources([{
      sourceId: "agent-teams",
      state: "available",
      sessions: [bridgeSession({
        id: "shared-native",
        providerId: "agent-teams",
      })],
    }]);

    await expect(hub.prompt(
      "agent-teams",
      "shared-native",
      "continue",
      "queue",
    )).resolves.toEqual({ accepted: true });
    await expect(hub.history(
      "agent-teams",
      "shared-native",
      10,
    )).resolves.toEqual({ messages: [], hasMore: false, asOfSeq: 12 });
  });

  it("rejects unknown sessions before reading a page", async () => {
    const controller = localController({
      list: vi.fn(async () => ({ items: [] })),
    });
    const hub = new SessionHub({ getSessionController: () => controller });

    await expect(hub.history("dsh-local", "missing", 50)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    } satisfies Partial<SessionHubError>);
    expect(controller.page).not.toHaveBeenCalled();
  });

  it.each([
    { sourceId: "unknown", state: "available", expected: "UNKNOWN_SOURCE" },
    { sourceId: "agent-teams", state: "available", expected: "NOT_FOUND" },
    { sourceId: "agent-teams", state: "failed", expected: "UNAVAILABLE" },
    { sourceId: "agent-teams", state: "unavailable", expected: "UNAVAILABLE" },
  ] as const)("rejects $sourceId / $state before mapping an equal local id", async ({ sourceId, state, expected }) => {
    const controller = localController({
      list: vi.fn(async () => ({ items: [{
        sessionId: "local-1", running: true, agentAvailable: true,
        blank: false, updatedAt: 1,
      }] })),
    });
    const hub = new SessionHub({ getSessionController: () => controller });
    hub.setBridgeSources([{
      sourceId: "agent-teams", state,
      sessions: [bridgeSession({ id: state === "available" ? "other-id" : "local-1" })],
    }]);

    await expect(hub.history(sourceId, "local-1")).rejects.toMatchObject({ code: expected });
    await expect(hub.prompt(sourceId, "local-1", "continue")).rejects.toMatchObject({ code: expected });
    expect(controller.projections).not.toHaveBeenCalled();
    expect(controller.page).not.toHaveBeenCalled();
    expect(controller.prompt).not.toHaveBeenCalled();
  });

  it("does not let a different bridge supply the failed source identity", async () => {
    const controller = localController();
    const hub = new SessionHub({ getSessionController: () => controller });
    hub.setBridgeSources([
      { sourceId: "agent-room", state: "available", sessions: [bridgeSession({ id: "local-1" })] },
      { sourceId: "agent-teams", state: "failed", sessions: [] },
    ]);

    expect((await hub.snapshot()).sessions.map((session) => session.id)).toEqual(["dsh-local:local-1"]);
    await expect(hub.history("agent-teams", "local-1")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(hub.prompt("agent-teams", "local-1", "continue")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(controller.projections).not.toHaveBeenCalled();
  });

  it("reports a failed local source as unavailable for both history and prompt", async () => {
    const controller = localController({ list: vi.fn(async () => { throw new Error("local offline"); }) });
    const hub = new SessionHub({ getSessionController: () => controller });
    await expect(hub.history("dsh-local", "local-1")).rejects.toMatchObject({ code: "UNAVAILABLE", status: 503 });
    await expect(hub.prompt("dsh-local", "local-1", "continue")).rejects.toMatchObject({ code: "UNAVAILABLE", status: 503 });
    expect(controller.prompt).not.toHaveBeenCalled();
  });

  it("debounces session events and removes listeners plus timers on dispose", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const onChange = vi.fn();
    const hub = new SessionHub({
      getSessionController: () => localController(),
      debounceMs: 40,
      onChange,
      on: (event, listener) => {
        listeners.set(event, listener);
        const dispose = vi.fn(() => {
          listeners.delete(event);
        });
        disposers.push(dispose);
        return dispose;
      },
    });

    listeners.get("api-session/added")?.({
      sessionId: "local-1",
      running: false,
      agentAvailable: false,
      blank: false,
      updatedAt: 1,
    });
    listeners.get("api-session/status")?.("local-1", true);
    listeners.get("api-session/activity")?.("local-1", 2);
    await vi.advanceTimersByTimeAsync(39);
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      sessionIds: ["dsh-local:local-1"],
      reason: "api-session",
    });

    listeners.get("api-session/status")?.("local-1", false);
    hub.dispose();
    await vi.runAllTimersAsync();

    expect(disposers).toHaveLength(5);
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});
