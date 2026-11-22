import type {
  AgentFlowRecord,
  AgentTeamRecord,
  BotRecord,
  BridgedSnapshot,
  GroupRecord,
  NodeRecord,
  RoomRecord,
  RoomMessageRecord,
  SessionRecord,
  TaskEvidence,
  TaskRecord,
  TaskStatus,
} from "@dsh-fusion/core";

type JsonRecord = Record<string, unknown>;

const UNKNOWN_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const DEFAULT_TIMEOUT_MS = 5_000;

export const DEFAULT_AGENT_TEAMS_STATE_PATH = "/plugins/dsh-agent-teams/state";
export const DEFAULT_AGENT_BUS_STATE_PATH = "/plugins/dsh-agent-bus/state";
export const DEFAULT_ROOM_SESSION_ENDPOINT = "/agent-team-room/api/session/{sessionId}";

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;
export type ForwardHeaders = HeadersInit | Record<string, string | readonly string[] | undefined>;

export interface JsonFetchInit {
  headers?: ForwardHeaders;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BridgeLoadOptions {
  headers?: ForwardHeaders;
  timeoutMs?: number;
  failFast?: boolean;
}

export type JsonFetcher = (path: string, init?: JsonFetchInit) => Promise<unknown>;

export interface JsonFetcherOptions {
  baseUrl: string | URL;
  fetch?: FetchLike;
  fetchImpl?: FetchLike;
  headers?: ForwardHeaders;
  timeoutMs?: number;
}

export type JsonFetchErrorCode =
  | "INVALID_BASE_URL"
  | "CROSS_ORIGIN"
  | "FETCH_UNAVAILABLE"
  | "HTTP_ERROR"
  | "INVALID_JSON"
  | "TIMEOUT";

export class JsonFetchError extends Error {
  readonly code: JsonFetchErrorCode;
  readonly path: string | undefined;
  readonly status: number | undefined;

  constructor(
    code: JsonFetchErrorCode,
    message: string,
    details: { path?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "JsonFetchError";
    this.code = code;
    this.path = details.path;
    this.status = details.status;
  }
}

function isHopByHopHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "host"
    || normalized === "content-length"
    || normalized === "connection"
    || normalized === "keep-alive"
    || normalized === "transfer-encoding"
    || normalized === "upgrade"
    || normalized.startsWith("proxy-");
}

function mergeForwardHeaders(...sources: Array<ForwardHeaders | undefined>): Headers {
  const headers = new Headers();
  for (const source of sources) {
    if (source === undefined) continue;
    const entries: Array<[string, string]> = source instanceof Headers
      ? [...source.entries()]
      : Array.isArray(source)
        ? source.map(([name, value]) => [String(name), String(value)])
        : Object.entries(source).flatMap(([name, value]) => {
            if (value === undefined) return [];
            return [[name, Array.isArray(value) ? value.join(", ") : String(value)]];
          });
    for (const [name, value] of entries) {
      if (!isHopByHopHeader(name)) headers.set(name, value);
    }
  }
  return headers;
}

function resolveSameOriginUrl(path: string, baseUrl: URL): URL {
  let url: URL;
  try {
    url = new URL(path, baseUrl);
  } catch (error) {
    throw new JsonFetchError("INVALID_BASE_URL", `Invalid JSON fetch path: ${path}`, {
      path,
      cause: error,
    });
  }
  if (url.origin !== baseUrl.origin) {
    throw new JsonFetchError("CROSS_ORIGIN", `Cross-origin JSON fetch rejected: ${url.origin}`, { path });
  }
  return url;
}

function resolveTimeoutMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(1, Math.trunc(value))
    : DEFAULT_TIMEOUT_MS;
}

