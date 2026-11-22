import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import type { ExecutionMaterialManifest, ExecutionMaterialPins, ExpectedExecutionMaterials, TaskRecord, VerifiedExecutionMaterials } from "@dsh-fusion/core";
import { createDispatchFingerprint } from "./fleet-router.js";
import { createNativeExecutionStore } from "./native-task-execution-store.js";

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u;
const EMPTY_SHA256 = sha256("");
const ATTEMPT_LIMIT = 128;

export interface NativeExecutionJob {
  id: string;
  label: string;
  command: string;
  nodeIds: string[];
  /** Require profile-pinned material verification before issuing a receipt. */
  requireMaterials?: boolean;
  /** Expected code/input/runtime/config and artifact pins for material-aware jobs. */
  expectedMaterials?: ExecutionMaterialPins;
}


interface StreamDigest {
  sha256: string;
  bytes: number;
}


export interface NativeExecutionReceipt {
  sha256: string;
  taskId: string;
  sourceToken: string;
  attemptId: string;
  jobId: string;
  nodeId: string;
  workerTaskId: string;
  commandSha256: string;
  dispatchFingerprint: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  stdout: StreamDigest;
  stderr: StreamDigest;
  materials?: VerifiedExecutionMaterials;
}


export interface NativeExecutionReviewPayload {
  taskId: string;
  attemptId: string;
  receiptSha256: string;
  reviewerId: string;
  verdict: "passed" | "failed";
  summary: string;
}

export type NativeExecutionReviewInput = NativeExecutionReviewPayload & { signature: string; };
type SignedReview = NativeExecutionReviewInput;

interface StoredReview extends SignedReview {
  reviewedAt: string;
  keySha256: string;
}


export interface NativeExecutionAttemptView {
  id: string;
  taskId: string;
  sourceToken: string;
  jobId: string;
  nodeId: string;
  requestId: string;
  workerTaskId: string;
  createdAt: string;
  /** Missing or superseded sources are stale. A failed source read is unavailable. */
  sourceState: "current" | "stale" | "unavailable";
  /** Exited means the exact worker supplied a complete, consistent terminal receipt. */
  executionState: "pending" | "running" | "unconfirmed" | "exited";
  receipt?: NativeExecutionReceipt;
  review?: Omit<StoredReview, "taskId" | "attemptId" | "signature" | "keySha256"> & { state: "current" | "stale"; };
}


export interface NativeExecutionJobSummary {
  id: string;
  label: string;
  nodeIds: string[];
  requiresMaterialVerification: boolean;
  materialVerificationAvailable: boolean;
}


export interface NativeExecutionReadView {
  jobs: NativeExecutionJobSummary[];
  attempts: NativeExecutionAttemptView[];
  taskAvailable: boolean;
  sourceUnavailable?: true;
  sourceToken?: string;
  sourceRevision?: number;
  sourceGoal?: string;
  sourceDescription?: string;
}

export type NativeTaskExecutionErrorCode =
  | "invalid-input" | "task-missing" | "source-unavailable" | "source-stale"
  | "job-unavailable" | "attempt-conflict" | "attempt-missing" | "receipt-unavailable"
  | "review-untrusted" | "review-invalid" | "store-unavailable";
export class NativeTaskExecutionError extends Error {
  constructor(readonly code: NativeTaskExecutionErrorCode) {
    super(code);
    this.name = "NativeTaskExecutionError";
  }
}


export interface NativeExecutionStartInput {
  taskId: string;
  sourceToken: string;
  jobId: string;
  nodeId: string;
  requestId: string;
}

type StartInput = NativeExecutionStartInput;

interface StoredAttempt extends StartInput {
  id: string;
  workerTaskId: string;
  createdAt: string;
  commandSha256: string;
  dispatchFingerprint: string;
  /** `reserved` proves dispatch was not attempted; otherwise submission is ambiguous and must not be retried. */
  dispatchState?: "reserved" | "may-have-been-sent";
  materialsRequired?: true;
  expectedSourceRevision?: string;
  expectedMaterials?: ExecutionMaterialPins;
  receipt?: NativeExecutionReceipt;
  receiptConflict?: true;
  review?: StoredReview;
}


interface Source {
  token: string;
  revision: number;
  goal: string;
  description?: string;
  ownerId?: string;
  status: TaskRecord["status"];
  ready: boolean;
}

type SourceRead = { state: "found"; source: Source; } | { state: "missing" | "unavailable"; };
type WorkerRead = { state: "pending" | "running" | "unconfirmed"; } | { state: "exited"; receipt: NativeExecutionReceipt; };
type ReviewerKey = { key: KeyObject; sha256: string; };
const UNCONFIRMED: WorkerRead = { state: "unconfirmed" };

