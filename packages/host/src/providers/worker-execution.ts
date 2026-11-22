import { createHash } from "node:crypto";
import type { ExecutionMaterialManifest, WorkerExecutionObservation } from "@dsh-fusion/core";

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function unsignedInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function timestamp(value: string | undefined): value is string {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false;
  const epoch = Date.parse(value);
  const canonical = value.length === 20 ? `${value.slice(0, -1)}.000Z` : value;
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === canonical;
}

function digestStream(
  encoded: string | undefined,
  total: string | undefined,
  limit: number,
): WorkerExecutionObservation["stdout"] | undefined {
  const bytes = unsignedInteger(total);
  if (encoded === undefined || bytes === undefined || bytes > limit || encoded.length !== 4 * Math.ceil(bytes / 3)) {
    return undefined;
  }
  const raw = Buffer.from(encoded, "base64");
  if (raw.length !== bytes || raw.toString("base64") !== encoded) return undefined;
  return { sha256: createHash("sha256").update(raw).digest("hex"), bytes };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function materialPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !value.startsWith("/") && !value.includes("\\")
    && !value.split("/").some(part => part === "." || part === ".." || part === "")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function workspacePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 1024
    && !value.includes("\\") && !value.split("/").some(part => part === "." || part === "..")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validMaterialFile(value: unknown, runtime = false): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = runtime ? ["path", "digest", "evidence"] : ["path", "digest"];
  return exactKeys(item, keys) && materialPath(item.path) && typeof item.digest === "string" && HASH.test(item.digest)
    && (!runtime || item.evidence === "declared" || item.evidence === "measured");
}

function parseMaterials(encoded: string | undefined): ExecutionMaterialManifest | undefined {
  if (encoded === undefined || encoded.length === 0 || encoded.length > 64 * 1024
    || Buffer.from(encoded, "base64").toString("base64") !== encoded) return undefined;
  let value: unknown;
  let text: string;
  try {
    text = Buffer.from(encoded, "base64").toString("utf8");
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const object = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
  if (!exactKeys(record, ["version", "workspace", "source", "code", "input", "runtime", "config", "artifacts"])
    || record.version !== 1 || !object(record.workspace) || !exactKeys(record.workspace, ["id", "path"])
    || !object(record.source) || !exactKeys(record.source, ["revision", "digest"])
    || typeof record.workspace.id !== "string" || !ID.test(record.workspace.id)
    || !workspacePath(record.workspace.path)
    || typeof record.source.revision !== "string" || record.source.revision.length === 0 || record.source.revision.length > 256
    || typeof record.source.digest !== "string" || !HASH.test(record.source.digest)
    || !validMaterialFile(record.code) || !validMaterialFile(record.input)
    || !validMaterialFile(record.runtime, true) || !validMaterialFile(record.config)
    || !Array.isArray(record.artifacts) || record.artifacts.length > 64) return undefined;
  const artifacts = record.artifacts.map((artifact): ExecutionMaterialManifest["artifacts"][number] | undefined => {
    if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) return undefined;
    const item = artifact as Record<string, unknown>;
    if (!exactKeys(item, ["path", "digest", "bytes"])
      || !materialPath(item.path)
      || typeof item.digest !== "string" || !HASH.test(item.digest)
      || typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 0) return undefined;
    return { path: item.path, digest: item.digest, bytes: item.bytes };
  });
  if (artifacts.some((artifact) => artifact === undefined)) return undefined;
  const normalized = artifacts as ExecutionMaterialManifest["artifacts"];
  const paths = new Set(normalized.map((artifact) => artifact.path));
  if (paths.size !== normalized.length) return undefined;
  const normalizedManifest: ExecutionMaterialManifest = {
    version: 1,
    workspace: { id: record.workspace.id, path: record.workspace.path },
    source: { revision: record.source.revision, digest: record.source.digest as string },
    code: { path: (record.code as Record<string, unknown>).path as string, digest: (record.code as Record<string, unknown>).digest as string },
    input: { path: (record.input as Record<string, unknown>).path as string, digest: (record.input as Record<string, unknown>).digest as string },
    runtime: { path: (record.runtime as Record<string, unknown>).path as string, digest: (record.runtime as Record<string, unknown>).digest as string, evidence: (record.runtime as Record<string, unknown>).evidence as "declared" | "measured" },
    config: { path: (record.config as Record<string, unknown>).path as string, digest: (record.config as Record<string, unknown>).digest as string },
    artifacts: normalized,
  };
  return JSON.stringify(normalizedManifest) === text ? normalizedManifest : undefined;
}

/** Parse the worker protocol independently of the legacy text evidence. */
export function readWorkerExecutionObservation(
  metadata: string,
  taskId: string,
  nodeId: string,
  limit: number,
): WorkerExecutionObservation | undefined {
  const values = new Map<string, string>();
  for (const line of metadata.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (values.has(key)) return undefined;
    values.set(key, line.slice(separator + 1));
  }

  const status = values.get("STATUS");
  const exitCode = unsignedInteger(values.get("EXIT"));
  if (
    values.get("WORKER_TASK_ID") !== taskId
    || values.get("LOST_REASON") !== ""
    || (status !== "COMPLETED" && status !== "FAILED")
    || exitCode === undefined || exitCode > 255
    || (status === "COMPLETED") !== (exitCode === 0)
  ) return undefined;

  const commandSha256 = values.get("CAPTURE_COMMAND_SHA256");
  const startedAt = values.get("STARTED_AT");
  const finishedAt = values.get("FINISHED_AT");
  if (
    commandSha256 === undefined || !/^[a-f0-9]{64}$/u.test(commandSha256)
    || commandSha256 !== values.get("COMMAND_SHA256")
    || !timestamp(startedAt) || !timestamp(finishedAt)
    || Date.parse(finishedAt) < Date.parse(startedAt)
  ) return undefined;

  const stdout = digestStream(values.get("STDOUT"), values.get("STDOUT_TOTAL"), limit);
  const stderr = digestStream(values.get("STDERR"), values.get("STDERR_TOTAL"), limit);
  if (stdout === undefined || stderr === undefined) return undefined;
  const reportedMaterials = parseMaterials(values.get("EXECUTION_MANIFEST_B64"));
  if (values.has("EXECUTION_MANIFEST_B64") && reportedMaterials === undefined) return undefined;
  return { taskId, nodeId, commandSha256, startedAt, finishedAt, exitCode, stdout, stderr,
    ...(reportedMaterials === undefined ? {} : { reportedMaterials }) };
}