function requestInitFrom(options: BridgeLoadOptions): JsonFetchInit {
  return {
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

export function createJsonFetcher(options: JsonFetcherOptions): JsonFetcher;
export function createJsonFetcher(
  baseUrl: string | URL,
  options?: Omit<JsonFetcherOptions, "baseUrl">,
): JsonFetcher;
export function createJsonFetcher(
  baseUrl: string | URL,
  fetchImpl: FetchLike,
  headers?: ForwardHeaders,
  timeoutMs?: number,
): JsonFetcher;
export function createJsonFetcher(
  optionsOrBaseUrl: JsonFetcherOptions | string | URL,
  fetchOrOptions?: FetchLike | Omit<JsonFetcherOptions, "baseUrl">,
  headers?: ForwardHeaders,
  timeoutMs?: number,
): JsonFetcher {
  let resolved: JsonFetcherOptions;
  if (typeof optionsOrBaseUrl === "string" || optionsOrBaseUrl instanceof URL) {
    resolved = typeof fetchOrOptions === "function"
      ? {
          baseUrl: optionsOrBaseUrl,
          fetchImpl: fetchOrOptions,
          ...(headers === undefined ? {} : { headers }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }
      : {
          ...(fetchOrOptions ?? {}),
          baseUrl: optionsOrBaseUrl,
        };
  } else {
    resolved = optionsOrBaseUrl;
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(resolved.baseUrl);
  } catch (error) {
    throw new JsonFetchError("INVALID_BASE_URL", `Invalid DSH base URL: ${String(resolved.baseUrl)}`, {
      cause: error,
    });
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new JsonFetchError("INVALID_BASE_URL", `Unsupported DSH base URL protocol: ${baseUrl.protocol}`);
  }

  const fetchImpl = resolved.fetchImpl ?? resolved.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new JsonFetchError("FETCH_UNAVAILABLE", "No fetch implementation is available");
  }
  const defaultHeaders = resolved.headers;
  const defaultTimeoutMs = resolveTimeoutMs(resolved.timeoutMs);

  return async (path, init = {}) => {
    const url = resolveSameOriginUrl(path, baseUrl);
    const headers = mergeForwardHeaders(defaultHeaders, init.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (!headers.has("sec-fetch-site")) headers.set("sec-fetch-site", "same-origin");

    const controller = new AbortController();
    const externalSignal = init.signal;
    if (externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : new Error("JSON fetch aborted");
    }
    const abortFromExternal = (): void => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

    const effectiveTimeoutMs = resolveTimeoutMs(init.timeoutMs ?? defaultTimeoutMs);
    const timeoutError = new JsonFetchError(
      "TIMEOUT",
      `JSON fetch timed out after ${effectiveTimeoutMs}ms: ${path}`,
      { path },
    );
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort(timeoutError);
        reject(timeoutError);
      }, effectiveTimeoutMs);
    });

    try {
      const response = await Promise.race([
        fetchImpl(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        }),
        timeout,
      ]);
      const responseStatus = typeof response.status === "number" ? response.status : 200;
      const responseOk = typeof response.ok === "boolean"
        ? response.ok
        : responseStatus >= 200 && responseStatus < 300;
      if (!responseOk) {
        throw new JsonFetchError(
          "HTTP_ERROR",
          `JSON fetch failed with HTTP ${responseStatus}: ${path}`,
          { path, status: responseStatus },
        );
      }
      try {
        return await response.json() as unknown;
      } catch (error) {
        throw new JsonFetchError("INVALID_JSON", `Invalid JSON response: ${path}`, {
          path,
          cause: error,
        });
      }
    } catch (error) {
      if (timedOut) throw timeoutError;
      throw error;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  };
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : undefined;
  }
  return undefined;
}

function timestamp(value: unknown, fallback = UNKNOWN_TIMESTAMP): string {
  const time = timestampMs(value);
  if (time === undefined) return fallback;
  try {
    return new Date(time).toISOString();
  } catch {
    return fallback;
  }
}

function latestTimestamp(values: unknown[], fallback = UNKNOWN_TIMESTAMP): string {
  let latest: number | undefined;
  for (const value of values) {
    const time = timestampMs(value);
    if (time !== undefined && (latest === undefined || time > latest)) latest = time;
  }
  return latest === undefined ? fallback : timestamp(latest, fallback);
}

function taskStatus(value: unknown): TaskStatus {
  const status = text(value).toLowerCase();
  if (status === "running" || status === "working" || status === "in_progress") return "running";
  if (status === "completed" || status === "success" || status === "passed" || status === "archived") {
    return "completed";
  }
  if (status === "failed" || status === "error" || status === "rejected") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "claimed" || status === "submitted" || status === "input-required") return "claimed";
  if (status === "verifying") return "verifying";
  return "queued";
}

function reportedProgress(value?: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(100, value));
  return undefined;
}

function evidence(label: string, value: unknown): TaskEvidence | undefined {
  const content = typeof value === "string"
    ? value.trim()
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
  return content === "" ? undefined : { kind: "summary", label, value: content };
}

function emptyBridged(): BridgedSnapshot {
  return {
    bots: [],
    groups: [],
    sessions: [],
    tasks: [],
    agentTeams: [],
    agentFlows: [],
    rooms: [],
  };
}

export interface AgentTeamsBridgeResult {
  bots: BotRecord[];
  groups: GroupRecord[];
  sessions: SessionRecord[];
  tasks: TaskRecord[];
  agentTeams: AgentTeamRecord[];
}

export function emptyAgentTeamsBridgeResult(): AgentTeamsBridgeResult {
  return {
    bots: [],
    groups: [],
    sessions: [],
    tasks: [],
    agentTeams: [],
  };
}