export interface NativeExecutionOptions {
  directory: string;
  jobs: readonly NativeExecutionJob[];
  reviewerKeys: Readonly<Record<string, string>>;
  readTask: (taskId: string) => Promise<TaskRecord | undefined>;
  taskIdFor: (nodeId: string, key: string) => string;
  dispatch: (input: {
    goal: string;
    nodeIds: string[];
    command: string;
    idempotencyKey: string;
    executionWorkspace?: { id: string; sourceRevision: string; sourceDigest: string; };
    executionMaterialsDigest?: string;
  }) => Promise<TaskRecord>;
  inspect: (nodeId: string, workerTaskId: string) => Promise<TaskRecord>;
  /** Must read bounded bytes from the exact worker and hash them independently of worker stdout. */
  verifyMaterials?: (input: {
    taskId: string;
    attemptId: string;
    jobId: string;
    nodeId: string;
    workerTaskId: string;
    expected: ExpectedExecutionMaterials;
    reported?: ExecutionMaterialManifest;
  }) => Promise<ExecutionMaterialManifest | undefined>;
  supportsMaterials?: (nodeId: string) => boolean;
  now?: () => Date;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(domain: string, ...fields: unknown[]): Buffer {
  return Buffer.from(JSON.stringify([domain, ...fields]), "utf8");
}
/** These are the exact bytes an independent Ed25519 key holder signs. */
export function nativeExecutionReviewBytes(payload: NativeExecutionReviewPayload): Buffer {
  return canonical("dsh-native-execution-review/v1", payload.taskId, payload.attemptId,
    payload.receiptSha256, payload.reviewerId, payload.verdict, payload.summary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every(key => fields.includes(key));
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= max && !value.includes("\0");
}

function taskIdentity(value: unknown): value is string {
  return isText(value, 2048) && value.length > 0 && !/[\u0000-\u0020\u007f]/u.test(value);
}

function nativeIdentity(value: unknown): value is string {
  return isText(value, 2048) && value.trim().length > 0;
}

function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === "string" && pattern.test(value);
}

function validTime(value: unknown): value is string {
  if (!matches(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u, value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString() === (value.length === 20 ? `${value.slice(0, -1)}.000Z` : value);
}

function validStream(value: unknown): value is StreamDigest {
  return isRecord(value) && matches(HASH, value.sha256) && typeof value.bytes === "number"
    && Number.isSafeInteger(value.bytes) && value.bytes >= 0
    && (value.bytes === 0) === (value.sha256 === EMPTY_SHA256);
}

function knownStream(value: unknown): value is StreamDigest {
  return isRecord(value) && hasOnlyFields(value, ["sha256", "bytes"]) && validStream(value);
}

function validExit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

function validReviewPayload(value: Record<string, unknown>): boolean {
  return taskIdentity(value.taskId) && matches(ID, value.attemptId) && matches(HASH, value.receiptSha256)
    && matches(ID, value.reviewerId) && (value.verdict === "passed" || value.verdict === "failed")
    && isText(value.summary, 2048) && value.summary.trim().length > 0 && matches(SIGNATURE, value.signature);
}

function workerKey(attemptId: string): string {
  return `native-execution:${attemptId}`;
}

function receiptDigest(value: Omit<NativeExecutionReceipt, "sha256">): string {
  const fields = [value.taskId, value.sourceToken, value.attemptId,
  value.jobId, value.nodeId, value.workerTaskId, workerKey(value.attemptId), value.commandSha256,
  value.dispatchFingerprint, value.startedAt, value.finishedAt, value.exitCode,
  value.stdout.sha256, value.stdout.bytes, value.stderr.sha256, value.stderr.bytes];
  return value.materials === undefined
    ? sha256(canonical("dsh-native-execution-receipt/v1", ...fields))
    : sha256(canonical("dsh-native-execution-receipt/v2", ...fields, value.materials));
}

function isManifest(value: unknown): value is ExecutionMaterialManifest {
  if (!isRecord(value) || !hasOnlyFields(value, ["version", "workspace", "source", "code", "input", "runtime", "config", "artifacts"])
    || value.version !== 1 || !isRecord(value.workspace) || !hasOnlyFields(value.workspace, ["id", "path"])
    || !matches(ID, value.workspace.id) || !isText(value.workspace.path, 1024) || !isSafeAbsolutePath(value.workspace.path)
    || /[\u0000-\u001f\u007f]/u.test(value.workspace.path)
    || !isRecord(value.source) || !hasOnlyFields(value.source, ["revision", "digest"])
    || !isText(value.source.revision, 256) || value.source.revision.length === 0 || !matches(HASH, value.source.digest)
    || !isRecord(value.code) || !hasOnlyFields(value.code, ["path", "digest"]) || !isSafeRelativePath(value.code.path) || !matches(HASH, value.code.digest)
    || !isRecord(value.input) || !hasOnlyFields(value.input, ["path", "digest"]) || !isSafeRelativePath(value.input.path) || !matches(HASH, value.input.digest)
    || !isRecord(value.runtime) || !hasOnlyFields(value.runtime, ["path", "digest", "evidence"])
    || !isSafeRelativePath(value.runtime.path) || !matches(HASH, value.runtime.digest)
    || (value.runtime.evidence !== "declared" && value.runtime.evidence !== "measured")
    || !isRecord(value.config) || !hasOnlyFields(value.config, ["path", "digest"]) || !isSafeRelativePath(value.config.path) || !matches(HASH, value.config.digest)
    || !Array.isArray(value.artifacts) || value.artifacts.length > 64) return false;
  const paths = new Set<string>();
  for (const artifact of value.artifacts) {
    if (!isRecord(artifact) || !hasOnlyFields(artifact, ["path", "digest", "bytes"])
      || !isSafeRelativePath(artifact.path) || !matches(HASH, artifact.digest)
      || typeof artifact.bytes !== "number" || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0
      || paths.has(artifact.path)) return false;
    paths.add(artifact.path);
  }
  return true;
}

function isSafeRelativePath(value: unknown): value is string {
  return isText(value, 512) && value.length > 0 && !value.startsWith("/") && !value.includes("\\")
    && !value.split("/").some(part => part === "." || part === ".." || part === "")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isSafeAbsolutePath(value: string): boolean {
  if (!value.startsWith("/") || value.length > 1024 || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const segments = value.slice(1).split("/");
  return segments.length > 0 && segments.every(segment => segment !== "" && segment !== "." && segment !== "..");
}

function isPins(value: unknown): value is ExecutionMaterialPins {
  if (!isRecord(value) || !hasOnlyFields(value, ["code", "input", "runtime", "config", "artifacts"])
    || !["code", "input", "config"].every(key => isRecord(value[key])
      && hasOnlyFields(value[key] as Record<string, unknown>, ["path", "digest"])
      && isSafeRelativePath((value[key] as Record<string, unknown>).path)
      && matches(HASH, (value[key] as Record<string, unknown>).digest))
    || !isRecord(value.runtime) || !hasOnlyFields(value.runtime, ["path", "digest", "evidence"])
    || !isSafeRelativePath(value.runtime.path) || !matches(HASH, value.runtime.digest)
    || (value.runtime.evidence !== "declared" && value.runtime.evidence !== "measured")
    || !Array.isArray(value.artifacts) || value.artifacts.length > 64
    || !value.artifacts.every(artifact => isRecord(artifact) && hasOnlyFields(artifact, ["path", "digest", "bytes"])
      && isSafeRelativePath(artifact.path) && matches(HASH, artifact.digest)
      && typeof artifact.bytes === "number" && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0)
    || new Set(value.artifacts.map(artifact => (artifact as { path: string; }).path)).size !== value.artifacts.length) return false;
  return true;
}

function expectedManifest(source: Source, pins: ExecutionMaterialPins): ExpectedExecutionMaterials {
  return {
    source: { revision: String(source.revision), digest: source.token },
    code: { ...pins.code }, input: { ...pins.input }, runtime: { ...pins.runtime }, config: { ...pins.config },
    artifacts: pins.artifacts.map(artifact => ({ ...artifact })),
  };
}

function materialPinsDigest(pins: ExecutionMaterialPins): string {
  return sha256(canonical("dsh-native-execution-material-pins/v1", pins));
}

function manifestsMatch(expected: ExpectedExecutionMaterials, actual: ExecutionMaterialManifest, attemptId: string): boolean {
  return actual.version === 1 && actual.workspace.id === attemptId
    && expected.source.revision === actual.source.revision && expected.source.digest === actual.source.digest
    && expected.code.path === actual.code.path && expected.code.digest === actual.code.digest
    && expected.input.path === actual.input.path && expected.input.digest === actual.input.digest
    && expected.runtime.path === actual.runtime.path && expected.runtime.digest === actual.runtime.digest
    && expected.runtime.evidence === "measured" && actual.runtime.evidence === "measured"
    && expected.config.path === actual.config.path && expected.config.digest === actual.config.digest
    && JSON.stringify(expected.artifacts) === JSON.stringify(actual.artifacts);
}

function sameManifest(left: ExecutionMaterialManifest, right: ExecutionMaterialManifest): boolean {
  return left.version === right.version
    && left.workspace.id === right.workspace.id && left.workspace.path === right.workspace.path
    && left.source.revision === right.source.revision && left.source.digest === right.source.digest
    && left.code.path === right.code.path && left.code.digest === right.code.digest
    && left.input.path === right.input.path && left.input.digest === right.input.digest
    && left.runtime.path === right.runtime.path && left.runtime.digest === right.runtime.digest
    && left.runtime.evidence === right.runtime.evidence
    && left.config.path === right.config.path && left.config.digest === right.config.digest
    && JSON.stringify(left.artifacts) === JSON.stringify(right.artifacts);
}

function isExpectedMaterials(value: unknown): value is ExpectedExecutionMaterials {
  if (!isRecord(value) || !hasOnlyFields(value, ["source", "code", "input", "runtime", "config", "artifacts"])
    || !isRecord(value.source) || !hasOnlyFields(value.source, ["revision", "digest"])
    || !isText(value.source.revision, 256) || value.source.revision.length === 0 || !matches(HASH, value.source.digest)) return false;
  return isPins({ code: value.code, input: value.input, runtime: value.runtime, config: value.config, artifacts: value.artifacts });
}

function validStoredMaterials(value: Record<string, unknown>, attempt: StoredAttempt): boolean {
  const materials = value.materials;
  if (attempt.materialsRequired !== true) return materials === undefined;
  if (attempt.expectedMaterials === undefined || attempt.expectedSourceRevision === undefined || materials === undefined
    || !isRecord(materials) || !hasOnlyFields(materials, ["expected", "observed"])
    || !isExpectedMaterials(materials.expected) || !isManifest(materials.observed)) return false;
  return materials.expected.source.digest === value.sourceToken
    && materials.expected.source.revision === attempt.expectedSourceRevision
    && JSON.stringify({
      code: materials.expected.code, input: materials.expected.input,
      runtime: materials.expected.runtime, config: materials.expected.config,
      artifacts: materials.expected.artifacts,
    }) === JSON.stringify({
      code: attempt.expectedMaterials.code, input: attempt.expectedMaterials.input,
      runtime: attempt.expectedMaterials.runtime, config: attempt.expectedMaterials.config,
      artifacts: attempt.expectedMaterials.artifacts,
    })
    && manifestsMatch(materials.expected, materials.observed, attempt.id);
}

function validStoredReceipt(value: unknown, attempt: StoredAttempt): value is NativeExecutionReceipt {
  return isRecord(value) && hasOnlyFields(value, ["sha256", "taskId", "sourceToken", "attemptId", "jobId", "nodeId",
    "workerTaskId", "commandSha256", "dispatchFingerprint", "startedAt", "finishedAt", "exitCode", "stdout", "stderr", "materials"])
    && matches(HASH, value.sha256)
    && value.taskId === attempt.taskId && value.sourceToken === attempt.sourceToken
    && value.attemptId === attempt.id && value.jobId === attempt.jobId && value.nodeId === attempt.nodeId
    && value.workerTaskId === attempt.workerTaskId && value.commandSha256 === attempt.commandSha256
    && value.dispatchFingerprint === attempt.dispatchFingerprint && validExit(value.exitCode)
    && validTime(value.startedAt) && validTime(value.finishedAt)
    && Date.parse(value.startedAt) <= Date.parse(value.finishedAt) && knownStream(value.stdout) && knownStream(value.stderr)
    && validStoredMaterials(value, attempt)
    && value.sha256 === receiptDigest(value as unknown as NativeExecutionReceipt);
}

function decodeAttempts(taskId: string, value: unknown): StoredAttempt[] {
  if (!Array.isArray(value) || value.length > ATTEMPT_LIMIT) throw new NativeTaskExecutionError("store-unavailable");
  const ids = new Set<string>();
  const workers = new Set<string>();
  const requests = new Set<string>();
  const intents = new Set<string>();
  return value.map((entry: unknown) => {
    if (!isRecord(entry) || !hasOnlyFields(entry, ["taskId", "sourceToken", "jobId", "nodeId", "requestId", "id",
      "workerTaskId", "createdAt", "commandSha256", "dispatchFingerprint", "dispatchState", "materialsRequired", "expectedSourceRevision", "expectedMaterials", "receipt", "receiptConflict", "review"])
      || entry.taskId !== taskId || !matches(ID, entry.id) || !matches(HASH, entry.sourceToken)
      || !matches(ID, entry.jobId) || !matches(ID, entry.nodeId) || !matches(ID, entry.requestId)
      || !matches(ID, entry.workerTaskId) || !validTime(entry.createdAt)
      || !matches(HASH, entry.commandSha256) || !matches(HASH, entry.dispatchFingerprint)
      || (entry.dispatchState !== undefined && entry.dispatchState !== "reserved" && entry.dispatchState !== "may-have-been-sent")
      || (entry.materialsRequired !== undefined && entry.materialsRequired !== true)
      || (entry.expectedSourceRevision !== undefined && (typeof entry.expectedSourceRevision !== "string" || !/^\d{1,16}$/u.test(entry.expectedSourceRevision)))
      || (entry.expectedMaterials !== undefined && !isPins(entry.expectedMaterials))
      || (entry.materialsRequired === true && (entry.expectedMaterials === undefined || entry.expectedSourceRevision === undefined))
      || (entry.expectedMaterials !== undefined && entry.materialsRequired !== true)
      || (entry.expectedSourceRevision !== undefined && entry.materialsRequired !== true)
      || (entry.receiptConflict !== undefined && (entry.receiptConflict !== true || entry.receipt === undefined))) {
      throw new NativeTaskExecutionError("store-unavailable");
    }
    const attempt = entry as unknown as StoredAttempt;
    const intent = JSON.stringify([attempt.sourceToken, attempt.jobId, attempt.nodeId]);
    if (ids.has(attempt.id) || workers.has(attempt.workerTaskId) || requests.has(attempt.requestId) || intents.has(intent)
      || (attempt.receipt !== undefined && !validStoredReceipt(attempt.receipt, attempt))) {
      throw new NativeTaskExecutionError("store-unavailable");
    }
    const review = entry.review;
    if (review !== undefined && (!isRecord(review) || !hasOnlyFields(review, ["taskId", "attemptId", "receiptSha256", "reviewerId",
      "verdict", "summary", "signature", "reviewedAt", "keySha256"])
      || !validReviewPayload(review) || !matches(HASH, review.keySha256)
      || !validTime(review.reviewedAt) || review.taskId !== taskId || review.attemptId !== attempt.id
      || attempt.receipt?.sha256 !== review.receiptSha256)) {
      throw new NativeTaskExecutionError("store-unavailable");
    }
    ids.add(attempt.id);
    workers.add(attempt.workerTaskId);
    requests.add(attempt.requestId);
    intents.add(intent);
    return attempt;
  });
}

function parseJob(job: NativeExecutionJob): NativeExecutionJob {
  if (!matches(ID, job.id) || !isText(job.label, 256) || job.label.trim() === ""
    || !isText(job.command, 32768) || job.command.trim() === "" || !Array.isArray(job.nodeIds)
    || job.nodeIds.length === 0 || job.nodeIds.length > 32 || !job.nodeIds.every(nodeId => matches(ID, nodeId))
    || new Set(job.nodeIds).size !== job.nodeIds.length) {
    throw new NativeTaskExecutionError("invalid-input");
  }
  if (job.expectedMaterials !== undefined && !isPins(job.expectedMaterials)) {
    throw new NativeTaskExecutionError("invalid-input");
  }
  if (job.requireMaterials !== undefined && typeof job.requireMaterials !== "boolean") {
    throw new NativeTaskExecutionError("invalid-input");
  }
  if (job.requireMaterials === true && job.expectedMaterials === undefined) {
    throw new NativeTaskExecutionError("invalid-input");
  }
  const expectedMaterials = job.expectedMaterials === undefined ? undefined : {
    code: { ...job.expectedMaterials.code }, input: { ...job.expectedMaterials.input },
    runtime: { ...job.expectedMaterials.runtime }, config: { ...job.expectedMaterials.config },
    artifacts: job.expectedMaterials.artifacts.map(artifact => ({ ...artifact })),
  };
  return {
    id: job.id, label: job.label, command: job.command.trim(), nodeIds: [...job.nodeIds],
    ...(job.requireMaterials === undefined ? {} : { requireMaterials: job.requireMaterials }),
    ...(expectedMaterials === undefined ? {} : { expectedMaterials }),
  };
}

function parseReviewerKey(id: string, pem: string): ReviewerKey {
  if (!matches(ID, id) || !isText(pem, 256)
    || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/u.test(pem)) {
    throw new NativeTaskExecutionError("invalid-input");
  }
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new NativeTaskExecutionError("invalid-input");
    return { key, sha256: sha256(key.export({ format: "der", type: "spki" })) };
  } catch {
    throw new NativeTaskExecutionError("invalid-input");
  }
}

function signatureMatches(input: SignedReview, key: ReviewerKey): boolean {
  const signature = Buffer.from(input.signature, "base64");
  return signature.length === 64 && signature.toString("base64") === input.signature
    && verify(null, nativeExecutionReviewBytes(input), key.key, signature);
}

function sourceFor(taskId: string, task: TaskRecord | undefined): Source | undefined {
  const native = task?.agentTeamTask;
  if (task === undefined || task.id !== taskId || native === undefined || !nativeIdentity(native.teamId)
    || !nativeIdentity(native.taskId) || typeof native.revision !== "number" || !Number.isSafeInteger(native.revision)
    || native.revision < 1 || !isText(task.goal, 65536) || task.goal.trim() === ""
    || !Array.isArray(native.blockedBy) || !native.blockedBy.every(id => nativeIdentity(id))
    || !Array.isArray(native.writeScopes) || !native.writeScopes.every(scope => typeof scope === "string")
    || (native.ready !== undefined && typeof native.ready !== "boolean")
    || (native.ownerId !== undefined && typeof native.ownerId !== "string")
    || (task.description !== undefined && !isText(task.description, 65536))) return undefined;
  const token = sha256(canonical("dsh-native-execution-source/v1", taskId, native.teamId, native.taskId,
    native.revision, task.goal, task.description ?? null, native.ownerId ?? null, native.ready ?? null,
    native.blockedBy, native.writeScopes, task.expectedEvidence ?? null, task.status));
  return {
    token, revision: native.revision, goal: task.goal, status: task.status,
    ready: task.status !== "completed" && task.status !== "cancelled"
      && native.ready !== false && native.blockedBy.length === 0,
    ...(task.description === undefined ? {} : { description: task.description }),
    ...(native.ownerId === undefined ? {} : { ownerId: native.ownerId }),
  };
}

function sourceMatches(source: SourceRead, attempt: StoredAttempt): boolean {
  return source.state === "found" && source.source.token === attempt.sourceToken;
}

function currentSource(result: SourceRead, sourceToken?: string): Source {
  if (result.state === "unavailable") throw new NativeTaskExecutionError("source-unavailable");
  if (result.state !== "found") throw new NativeTaskExecutionError("task-missing");
  if (sourceToken !== undefined && result.source.token !== sourceToken) throw new NativeTaskExecutionError("source-stale");
  return result.source;
}
/** Binds dispatch and review decisions to the authoritative native task and fresh worker facts. */
export function createNativeTaskExecution(options: NativeExecutionOptions) {
  const store = createNativeExecutionStore(options.directory, decodeAttempts, () => new NativeTaskExecutionError("store-unavailable"));
  const jobs = new Map(options.jobs.map(job => [job.id, parseJob(job)]));
  const reviewers = new Map(Object.entries(options.reviewerKeys).map(([id, pem]) => [id, parseReviewerKey(id, pem)]));
  if (jobs.size !== options.jobs.length || new Set([...reviewers.values()].map(key => key.sha256)).size !== reviewers.size) {
    throw new NativeTaskExecutionError("invalid-input");
  }
  const now = () => (options.now?.() ?? new Date()).toISOString();
  async function readSource(taskId: string): Promise<SourceRead> {
    try {
      const source = sourceFor(taskId, await options.readTask(taskId));
      return source === undefined ? { state: "missing" } : { state: "found", source };
    } catch {
      return { state: "unavailable" };
    }
  }
  async function inspectWorker(attempt: StoredAttempt, source: Source): Promise<WorkerRead> {
    let task: TaskRecord;
    try {
      task = await options.inspect(attempt.nodeId, attempt.workerTaskId);
    } catch {
      return UNCONFIRMED;
    }
    if (task == null || task.id !== attempt.workerTaskId || !Array.isArray(task.targetNodeIds) || task.targetNodeIds.length !== 1
      || task.targetNodeIds[0] !== attempt.nodeId || task.idempotencyKey !== workerKey(attempt.id)
      || task.dispatchFingerprint !== attempt.dispatchFingerprint) return UNCONFIRMED;
    if (task.status === "queued" || task.status === "claimed") return { state: "pending" };
    if (task.status === "running") return { state: "running" };
    const observed = task.executionObservation;
    if ((task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled")
      || observed == null || observed.taskId !== attempt.workerTaskId || observed.nodeId !== attempt.nodeId
      || observed.commandSha256 !== attempt.commandSha256 || !validTime(observed.startedAt)
      || !validTime(observed.finishedAt) || Date.parse(observed.startedAt) > Date.parse(observed.finishedAt)
      || !validExit(observed.exitCode) || (task.status === "completed") !== (observed.exitCode === 0)
      || !validStream(observed.stdout) || !validStream(observed.stderr)) return UNCONFIRMED;
    const materialsRequired = attempt.materialsRequired === true;
    let verifiedMaterials: VerifiedExecutionMaterials | undefined;
    if (materialsRequired) {
      if (attempt.expectedMaterials === undefined || options.verifyMaterials === undefined) return UNCONFIRMED;
      if (attempt.expectedSourceRevision === undefined) return UNCONFIRMED;
      const expected = expectedManifest(source, attempt.expectedMaterials);
      expected.source.revision = attempt.expectedSourceRevision;
      if (observed.reportedMaterials !== undefined
        && (!isManifest(observed.reportedMaterials) || observed.reportedMaterials.workspace.id !== attempt.id)) return UNCONFIRMED;
      let actual: ExecutionMaterialManifest | undefined;
      try {
        actual = await options.verifyMaterials({
          taskId: attempt.taskId, attemptId: attempt.id, jobId: attempt.jobId, nodeId: attempt.nodeId,
          workerTaskId: attempt.workerTaskId, expected,
          ...(observed.reportedMaterials === undefined ? {} : { reported: observed.reportedMaterials }),
        });
      } catch {
        return UNCONFIRMED;
      }
      if (actual === undefined || !isManifest(actual) || !manifestsMatch(expected, actual, attempt.id)
        || (observed.reportedMaterials !== undefined && !sameManifest(observed.reportedMaterials, actual))) return UNCONFIRMED;
      verifiedMaterials = { expected, observed: actual };
    }
    const facts = {
      taskId: attempt.taskId, sourceToken: attempt.sourceToken, attemptId: attempt.id, jobId: attempt.jobId,
      nodeId: attempt.nodeId, workerTaskId: attempt.workerTaskId, commandSha256: attempt.commandSha256,
      dispatchFingerprint: attempt.dispatchFingerprint, startedAt: observed.startedAt, finishedAt: observed.finishedAt,
      exitCode: observed.exitCode, stdout: { sha256: observed.stdout.sha256, bytes: observed.stdout.bytes },
      stderr: { sha256: observed.stderr.sha256, bytes: observed.stderr.bytes },
      ...(verifiedMaterials === undefined ? {} : { materials: verifiedMaterials }),
    };
    return { state: "exited", receipt: { ...facts, sha256: receiptDigest(facts) } };
  }
  function pinReceipt(attempt: StoredAttempt, worker: WorkerRead): Promise<StoredAttempt> {
    if (worker.state !== "exited" || attempt.receiptConflict === true || attempt.receipt?.sha256 === worker.receipt.sha256) {
      return Promise.resolve(attempt);
    }
    return store.update(attempt.taskId, entries => {
      const index = entries.findIndex(entry => entry.id === attempt.id);
      if (index < 0) throw new NativeTaskExecutionError("attempt-missing");
      const saved = entries[index]!;
      if (saved.receiptConflict === true || saved.receipt?.sha256 === worker.receipt.sha256) return { result: saved };
      const pinned: StoredAttempt = saved.receipt === undefined
        ? { ...saved, receipt: worker.receipt }
        : { ...saved, receiptConflict: true };
      entries[index] = pinned;
      return { result: pinned, entries };
    });
  }
  function view(attempt: StoredAttempt, source: SourceRead, worker: WorkerRead): NativeExecutionAttemptView {
    const { id, taskId, sourceToken, jobId, nodeId, requestId, workerTaskId, createdAt } = attempt;
    const activeSource = source.state === "found" && source.source.token === sourceToken ? source.source : undefined;
    const receipt = worker.state === "exited" && !attempt.receiptConflict && worker.receipt.sha256 === attempt.receipt?.sha256
      ? worker.receipt : undefined;
    const executionState = worker.state === "exited" && receipt === undefined ? "unconfirmed" : worker.state;
    const configuredJob = jobs.get(jobId);
    const jobPolicyCurrent = configuredJob !== undefined && configuredJob.nodeIds.includes(attempt.nodeId)
      && sha256(configuredJob.command) === attempt.commandSha256
      && (attempt.materialsRequired === true
        ? attempt.expectedMaterials !== undefined && configuredJob.expectedMaterials !== undefined
        && materialPinsDigest(attempt.expectedMaterials) === materialPinsDigest(configuredJob.expectedMaterials)
        && (configuredJob.requireMaterials === true || configuredJob.expectedMaterials !== undefined)
        : configuredJob.requireMaterials !== true && configuredJob.expectedMaterials === undefined);
    const saved = attempt.review;
    let review: NativeExecutionAttemptView["review"];
    if (saved !== undefined) {
      const key = reviewers.get(saved.reviewerId);
      const current = activeSource !== undefined && jobPolicyCurrent && activeSource.ownerId !== saved.reviewerId
        && receipt?.sha256 === saved.receiptSha256 && key?.sha256 === saved.keySha256 && signatureMatches(saved, key);
      const { reviewerId, verdict, summary, receiptSha256, reviewedAt } = saved;
      review = { reviewerId, verdict, summary, receiptSha256, reviewedAt, state: current ? "current" : "stale" };
    }
    return {
      id, taskId, sourceToken, jobId, nodeId, requestId, workerTaskId, createdAt, executionState,
      sourceState: activeSource !== undefined ? "current" : source.state === "unavailable" ? "unavailable" : "stale",
      ...(receipt === undefined ? {} : { receipt }), ...(review === undefined ? {} : { review }),
    };
  }
  async function observe(attempt: StoredAttempt, source: SourceRead): Promise<{ attempt: StoredAttempt; worker: WorkerRead; }> {
    if (!sourceMatches(source, attempt)) return { attempt, worker: UNCONFIRMED };
    const activeSource = source.state === "found" ? source.source : undefined;
    if (activeSource === undefined) return { attempt, worker: UNCONFIRMED };
    const worker = await inspectWorker(attempt, activeSource);
    return { attempt: await pinReceipt(attempt, worker), worker };
  }
  return {
    async read(taskId: string): Promise<NativeExecutionReadView> {
      if (!taskIdentity(taskId)) throw new NativeTaskExecutionError("invalid-input");
      const [initialSource, entries] = await Promise.all([readSource(taskId), store.read(taskId)]);
      const observations: Awaited<ReturnType<typeof observe>>[] = [];
      const recentFirst = entries.reverse();
      for (let offset = 0; offset < recentFirst.length; offset += 4) {
        observations.push(...await Promise.all(recentFirst.slice(offset, offset + 4).map(entry => observe(entry, initialSource))));
      }
      const source = entries.some(entry => sourceMatches(initialSource, entry)) ? await readSource(taskId) : initialSource;
      const attempts = observations.map(({ attempt, worker }) => view(attempt, source, sourceMatches(source, attempt) ? worker : UNCONFIRMED));
      return {
        jobs: [...jobs.values()].map(({ id, label, nodeIds, requireMaterials, expectedMaterials }) => {
          const requiresMaterialVerification = requireMaterials === true || expectedMaterials !== undefined;
          const materialVerificationAvailable = !requiresMaterialVerification || (
            expectedMaterials?.runtime.evidence === "measured" && options.verifyMaterials !== undefined
          );
          return {
            id, label,
            nodeIds: materialVerificationAvailable && requiresMaterialVerification && options.supportsMaterials !== undefined
              ? nodeIds.filter(nodeId => options.supportsMaterials!(nodeId))
              : materialVerificationAvailable ? [...nodeIds] : [],
            requiresMaterialVerification,
            materialVerificationAvailable,
          };
        }),
        attempts, taskAvailable: source.state === "found",
        ...(source.state === "unavailable" ? { sourceUnavailable: true as const } : {}),
        ...(source.state === "found" ? {
          sourceToken: source.source.token, sourceRevision: source.source.revision, sourceGoal: source.source.goal,
          ...(source.source.description === undefined ? {} : { sourceDescription: source.source.description }),
        } : {}),
      };
    },
    async start(input: StartInput): Promise<NativeExecutionAttemptView> {
      if (!isRecord(input) || !taskIdentity(input.taskId) || !matches(HASH, input.sourceToken)
        || !matches(ID, input.jobId) || !matches(ID, input.nodeId) || !matches(ID, input.requestId)) {
        throw new NativeTaskExecutionError("invalid-input");
      }
      const { taskId, sourceToken, jobId, nodeId, requestId } = input;
      const source = currentSource(await readSource(taskId), sourceToken);
      const job = jobs.get(jobId);
      if (job === undefined || !job.nodeIds.includes(nodeId) || !source.ready) throw new NativeTaskExecutionError("job-unavailable");
      if ((job.requireMaterials === true || job.expectedMaterials !== undefined)
        && (job.expectedMaterials?.runtime.evidence !== "measured" || options.verifyMaterials === undefined
          || options.supportsMaterials?.(nodeId) === false)) {
        throw new NativeTaskExecutionError("job-unavailable");
      }
      const id = randomUUID();
      const idempotencyKey = workerKey(id);
      const makeDispatch = (attempt: Pick<StoredAttempt, "id" | "sourceToken" | "expectedSourceRevision" | "expectedMaterials" | "materialsRequired">) => ({
        goal: `Native task execution ${attempt.id} (${job.id})`, nodeIds: [nodeId], command: job.command,
        idempotencyKey: workerKey(attempt.id),
        ...(attempt.materialsRequired === true && attempt.expectedMaterials !== undefined ? {
          executionMaterialsDigest: materialPinsDigest(attempt.expectedMaterials),
        } : {}),
        ...(attempt.materialsRequired === true ? {
          executionWorkspace: {
            id: attempt.id,
            sourceRevision: attempt.expectedSourceRevision ?? String(source.revision),
            sourceDigest: attempt.sourceToken,
          },
        } : {}),
      });
      const proposedDispatch = makeDispatch({
        id, sourceToken, expectedSourceRevision: String(source.revision),
        ...(job.expectedMaterials === undefined ? {} : { expectedMaterials: job.expectedMaterials }),
        ...((job.requireMaterials === true || job.expectedMaterials !== undefined) ? { materialsRequired: true as const } : {}),
      });
      const reservation = await store.update(taskId, entries => {
        const sameRequest = entries.find(entry => entry.requestId === requestId);
        if (sameRequest !== undefined) {
          if (sameRequest.sourceToken !== sourceToken || sameRequest.jobId !== jobId || sameRequest.nodeId !== nodeId) {
            throw new NativeTaskExecutionError("attempt-conflict");
          }
          const oldPinsDigest = sameRequest.expectedMaterials === undefined
            ? undefined : materialPinsDigest(sameRequest.expectedMaterials);
          const newPinsDigest = job.expectedMaterials === undefined
            ? undefined : materialPinsDigest(job.expectedMaterials);
          if (sameRequest.commandSha256 !== sha256(job.command) || oldPinsDigest !== newPinsDigest
            || (sameRequest.materialsRequired === true) !== (job.requireMaterials === true || job.expectedMaterials !== undefined)) {
            throw new NativeTaskExecutionError("attempt-conflict");
          }
          return { result: { created: false, attempt: sameRequest } };
        }
        if (entries.length >= ATTEMPT_LIMIT || entries.some(entry => entry.sourceToken === sourceToken
          && entry.jobId === jobId && entry.nodeId === nodeId)) throw new NativeTaskExecutionError("attempt-conflict");
        const workerTaskId = options.taskIdFor(nodeId, idempotencyKey);
        if (!matches(ID, workerTaskId)) throw new NativeTaskExecutionError("job-unavailable");
        const attempt: StoredAttempt = {
          id, taskId, sourceToken, jobId, nodeId, requestId, workerTaskId, createdAt: now(),
          commandSha256: sha256(job.command), dispatchFingerprint: createDispatchFingerprint(proposedDispatch),
          dispatchState: "reserved",
          ...((job.requireMaterials === true || job.expectedMaterials !== undefined) ? {
            materialsRequired: true as const,
            ...(job.expectedMaterials === undefined ? {} : {
              expectedSourceRevision: String(source.revision),
              expectedMaterials: structuredClone(job.expectedMaterials),
            }),
          } : {}),
        };
        return { result: { created: true, attempt }, entries: [...entries, attempt] };
      });
      const dispatch = makeDispatch(reservation.attempt);
      if (createDispatchFingerprint(dispatch) !== reservation.attempt.dispatchFingerprint) {
        throw new NativeTaskExecutionError("attempt-conflict");
      }
      let latest = await readSource(taskId);
      let attempt = reservation.attempt;
      if (latest.state === "found" && latest.source.token === sourceToken && attempt.dispatchState === "reserved") {
        const claim = await store.update(taskId, entries => {
          const index = entries.findIndex(entry => entry.id === attempt.id);
          if (index < 0) throw new NativeTaskExecutionError("attempt-missing");
          const saved = entries[index]!;
          if (saved.dispatchState !== "reserved") return { result: { claimed: false, attempt: saved } };
          const submitted: StoredAttempt = { ...saved, dispatchState: "may-have-been-sent" };
          entries[index] = submitted;
          return { result: { claimed: true, attempt: submitted }, entries };
        });
        attempt = claim.attempt;
        if (claim.claimed) {
          try {
            await options.dispatch(dispatch);
          } catch {
          }
          latest = await readSource(taskId);
        }
      }
      const { attempt: observedAttempt, worker } = await observe(attempt, latest);
      if (sourceMatches(latest, attempt)) latest = await readSource(taskId);
      return view(observedAttempt, latest, sourceMatches(latest, observedAttempt) ? worker : UNCONFIRMED);
    },
    async review(input: SignedReview): Promise<NativeExecutionAttemptView> {
      if (!isRecord(input) || !validReviewPayload(input)) throw new NativeTaskExecutionError("invalid-input");
      const { taskId, attemptId, receiptSha256, reviewerId, verdict, summary, signature } = input;
      const key = reviewers.get(reviewerId);
      if (key === undefined) throw new NativeTaskExecutionError("review-untrusted");
      const attempt = (await store.read(taskId)).find(entry => entry.id === attemptId);
      if (attempt === undefined) throw new NativeTaskExecutionError("attempt-missing");
      const source = currentSource(await readSource(taskId), attempt.sourceToken);
      if (source.ownerId === reviewerId) throw new NativeTaskExecutionError("review-untrusted");
      const signed = { taskId, attemptId, receiptSha256, reviewerId, verdict, summary, signature };
      if (!signatureMatches(signed, key)) throw new NativeTaskExecutionError("review-invalid");
      const worker = await inspectWorker(attempt, source);
      const pinned = await pinReceipt(attempt, worker);
      if (worker.state !== "exited" || pinned.receiptConflict === true || worker.receipt.sha256 !== receiptSha256) {
        throw new NativeTaskExecutionError("receipt-unavailable");
      }
      const latest = currentSource(await readSource(taskId), attempt.sourceToken);
      const reviewed = await store.update(taskId, entries => {
        const index = entries.findIndex(entry => entry.id === attemptId);
        if (index < 0) throw new NativeTaskExecutionError("attempt-missing");
        const current = entries[index]!;
        if (current.receiptConflict === true || current.receipt?.sha256 !== receiptSha256) {
          throw new NativeTaskExecutionError("receipt-unavailable");
        }
        if (current.review !== undefined) {
          const oldKey = reviewers.get(current.review.reviewerId);
          if (oldKey?.sha256 === current.review.keySha256 && current.review.signature === signature) {
            return { result: current };
          }
          throw new NativeTaskExecutionError("attempt-conflict");
        }
        const next = { ...current, review: { ...signed, keySha256: key.sha256, reviewedAt: now() } };
        entries[index] = next;
        return { result: next, entries };
      });
      return view(reviewed, { state: "found", source: latest }, worker);
    },
  };
}
