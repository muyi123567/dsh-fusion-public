import { useEffect, useMemo, useRef, useState } from "react";
import type {
  SessionHistoryMessage,
  SessionHubSessionRecord,
  SessionHubSnapshot,
  SessionRecord,
} from "@dsh-fusion/core";
import { fusionBrowserUrl } from "../../routes.js";

export interface UseSessionHubOptions {
  endpoint?: string;
  fallbackSessions: readonly SessionRecord[];
  refreshSignal?: number;
  authoritativeSnapshot?: SessionHubSnapshot;
}

export interface SessionHubView {
  snapshot: SessionHubSnapshot;
  loading: boolean;
  usingFallback: boolean;
  error?: string;
}

export interface UseSessionHistoryOptions {
  historyUrl?: string;
  sourceId: string;
  sessionId: string;
  maxMessages?: number;
  refreshSignal?: number;
  /**
   * Bumped by the pane itself after it sends a prompt. A change
   * always re-reads, even when the recorded version is unchanged:
   * the send may not have moved the listing's sequence yet.
   */
  forceSignal?: number;
  /**
   * The session record's historySeq. When present, refreshSignal
   * bumps re-read only once the recorded version moves past what
   * the last read already covers; when absent the hook keeps its
   * historical behaviour and re-reads on every signal.
   */
  historySeq?: number;
  enabled?: boolean;
}

export interface SessionHistoryView {
  messages: SessionHistoryMessage[];
  hasMore: boolean;
  loading: boolean;
  error?: string;
}

export interface SessionTarget {
  sourceId: string;
  nativeSessionId: string;
}