function mergeAgentTeamsResults(
  ...results: AgentTeamsBridgeResult[]
): AgentTeamsBridgeResult {
  const merged = emptyAgentTeamsBridgeResult();
  const appendUnique = <T extends { id: string }>(target: T[], values: T[]): void => {
    const existing = new Set(target.map((entry) => entry.id));
    for (const value of values) {
      if (!existing.has(value.id)) {
        target.push(value);
        existing.add(value.id);
      }
    }
  };
  for (const result of results) {
    appendUnique(merged.bots, result.bots);
    appendUnique(merged.groups, result.groups);
    appendUnique(merged.sessions, result.sessions);
    appendUnique(merged.tasks, result.tasks);
    appendUnique(merged.agentTeams, result.agentTeams);
  }
  return merged;
}

export function mapAgentTeamsSnapshot(
  value: unknown,
  archived = false,
): AgentTeamsBridgeResult {
  const result = emptyAgentTeamsBridgeResult();
  const teams = Array.isArray(value) ? value : array(record(value).teams);

  for (const item of teams) {
    const team = record(item);
    const teamId = text(team.teamId, text(team.id));
    if (teamId === "") continue;
    const teamName = text(team.name, teamId);
    const teamKey = `agent-teams:${teamId}`;
    const members = array(team.members).map(record);
    const tasks = array(team.tasks).map(record);
    const captainSessionId = text(team.captainSessionId);
    const memberIds = members.map((member, index) =>
      text(member.id, text(member.name, `member-${index + 1}`))
    );
    const taskIds = tasks.map((task, index) =>
      `${teamKey}:${text(task.id, `task-${index + 1}`)}`
    );
    const teamTimestamp = latestTimestamp([
      team.updatedAt,
      ...tasks.map((task) => task.updatedAt),
    ]);

    result.agentTeams.push({
      id: teamKey,
      providerId: "agent-teams",
      name: teamName,
      workspace: text(team.workspace),
      phase: archived
        ? "archived"
        : text(team.phase) === "staged"
          ? "staged"
          : "running",
      captainSessionId,
      memberIds,
      taskIds,
    });

    const memberSessionIds = new Map<string, string>();
    members.forEach((member, index) => {
      const memberId = memberIds[index]!;
      memberSessionIds.set(memberId, memberId);
      const memberName = text(member.name);
      if (memberName !== "") memberSessionIds.set(memberName, memberId);
    });

    if (captainSessionId !== "") {
      const captainInbox = array(team.captainInbox).flatMap((item, index) => {
        const message = record(item);
        const content = text(message.content).trim();
        if (content === "") return [];
        return [{
          id: `${teamKey}:inbox:${index + 1}`,
          from: text(message.from, "AgentTeams"),
          content,
        }];
      });
      result.bots.push({
        id: captainSessionId,
        providerId: "agent-teams",
        name: `${teamName} Captain`,
        role: "AgentTeams captain",
        model: "unknown",
        isMain: true,
        status: archived ? "offline" : "working",
        ...(captainInbox.length === 0 ? {} : { recentMessages: captainInbox }),
      });
      result.sessions.push({
        id: captainSessionId,
        providerId: "agent-teams",
        title: `${teamName} captain`,
        status: archived ? "finished" : "live",
        updatedAt: teamTimestamp,
      });
    }

    members.forEach((member, index) => {
      const memberId = memberIds[index]!;
      const memberStatus = text(member.status);
      const isWorking = memberStatus === "working" || text(member.activity) === "working";
      result.bots.push({
        id: memberId,
        providerId: "agent-teams",
        name: text(member.name, memberId),
        role: text(member.role, "AgentTeams member"),
        model: text(member.model, text(member.provider, "unknown")),
        ...(text(member.reasoningEffort) === ""
          ? {}
          : { reasoningEffort: text(member.reasoningEffort) }),
        isMain: index === 0,
        status: archived ? "offline" : isWorking ? "working" : memberStatus === "removed" ? "offline" : "idle",
        memoryCount: 0,
        usageTokens: 0,
      });
      result.sessions.push({
        id: memberId,
        providerId: "agent-teams",
        title: text(member.name, memberId),
        status: archived ? "finished" : memberStatus === "removed" ? "finished" : isWorking ? "live" : "idle",
        updatedAt: timestamp(member.updatedAt, teamTimestamp),
      });
    });

    result.groups.push({
      id: teamKey,
      providerId: "agent-teams",
      name: teamName,
      ...(captainSessionId === "" ? {} : { adminBotId: captainSessionId }),
      memberBotIds: captainSessionId === "" ? memberIds : [captainSessionId, ...memberIds],
      unreadCount: typeof team.messageCount === "number" && Number.isFinite(team.messageCount)
        ? Math.max(0, Math.trunc(team.messageCount))
        : 0,
    });

    tasks.forEach((task, index) => {
      const status = taskStatus(task.status ?? task.state);
      const taskKey = taskIds[index]!;
      const assignee = text(task.assignee);
      const assigneeSessionId = memberSessionIds.get(assignee);
      const taskId = text(task.id);
      const blockedBySource = Array.isArray(task.blockedBy)
        ? task.blockedBy
        : array(task.dependencies);
      const blockedBy = blockedBySource
        .map((value) => text(value))
        .filter((value) => value !== "");
      const dependencies = blockedBy.map((value) => `${teamKey}:${value}`);
      const taskEvidence = [
        evidence("verdict", task.verdict),
        evidence("verdictStale", task.verdictStale),
      ].filter((entry): entry is TaskEvidence => entry !== undefined);
      const createdAt = timestamp(task.createdAt, teamTimestamp);
      const progress = reportedProgress(task.progress);
      const revision = typeof task.revision === "number"
        && Number.isSafeInteger(task.revision)
        && task.revision >= 0
        ? task.revision
        : undefined;
      const ownerId = text(task.ownerId);
      const ownerName = text(task.ownerName);
      const writeScopes = array(task.writeScopes)
        .map((value) => text(value))
        .filter((value) => value !== "");
      const ready = typeof task.ready === "boolean" ? task.ready : undefined;
      const writeScopeWarnings = array(task.writeScopeWarnings)
        .map((value) => text(value))
        .filter((value) => value !== "");
      const agentTeamTask = taskId === "" ? undefined : {
        teamId,
        taskId,
        ...(revision === undefined ? {} : { revision }),
        ...(ownerId === "" ? {} : { ownerId }),
        ...(ownerName === "" ? {} : { ownerName }),
        blockedBy,
        writeScopes,
        ...(ready === undefined ? {} : { ready }),
        ...(writeScopeWarnings.length === 0 ? {} : { writeScopeWarnings }),
      };
      result.tasks.push({
        id: taskKey,
        goal: text(task.subject, text(task.description, taskKey)),
        ...(typeof task.description === "string" ? { description: task.description } : {}),
        targetNodeIds: [],
        ...(dependencies.length === 0 ? {} : { dependsOnTaskIds: dependencies }),
        ...(agentTeamTask === undefined ? {} : { agentTeamTask }),
        transport: "dsh-fleet",
        status,
        ...(progress === undefined ? {} : { progress }),
        ...(assigneeSessionId === undefined ? {} : {
          requestedByBotId: assigneeSessionId,
          sessionId: assigneeSessionId,
        }),
        evidence: taskEvidence,
        expectedEvidence: ["summary"],
        createdAt,
        updatedAt: timestamp(task.updatedAt, createdAt),
      });
    });
  }

  return result;
}

