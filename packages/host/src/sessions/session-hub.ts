import { randomUUID } from "node:crypto";
import type {
  SessionHistoryMessage,
  SessionHubHistory,
  SessionHubProviderState,
  SessionHubSessionRecord,
  SessionHubSnapshot,
  SessionHubSourceState,
  SessionHubSourceStatus,
  SessionRecord,
} from "@dsh-fusion/core";

type SessionId = string;

interface NativeSessionProjectionHints {
  kind: "cached" | "sequenced";
  asOfSeq: number;
  values: Readonly<Record<string, unknown>>;
}

export interface NativeSessionSummary {
  agentAvailable: boolean;
  sessionId: SessionId;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: SessionId;
  origin?: "subagent";
  cwd?: string;
  projections?: NativeSessionProjectionHints;
}

export interface NativeSessionProjectionBaseline {
  asOfSeq: number;
  values: Readonly<Record<string, unknown>>;
}

export type NativeSessionAddress = {
  kind: "session";
  sessionId: SessionId;
} | {
  kind: "subagent";
  parentSessionId: SessionId;
  childSessionId: SessionId;
  mode: "one-shot" | "continuable" | "unknown";
};

export interface NativeSessionHistoryEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
}

export interface NativeSessionPage {
  records: ReadonlyArray<{
    type: "event";
    event: NativeSessionHistoryEvent;
  }>;
  hasMore: boolean;
}

export interface SessionControllerLike {
  list(
    request: Record<string, never>,
    signal: AbortSignal,
  ): Promise<{ items: readonly NativeSessionSummary[] }>;
  projections(
    request: { sessionId: SessionId },
    signal: AbortSignal,
  ): Promise<NativeSessionProjectionBaseline | null>;
  page(
    request: {
      address: NativeSessionAddress;
      throughSeq: number;
      beforeSeq?: number;
      maxMessages?: number;
    },
    signal: AbortSignal,
  ): Promise<NativeSessionPage>;
  prompt(
    request: {
      requestId: string;
      sessionId: SessionId;
      mode: "queue" | "steer";
      content: ReadonlyArray<{ type: "text"; text: string }>;
    },
    signal: AbortSignal,
  ): Promise<{ accepted: true }>;
}

export interface SessionHubBridgeSource {
  sourceId: string;
  state: SessionHubSourceState;
  sessions: readonly SessionRecord[];
  error?: string;
}

export interface SessionHubChange {
  sessionIds: string[];
  reason: "api-session";
}

export type SessionHubEventName =
  | "api-session/added"
  | "api-session/removed"
  | "api-session/status"
  | "api-session/activity"
  | "api-session/error";

type SessionHubListener = (...args: unknown[]) => void;

export interface SessionHubOptions {
  getSessionController: () => SessionControllerLike | undefined;
  on?: (
    event: SessionHubEventName,
    listener: SessionHubListener,
  ) => () => void;
  debounceMs?: number;
  now?: () => number;
  onChange?: (change: SessionHubChange) => void;
}

export type SessionHubErrorCode =
  | "NOT_FOUND"
  | "UNKNOWN_SOURCE"
  | "UNSUPPORTED_SOURCE"
  | "UNAVAILABLE"
  | "INVALID_ARGUMENT"
  | "CONFLICT";

export class SessionHubError extends Error {
  readonly code: SessionHubErrorCode;
  readonly status: number;

  constructor(code: SessionHubErrorCode, message: string, status: number) {
    super(message);
    this.name = "SessionHubError";
    this.code = code;
    this.status = status;
  }
}

const LOCAL_SOURCE_ID = "dsh-local";
const SESSION_EVENTS: readonly SessionHubEventName[] = [
  "api-session/added",
  "api-session/removed",
  "api-session/status",
  "api-session/activity",
  "api-session/error",
];

function localKey(sessionId: string): string {
  return `${LOCAL_SOURCE_ID}:${sessionId}`;
}

function sourceKey(sourceId: string, sessionId: string): string {
  return `${sourceId}:${sessionId}`;
}

function directoryName(path: string): string {
  const withoutTrailingSeparators = path.replace(/[\\/]+$/u, "");
  const separatorIndex = Math.max(
    withoutTrailingSeparators.lastIndexOf("/"),
    withoutTrailingSeparators.lastIndexOf("\\"),
  );
  return withoutTrailingSeparators.slice(separatorIndex + 1).trim();
}

function fallbackTitle(cwd: string | undefined, sessionId: string): string {
  const directory = cwd === undefined ? "" : directoryName(cwd);
  return directory === ""
    ? `未命名会话 (${sessionId})`
    : `未命名会话 · ${directory}`;
}

