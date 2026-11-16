import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeTaskRecord } from "./plugin-runtime.js";

const TASK_LEDGER_LIMIT = 200;

const TASK_STATUSES = new Set<RuntimeTaskRecord["status"]>([
  "queued",
  "claimed",
  "running",
  "verifying",
  "completed",
  "failed",
  "cancelled",
]);

type RuntimeEvidenceKind = NonNullable<RuntimeTaskRecord["expectedEvidence"]>[number];

const TASK_EVIDENCE_KINDS = new Set<RuntimeEvidenceKind>([
  "command",
  "log",
  "artifact",
  "git",
  "summary",
]);

/**
 * Serialize writes per ledger path. Every write for one path runs in order so
 * two task updates can never interleave and corrupt the file.
 */
const writeQueues = new Map<string, Promise<void>>();

function ledgerTask(task: RuntimeTaskRecord): RuntimeTaskRecord {
  return {
    id: task.id,
    goal: task.goal,
    targetNodeIds: [...task.targetNodeIds],
    transport: task.transport,
    status: task.status,
    ...(task.idempotencyKey === undefined ? {} : { idempotencyKey: task.idempotencyKey }),
    ...(task.dispatchFingerprint === undefined ? {} : { dispatchFingerprint: task.dispatchFingerprint }),
    ...(task.progress === undefined ? {} : { progress: task.progress }),
    evidence: [],
    ...(task.expectedEvidence === undefined ? {} : { expectedEvidence: [...task.expectedEvidence] }),
    ...(task.childTaskRefs === undefined ? {} : {
      childTaskRefs: task.childTaskRefs.map((child) => ({
        id: child.id,
        targetNodeIds: [...child.targetNodeIds],
        ...(child.status === undefined ? {} : { status: child.status }),
        ...(child.progress === undefined ? {} : { progress: child.progress }),
      })),
    }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export async function loadTaskLedger(path: string): Promise<RuntimeTaskRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
      return [];
    }
    return (parsed as { tasks: unknown[] }).tasks.flatMap((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
      const task = value as Record<string, unknown>;
      if (
        typeof task.id !== "string"
        || typeof task.goal !== "string"
        || !Array.isArray(task.targetNodeIds)
        || typeof task.transport !== "string"
        || typeof task.status !== "string"
        || !TASK_STATUSES.has(task.status as RuntimeTaskRecord["status"])
        || typeof task.createdAt !== "string"
        || typeof task.updatedAt !== "string"
      ) {
        return [];
      }
      const expectedEvidence = Array.isArray(task.expectedEvidence)
        ? task.expectedEvidence.filter((value): value is RuntimeEvidenceKind =>
            typeof value === "string" && TASK_EVIDENCE_KINDS.has(value as RuntimeEvidenceKind)
          )
        : [];
      return [{
        id: task.id,
        goal: task.goal,
        targetNodeIds: task.targetNodeIds.map(String),
        transport: task.transport as RuntimeTaskRecord["transport"],
        status: task.status as RuntimeTaskRecord["status"],
        ...(typeof task.idempotencyKey === "string" && task.idempotencyKey !== ""
          ? { idempotencyKey: task.idempotencyKey }
          : {}),
        ...(typeof task.dispatchFingerprint === "string" && task.dispatchFingerprint !== ""
          ? { dispatchFingerprint: task.dispatchFingerprint }
          : {}),
        ...(typeof task.progress === "number" ? { progress: task.progress } : {}),
        evidence: [],
        ...(expectedEvidence.length === 0 ? {} : { expectedEvidence }),
        ...(Array.isArray(task.childTaskRefs)
          ? {
              childTaskRefs: task.childTaskRefs.flatMap((child) => {
                if (child === null || typeof child !== "object" || Array.isArray(child)) return [];
                const reference = child as Record<string, unknown>;
                if (typeof reference.id !== "string" || !Array.isArray(reference.targetNodeIds)) return [];
                return [{
                  id: reference.id,
                  targetNodeIds: reference.targetNodeIds.map(String),
                  ...(typeof reference.status === "string"
                    && TASK_STATUSES.has(reference.status as RuntimeTaskRecord["status"])
                    ? { status: reference.status as RuntimeTaskRecord["status"] }
                    : {}),
                  ...(typeof reference.progress === "number" ? { progress: reference.progress } : {}),
                }];
              }),
            }
          : {}),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      }];
    });
  } catch {
    return [];
  }
}

export async function inspectTaskLedger(path: string | undefined): Promise<{
  readable: boolean;
  taskCount: number;
  error?: string;
}> {
  if (path === undefined) return { readable: true, taskCount: 0 };
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { tasks?: unknown };
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    return { readable: true, taskCount: tasks.length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { readable: true, taskCount: 0 };
    }
    return {
      readable: false,
      taskCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Windows refuses to replace a file that another handle still has open, and
 * `rename` then fails with EPERM. Readers of the ledger (the state route, the
 * doctor route) hold the file open for the length of a read, so a write that
 * lands in that window loses the race. Retry the rename briefly instead of
 * failing the write outright.
 */
async function renameWithRetry(source: string, target: string): Promise<void> {
  const delays = [0, 10, 25, 50, 100, 200];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw error;
    }
  }
  throw lastError;
}

export async function writeTaskLedger(path: string, tasks: RuntimeTaskRecord[]): Promise<void> {
  const directory = dirname(path);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const records = tasks
    .map(ledgerTask)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, TASK_LEDGER_LIMIT);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(tempPath, `${JSON.stringify({ version: 1, tasks: records }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await renameWithRetry(tempPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function saveTaskLedger(path: string, tasks: RuntimeTaskRecord[]): Promise<void> {
  const snapshot = tasks.map((task) => ({
    ...task,
    targetNodeIds: [...task.targetNodeIds],
    evidence: [...task.evidence],
    ...(task.expectedEvidence === undefined
      ? {}
      : { expectedEvidence: [...task.expectedEvidence] }),
    ...(task.childTaskRefs === undefined
      ? {}
      : {
          childTaskRefs: task.childTaskRefs.map((child) => ({
            id: child.id,
            targetNodeIds: [...child.targetNodeIds],
            ...(child.status === undefined ? {} : { status: child.status }),
            ...(child.progress === undefined ? {} : { progress: child.progress }),
          })),
        }),
  }));
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => writeTaskLedger(path, snapshot));
  // `tracked` is stored in the queue map but nothing ever awaits it. If it
  // carried the rejection, a failed ledger write would surface as an
  // unhandled rejection and take the whole DSH host process down. The queue
  // must keep running even when a write fails, so the tracked promise
  // resolves either way and the failure is reported to the caller.
  const tracked = next.catch(() => {}).finally(() => {
    if (writeQueues.get(path) === tracked) writeQueues.delete(path);
  });
  writeQueues.set(path, tracked);
  return next;
}