export interface AgentBusBridgeResult {
  sessions: SessionRecord[];
  tasks: TaskRecord[];
  agentFlows: AgentFlowRecord[];
}

export function emptyAgentBusBridgeResult(): AgentBusBridgeResult {
  return { sessions: [], tasks: [], agentFlows: [] };
}

export function mapAgentBusSnapshot(value: unknown): AgentBusBridgeResult {
  const root = record(value);
  const result = emptyAgentBusBridgeResult();
  const taskById = new Map<string, string[]>();
  const sessionActivity = new Map<string, number>();

  for (const item of array(root.tasks)) {
    const task = record(item);
    const id = text(task.id);
    if (id === "") continue;
    const fusionId = `agent-bus:${id}`;
    const flowId = text(task.flowId);
    const status = taskStatus(task.status);
    const createdAt = timestamp(task.createdAt);
    const updatedAt = timestamp(task.updatedAt, createdAt);
    const taskEvidence = [
      evidence("reportZone", task.reportZone),
      evidence("hasReportRef", task.hasReportRef),
      evidence("outcome", task.outcome),
      evidence("feedback", task.feedback),
      evidence("assignedReviewer", task.assignedReviewer),
      evidence("acceptanceCriteria", task.acceptanceCriteria),
    ].filter((entry): entry is TaskEvidence => entry !== undefined);
    const progress = reportedProgress(task.progress);
    const dependencies = array(task.dependencies)
      .map((value) => text(value))
      .filter((value) => value !== "")
      .map((value) => value.startsWith("agent-bus:") ? value : `agent-bus:${value}`);
    const assignedTo = text(task.assignedTo);

    result.tasks.push({
      id: fusionId,
      goal: text(task.title, text(task.content, id)),
      targetNodeIds: [],
      ...(dependencies.length === 0 ? {} : { dependsOnTaskIds: dependencies }),
      transport: "dsh-fleet",
      status,
      ...(progress === undefined ? {} : { progress }),
      ...(assignedTo === "" ? {} : { sessionId: `agent-bus:${assignedTo}` }),
      evidence: taskEvidence,
      expectedEvidence: ["summary"],
      createdAt,
      updatedAt,
    });

    const sessionIds = new Set([
      text(task.assignedBy),
      text(task.assignedTo),
      text(task.assignedReviewer),
      ...array(task.staff).map(record).map((entry) => text(entry.sessionId)),
    ]);
    const activityTime = timestampMs(task.updatedAt) ?? timestampMs(task.createdAt);
    if (activityTime !== undefined) {
      for (const sessionId of sessionIds) {
        if (sessionId === "") continue;
        const previous = sessionActivity.get(sessionId);
        if (previous === undefined || activityTime > previous) {
          sessionActivity.set(sessionId, activityTime);
        }
      }
    }
    if (flowId !== "") {
      const ids = taskById.get(flowId) ?? [];
      ids.push(fusionId);
      taskById.set(flowId, ids);
    }
  }

  for (const item of array(root.sessions)) {
    const session = record(item);
    const id = text(session.id);
    if (id === "") continue;
    const activityTime = sessionActivity.get(id);
    result.sessions.push({
      id: `agent-bus:${id}`,
      providerId: "agent-bus",
      title: text(session.title, id),
      status: session.live === true ? "live" : session.archived === true ? "finished" : "idle",
      updatedAt: timestamp(
        session.updatedAt,
        activityTime === undefined ? UNKNOWN_TIMESTAMP : timestamp(activityTime),
      ),
    });
  }

  for (const item of array(root.flows)) {
    const flow = record(item);
    const id = text(flow.id);
    if (id === "") continue;
    const description = text(flow.description);
    result.agentFlows.push({
      id: `agent-bus:${id}`,
      providerId: "agent-bus",
      name: text(flow.name, id),
      ...(description === "" ? {} : { description }),
      workspacePath: text(flow.workspacePath),
      taskIds: taskById.get(id) ?? [],
      archived: flow.archived === true,
    });
  }

  return result;
}

