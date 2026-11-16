import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SessionHubSessionRecord,
  SessionHubSnapshot,
  SessionRecord,
} from "@dsh-fusion/core";
import { MissionControl } from "./MissionControl.js";
import { SessionPane } from "./SessionPane.js";
import {
  sessionHubUrlFromSnapshot,
  useSessionHistory,
  useSessionHub,
} from "./use-session-hub.js";

const localSession: SessionHubSessionRecord = {
  id: "dsh-local:child-1",
  sourceId: "dsh-local",
  nativeSessionId: "child-1",
  title: "真实会话",
  running: true,
  agentAvailable: true,
  blank: false,
  updatedAt: 1_760_000_000_000,
  cwd: "F:\\AI\\demo",
  parentNativeId: "parent-1",
  subagentMode: "unknown",
  origin: "subagent",
};

function snapshot(): SessionHubSnapshot {
  return {
    provider: "available",
    sessions: [localSession],
    sources: [{ sourceId: "dsh-local", state: "available", sessionCount: 1 }],
    checkedAt: 1_760_000_000_000,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Session Hub client", () => {
  it("derives the dedicated Session Hub route from the plugin snapshot route", () => {
    expect(sessionHubUrlFromSnapshot("/plugins/dsh-fusion/state"))
      .toBe("/plugins/dsh-fusion/session-hub");
    expect(sessionHubUrlFromSnapshot("/api/fusion/snapshot")).toBeUndefined();
  });

  it("fetches Session Hub and refetches when the live stream revision changes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(snapshot()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const fallback: SessionRecord[] = [];

    const { result, rerender } = renderHook(
      ({ revision }) => useSessionHub({
        endpoint: "/plugins/dsh-fusion/session-hub",
        fallbackSessions: fallback,
        refreshSignal: revision,
      }),
      { initialProps: { revision: 1 } },
    );

    await waitFor(() => expect(result.current.snapshot?.provider).toBe("available"));
    expect(result.current.usingFallback).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "plugins/dsh-fusion/session-hub",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    rerender({ revision: 2 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("falls back to the existing bridge sessions when Session Hub is absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "not found" }),
      { status: 404, headers: { "content-type": "application/json" } },
    )));

    const { result } = renderHook(() => useSessionHub({
      endpoint: "/plugins/dsh-fusion/session-hub",
      fallbackSessions: [{
        id: "bridge-1",
        providerId: "agent-teams",
        title: "Bridge 会话",
        status: "live",
        updatedAt: "2026-10-22T00:00:00.000Z",
      }],
    }));

    await waitFor(() => expect(result.current.usingFallback).toBe(true));
    expect(result.current.snapshot.sessions).toEqual([
      expect.objectContaining({
        id: "agent-teams:bridge-1",
        sourceId: "agent-teams",
        nativeSessionId: "bridge-1",
        agentAvailable: false,
      }),
    ]);
    expect(result.current.error).toContain("404");
  });

  it("consumes shared authoritative snapshots without a duplicate Hub GET", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ shared }) => useSessionHub({
      endpoint: "/plugins/dsh-fusion/session-hub", fallbackSessions: [],
      authoritativeSnapshot: shared,
    }), { initialProps: { shared: snapshot() } });
    await waitFor(() => expect(result.current.snapshot.sessions).toEqual([localSession]));
    rerender({ shared: { ...snapshot(), sessions: [{ ...localSession, title: "Updated" }] } });
    await waitFor(() => expect(result.current.snapshot.sessions[0]?.title).toBe("Updated"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["failed", "unavailable"] as const)(
    "disables stale payload session flags when its shared source is %s",
    async (state) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const otherSession = { ...localSession, id: "other:other-1", sourceId: "other", nativeSessionId: "other-1" };
      const { result, rerender } = renderHook(({ shared }) => useSessionHub({
        endpoint: "/plugins/dsh-fusion/session-hub", fallbackSessions: [], authoritativeSnapshot: shared,
      }), { initialProps: { shared: snapshot() } });
      expect(result.current.snapshot.sessions[0]?.agentAvailable).toBe(true);
      rerender({ shared: {
        ...snapshot(), provider: "partial", sessions: [localSession, otherSession], sources: [
          { sourceId: "dsh-local", state, sessionCount: 1 },
          { sourceId: "other", state: "available", sessionCount: 1 },
        ],
      } });

      await waitFor(() => expect(result.current.snapshot.sessions[0]).toMatchObject({
        id: localSession.id, running: false, agentAvailable: false,
      }));
      expect(result.current.snapshot.sessions[1]).toMatchObject({ running: true, agentAvailable: true });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("retains the last valid session snapshot through 503 and recovery", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot()), { status: 200 }))
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot(), sessions: [{ ...localSession, title: "Recovered" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ revision }) => useSessionHub({
      endpoint: "/plugins/dsh-fusion/session-hub", fallbackSessions: [], refreshSignal: revision,
    }), { initialProps: { revision: 0 } });
    await waitFor(() => expect(result.current.snapshot.sessions).toEqual([localSession]));
    rerender({ revision: 1 });
    await waitFor(() => expect(result.current.error).toContain("503"));
    expect(result.current.snapshot.sessions.map((session) => session.id)).toEqual([localSession.id]);
    rerender({ revision: 2 });
    await waitFor(() => expect(result.current.snapshot.sessions[0]?.title).toBe("Recovered"));
    expect(result.current.error).toBeUndefined();
  });

  it("does not resurrect a removed legacy session after a transient error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot(), sessions: [], sources: [{ sourceId: "dsh-local", state: "available", sessionCount: 0 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot(), provider: "failed", sessions: [], sources: [{ sourceId: "dsh-local", state: "failed", sessionCount: 0 }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ revision }) => useSessionHub({
      endpoint: "/plugins/dsh-fusion/session-hub", refreshSignal: revision,
      fallbackSessions: [{ id: "child-1", providerId: "dsh-local", title: "Stale", status: "idle", updatedAt: "2026-10-22T00:00:00.000Z" }],
    }), { initialProps: { revision: 0 } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot.sessions).toEqual([]);
    rerender({ revision: 1 });
    await waitFor(() => expect(result.current.error).toContain("503"));
    rerender({ revision: 2 });
    await waitFor(() => expect(result.current.snapshot.provider).toBe("failed"));
    expect(result.current.snapshot.sessions).toEqual([]);
  });

  it("keeps persisted panes through source failure and prunes only an authoritative empty list", async () => {
    const storageKey = "dsh-fusion:mission-control:panes";
    const layout = { panes: [localSession.id], rows: { [localSession.id]: 3 } };
    localStorage.setItem(storageKey, JSON.stringify(layout));
    const props = { sessions: [], nodes: [], onOpenMain: () => {} };
    const { rerender } = render(<MissionControl {...props} sessionHubSnapshot={snapshot()} />);
    expect(await screen.findByRole("region", { name: "会话 真实会话" })).toBeInTheDocument();
    rerender(<MissionControl {...props} sessionHubSnapshot={{
      ...snapshot(), provider: "partial", sessions: [],
      sources: [{ sourceId: "dsh-local", state: "failed", sessionCount: 0, error: "offline" }],
    }} />);
    await waitFor(() => expect(screen.getByRole("region", { name: "会话 真实会话" })).toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual(layout);
    rerender(<MissionControl {...props} sessionHubSnapshot={{ ...snapshot(), sessions: [], sources: [{ sourceId: "dsh-local", state: "available", sessionCount: 0 }] }} />);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}").panes).toEqual([]));
  });

  it("does not erase a persisted pane before its unavailable source recovers", async () => {
    const storageKey = "dsh-fusion:mission-control:panes";
    const layout = { panes: [localSession.id], rows: { [localSession.id]: 2 } };
    localStorage.setItem(storageKey, JSON.stringify(layout));
    const props = { sessions: [], nodes: [], onOpenMain: () => {} };
    const { rerender } = render(<MissionControl {...props} sessionHubSnapshot={{
      ...snapshot(), provider: "unavailable", sessions: [],
      sources: [{ sourceId: "dsh-local", state: "unavailable", sessionCount: 0 }],
    }} />);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual(layout));
    rerender(<MissionControl {...props} sessionHubSnapshot={snapshot()} />);
    expect(await screen.findByRole("region", { name: "会话 真实会话" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual(layout);
  });

  it("prunes an available source without erasing another failed source pane", async () => {
    const storageKey = "dsh-fusion:mission-control:panes";
    const bridge = { ...localSession, id: "agent-teams:child-1", sourceId: "agent-teams", title: "Bridge" };
    localStorage.setItem(storageKey, JSON.stringify({ panes: [localSession.id, bridge.id], rows: { [localSession.id]: 1, [bridge.id]: 4 } }));
    const props = { sessions: [], nodes: [], onOpenMain: () => {} };
    const { rerender } = render(<MissionControl {...props} sessionHubSnapshot={{
      ...snapshot(), sessions: [localSession, bridge], sources: [
        ...snapshot().sources, { sourceId: "agent-teams", state: "available", sessionCount: 1 },
      ],
    }} />);
    expect(await screen.findByRole("region", { name: "会话 Bridge" })).toBeInTheDocument();
    rerender(<MissionControl {...props} sessionHubSnapshot={{
      ...snapshot(), provider: "partial", sessions: [], sources: [
        { sourceId: "dsh-local", state: "available", sessionCount: 0 },
        { sourceId: "agent-teams", state: "failed", sessionCount: 0 },
      ],
    }} />);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual({ panes: [bridge.id], rows: { [bridge.id]: 4 } }));
    expect(screen.getByRole("region", { name: "会话 Bridge" })).toBeInTheDocument();
  });

  it.each(["failed", "unavailable"] as const)(
    "keeps legacy sessions when a 200 %s payload has no usable source",
    async (provider) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(
        JSON.stringify({
          provider,
          sessions: [],
          sources: [{
            sourceId: "agent-bus",
            state: provider,
            sessionCount: 0,
          }],
          checkedAt: 1_760_000_000_000,
        } satisfies SessionHubSnapshot),
        { status: 200, headers: { "content-type": "application/json" } },
      )));

      const { result } = renderHook(() => useSessionHub({
        endpoint: "/plugins/dsh-fusion/session-hub",
        fallbackSessions: [{
          id: "legacy-1",
          providerId: "agent-bus",
          title: "Legacy 会话",
          status: "idle",
          updatedAt: "2026-10-22T00:00:00.000Z",
        }],
      }));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.usingFallback).toBe(true);
      expect(result.current.snapshot.sessions).toEqual([
        expect.objectContaining({
          id: "agent-bus:legacy-1",
          title: "Legacy 会话",
        }),
      ]);
    },
  );

  it("merges fallback sessions for failed sources in a partial 200 payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        provider: "partial",
        sessions: [{ ...localSession, id: "untrusted-server-id" }],
        sources: [
          { sourceId: "dsh-local", state: "available", sessionCount: 1 },
          { sourceId: "agent-teams", state: "failed", sessionCount: 0 },
        ],
        checkedAt: 1_760_000_000_000,
      } satisfies SessionHubSnapshot),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const { result } = renderHook(() => useSessionHub({
      endpoint: "/plugins/dsh-fusion/session-hub",
      fallbackSessions: [{
        id: "bridge-1",
        providerId: "agent-teams",
        title: "Fallback Bridge",
        status: "live",
        updatedAt: "2026-10-22T00:00:00.000Z",
      }],
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.usingFallback).toBe(true);
    expect(result.current.snapshot.sessions.map((session) => session.id)).toEqual([
      "dsh-local:child-1",
      "agent-teams:bridge-1",
    ]);
  });

  it("resolves requested sessions by exact source and native id", async () => {
    render(
      <MissionControl
        sessions={[
          {
            id: "shared",
            providerId: "source-a",
            title: "会话 A",
            status: "live",
            updatedAt: "2026-10-22T00:00:00.000Z",
          },
          {
            id: "shared",
            providerId: "source-b",
            title: "会话 B",
            status: "idle",
            updatedAt: "2026-10-22T00:00:00.000Z",
          },
        ]}
        nodes={[]}
        requestedSessionSourceId="source-b"
        requestedSessionId="shared"
        requestToken={1}
        onOpenMain={() => {}}
      />,
    );

    expect(await screen.findByRole("region", { name: "会话 会话 B" })).toBeInTheDocument();
    await waitFor(() => {
      const stored = JSON.parse(
        localStorage.getItem("dsh-fusion:mission-control:panes") ?? "{}",
      ) as { panes?: string[] };
      expect(stored.panes).toEqual(["source-b:shared"]);
    });
  });

  it("drops an ambiguous legacy persisted id instead of opening the wrong session", async () => {
    localStorage.setItem(
      "dsh-fusion:mission-control:panes",
      JSON.stringify({ panes: ["shared"], rows: { shared: 0 } }),
    );
    render(
      <MissionControl
        sessions={[
          {
            id: "shared",
            providerId: "source-a",
            title: "会话 A",
            status: "live",
            updatedAt: "2026-10-22T00:00:00.000Z",
          },
          {
            id: "shared",
            providerId: "source-b",
            title: "会话 B",
            status: "idle",
            updatedAt: "2026-10-22T00:00:00.000Z",
          },
        ]}
        nodes={[]}
        onOpenMain={() => {}}
      />,
    );

    await waitFor(() => {
      const stored = JSON.parse(
        localStorage.getItem("dsh-fusion:mission-control:panes") ?? "{}",
      ) as { panes?: string[] };
      expect(stored.panes).toEqual([]);
    });
    expect(screen.queryByRole("region", { name: "会话 会话 A" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "会话 会话 B" })).not.toBeInTheDocument();
  });

  it("migrates a legacy persisted id only when it has one exact source match", async () => {
    localStorage.setItem(
      "dsh-fusion:mission-control:panes",
      JSON.stringify({ panes: ["unique"], rows: { unique: 2 } }),
    );
    render(
      <MissionControl
        sessions={[{
          id: "unique",
          providerId: "source-a",
          title: "唯一会话",
          status: "live",
          updatedAt: "2026-10-22T00:00:00.000Z",
        }]}
        nodes={[]}
        onOpenMain={() => {}}
      />,
    );

    expect(await screen.findByRole("region", { name: "会话 唯一会话" })).toBeInTheDocument();
    await waitFor(() => {
      const stored = JSON.parse(
        localStorage.getItem("dsh-fusion:mission-control:panes") ?? "{}",
      ) as { panes?: string[]; rows?: Record<string, number> };
      expect(stored.panes).toEqual(["source-a:unique"]);
      expect(stored.rows?.["source-a:unique"]).toBe(2);
    });
  });

  it("loads bounded local history through the dedicated endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messages: [{
        role: "assistant",
        text: "真实回复",
        seq: 9,
        time: 1_760_000_000_000,
      }],
      hasMore: false,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSessionHistory({
      historyUrl: "/plugins/dsh-fusion/session-hub/history",
      sourceId: "dsh-local",
      sessionId: "child-1",
      maxMessages: 25,
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages).toEqual([
      {
        role: "assistant",
        text: "真实回复",
        seq: 9,
        time: 1_760_000_000_000,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "plugins/dsh-fusion/session-hub/history?sourceId=dsh-local&sessionId=child-1&maxMessages=25",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("does not refetch history while the session version is unchanged", async () => {
    let serverSeq = 7;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messages: [{ role: "assistant", text: `版本 ${serverSeq}`, seq: serverSeq, time: 1_760_000_000_000 }],
      hasMore: false,
      asOfSeq: serverSeq,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      (props: { refreshSignal: number; historySeq: number }) => useSessionHistory({
        historyUrl: "/plugins/dsh-fusion/session-hub/history",
        sourceId: "dsh-local",
        sessionId: "child-1",
        ...props,
      }),
      { initialProps: { refreshSignal: 0, historySeq: 7 } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Unrelated refresh signals (other sessions, node events) bump
    // the signal but not this session's version: no refetch, even
    // after any trailing throttle window has elapsed.
    rerender({ refreshSignal: 1, historySeq: 7 });
    rerender({ refreshSignal: 2, historySeq: 7 });
    rerender({ refreshSignal: 3, historySeq: 7 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A version advance does refetch and lands on the new version.
    serverSeq = 8;
    rerender({ refreshSignal: 4, historySeq: 8 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.messages[0]?.text).toBe("版本 8"));
  });

  it("refetches after being disabled and re-enabled at the same version", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messages: [{ role: "assistant", text: "版本 7", seq: 7, time: 1_760_000_000_000 }],
      hasMore: false,
      asOfSeq: 7,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) => useSessionHistory({
        historyUrl: "/plugins/dsh-fusion/session-hub/history",
        sourceId: "dsh-local",
        sessionId: "child-1",
        historySeq: 7,
        enabled: props.enabled,
      }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Going inactive clears the on-screen messages...
    rerender({ enabled: false });
    await waitFor(() => expect(result.current.messages).toEqual([]));

    // ...so re-enabling at the SAME version must read again: the
    // earlier read no longer covers anything on screen, and
    // treating it as covered would leave the pane blank forever.
    rerender({ enabled: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
  });

  it("retries at the same version after a failed read instead of trusting the stale coverage proof", async () => {
    let failNext = false;
    const fetchMock = vi.fn(async () => {
      if (failNext) {
        failNext = false;
        return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify({
        messages: [{ role: "assistant", text: "版本 7", seq: 7, time: 1_760_000_000_000 }],
        hasMore: false,
        asOfSeq: 7,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      (props: { refreshSignal: number; forceSignal: number }) => useSessionHistory({
        historyUrl: "/plugins/dsh-fusion/session-hub/history",
        sourceId: "dsh-local",
        sessionId: "child-1",
        historySeq: 7,
        ...props,
      }),
      { initialProps: { refreshSignal: 0, forceSignal: 0 } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A forced re-read fails: messages are replaced by the error
    // state, so the earlier successful read covers nothing now.
    failNext = true;
    rerender({ refreshSignal: 0, forceSignal: 1 });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The next ordinary signal at the same version must retry,
    // not be blocked by the stale recordSeq/readSeq pair.
    rerender({ refreshSignal: 1, forceSignal: 1 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
  });

  it("coalesces rapid version jumps into one trailing read of the final version", async () => {
    let serverSeq = 7;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messages: [{ role: "assistant", text: `版本 ${serverSeq}`, seq: serverSeq, time: 1_760_000_000_000 }],
      hasMore: false,
      asOfSeq: serverSeq,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      (props: { historySeq: number }) => useSessionHistory({
        historyUrl: "/plugins/dsh-fusion/session-hub/history",
        sourceId: "dsh-local",
        sessionId: "child-1",
        ...props,
      }),
      { initialProps: { historySeq: 7 } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Three version jumps inside one throttle window must produce
    // exactly one trailing fetch, reading the final version.
    for (const seq of [8, 9, 10]) {
      serverSeq = seq;
      rerender({ historySeq: seq });
    }
    await waitFor(() => expect(result.current.messages[0]?.text).toBe("版本 10"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps refetching on every signal when no version is available, and force-refetches after a send", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messages: [],
      hasMore: false,
      asOfSeq: 7,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { rerender: rerenderOpen } = renderHook(
      (props: { refreshSignal: number }) => useSessionHistory({
        historyUrl: "/plugins/dsh-fusion/session-hub/history",
        sourceId: "dsh-local",
        sessionId: "child-1",
        ...props,
      }),
      { initialProps: { refreshSignal: 0 } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerenderOpen({ refreshSignal: 1 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // With a version present, an unchanged version skips — but a
    // send (forceSignal) always re-reads.
    const { rerender: rerenderForced } = renderHook(
      (props: { forceSignal: number }) => useSessionHistory({
        historyUrl: "/plugins/dsh-fusion/session-hub/history",
        sourceId: "dsh-local",
        sessionId: "child-1",
        historySeq: 7,
        ...props,
      }),
      { initialProps: { forceSignal: 0 } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    rerenderForced({ forceSignal: 1 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  });

  it("renders metadata, real history, and keeps the composer readonly without a prompt backend", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messages: [{
        role: "user",
        text: "展示真实历史",
        seq: 3,
        time: 1_760_000_000_000,
      }],
      hasMore: false,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SessionPane
        session={localSession}
        historyUrl="/plugins/dsh-fusion/session-hub/history"
        maximized={false}
        wide={false}
        onMaximize={() => {}}
        onResize={() => {}}
        onMoveRow={() => {}}
        onOpenMain={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(await screen.findByText("展示真实历史")).toBeInTheDocument();
    expect(screen.getByText("来源 dsh-local")).toBeInTheDocument();
    expect(screen.getByText("父会话 parent-1")).toBeInTheDocument();
    expect(screen.getByText("子代理 unknown")).toBeInTheDocument();
    expect(screen.getByText("运行中 · Agent 可用")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "输入 真实会话" })).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByText("只有本地且 Agent 可用的 Session 支持 Prompt。"))
      .toBeInTheDocument();
  });

  it("submits a queue prompt and refreshes local history", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ accepted: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        messages: [{
          role: "user",
          text: "展示真实历史",
          seq: 3,
          time: 1_760_000_000_000,
        }],
        hasMore: false,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SessionPane
        session={localSession}
        historyUrl="/plugins/dsh-fusion/session-hub/history"
        promptUrl="/plugins/dsh-fusion/session-hub/prompt"
        maximized={false}
        wide={false}
        onMaximize={() => {}}
        onResize={() => {}}
        onMoveRow={() => {}}
        onOpenMain={() => {}}
        onRemove={() => {}}
      />,
    );

    await screen.findByText("展示真实历史");
    const composer = screen.getByRole("textbox", { name: "输入 真实会话" });
    expect(composer).not.toHaveAttribute("readonly");
    await userEvent.type(composer, "继续推进");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "plugins/dsh-fusion/session-hub/prompt",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId: "dsh-local",
          sessionId: "child-1",
          text: "继续推进",
          mode: "queue",
        }),
      }),
    );
    await waitFor(() => expect(composer).toHaveValue(""));
  });
});
