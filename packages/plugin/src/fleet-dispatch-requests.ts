import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NativeExecutionEnvironmentRequest } from "./native-task-execution.js";
import type { FleetNotificationEvent } from "./fleet-notifications.js";

export type DispatchRequestStatus = "pending" | "approved" | "rejected" | "failed" | "expired";

export interface FleetDispatchRequestInput {
  requestId: string;
  taskId: string;
  sourceToken: string;
  jobId: string;
  nodeId: string;
  environment?: NativeExecutionEnvironmentRequest;
  requestedBy: string;
  source: string;
}

export interface FleetDispatchRequest extends FleetDispatchRequestInput {
  id: string;
  status: DispatchRequestStatus;
  createdAt: string;
  updatedAt: string;
  attemptId?: string;
  error?: string;
  reason?: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface FleetDispatchRequestService {
  readonly path: string;
  create(input: FleetDispatchRequestInput): Promise<{ request: FleetDispatchRequest; created: boolean }>;
  list(): Promise<FleetDispatchRequest[]>;
  approve(id: string, decidedBy: string): Promise<{ request: FleetDispatchRequest; attemptId: string }>;
  reject(id: string, reason: string, decidedBy: string): Promise<FleetDispatchRequest>;
}

export class DispatchRequestError extends Error {
  constructor(readonly code:
    | "invalid-input" | "request-conflict" | "request-not-found" | "request-not-pending"
    | "request-expired" | "dispatch-failed" | "store-invalid") {
    super(code);
    this.name = "DispatchRequestError";
  }
}

interface StoredFile {
  version: 1;
  requests: FleetDispatchRequest[];
}

const TTL_MS = 24 * 60 * 60 * 1_000;
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HOST = /^sha256:[a-f0-9]{64}$/u;

export function createFleetDispatchRequests(options: {
  path: string;
  dispatch: (input: FleetDispatchRequestInput) => Promise<{ id: string }>;
  now?: () => number;
  ttlMs?: number;
  onEvent?: (event: FleetNotificationEvent) => void | Promise<void>;
}): FleetDispatchRequestService {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? TTL_MS;
  const inFlight = new Set<string>();
  const emit = async (event: FleetNotificationEvent): Promise<void> => {
    try {
      await options.onEvent?.(event);
    } catch {
      // Notifications are best effort; they never change the request decision.
    }
  };

  const read = (): StoredFile => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(options.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { version: 1, requests: [] };
      throw new DispatchRequestError("store-invalid");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new DispatchRequestError("store-invalid");
    const file = parsed as Partial<StoredFile>;
    if (file.version !== 1 || !Array.isArray(file.requests) || !file.requests.every(validRequest)) {
      throw new DispatchRequestError("store-invalid");
    }
    return { version: 1, requests: file.requests };
  };

  const save = (file: StoredFile): void => {
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    const temporary = `${options.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    renameSync(temporary, options.path);
  };

  const expire = (file: StoredFile): boolean => {
    let changed = false;
    const timestamp = now();
    for (const request of file.requests) {
      if (request.status === "pending" && timestamp - Date.parse(request.createdAt) > ttlMs) {
        request.status = "expired";
        request.updatedAt = new Date(timestamp).toISOString();
        changed = true;
      }
    }
    return changed;
  };

  const list = async (): Promise<FleetDispatchRequest[]> => {
    const file = read();
    if (expire(file)) save(file);
    return file.requests.filter(request => request.status !== "expired");
  };

  const create = async (input: FleetDispatchRequestInput) => {
    validateInput(input);
    const file = read();
    if (expire(file)) save(file);
    const existing = file.requests.find(request => request.requestId === input.requestId);
    if (existing !== undefined) {
      if (existing.taskId !== input.taskId || existing.sourceToken !== input.sourceToken
        || existing.jobId !== input.jobId || existing.nodeId !== input.nodeId
        || JSON.stringify(existing.environment) !== JSON.stringify(input.environment)) {
        throw new DispatchRequestError("request-conflict");
      }
      return { request: existing, created: false };
    }
    const timestamp = new Date(now()).toISOString();
    const request: FleetDispatchRequest = {
      ...input,
      ...(input.environment === undefined ? {} : { environment: structuredClone(input.environment) }),
      id: randomUUID(), status: "pending", createdAt: timestamp, updatedAt: timestamp,
    };
    file.requests.push(request);
    save(file);
    await emit({
      type: "created", requestId: request.requestId, taskId: request.taskId,
      jobId: request.jobId, nodeId: request.nodeId, requestedBy: request.requestedBy,
      status: request.status,
    });
    return { request, created: true };
  };

  const approve = async (id: string, decidedBy: string) => {
    if (inFlight.has(id)) throw new DispatchRequestError("request-not-pending");
    inFlight.add(id);
    try {
    const file = read();
    if (expire(file)) save(file);
    const request = file.requests.find(row => row.id === id);
    if (request === undefined) throw new DispatchRequestError("request-not-found");
    if (request.status === "expired") throw new DispatchRequestError("request-expired");
    if (request.status !== "pending") throw new DispatchRequestError("request-not-pending");
    try {
      const attempt = await options.dispatch({
        requestId: request.requestId, taskId: request.taskId, sourceToken: request.sourceToken,
        jobId: request.jobId, nodeId: request.nodeId,
        ...(request.environment === undefined ? {} : { environment: request.environment }),
        requestedBy: request.requestedBy, source: request.source,
      });
      request.status = "approved";
      request.attemptId = attempt.id;
      request.decidedBy = decidedBy;
      request.decidedAt = new Date(now()).toISOString();
      request.updatedAt = request.decidedAt;
      save(file);
      await emit({
        type: "approved", requestId: request.requestId, taskId: request.taskId,
        jobId: request.jobId, nodeId: request.nodeId, requestedBy: request.requestedBy,
        status: request.status,
        ...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
      });
      return { request, attemptId: attempt.id };
    } catch (error) {
      request.status = "failed";
      request.error = typeof (error as { code?: unknown } | undefined)?.code === "string"
        ? (error as { code: string }).code
        : error instanceof Error ? error.message : String(error);
      request.decidedBy = decidedBy;
      request.decidedAt = new Date(now()).toISOString();
      request.updatedAt = request.decidedAt;
      save(file);
      await emit({
        type: "failed", requestId: request.requestId, taskId: request.taskId,
        jobId: request.jobId, nodeId: request.nodeId, requestedBy: request.requestedBy,
        status: request.status,
        ...(request.error === undefined ? {} : { error: request.error }),
      });
      throw new DispatchRequestError("dispatch-failed");
    }
    } finally {
      inFlight.delete(id);
    }
  };

  const reject = async (id: string, reason: string, decidedBy: string) => {
    if (inFlight.has(id)) throw new DispatchRequestError("request-not-pending");
    inFlight.add(id);
    try {
    const file = read();
    if (expire(file)) save(file);
    const request = file.requests.find(row => row.id === id);
    if (request === undefined) throw new DispatchRequestError("request-not-found");
    if (request.status !== "pending") throw new DispatchRequestError("request-not-pending");
    if (reason.length > 512) throw new DispatchRequestError("invalid-input");
    request.status = "rejected";
    request.reason = reason;
    request.decidedBy = decidedBy;
    request.decidedAt = new Date(now()).toISOString();
    request.updatedAt = request.decidedAt;
    save(file);
    await emit({
      type: "rejected", requestId: request.requestId, taskId: request.taskId,
      jobId: request.jobId, nodeId: request.nodeId, requestedBy: request.requestedBy,
      status: request.status,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    });
    return request;
    } finally {
      inFlight.delete(id);
    }
  };

  return { path: options.path, create, list, approve, reject };
}

function validateInput(input: FleetDispatchRequestInput): void {
  if (!ID.test(input.requestId) || typeof input.taskId !== "string" || input.taskId === ""
    || !HASH.test(input.sourceToken) || !ID.test(input.jobId) || !ID.test(input.nodeId)
    || typeof input.requestedBy !== "string" || input.requestedBy === "" || input.requestedBy.length > 128
    || typeof input.source !== "string" || input.source === "" || input.source.length > 128) {
    throw new DispatchRequestError("invalid-input");
  }
  const environment = input.environment;
  if (environment !== undefined) {
    const digest = (value: unknown) => value === undefined || (typeof value === "string" && HOST.test(value));
    if (!digest(environment.hostId) || !digest(environment.requireDigest)
      || (environment.policy !== undefined && environment.policy !== "exact" && environment.policy !== "compatible")) {
      throw new DispatchRequestError("invalid-input");
    }
  }
}

function validRequest(value: unknown): value is FleetDispatchRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<FleetDispatchRequest>;
  return typeof request.id === "string" && ID.test(request.id)
    && typeof request.requestId === "string" && ID.test(request.requestId)
    && typeof request.taskId === "string" && request.taskId !== ""
    && typeof request.sourceToken === "string" && HASH.test(request.sourceToken)
    && typeof request.jobId === "string" && ID.test(request.jobId)
    && typeof request.nodeId === "string" && ID.test(request.nodeId)
    && ["pending", "approved", "rejected", "failed", "expired"].includes(String(request.status))
    && typeof request.createdAt === "string" && typeof request.updatedAt === "string";
}