export interface RoomBridgeResult {
  groups: GroupRecord[];
  sessions: SessionRecord[];
  rooms: RoomRecord[];
}

export function emptyRoomBridgeResult(): RoomBridgeResult {
  return { groups: [], sessions: [], rooms: [] };
}

function roomItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const root = record(value);
  if (Array.isArray(root.rooms)) return root.rooms;
  if (text(record(root.room).id) !== "") return [root.room];
  return text(root.id) === "" ? [] : [value];
}

function roomSessionStatus(value: unknown): SessionRecord["status"] {
  const status = text(value).toLowerCase();
  if (status === "leader" || status === "active" || status === "working") return "live";
  if (status === "error") return "error";
  if (status === "removed" || status === "interrupted") return "finished";
  return "idle";
}

function mapRoomActivity(
  room: JsonRecord,
  memberIdMap: ReadonlyMap<string, string>,
): RoomRecord["activity"] {
  const activity = Array.isArray(room.activity) ? room.activity : array(room.events);
  if (activity.length === 0) return undefined;
  return activity.map((item, index) => {
    const event = record(item);
    const type = text(event.type, "room.updated");
    const acceptedCount = typeof event.acceptedCount === "number" && Number.isFinite(event.acceptedCount)
      ? Math.max(0, Math.trunc(event.acceptedCount))
      : undefined;
    const failedCount = typeof event.failedCount === "number" && Number.isFinite(event.failedCount)
      ? Math.max(0, Math.trunc(event.failedCount))
      : undefined;
    const actorMemberId = text(event.actorMemberId);
    const targetMemberId = text(event.targetMemberId);
    return {
      id: text(event.id, `activity-${index + 1}`),
      type,
      at: timestamp(event.at),
      label: text(event.label, type),
      ...(actorMemberId === "" ? {} : { actorMemberId: memberIdMap.get(actorMemberId) ?? actorMemberId }),
      ...(targetMemberId === "" ? {} : { targetMemberId: memberIdMap.get(targetMemberId) ?? targetMemberId }),
      ...(acceptedCount === undefined ? {} : { acceptedCount }),
      ...(failedCount === undefined ? {} : { failedCount }),
    };
  });
}

function mapRoomConversation(
  room: JsonRecord,
  memberIdMap: ReadonlyMap<string, string>,
): RoomRecord["conversation"] {
  if (room.conversation === null || typeof room.conversation !== "object" || Array.isArray(room.conversation)) {
    return undefined;
  }
  const conversation = record(room.conversation);
  const messages = array(conversation.messages).flatMap((item, index) => {
    const message = record(item);
    const textValue = text(message.text).trim();
    const authorMemberId = text(message.authorMemberId);
    if (textValue === "" || authorMemberId === "") return [];
    const normalizedAuthorId = memberIdMap.get(authorMemberId) ?? authorMemberId;
    const role = text(message.role) === "member" ? "member" as const : "leader" as const;
    const status = text(message.status) === "completed" ? "completed" as const : "accepted" as const;
    const mode = text(message.mode);
    const messageRecord: RoomMessageRecord = {
      id: text(message.id, `message-${index + 1}`),
      at: timestamp(message.at),
      role,
      authorMemberId: normalizedAuthorId,
      authorName: text(message.authorName, authorMemberId),
      recipientMemberIds: array(message.recipientMemberIds)
        .map((value) => text(value))
        .filter(Boolean)
        .map((value) => memberIdMap.get(value) ?? value),
      text: textValue,
      status,
      ...(text(message.sessionId) === "" ? {} : { sessionId: text(message.sessionId) }),
      ...(text(message.relayId) === "" ? {} : { relayId: text(message.relayId) }),
      ...(mode === "direct" || mode === "broadcast" ? { mode } : {}),
      ...(Array.isArray(message.replyTo)
        ? {
            replyTo: message.replyTo
              .map((value) => text(value))
              .filter((value): value is string => value !== ""),
          }
        : {}),
    };
    return [messageRecord];
  });
  return {
    messages,
    unavailableMemberIds: array(conversation.unavailableMemberIds)
      .map((value) => text(value))
      .filter((value): value is string => value !== "")
      .map((value) => memberIdMap.get(value) ?? value),
    hiddenMixedReplyCount: typeof conversation.hiddenMixedReplyCount === "number"
      && Number.isFinite(conversation.hiddenMixedReplyCount)
      ? Math.max(0, Math.trunc(conversation.hiddenMixedReplyCount))
      : 0,
  };
}