function bridgeUpdatedAt(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function fallbackSessionHub(
  sessions: readonly SessionRecord[],
  checkedAt = Date.now(),
): SessionHubSnapshot {
  const records: SessionHubSessionRecord[] = sessions.map((session) => ({
    id: `${session.providerId}:${session.id}`,
    sourceId: session.providerId,
    nativeSessionId: session.id,
    title: session.title.trim() === "" ? `未命名会话 (${session.id})` : session.title,
    running: session.status === "live",
    agentAvailable: false,
    blank: false,
    updatedAt: bridgeUpdatedAt(session.updatedAt, checkedAt),
  }));
  const counts = new Map<string, number>();
  for (const session of sessions) {
    counts.set(session.providerId, (counts.get(session.providerId) ?? 0) + 1);
  }
  return {
    provider: "unavailable",
    sessions: records,
    sources: [...counts].map(([sourceId, sessionCount]) => ({
      sourceId,
      state: "unavailable" as const,
      sessionCount,
    })),
    checkedAt,
  };
}

export function sessionCompositeId(sourceId: string, nativeSessionId: string): string {
  return `${sourceId}:${nativeSessionId}`;
}

export function exactSessionForTarget(
  sessions: readonly SessionHubSessionRecord[],
  target: SessionTarget,
): SessionHubSessionRecord | undefined {
  return sessions.find((session) => (
    session.sourceId === target.sourceId
    && session.nativeSessionId === target.nativeSessionId
  ));
}

export function legacySessionForPersistedId(
  sessions: readonly SessionHubSessionRecord[],
  persistedId: string,
): SessionHubSessionRecord | undefined {
  const matches = sessions.filter((session) => session.nativeSessionId === persistedId);
  return matches.length === 1 ? matches[0] : undefined;
}

export function parseSessionDragData(value: string): SessionTarget | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<SessionTarget>;
    return typeof parsed.sourceId === "string"
      && parsed.sourceId !== ""
      && typeof parsed.nativeSessionId === "string"
      && parsed.nativeSessionId !== ""
      ? {
          sourceId: parsed.sourceId,
          nativeSessionId: parsed.nativeSessionId,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export function mergeSessionHubWithFallback(
  payload: SessionHubSnapshot,
  fallback: SessionHubSnapshot,
): { snapshot: SessionHubSnapshot; usingFallback: boolean } {
  const payloadSources = new Map(payload.sources.map((source) => [source.sourceId, source]));
  const normalizedPayload: SessionHubSnapshot = {
    ...payload,
    sessions: payload.sessions.map((session) => ({
      ...session,
      id: sessionCompositeId(session.sourceId, session.nativeSessionId),
      ...(payloadSources.get(session.sourceId)?.state === "available" ? {} : {
        running: false,
        agentAvailable: false,
      }),
    })),
  };
  const payloadIds = new Set(normalizedPayload.sessions.map((session) => session.id));
  const mergedFallbackSessions = fallback.sessions.filter((session) => {
    const status = payloadSources.get(session.sourceId);
    return status?.state !== "available" && !payloadIds.has(session.id);
  }).map((session) => ({ ...session, running: false, agentAvailable: false }));
  if (mergedFallbackSessions.length === 0) {
    return { snapshot: normalizedPayload, usingFallback: false };
  }
  const mergedSources = [...normalizedPayload.sources];
  for (const source of fallback.sources) {
    if (mergedSources.some((candidate) => candidate.sourceId === source.sourceId)) continue;
    mergedSources.push({ ...source, state: "unavailable" });
  }
  return {
    snapshot: {
      ...normalizedPayload,
      sessions: [...normalizedPayload.sessions, ...mergedFallbackSessions],
      sources: mergedSources,
    },
    usingFallback: true,
  };
}

export function sessionHubUrlFromSnapshot(snapshotUrl: string): string | undefined {
  if (!snapshotUrl.endsWith("/state")) return undefined;
  return `${snapshotUrl.slice(0, -"/state".length)}/session-hub`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useSessionHub({
  endpoint,
  fallbackSessions,
  refreshSignal = 0,
  authoritativeSnapshot,
}: UseSessionHubOptions): SessionHubView {
  const fallbackKey = JSON.stringify(fallbackSessions);
  const fallback = useMemo(
    () => fallbackSessionHub(fallbackSessions),
    [fallbackKey],
  );
  const [view, setView] = useState<SessionHubView>(() => authoritativeSnapshot === undefined
    ? { snapshot: fallback, usingFallback: endpoint === undefined, loading: endpoint !== undefined }
    : { ...mergeSessionHubWithFallback(authoritativeSnapshot, fallback), loading: false });
  const authoritativeSources = useRef(new Set(
    authoritativeSnapshot?.sources.filter((source) => source.state === "available").map((source) => source.sourceId),
  ));

  useEffect(() => {
    const applySnapshot = (payload: SessionHubSnapshot) => {
      // Legacy fallback stops being authoritative once a source has answered successfully.
      const legacyFallback = {
        ...fallback,
        sessions: fallback.sessions.filter((session) => !authoritativeSources.current.has(session.sourceId)),
      };
      for (const source of payload.sources) {
        if (source.state === "available") authoritativeSources.current.add(source.sourceId);
      }
      setView((current) => {
        const known = mergeSessionHubWithFallback(current.snapshot, legacyFallback).snapshot;
        const merged = mergeSessionHubWithFallback(payload, known);
        const failedSources = payload.sources.filter((source) => source.state !== "available");
        return {
          ...merged,
          loading: false,
          ...(failedSources.length === 0 ? {} : {
            error: failedSources.map((source) => source.error ?? `${source.sourceId}: ${source.state}`).join("; "),
          }),
        };
      });
    };
    if (authoritativeSnapshot !== undefined) {
      applySnapshot(authoritativeSnapshot);
      return;
    }
    if (endpoint === undefined) {
      setView({ snapshot: fallback, usingFallback: true, loading: false });
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    setView((current) => ({ ...current, loading: true }));
    void (async () => {
      try {
        const response = await fetch(fusionBrowserUrl(endpoint), {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Session Hub HTTP ${response.status}`);
        }
        const payload = await response.json() as SessionHubSnapshot;
        if (disposed) return;
        applySnapshot(payload);
      } catch (caught) {
        if (disposed || isAbortError(caught)) return;
        setView((current) => ({
          snapshot: {
            ...current.snapshot,
            provider: "unavailable",
            sessions: current.snapshot.sessions.map((session) => ({ ...session, running: false, agentAvailable: false })),
            sources: current.snapshot.sources.map((source) => ({ ...source, state: "unavailable" })),
          },
          loading: false,
          usingFallback: true,
          error: caught instanceof Error ? caught.message : String(caught),
        }));
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [endpoint, fallback, refreshSignal, authoritativeSnapshot]);

  return view;
}

const HISTORY_THROTTLE_MS = 250;

interface HistoryGate {
  key: string;
  /** historySeq of the record the last scheduled read targeted. */
  recordSeq: number | undefined;
  /** asOfSeq the last successful read reported: the version on screen. */
  readSeq: number | undefined;
  forceSignal: number;
  lastStartedAt: number;
  controller: AbortController | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function useSessionHistory({
  historyUrl,
  sourceId,
  sessionId,
  maxMessages = 50,
  refreshSignal = 0,
  forceSignal = 0,
  historySeq,
  enabled = true,
}: UseSessionHistoryOptions): SessionHistoryView {
  const active = enabled && historyUrl !== undefined;
  const [state, setState] = useState<SessionHistoryView>({
    messages: [],
    hasMore: false,
    loading: active,
  });
  const gateRef = useRef<HistoryGate>({
    key: "",
    recordSeq: undefined,
    readSeq: undefined,
    forceSignal: 0,
    lastStartedAt: 0,
    controller: undefined,
    timer: undefined,
  });
  // The trailing throttle timer fires after the render that
  // scheduled it, so it must read the newest inputs, not a
  // captured render's values.
  const latestRef = useRef({ active, historyUrl, sourceId, sessionId, maxMessages, forceSignal, historySeq });
  latestRef.current = { active, historyUrl, sourceId, sessionId, maxMessages, forceSignal, historySeq };

  const teardownGate = (gate: HistoryGate) => {
    gate.controller?.abort();
    gate.controller = undefined;
    if (gate.timer !== undefined) {
      clearTimeout(gate.timer);
      gate.timer = undefined;
    }
  };

  const performRead = () => {
    const gate = gateRef.current;
    const inputs = latestRef.current;
    if (!inputs.active || inputs.historyUrl === undefined) return;
    if (gate.timer !== undefined) {
      clearTimeout(gate.timer);
      gate.timer = undefined;
    }
    gate.controller?.abort();
    const controller = new AbortController();
    gate.controller = controller;
    gate.lastStartedAt = Date.now();
    gate.recordSeq = inputs.historySeq;
    setState((current) => {
      const { error: _error, ...rest } = current;
      return { ...rest, loading: true };
    });
    const query = new URLSearchParams({
      sourceId: inputs.sourceId,
      sessionId: inputs.sessionId,
      maxMessages: String(inputs.maxMessages),
    });
    void (async () => {
      try {
        const response = await fetch(
          fusionBrowserUrl(`${inputs.historyUrl}?${query.toString()}`),
          { signal: controller.signal },
        );
        if (!response.ok) {
          throw new Error(`history HTTP ${response.status}`);
        }
        const payload = await response.json() as {
          messages?: SessionHistoryMessage[];
          hasMore?: boolean;
          asOfSeq?: number;
        };
        if (controller.signal.aborted) return;
        // A response without asOfSeq (older server) disengages
        // the version gate: fail open to per-signal reads.
        gate.readSeq = typeof payload.asOfSeq === "number" ? payload.asOfSeq : undefined;
        setState({
          messages: Array.isArray(payload.messages) ? payload.messages : [],
          hasMore: payload.hasMore === true,
          loading: false,
        });
      } catch (caught) {
        if (controller.signal.aborted || isAbortError(caught)) return;
        // A failed read replaces the messages with the error
        // state, so any earlier coverage proof is void: the
        // next signal at the same version must retry instead
        // of being blocked by the stale recordSeq/readSeq pair.
        gate.recordSeq = undefined;
        gate.readSeq = undefined;
        setState({
          messages: [],
          hasMore: false,
          loading: false,
          error: caught instanceof Error ? caught.message : String(caught),
        });
      }
    })();
  };

  const requestRead = () => {
    const gate = gateRef.current;
    const inputs = latestRef.current;
    if (!inputs.active) {
      teardownGate(gate);
      // The messages are being cleared, so the coverage proof
      // must die with them: recordSeq/readSeq asserted that the
      // ON-SCREEN read covers the recorded version, and after
      // this clear nothing is on screen. Keeping the proof
      // would make a later re-activation at the same version
      // skip the read and leave the pane blank forever.
      gate.recordSeq = undefined;
      gate.readSeq = undefined;
      setState({ messages: [], hasMore: false, loading: false });
      return;
    }
    const key = `${inputs.sourceId}:${inputs.sessionId}`;
    if (gate.key !== key) {
      teardownGate(gate);
      gate.key = key;
      gate.recordSeq = undefined;
      gate.readSeq = undefined;
      gate.forceSignal = inputs.forceSignal;
      gate.lastStartedAt = 0;
    }
    const forced = inputs.forceSignal !== gate.forceSignal;
    if (forced) gate.forceSignal = inputs.forceSignal;
    const seq = inputs.historySeq;
    // Skip only when the on-screen read provably covers the
    // recorded version: the last read targeted this same record
    // sequence and the server reported holding at least that much.
    // A moved record sequence (advance or regression) always reads.
    const covered = seq !== undefined
      && gate.recordSeq === seq
      && gate.readSeq !== undefined
      && gate.readSeq >= seq;
    if (!forced && covered) return;
    // Rapid version jumps coalesce into one trailing read of the
    // newest inputs; unversioned callers keep the historical
    // immediate per-signal behaviour.
    if (seq !== undefined && gate.lastStartedAt !== 0) {
      const wait = HISTORY_THROTTLE_MS - (Date.now() - gate.lastStartedAt);
      if (wait > 0) {
        setState((current) => ({ ...current, loading: true }));
        if (gate.timer !== undefined) clearTimeout(gate.timer);
        gate.timer = setTimeout(() => {
          gate.timer = undefined;
          performRead();
        }, wait);
        return;
      }
    }
    performRead();
  };

  useEffect(() => {
    requestRead();
  }, [active, historyUrl, sessionId, sourceId, maxMessages, refreshSignal, forceSignal, historySeq]);

  useEffect(() => () => teardownGate(gateRef.current), []);

  return state;
}
