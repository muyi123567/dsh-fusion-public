import type { TaskRecord, TaskStatus } from "@dsh-fusion/core";
import {
  BridgeSchemaMismatchError,
  emptyAgentTeamsBridgeResult,
  type AgentTeamsBridgeResult,
  type NativeSessionSummary,
  type SessionControllerLike,
} from "@dsh-fusion/host";

type ReadController = Pick<SessionControllerLike, "list" | "projections">;
type JsonRecord = Record<string, unknown>;

// Read-only structural contract from dsh-v0.2.2-rc.3, commit
// 38a6a5c965aa99ab525161efb7cc5cf1fe62fced,
// packages/team/agent-team/src/types.ts (TeamTaskView / TeamProjection).
interface NativeTeamTask {
  id: string;
  revision: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  ownerId?: string;
  ownerName?: string;
  blockedBy: string[];
  writeScopes: string[];
  ready: boolean;
  writeScopeWarnings: string[];
}

const PROVIDER_ID = "dsh-native-teams";
const UNKNOWN_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const STATUS: Record<NativeTeamTask["status"], TaskStatus> = {
  pending: "queued",
  in_progress: "running",
  completed: "completed",
  deleted: "cancelled",
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireShape(condition: boolean, detail: string): asserts condition {
  if (!condition) throw new BridgeSchemaMismatchError(PROVIDER_ID, detail);
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && Array.from(value).every((entry) => typeof entry === "string");
}

function isIdentity(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  // encodeURIComponent rejects lone surrogates; classify them at the schema boundary.
  try { encodeURIComponent(value); return true; } catch { return false; }
}

function decodeTask(value: unknown, detail: string): NativeTeamTask {
  requireShape(isRecord(value), detail);
  requireShape(isIdentity(value.id), detail + ".id");
  requireShape(
    typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 1,
    detail + ".revision",
  );
  requireShape(typeof value.subject === "string", detail + ".subject");
  requireShape(typeof value.description === "string", detail + ".description");
  requireShape(
    value.status === "pending" || value.status === "in_progress"
      || value.status === "completed" || value.status === "deleted",
    detail + ".status",
  );
  for (const field of ["ownerId", "ownerName"] as const) {
    requireShape(value[field] === undefined || typeof value[field] === "string", detail + "." + field);
  }
  for (const field of ["blockedBy", "writeScopes", "writeScopeWarnings"] as const) {
    requireShape(isStrings(value[field]), detail + "." + field);
  }
  requireShape(isStrings(value.blockedBy) && value.blockedBy.every(isIdentity), detail + ".blockedBy");
  requireShape(typeof value.ready === "boolean", detail + ".ready");
  return value as unknown as NativeTeamTask;
}

function teamKey(sessionId: string): string {
  return "dsh-native-team:" + encodeURIComponent(sessionId);
}

function observedTimestamp(value: number): string {
  return Number.isFinite(value) && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toISOString()
    : UNKNOWN_TIMESTAMP;
}

function mapTask(task: NativeTeamTask, root: NativeSessionSummary): TaskRecord {
  const key = teamKey(root.sessionId);
  return {
    id: key + ":" + encodeURIComponent(task.id),
    goal: task.subject,
    targetNodeIds: [],
    dependsOnTaskIds: task.blockedBy.map((id) => key + ":" + encodeURIComponent(id)),
    agentTeamTask: {
      teamId: root.sessionId,
      taskId: task.id,
      revision: task.revision,
      ...(task.ownerId === undefined ? {} : { ownerId: task.ownerId }),
      ...(task.ownerName === undefined ? {} : { ownerName: task.ownerName }),
      blockedBy: [...task.blockedBy],
      writeScopes: [...task.writeScopes],
      ready: task.ready,
      writeScopeWarnings: [...task.writeScopeWarnings],
    },
    transport: "dsh-fleet",
    status: STATUS[task.status],
    sessionId: root.sessionId,
    evidence: [],
    // rc.3 task views contain no creation time; never fabricate one.
    createdAt: UNKNOWN_TIMESTAMP,
    updatedAt: observedTimestamp(root.updatedAt),
  };
}

async function readRoot(
  controller: ReadController,
  root: NativeSessionSummary,
  signal: AbortSignal,
): Promise<AgentTeamsBridgeResult | undefined> {
  const baseline = await controller.projections({ sessionId: root.sessionId }, signal);
  // A Session can disappear between listing and projection reads.
  if (baseline === null) return undefined;
  requireShape(isRecord(baseline) && isRecord(baseline.values), root.sessionId + ".values");
  if (!Object.prototype.hasOwnProperty.call(baseline.values, "agentTeam")) return undefined;
  // Migration/cache-only values are not a verified current task board.
  const kind = (baseline as { kind?: unknown }).kind;
  requireShape(kind === "sequenced", root.sessionId + ".projection.kind");
  requireShape(
    Number.isSafeInteger(baseline.asOfSeq) && baseline.asOfSeq >= -1,
    root.sessionId + ".projection.asOfSeq",
  );
  const projection = baseline.values.agentTeam;
  const detail = root.sessionId + ".agentTeam";
  requireShape(isRecord(projection), detail);
  requireShape(typeof projection.enabled === "boolean", detail + ".enabled");
  requireShape(Array.isArray(projection.tasks), detail + ".tasks");
  requireShape(projection.failure === undefined || typeof projection.failure === "string", detail + ".failure");
  if (projection.failure !== undefined) {
    // A journal failure leaves the last valid tasks visible upstream, not healthy.
    throw new Error("NATIVE_AGENT_TEAM_PROJECTION_FAILURE:" + root.sessionId + ":" + projection.failure);
  }
  const result = emptyAgentTeamsBridgeResult();

  const seen = new Set<string>();
  const tasks = Array.from(projection.tasks, (value, index) => {
    const task = decodeTask(value, detail + ".tasks[" + index + "]");
    requireShape(!seen.has(task.id), detail + ".duplicate-task-id");
    seen.add(task.id);
    return task;
  });
  if (!projection.enabled) return result;
  result.tasks = tasks.map((task) => mapTask(task, root));
  result.agentTeams.push({
    id: teamKey(root.sessionId),
    providerId: PROVIDER_ID,
    name: "Native Team (" + root.sessionId + ")",
    workspace: root.cwd ?? "",
    phase: root.running || tasks.some((task) => task.status === "in_progress") ? "running" : "staged",
    captainSessionId: root.sessionId,
    // The projection has no roster. Do not synthesize bots or Sessions.
    memberIds: [],
    taskIds: result.tasks.map((task) => task.id),
  });
  return result;
}

async function readBoards(
  controller: ReadController,
  signal: AbortSignal,
): Promise<AgentTeamsBridgeResult | undefined> {
  const listing = await controller.list({}, signal);
  requireShape(isRecord(listing) && Array.isArray(listing.items), "list.items");
  const rootById = new Map<string, NativeSessionSummary>();
  for (const summary of listing.items) {
    requireShape(isRecord(summary), "list.item");
    if (summary.parentSessionId !== undefined || summary.origin === "subagent") continue;
    requireShape(isIdentity(summary.sessionId), "list.sessionId");
    requireShape(typeof summary.updatedAt === "number", "list.updatedAt");
    // The session list carries a projection baseline on current rc.3.
    // Do not issue a second read for old/legacy roots that explicitly
    // have no native AgentTeam projection.
    if (summary.projections !== undefined) {
      requireShape(isRecord(summary.projections) && isRecord(summary.projections.values), "list.projections");
      if (!Object.prototype.hasOwnProperty.call(summary.projections.values, "agentTeam")) continue;
    }
    requireShape(typeof summary.running === "boolean", "list.running");
    requireShape(summary.cwd === undefined || typeof summary.cwd === "string", "list.cwd");
    rootById.set(summary.sessionId, summary as unknown as NativeSessionSummary);
  }
  const roots = [...rootById.values()];
  const snapshots: Array<AgentTeamsBridgeResult | undefined> = new Array(roots.length);
  let next = 0;
  let failed = false;
  const readNext = async (): Promise<void> => {
    while (!failed && next < roots.length) {
      signal.throwIfAborted();
      const index = next++;
      try {
        snapshots[index] = await readRoot(controller, roots[index]!, signal);
      } catch (error) {
        // Stop siblings before the aggregate rejection reaches the outer abort.
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, roots.length) }, readNext));
  const result = emptyAgentTeamsBridgeResult();
  let supported = false;
  for (const snapshot of snapshots) {
    if (snapshot === undefined) continue;
    supported = true;
    result.tasks.push(...snapshot.tasks);
    result.agentTeams.push(...snapshot.agentTeams);
  }
  return supported ? result : undefined;
}

/**
 * Observe native root Session boards without creating Agents or changing DSH state.
 * undefined means no native capability was observed; an empty result is supported.
 * The deadline covers the whole read round, even for controllers ignoring abort.
 */
export async function loadNativeAgentTeams(
  controller: Pick<SessionControllerLike, "list" | "projections"> | undefined,
  timeoutMs = 5_000,
): Promise<AgentTeamsBridgeResult | undefined> {
  if (controller == null || typeof controller.list !== "function" || typeof controller.projections !== "function") {
    return undefined;
  }
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(2_147_483_647, Math.max(1, Math.trunc(timeoutMs)))
    : 5_000;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("NATIVE_AGENT_TEAMS_TIMEOUT:" + duration + "ms");
      error.name = "TimeoutError";
      reject(error);
      abort.abort(error);
    }, duration);
  });
  try {
    return await Promise.race([readBoards(controller, abort.signal), timeout]);
  } catch (error) {
    abort.abort(error);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