export function mapRoomSnapshot(value: unknown): RoomBridgeResult {
  const result = emptyRoomBridgeResult();

  for (const item of roomItems(value)) {
    const room = record(item);
    const id = text(room.id);
    if (id === "") continue;
    const roomKey = `agent-room:${id}`;
    const roomName = text(room.name, id);
    const members = array(room.members).map(record);
    const memberIds = members.map((member, index) =>
      `${roomKey}:${text(member.memberId, text(member.id, `member-${index + 1}`))}`
    );
    const memberIdMap = new Map<string, string>();
    members.forEach((member, index) => {
      const rawMemberId = text(member.memberId, text(member.id, `member-${index + 1}`));
      memberIdMap.set(rawMemberId, memberIds[index]!);
    });
    const activity = mapRoomActivity(room, memberIdMap);
    const conversation = mapRoomConversation(room, memberIdMap);
    const roomTimestamp = timestamp(room.updatedAt);
    const topic = text(room.topic);

    result.rooms.push({
      id: roomKey,
      providerId: "agent-room",
      name: roomName,
      ...(topic === "" ? {} : { topic }),
      status: text(room.status) === "closed" ? "closed" : "open",
      leaderSessionId: text(room.leaderSessionId),
      memberIds,
      activityCount: activity?.length ?? 0,
      ...(activity === undefined ? {} : { activity }),
      ...(conversation === undefined ? {} : { conversation }),
    });
    result.groups.push({
      id: roomKey,
      providerId: "agent-room",
      name: roomName,
      memberBotIds: memberIds,
      unreadCount: activity?.length ?? 0,
    });

    members.forEach((member, index) => {
      const memberId = memberIds[index]!;
      const connection = record(member.connection);
      const connectionSessionId = text(connection.sessionId);
      result.sessions.push({
        id: connectionSessionId === "" ? memberId : connectionSessionId,
        providerId: "agent-room",
        title: text(member.name, memberId),
        status: roomSessionStatus(member.status),
        updatedAt: timestamp(member.updatedAt, roomTimestamp),
      });
    });
  }

  return result;
}

export type BridgeLoaderInput = JsonFetcher | ({
  fetchJson: JsonFetcher;
} & BridgeLoadOptions);

interface ResolvedLoader {
  fetchJson: JsonFetcher;
  headers?: ForwardHeaders;
  timeoutMs?: number;
}

function resolveLoader(input: BridgeLoaderInput, options: BridgeLoadOptions): ResolvedLoader {
  if (typeof input === "function") {
    return {
      fetchJson: input,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    };
  }
  return {
    fetchJson: input.fetchJson,
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };
}

export type BridgeSnapshotDecode =
  | { kind: "recognized"; value: unknown }
  | { kind: "schema-mismatch"; source: string; detail: string };

export class BridgeSchemaMismatchError extends Error {
  readonly source: string;
  readonly detail: string;

  constructor(source: string, detail: string) {
    super(`BRIDGE_SCHEMA_MISMATCH:${source}:${detail}`);
    this.name = "BridgeSchemaMismatchError";
    this.source = source;
    this.detail = detail;
  }
}

function isSnapshotRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const AGENT_BUS_COLLECTIONS = ["tasks", "sessions", "flows"] as const;

// Snapshot decoders sit between transport and the (deliberately
// fail-soft) mappers. They separate a legitimately empty payload from
// structural drift: without them a drifted envelope maps to an empty
// result, and the runtime marks the source "connected, zero tasks",
// hiding the incompatibility. A mismatch is an incompatibility signal,
// not a transport failure, so loaders surface it regardless of
// failFast; only fetch failures keep the fail-soft contract.
export function decodeAgentBusSnapshot(value: unknown): BridgeSnapshotDecode {
  if (!isSnapshotRecord(value)) {
    return { kind: "schema-mismatch", source: "agent-bus", detail: "root" };
  }
  for (const field of AGENT_BUS_COLLECTIONS) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && !Array.isArray(fieldValue)) {
      return { kind: "schema-mismatch", source: "agent-bus", detail: field };
    }
  }
  // Partial snapshots are legitimate (the mapper defaults missing
  // collections to empty), but a record carrying none of the known
  // collections extracts nothing at all: recognizing it would
  // disguise a drifted payload (e.g. a renamed envelope) as a
  // legitimately empty result.
  if (!AGENT_BUS_COLLECTIONS.some((field) => value[field] !== undefined)) {
    return { kind: "schema-mismatch", source: "agent-bus", detail: "shape" };
  }
  return { kind: "recognized", value };
}