function bridgeUpdatedAt(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function localRecord(
  summary: NativeSessionSummary,
  fallbackNow: number,
  lastError: string | undefined,
): SessionHubSessionRecord {
  const projectedTitle = summary.projections?.values.title;
  const title = typeof projectedTitle === "string" && projectedTitle.trim() !== ""
    ? projectedTitle
    : fallbackTitle(summary.cwd, summary.sessionId);
  const isSubagent = summary.origin === "subagent" && summary.parentSessionId !== undefined;
  return {
    id: localKey(summary.sessionId),
    sourceId: LOCAL_SOURCE_ID,
    nativeSessionId: summary.sessionId,
    title,
    running: summary.running,
    agentAvailable: summary.agentAvailable,
    blank: summary.blank,
    updatedAt: Number.isFinite(summary.updatedAt) ? summary.updatedAt : fallbackNow,
    ...(summary.projections === undefined ? {} : { historySeq: summary.projections.asOfSeq }),
    ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
    ...(!isSubagent ? {} : {
      parentNativeId: summary.parentSessionId,
      subagentMode: "unknown" as const,
    }),
    ...(summary.origin === undefined ? {} : { origin: summary.origin }),
    ...(lastError === undefined ? {} : { lastError }),
  };
}

function bridgeRecord(
  session: SessionRecord,
  fallbackNow: number,
): SessionHubSessionRecord {
  return {
    id: sourceKey(session.providerId, session.id),
    sourceId: session.providerId,
    nativeSessionId: session.id,
    title: session.title.trim() === "" ? fallbackTitle(undefined, session.id) : session.title,
    running: session.status === "live",
    agentAvailable: false,
    blank: false,
    updatedAt: bridgeUpdatedAt(session.updatedAt, fallbackNow),
  };
}

function aggregateProvider(
  sources: readonly SessionHubSourceStatus[],
): SessionHubProviderState {
  if (sources.length === 0) return "unavailable";
  const available = sources.filter((source) => source.state === "available").length;
  const failed = sources.filter((source) => source.state === "failed").length;
  if (available === 0) {
    return failed === sources.length ? "failed" : "unavailable";
  }
  const unavailable = sources.length - available;
  return unavailable > 0 ? "partial" : "available";
}

function messageContent(
  event: NativeSessionHistoryEvent,
): { role: "user" | "assistant"; text: string } | undefined {
  const role = event.type === "user/message"
    ? "user" as const
    : event.type === "assistant/message"
      ? "assistant" as const
      : undefined;
  if (role === undefined || event.data === null || typeof event.data !== "object") {
    return undefined;
  }
  const message = (event.data as { message?: unknown }).message;
  if (message === null || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((block) => {
      if (
        block !== null
        && typeof block === "object"
        && (block as { type?: unknown }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
      ) {
        return [(block as { text: string }).text];
      }
      return [];
    })
    .join("\n")
    .trim();
  return text === "" ? undefined : { role, text };
}

export class SessionHub {
  private readonly getSessionController: () => SessionControllerLike | undefined;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly onChange: (change: SessionHubChange) => void;
  private readonly disposers: Array<() => void> = [];
  private readonly lastErrors = new Map<string, string>();
  private readonly pendingSessionIds = new Set<string>();
  private bridgeSources: readonly SessionHubBridgeSource[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(options: SessionHubOptions) {
    this.getSessionController = options.getSessionController;
    this.debounceMs = Math.max(0, Math.trunc(options.debounceMs ?? 50));
    this.now = options.now ?? (() => Date.now());
    this.onChange = options.onChange ?? (() => {});
    if (options.on !== undefined) {
      for (const event of SESSION_EVENTS) {
        this.disposers.push(options.on(event, (...args) => this.handleEvent(event, args)));
      }
    }
  }

  setBridgeSources(sources: readonly SessionHubBridgeSource[]): void {
    this.bridgeSources = sources;
  }

  async snapshot(signal: AbortSignal = new AbortController().signal): Promise<SessionHubSnapshot> {
    const checkedAt = this.now();
    const sources: SessionHubSourceStatus[] = [];
    const sessions: SessionHubSessionRecord[] = [];
    const controller = this.getSessionController();

    if (controller === undefined) {
      sources.push({
        sourceId: LOCAL_SOURCE_ID,
        state: "unavailable",
        sessionCount: 0,
        error: "DSH sessionController is unavailable",
      });
    } else {
      try {
        const listed = await controller.list({}, signal);
        sources.push({
          sourceId: LOCAL_SOURCE_ID,
          state: "available",
          sessionCount: listed.items.length,
        });
        sessions.push(...listed.items.map((summary) => localRecord(
          summary,
          checkedAt,
          this.lastErrors.get(summary.sessionId),
        )));
      } catch (error) {
        if (signal.aborted) throw error;
        sources.push({
          sourceId: LOCAL_SOURCE_ID,
          state: "failed",
          sessionCount: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const source of this.bridgeSources) {
      sources.push({
        sourceId: source.sourceId,
        state: source.state,
        sessionCount: source.sessions.length,
        ...(source.error === undefined ? {} : { error: source.error }),
      });
      if (source.state === "available") {
        sessions.push(...source.sessions
          .filter((session) => session.providerId === source.sourceId)
          .map((session) => bridgeRecord(session, checkedAt)));
      }
    }

    return {
      provider: aggregateProvider(sources),
      sessions,
      sources,
      checkedAt,
    };
  }

  async history(
    sourceId: string,
    sessionId: string,
    maxMessages = 50,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SessionHubHistory> {
    const controller = this.getSessionController();
    if (controller === undefined) {
      throw new SessionHubError(
        "UNAVAILABLE",
        "DSH sessionController is unavailable",
        503,
      );
    }
    const session = this.resolveLocalSession(await this.snapshot(signal), sourceId, sessionId);
    const projections = await controller.projections({ sessionId }, signal);
    if (projections === null) {
      throw new SessionHubError("NOT_FOUND", `Unknown session ${sessionId}`, 404);
    }
    const address: NativeSessionAddress = session.origin === "subagent"
      && session.parentNativeId !== undefined
      ? {
          kind: "subagent",
          parentSessionId: session.parentNativeId,
          childSessionId: session.nativeSessionId,
          mode: session.subagentMode ?? "unknown",
        }
      : { kind: "session", sessionId: session.nativeSessionId };
    const page = await controller.page({
      address,
      throughSeq: projections.asOfSeq,
      maxMessages: Math.max(1, Math.min(200, Math.trunc(maxMessages))),
    }, signal);
    const messages = page.records
      .flatMap((record): SessionHistoryMessage[] => {
        const mapped = messageContent(record.event);
        return mapped === undefined
          ? []
          : [{
              ...mapped,
              seq: record.event.seq,
              time: record.event.time,
            }];
      })
      .sort((left, right) => left.seq - right.seq);
    return { messages, hasMore: page.hasMore, asOfSeq: projections.asOfSeq };
  }

  async prompt(
    sourceId: string,
    sessionId: string,
    text: string,
    mode: "queue" | "steer" = "queue",
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ accepted: true }> {
    const content = text.trim();
    if (content === "" || content.length > 16_000) {
      throw new SessionHubError(
        "INVALID_ARGUMENT",
        "Prompt text must be between 1 and 16000 characters",
        400,
      );
    }
    const controller = this.getSessionController();
    if (controller === undefined) {
      throw new SessionHubError(
        "UNAVAILABLE",
        "DSH sessionController is unavailable",
        503,
      );
    }
    const session = this.resolveLocalSession(await this.snapshot(signal), sourceId, sessionId);
    if (!session.agentAvailable) {
      throw new SessionHubError(
        "CONFLICT",
        `Session ${sessionId} has no available Agent`,
        409,
      );
    }
    return await controller.prompt({
      requestId: randomUUID(),
      sessionId,
      mode,
      content: [{ type: "text", text: content }],
    }, signal);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pendingSessionIds.clear();
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  private resolveLocalSession(
    snapshot: SessionHubSnapshot,
    sourceId: string,
    sessionId: string,
  ): SessionHubSessionRecord {
    const source = snapshot.sources.find((candidate) => candidate.sourceId === sourceId);
    if (source === undefined) {
      throw new SessionHubError("UNKNOWN_SOURCE", `Unknown Session source ${sourceId}`, 404);
    }
    if (source.state !== "available") {
      throw new SessionHubError("UNAVAILABLE", source.error ?? `Session source ${sourceId} is unavailable`, 503);
    }
    // An equal local id is a mapping only after the requested source proves ownership.
    const exactSession = snapshot.sessions.find((candidate) => (
      candidate.sourceId === sourceId && candidate.nativeSessionId === sessionId
    ));
    if (exactSession === undefined) {
      throw new SessionHubError("NOT_FOUND", `Unknown session ${sourceId}:${sessionId}`, 404);
    }
    const localSource = snapshot.sources.find((candidate) => candidate.sourceId === LOCAL_SOURCE_ID);
    if (localSource?.state !== "available") {
      throw new SessionHubError("UNAVAILABLE", localSource?.error ?? "DSH Session list is unavailable", 503);
    }
    const localSession = snapshot.sessions.find((candidate) => (
      candidate.sourceId === LOCAL_SOURCE_ID && candidate.nativeSessionId === sessionId
    ));
    if (localSession === undefined) {
      throw new SessionHubError("UNSUPPORTED_SOURCE", `Bridge source ${sourceId} has no local DSH Session mapping`, 400);
    }
    return localSession;
  }

  private handleEvent(event: SessionHubEventName, args: readonly unknown[]): void {
    if (this.disposed) return;
    if (event === "api-session/added") {
      const summary = args[0] as NativeSessionSummary | undefined;
      if (typeof summary?.sessionId === "string") {
        this.pendingSessionIds.add(localKey(summary.sessionId));
      }
    } else {
      const sessionId = args[0];
      if (typeof sessionId === "string") {
        this.pendingSessionIds.add(localKey(sessionId));
        if (event === "api-session/error") {
          this.lastErrors.set(sessionId, typeof args[1] === "string" ? args[1] : "Unknown error");
        } else if (event === "api-session/status" || event === "api-session/activity") {
          this.lastErrors.delete(sessionId);
        }
      }
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const sessionIds = [...this.pendingSessionIds].sort();
      this.pendingSessionIds.clear();
      this.onChange({ sessionIds, reason: "api-session" });
    }, this.debounceMs);
  }
}