// Room session payloads are heterogeneous by contract (see roomItems):
// an array of rooms, a { rooms } envelope, a { room } envelope whose
// room carries a usable id, or a single room object with a usable id.
// The decoder mirrors the mapper's own extraction conditions exactly:
// a plain object with no rooms, no room, and no usable id extracts
// nothing, so recognizing it would disguise a drifted payload (e.g. a
// renamed envelope) as a legitimately empty result.
export function decodeRoomSnapshot(value: unknown): BridgeSnapshotDecode {
  if (Array.isArray(value)) return { kind: "recognized", value };
  if (!isSnapshotRecord(value)) {
    return { kind: "schema-mismatch", source: "room", detail: "root" };
  }
  if (value.rooms !== undefined) {
    return Array.isArray(value.rooms)
      ? { kind: "recognized", value }
      : { kind: "schema-mismatch", source: "room", detail: "rooms" };
  }
  if (value.room !== undefined) {
    return isSnapshotRecord(value.room) && text(value.room.id) !== ""
      ? { kind: "recognized", value }
      : { kind: "schema-mismatch", source: "room", detail: "room" };
  }
  if (text(value.id) !== "") return { kind: "recognized", value };
  return { kind: "schema-mismatch", source: "room", detail: "shape" };
}

export function decodeAgentTeamsSnapshot(value: unknown): BridgeSnapshotDecode {
  if (Array.isArray(value)) return { kind: "recognized", value };
  if (!isSnapshotRecord(value)) {
    return { kind: "schema-mismatch", source: "agent-teams", detail: "root" };
  }
  if (!Array.isArray(value.teams)) {
    return { kind: "schema-mismatch", source: "agent-teams", detail: "teams" };
  }
  return { kind: "recognized", value };
}

function assertSnapshotRecognized(decode: BridgeSnapshotDecode): void {
  if (decode.kind === "schema-mismatch") {
    throw new BridgeSchemaMismatchError(decode.source, decode.detail);
  }
}

async function loadSnapshot<T>(
  input: BridgeLoaderInput,
  options: BridgeLoadOptions,
  path: string,
  map: (value: unknown) => T,
  empty: () => T,
  decode?: (value: unknown) => BridgeSnapshotDecode,
): Promise<T> {
  const loader = resolveLoader(input, options);
  let raw: unknown;
  try {
    raw = await loader.fetchJson(path, requestInitFrom(loader));
  } catch (error) {
    if (options.failFast === true) throw error;
    return empty();
  }
  if (decode !== undefined) assertSnapshotRecognized(decode(raw));
  return map(raw);
}

export async function loadAgentTeamsSnapshot(
  input: BridgeLoaderInput,
  options: BridgeLoadOptions = {},
): Promise<AgentTeamsBridgeResult> {
  const loader = resolveLoader(input, options);
  let liveRaw: unknown;
  let archivedRaw: unknown;
  try {
    liveRaw = await loader.fetchJson(
      DEFAULT_AGENT_TEAMS_STATE_PATH,
      requestInitFrom(loader),
    );
    archivedRaw = await loader.fetchJson(
      `${DEFAULT_AGENT_TEAMS_STATE_PATH}?archived=1`,
      requestInitFrom(loader),
    );
  } catch (error) {
    if (options.failFast === true) throw error;
    return emptyAgentTeamsBridgeResult();
  }
  assertSnapshotRecognized(decodeAgentTeamsSnapshot(liveRaw));
  assertSnapshotRecognized(decodeAgentTeamsSnapshot(archivedRaw));
  return mergeAgentTeamsResults(
    mapAgentTeamsSnapshot(liveRaw),
    mapAgentTeamsSnapshot(archivedRaw, true),
  );
}

export function loadAgentBusSnapshot(
  input: BridgeLoaderInput,
  options: BridgeLoadOptions = {},
): Promise<AgentBusBridgeResult> {
  return loadSnapshot(
    input,
    options,
    DEFAULT_AGENT_BUS_STATE_PATH,
    mapAgentBusSnapshot,
    emptyAgentBusBridgeResult,
    decodeAgentBusSnapshot,
  );
}

export type RoomSessionEndpoint = string | ((sessionId: string) => string);

export interface RoomSessionLoadOptions extends BridgeLoadOptions {
  sessionId: string;
  endpoint?: RoomSessionEndpoint;
  sessionEndpoint?: RoomSessionEndpoint;
}

export type RoomSessionLoaderInput = RoomSessionLoadOptions & {
  fetchJson: JsonFetcher;
};

export function buildRoomSessionPath(
  sessionId: string,
  endpoint: RoomSessionEndpoint = DEFAULT_ROOM_SESSION_ENDPOINT,
): string {
  const normalizedSessionId = sessionId.trim();
  const encodedSessionId = encodeURIComponent(normalizedSessionId);
  if (typeof endpoint === "function") return endpoint(normalizedSessionId);
  const template = endpoint.trim() === "" ? DEFAULT_ROOM_SESSION_ENDPOINT : endpoint;
  if (/\{sessionId\}|<sessionId>|:sessionId/u.test(template)) {
    return template.replace(/\{sessionId\}|<sessionId>|:sessionId/gu, encodedSessionId);
  }
  return `${template.replace(/\/+$/u, "")}/${encodedSessionId}`;
}

export function loadRoomSessionSnapshot(input: RoomSessionLoaderInput): Promise<RoomBridgeResult>;
export function loadRoomSessionSnapshot(
  fetchJson: JsonFetcher,
  sessionId: string,
  options?: Omit<RoomSessionLoadOptions, "sessionId">,
): Promise<RoomBridgeResult>;
export function loadRoomSessionSnapshot(
  fetchJson: JsonFetcher,
  options: RoomSessionLoadOptions,
): Promise<RoomBridgeResult>;
export async function loadRoomSessionSnapshot(
  input: JsonFetcher | RoomSessionLoaderInput,
  sessionIdOrOptions?: string | RoomSessionLoadOptions,
  options: Omit<RoomSessionLoadOptions, "sessionId"> = {},
): Promise<RoomBridgeResult> {
  let loader: ResolvedLoader;
  let config: RoomSessionLoadOptions;
  if (typeof input === "function") {
    if (typeof sessionIdOrOptions === "string") {
      config = {
        sessionId: sessionIdOrOptions,
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.failFast === undefined ? {} : { failFast: options.failFast }),
        ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        ...(options.sessionEndpoint === undefined ? {} : { sessionEndpoint: options.sessionEndpoint }),
      };
      loader = {
        fetchJson: input,
        ...(config.headers === undefined ? {} : { headers: config.headers }),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      };
    } else if (sessionIdOrOptions !== undefined) {
      config = sessionIdOrOptions;
      loader = resolveLoader(input, config);
    } else {
      return emptyRoomBridgeResult();
    }
  } else {
    config = input;
    loader = resolveLoader(input, input);
  }

  const sessionId = config.sessionId.trim();
  if (sessionId === "") return emptyRoomBridgeResult();
  let raw: unknown;
  try {
    const path = buildRoomSessionPath(
      sessionId,
      config.endpoint ?? config.sessionEndpoint ?? DEFAULT_ROOM_SESSION_ENDPOINT,
    );
    const headers = mergeForwardHeaders(loader.headers, {
      "x-agent-team-room-client": "1",
    });
    const requestInit = {
      headers,
      ...(loader.timeoutMs === undefined ? {} : { timeoutMs: loader.timeoutMs }),
    };
    raw = await loader.fetchJson(path, requestInit);
  } catch (error) {
    if (config.failFast === true) throw error;
    return emptyRoomBridgeResult();
  }
  assertSnapshotRecognized(decodeRoomSnapshot(raw));
  return mapRoomSnapshot(raw);
}

export const loadAgentTeamsState = loadAgentTeamsSnapshot;
export const loadAgentTeams = loadAgentTeamsSnapshot;
export const loadAgentBusState = loadAgentBusSnapshot;
export const loadAgentBus = loadAgentBusSnapshot;
export const loadRoomSessionState = loadRoomSessionSnapshot;
export const loadRoomSession = loadRoomSessionSnapshot;
export const loadRoomSnapshot = loadRoomSessionSnapshot;

export function mergeBridgedData(
  base: BridgedSnapshot,
  teams: AgentTeamsBridgeResult,
  bus: AgentBusBridgeResult,
  rooms: RoomBridgeResult,
  nodes: NodeRecord[] = [],
): BridgedSnapshot & { nodes: NodeRecord[] } {
  return {
    ...emptyBridged(),
    nodes,
    bots: [...teams.bots, ...base.bots],
    groups: [...teams.groups, ...rooms.groups, ...base.groups],
    sessions: [...teams.sessions, ...bus.sessions, ...rooms.sessions, ...base.sessions],
    tasks: [...teams.tasks, ...bus.tasks, ...base.tasks],
    agentTeams: [...teams.agentTeams, ...base.agentTeams],
    agentFlows: [...bus.agentFlows, ...base.agentFlows],
    rooms: [...rooms.rooms, ...base.rooms],
  };
}
