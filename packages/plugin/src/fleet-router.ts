import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_EXEC_CAPABILITY_TTL_MS,
  type ExecCapabilityObservation,
  type HostAccessPolicy,
} from "@dsh-fusion/core";
import { gateCompletedTask } from "@dsh-fusion/host";
import type { RuntimeNodeRecord, RuntimeProviderHealthStatus, RuntimeTaskRecord } from "./plugin-runtime.js";

const PROVIDER_HEALTH_ERROR_TTL_MS = 60_000;
const LEDGER_MAX_RETRIES = 3;
const LEDGER_RETRY_BASE_DELAY_MS = 100;
const MAX_IDEMPOTENT_TASKS = 200;

export interface RoutableFleetProvider {
  readonly id: string;
  health(): Promise<RuntimeProviderHealthStatus>;
  listNodes(): Promise<RuntimeNodeRecord[]>;
  /**
   * The nodes this provider owns, reported without probing them.
   *
   * A provider that cannot be reached still has a known identity, so the
   * router can keep its nodes visible as offline instead of dropping them.
   */
  describeNodes?(): RuntimeNodeRecord[];
  /**
   * The health of every provider behind this one, keyed by provider id.
   *
   * A router fronts several providers, and its aggregate health cannot say
   * which one failed. This reports each provider separately, so an operator
   * sees the failing machine instead of a fleet that merely looks degraded.
   */
  providerHealth?(): Promise<Record<string, RuntimeProviderHealthStatus>>;
  dispatch(input: {
    goal: string;
    nodeIds: string[];
    command?: string;
    executionWorkspace?: { id: string; sourceRevision: string; sourceDigest: string };
    executionMaterialsDigest?: string;
  }): Promise<RuntimeTaskRecord>;
  readExecutionMaterialFiles?(taskId: string, workspaceId: string, paths: readonly string[]): Promise<{
    workspacePath: string;
    workspaceId: string;
    sourceRevision: string;
    sourceDigest: string;
    files: Array<{ path: string; digest: string; bytes: number }>;
  } | undefined>;
  doctor(nodeId?: string): Promise<{ node: RuntimeNodeRecord; evidence: RuntimeTaskRecord["evidence"] }>;
  inspect?(taskId: string): Promise<RuntimeTaskRecord>;
  cancel?(taskId: string): Promise<void>;
  probeExecCapability?(): Promise<ExecCapabilityObservation>;
}

export function createDispatchFingerprint(input: {
  goal: string;
  command?: string;
  nodeIds: string[];
  executionWorkspace?: { id: string; sourceRevision: string; sourceDigest: string };
  executionMaterialsDigest?: string;
  executionEnvironmentDigest?: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    command: input.command ?? "",
    ...(input.executionWorkspace === undefined ? {} : { executionWorkspace: input.executionWorkspace }),
    ...(input.executionMaterialsDigest === undefined ? {} : { executionMaterialsDigest: input.executionMaterialsDigest }),
    ...(input.executionEnvironmentDigest === undefined ? {} : { executionEnvironmentDigest: input.executionEnvironmentDigest }),
    goal: input.goal,
    nodeIds: [...new Set(input.nodeIds)],
  })).digest("hex");
}

function deterministicTaskId(
  route: FleetRoute,
  idempotencyKey: string,
  nodeIds: readonly string[],
): string {
  const prefix = route.taskPrefixes?.[0] ?? `${route.provider.id.toUpperCase()}-`;
  const digest = createHash("sha256").update(JSON.stringify({
    idempotencyKey,
    nodeIds: [...new Set(nodeIds)],
    providerId: route.provider.id,
  })).digest("hex").slice(0, 32);
  return `${prefix}${digest}`;
}

export interface FleetRoute {
  nodeIds: string[];
  provider: RoutableFleetProvider;
  taskPrefixes?: string[];
}

export interface FleetRouterOptions {
  initialTasks?: RuntimeTaskRecord[];
  onChange?: (tasks: RuntimeTaskRecord[]) => void | Promise<void>;
  hostAccess?: Record<string, HostAccessPolicy>;
  inspectConcurrency?: {
    global?: number;
    perProvider?: number;
  };
}

// Refresh rounds fan out one inspect per active task. Without a budget
// a round starts O(tasks) provider operations at once, so connection
// peaks grow with the fleet and one slow provider can occupy every
// slot. Two budgets bound that: a global cap for the router and a
// per-provider cap so a single provider cannot starve the others.
const DEFAULT_INSPECT_CONCURRENCY_GLOBAL = 8;
const DEFAULT_INSPECT_CONCURRENCY_PER_PROVIDER = 4;

function normalizeConcurrency(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.trunc(value)
    : fallback;
}

class InspectSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private peakWaiters = 0;

  constructor(private readonly limit: number) {}

  /** Deepest waiter queue observed since the last peak reset. */
  get peakWaiting(): number {
    return this.peakWaiters;
  }

  resetPeakWaiting(): void {
    this.peakWaiters = this.waiters.length;
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      this.peakWaiters = Math.max(this.peakWaiters, this.waiters.length);
    });
  }

  release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) {
      this.active += 1;
      next();
    }
  }
}

interface AggregatedTask {
  id: string;
  provider: RoutableFleetProvider;
  children: RuntimeTaskRecord[];
}

interface ProviderHealthError {
  generation: number;
  message: string;
  recordedAt: number;
}

interface LedgerDurabilityError {
  generation: number;
  message: string;
}

function aggregateStatus(tasks: RuntimeTaskRecord[]): RuntimeTaskRecord["status"] {
  if (tasks.some((task) => task.status === "running")) return "running";
  if (tasks.some((task) => task.status === "verifying")) return "verifying";
  if (tasks.some((task) => task.status === "claimed")) return "claimed";
  if (tasks.some((task) => task.status === "queued")) return "queued";
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "cancelled")) return "cancelled";
  return tasks.every((task) => task.status === "completed") ? "completed" : "queued";
}


function gateFleetTask(task: RuntimeTaskRecord): RuntimeTaskRecord {
  const refs = task.childTaskRefs;
  if (refs === undefined
    || (refs.length === 1 && refs[0]!.id === task.id)) return gateCompletedTask(task);
  const children = refs.map((ref) => {
    const { childTaskRefs: _refs, ...parent } = task;
    return gateCompletedTask({
      ...parent,
      id: ref.id,
      targetNodeIds: [...ref.targetNodeIds],
      status: ref.status ?? task.status,
      evidence: task.evidence.flatMap((item) => {
        const prefix = ref.targetNodeIds.map((nodeId) => "[" + nodeId + "] ")
          .find((candidate) => item.label.startsWith(candidate));
        return prefix === undefined ? [] : [{ ...item, label: item.label.slice(prefix.length) }];
      }),
    });
  });
  return gateCompletedTask({
    ...task,
    status: task.status === "completed" && children.some((child) => child.status !== "completed")
      ? "verifying"
      : task.status,
    childTaskRefs: refs.map((ref, index) => ({ ...ref, status: children[index]!.status })),
  });
}

function averageProgress(tasks: RuntimeTaskRecord[]): number | undefined {
  let total = 0;
  for (const task of tasks) {
    if (task.progress === undefined) return undefined;
    total += task.progress;
  }
  return Math.round(total / tasks.length);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return "unknown error";
  }
}

function isTaskLookupMiss(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("_TASK_NOT_FOUND:")
    || message.includes("TASK_ID_INVALID");
}

/** Inspect effort of one refresh round (review 05 P1-2 metrics). */
export interface FleetInspectRoundStats {
  round: number;
  attempts: number;
  failures: number;
  /** Deepest budget waiter queue observed during the round. */
  peakQueueDepth: number;
  startedAt: number;
  /** Set once the round settles; undefined while it is running. */
  durationMs: number | undefined;
}

export interface FleetInspectStats {
  /** Every budgeted inspect since this router was created. */
  totals: { attempts: number; failures: number };
  /** The running round, or the most recent settled one. */
  lastRound: FleetInspectRoundStats | undefined;
}

export class FleetRouter implements RoutableFleetProvider {
  readonly id = "fleet-router";
  private readonly routes: FleetRoute[];
  private readonly onChange: FleetRouterOptions["onChange"];
  private readonly hostAccess: ReadonlyMap<string, HostAccessPolicy>;
  private readonly startingTasksByNode = new Map<string, number>();
  private readonly taskRoutes = new Map<string, AggregatedTask>();
  private readonly taskRecords = new Map<string, RuntimeTaskRecord>();
  private readonly taskVersions = new Map<string, number>();
  private readonly idempotentDispatches = new Map<string, {
    fingerprint: string;
    promise: Promise<RuntimeTaskRecord>;
  }>();
  private readonly idempotentTasks = new Map<string, RuntimeTaskRecord>();
  // Physical probes outlive HTTP deadlines. Keep their slots until settlement.
  private readonly execCapabilityProbes = new Map<string, Promise<ExecCapabilityObservation>>();
  private readonly providerHealthErrors = new Map<string, ProviderHealthError>();
  private readonly providerSuccessGenerations = new Map<string, number>();
  private readonly inspectGlobalBudget: InspectSemaphore;
  private readonly inspectPerProviderLimit: number;
  private readonly inspectProviderBudgets = new Map<string, InspectSemaphore>();
  private readonly inspectTotals = { attempts: 0, failures: 0 };
  private inspectRoundCount = 0;
  private openInspectRound: FleetInspectRoundStats | undefined;
  private lastInspectRound: FleetInspectRoundStats | undefined;
  private refreshPromise: Promise<void> | undefined;
  private ledgerDirtyTasks: RuntimeTaskRecord[] | undefined;
  private ledgerDurabilityError: LedgerDurabilityError | undefined;
  private ledgerRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private ledgerWriteInFlight = false;
  private healthGeneration = 0;
  private cachedLoad:
    | {
        at: number;
        results: Array<{
          route: FleetRoute;
          nodes: RuntimeNodeRecord[];
          error?: string;
        }>;
      }
    | undefined;
  private loading:
    | Promise<Array<{
        route: FleetRoute;
        nodes: RuntimeNodeRecord[];
        error?: string;
      }>>
    | undefined;

  constructor(routes: FleetRoute[], options: FleetRouterOptions = {}) {
    this.routes = routes.filter((route) => route.nodeIds.length > 0);
    this.onChange = options.onChange;
    this.hostAccess = new Map(Object.entries(options.hostAccess ?? {}));
    this.inspectGlobalBudget = new InspectSemaphore(normalizeConcurrency(
      options.inspectConcurrency?.global,
      DEFAULT_INSPECT_CONCURRENCY_GLOBAL,
    ));
    this.inspectPerProviderLimit = normalizeConcurrency(
      options.inspectConcurrency?.perProvider,
      DEFAULT_INSPECT_CONCURRENCY_PER_PROVIDER,
    );
    const nodeOwners = new Map<string, string>();
    for (const route of this.routes) {
      for (const nodeId of route.nodeIds) {
        const existing = nodeOwners.get(nodeId);
        if (existing !== undefined) {
          throw new Error(`FLEET_NODE_ID_CONFLICT:${nodeId}:${existing}:${route.provider.id}`);
        }
        nodeOwners.set(nodeId, route.provider.id);
      }
    }
    for (const restored of options.initialTasks ?? []) {
      const task = gateFleetTask(restored);
      if (
        typeof task.idempotencyKey === "string" && task.idempotencyKey !== ""
        && typeof task.dispatchFingerprint === "string" && task.dispatchFingerprint !== ""
      ) {
        this.idempotentTasks.set(task.idempotencyKey, task);
      }
      const route = this.providerRouteForTask(task);
      if (route === undefined) continue;
      const childRefs = task.childTaskRefs;
      const isAggregate = childRefs !== undefined
        && (
          task.id.startsWith("FLEET-")
          || childRefs.length > 1
          || childRefs[0]?.id !== task.id
        );
      const children = childRefs === undefined || !isAggregate
        ? [task]
        : childRefs.map((child) => ({
            id: child.id,
            goal: task.goal,
            targetNodeIds: [...child.targetNodeIds],
            transport: task.transport,
            status: child.status
              ?? (task.status === "completed"
                ? "completed"
                : task.status === "failed"
                  ? "failed"
                  : task.status === "cancelled"
                    ? "cancelled"
                    : "queued"),
            ...(child.progress === undefined ? {} : { progress: child.progress }),
            evidence: [],
            ...(task.expectedEvidence === undefined
              ? {}
              : { expectedEvidence: [...task.expectedEvidence] }),
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          }));
      this.taskRoutes.set(task.id, {
        id: task.id,
        provider: route.provider,
        children,
      });
      this.taskRecords.set(task.id, task);
    }
  }

  private withHostAccess(node: RuntimeNodeRecord): RuntimeNodeRecord {
    const policy = this.hostAccess.get(node.id);
    return policy === undefined
      ? node
      : { ...node, hostAccess: { ...policy } };
  }

  private activeTaskBlocksNode(task: RuntimeTaskRecord, nodeId: string): boolean {
    const active = new Set<RuntimeTaskRecord["status"]>([
      "queued",
      "claimed",
      "running",
      "verifying",
    ]);
    if (task.childTaskRefs !== undefined && task.id.startsWith("FLEET-")) {
      return task.childTaskRefs.some((child) =>
        child.targetNodeIds.includes(nodeId)
        && active.has(child.status ?? task.status)
      );
    }
    return task.targetNodeIds.includes(nodeId) && active.has(task.status);
  }

  private reserveHostSlots(nodeIds: readonly string[]): () => void {
    const unique = [...new Set(nodeIds)];
    for (const nodeId of unique) {
      const limit = this.hostAccess.get(nodeId)?.maxConcurrentTasks;
      if (limit === undefined) continue;
      const active = [...this.taskRecords.values()]
        .filter((task) => this.activeTaskBlocksNode(task, nodeId))
        .length;
      const starting = this.startingTasksByNode.get(nodeId) ?? 0;
      if (active + starting >= limit) {
        throw new Error(`FLEET_NODE_CONCURRENCY_LIMIT:${nodeId}:${limit}`);
      }
    }
    const reserved = unique.filter((nodeId) =>
      this.hostAccess.get(nodeId)?.maxConcurrentTasks !== undefined
    );
    for (const nodeId of reserved) {
      this.startingTasksByNode.set(
        nodeId,
        (this.startingTasksByNode.get(nodeId) ?? 0) + 1,
      );
    }
    return () => {
      for (const nodeId of reserved) {
        const next = (this.startingTasksByNode.get(nodeId) ?? 1) - 1;
        if (next <= 0) this.startingTasksByNode.delete(nodeId);
        else this.startingTasksByNode.set(nodeId, next);
      }
    };
  }

  async health(): Promise<RuntimeProviderHealthStatus> {
    if (this.routes.length === 0) {
      return {
        state: "not-configured",
        checkedAt: Date.now(),
        message: "No remote fleet provider configured",
      };
    }
    await this.awaitPendingRefresh();
    this.pruneProviderHealthErrors();
    const results = await this.loadFleet();
    const connected = results.filter((result) =>
      result.error === undefined && result.nodes.some((node) => node.status === "online")
    ).length;
    const degraded = results.filter((result) =>
      result.error === undefined
      && result.nodes.length > 0
      && result.nodes.every((node) => node.status !== "online")
    ).length;
    const probeState = connected === this.routes.length
      ? "connected"
      : connected + degraded > 0
        ? "degraded"
        : "offline";
    const failures = results.flatMap((result) => result.error === undefined ? [] : [result.error]);
    const operationErrors = this.activeHealthErrors().map((error) => error.message);
    const state = probeState === "connected" && operationErrors.length > 0
      ? "degraded"
      : probeState;
    const messages = [...failures, ...operationErrors];
    return {
      state,
      checkedAt: Date.now(),
      message: messages.length === 0
        ? `${connected}/${this.routes.length} fleet providers connected`
        : `${connected}/${this.routes.length} fleet providers connected; ${messages.join(" | ")}`,
    };
  }

  async listNodes(): Promise<RuntimeNodeRecord[]> {
    const results = await this.loadFleet();
    const failures = results.flatMap((result) => result.error === undefined ? [] : [result.error]);
    if (results.length > 0 && failures.length === results.length) {
      // Every provider is unreachable, so the fleet cannot be observed at
      // all. That is a hard failure, not a fleet of offline nodes.
      throw new Error(`FLEET_NODES_UNAVAILABLE:${failures.join(" | ")}`);
    }
    const nodes = results.flatMap((result) => result.nodes);
    const unique = new Map(nodes.map((node) => [node.id, node]));
    return [...unique.values()];
  }

  /** Explicit read-only diagnostics; never dispatches or widens the selection. */
  async probeExecCapabilities(nodeIds: string[]): Promise<ExecCapabilityObservation[]> {
    const selected = [...new Set(nodeIds)].map((nodeId) => ({
      nodeId,
      route: this.routes.find((route) => route.nodeIds.includes(nodeId)),
    }));
    const unknown = selected.filter((entry) => entry.route === undefined);
    if (unknown.length > 0) throw new Error(`FLEET_NODE_UNKNOWN:${unknown.map((entry) => entry.nodeId).join(",")}`);
    const unknownObservation = (index: number, reason: string): ExecCapabilityObservation => {
      const { nodeId, route } = selected[index]!;
      const checkedAt = Date.now();
      return { nodeId, providerId: route!.provider.id, state: "unknown", checkedAt,
        expiresAt: checkedAt + DEFAULT_EXEC_CAPABILITY_TTL_MS,
        source: "fusion:fleet-router", reasonCodes: [reason], checks: [] };
    };
    return await Promise.all(selected.map(async (_, index) => {
        const { nodeId, route } = selected[index]!;
        const provider = route!.provider;
        if (provider.probeExecCapability === undefined) {
          return unknownObservation(index, "EXEC_PROBE_UNAVAILABLE");
        }
        let physicalProbe = this.execCapabilityProbes.get(provider.id);
        if (physicalProbe === undefined) {
          if (this.execCapabilityProbes.size >= 4) return unknownObservation(index, "EXEC_PROBE_BUSY");
          const started = Promise.resolve().then(() => provider.probeExecCapability!()).finally(() => {
            if (this.execCapabilityProbes.get(provider.id) === started) this.execCapabilityProbes.delete(provider.id);
          });
          this.execCapabilityProbes.set(provider.id, started);
          physicalProbe = started;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            physicalProbe.then((observation) => {
              if (observation?.nodeId !== nodeId || observation.providerId !== provider.id) {
                return unknownObservation(index, "EXEC_PROBE_IDENTITY_MISMATCH");
              }
              if (!["supported", "unsupported", "unknown"].includes(observation.state)
                || !Number.isFinite(observation.checkedAt) || !Number.isFinite(observation.expiresAt)
                || typeof observation.source !== "string" || observation.source.trim() === ""
                || !Array.isArray(observation.reasonCodes) || observation.reasonCodes.some((code) => typeof code !== "string")
                || !Array.isArray(observation.checks) || observation.checks.some((check) =>
                  typeof check?.id !== "string" || check.id.trim() === "" || typeof check.ok !== "boolean")) {
                return unknownObservation(index, "EXEC_PROBE_INVALID");
              }
              return observation;
            }),
            new Promise<ExecCapabilityObservation>((resolve) => {
              timer = setTimeout(() => {
                resolve(unknownObservation(index, "EXEC_PROBE_TIMEOUT"));
              }, 5_000);
            }),
          ]);
        } catch {
          return unknownObservation(index, "EXEC_PROBE_FAILED");
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
    }));
  }

  /**
   * The health of each fleet provider, keyed by provider id.
   *
   * The aggregate `health()` cannot say *which* provider failed. This can,
   * so an operator sees the failing provider rather than a fleet that merely
   * looks degraded.
   */
  async providerHealth(): Promise<Record<string, RuntimeProviderHealthStatus>> {
    await this.awaitPendingRefresh();
    this.pruneProviderHealthErrors();
    const results = await this.loadFleet();
    const statuses: Record<string, RuntimeProviderHealthStatus> = {};
    for (const result of results) {
      const providerId = result.route.provider.id;
      const status: RuntimeProviderHealthStatus = result.error !== undefined
        ? {
          state: "offline",
          checkedAt: Date.now(),
          message: result.error,
        }
        : result.nodes.some((node) => node.status === "online")
          ? { state: "connected", checkedAt: Date.now() }
          : {
            state: "degraded",
            checkedAt: Date.now(),
            message: result.nodes.length === 0
              ? "provider reported no node"
              : "no node reported as online",
          };
      // A provider serving several routes keeps the worst status.
      const existing = statuses[providerId];
      if (existing === undefined || existing.state === "connected") {
        statuses[providerId] = status;
      }
    }
    for (const error of this.activeHealthErrors()) {
      const providerId = error.providerId;
      const existing = statuses[providerId];
      const message = existing?.message === undefined
        ? error.message
        : `${existing.message} | ${error.message}`;
      statuses[providerId] = existing?.state === "offline"
        ? { ...existing, checkedAt: Date.now(), message }
        : { state: "degraded", checkedAt: Date.now(), message };
    }
    return statuses;
  }

  /** The single-worker address of an already bound execution intent. */
  executionTaskId(nodeId: string, idempotencyKey: string): string {
    const route = this.executionRoute(nodeId);
    return deterministicTaskId(route, idempotencyKey, [nodeId]);
  }

  /** Read the identified worker directly, without cached ledger metadata. */
  async inspectExecution(nodeId: string, taskId: string): Promise<RuntimeTaskRecord> {
    return await this.inspectWithBudget(this.executionRoute(nodeId).provider, taskId);
  }

  async readRoutedExecutionMaterialFiles(nodeId: string, taskId: string, workspaceId: string, paths: readonly string[]) {
    const provider = this.executionRoute(nodeId).provider;
    if (provider.readExecutionMaterialFiles === undefined) return undefined;
    return await provider.readExecutionMaterialFiles(taskId, workspaceId, paths);
  }

  supportsExecutionMaterials(nodeId: string): boolean {
    return this.executionRoute(nodeId).provider.readExecutionMaterialFiles !== undefined;
  }

  private executionRoute(nodeId: string): FleetRoute {
    const route = this.routes.find((candidate) => candidate.nodeIds.includes(nodeId));
    if (route?.provider.inspect === undefined) throw new Error("FLEET_EXECUTION_WORKER_UNAVAILABLE");
    return route;
  }

  async dispatch(input: {
    goal: string;
    nodeIds: string[];
    command?: string;
    idempotencyKey?: string;
    executionWorkspace?: { id: string; sourceRevision: string; sourceDigest: string };
    executionMaterialsDigest?: string;
  }): Promise<RuntimeTaskRecord> {
    const key = input.idempotencyKey?.trim();
    if (key === undefined) return this.dispatchToFleet(input);
    if (key === "" || key.length > 128 || /[\u0000-\u001f\u007f]/u.test(key)) {
      throw new Error("FLEET_IDEMPOTENCY_KEY_INVALID");
    }
    const fingerprint = createDispatchFingerprint(input);
    const restored = this.idempotentTasks.get(key);
    if (restored !== undefined) {
      if (restored.dispatchFingerprint !== fingerprint) {
        throw new Error(`FLEET_IDEMPOTENCY_KEY_REUSE:${key}`);
      }
      const requestedNodes = new Set(input.nodeIds);
      const restoredNodes = new Set(restored.targetNodeIds);
      if (requestedNodes.size === restoredNodes.size
        && [...requestedNodes].every((nodeId) => restoredNodes.has(nodeId))) {
        return gateFleetTask(this.taskRecords.get(restored.id) ?? restored);
      }
      // Older ledgers may contain a recovered child tagged with the parent's
      // fingerprint. It is a recovery hint, not a result for the whole request.
      this.idempotentTasks.delete(key);
    }
    const pending = this.idempotentDispatches.get(key);
    if (pending !== undefined) {
      if (pending.fingerprint !== fingerprint) {
        throw new Error(`FLEET_IDEMPOTENCY_KEY_REUSE:${key}`);
      }
      return pending.promise;
    }

    const dispatch = (async () => {
      // Recovery may find a running child before other routes finish probing.
      // Hold every requested slot until the complete request is recorded.
      const releaseCapacity = this.reserveHostSlots(input.nodeIds);
      try {
        return await this.dispatchToFleet({
          ...input,
          dispatchFingerprint: fingerprint,
        }, true);
      } finally {
        releaseCapacity();
      }
    })().then((task) => {
      const tagged = {
        ...task,
        idempotencyKey: key,
        dispatchFingerprint: fingerprint,
      };
      this.idempotentTasks.set(key, tagged);
      while (this.idempotentTasks.size > MAX_IDEMPOTENT_TASKS) {
        const oldest = this.idempotentTasks.keys().next().value;
        if (oldest === undefined) break;
        this.idempotentTasks.delete(oldest);
      }
      if (this.taskRecords.get(task.id) !== undefined) {
        this.taskRecords.set(task.id, tagged);
        this.notifyChange();
      }
      return tagged;
    }).finally(() => {
      if (this.idempotentDispatches.get(key)?.promise === dispatch) {
        this.idempotentDispatches.delete(key);
      }
    });
    this.idempotentDispatches.set(key, { fingerprint, promise: dispatch });
    return dispatch;
  }

  private async dispatchToFleet(input: {
    goal: string;
    nodeIds: string[];
    command?: string;
    idempotencyKey?: string;
    dispatchFingerprint?: string;
    executionWorkspace?: { id: string; sourceRevision: string; sourceDigest: string };
    executionMaterialsDigest?: string;
  }, capacityReserved = false): Promise<RuntimeTaskRecord> {
    const requestedNodeIds = [...new Set(input.nodeIds)];
    const selected = this.routes.flatMap((route) => {
      const nodeIds = requestedNodeIds.filter((nodeId) => route.nodeIds.includes(nodeId));
      return nodeIds.length === 0 ? [] : [{ route, nodeIds }];
    });
    const selectedNodeIds = new Set(selected.flatMap((entry) => entry.nodeIds));
    const unknown = requestedNodeIds.filter((nodeId) => !selectedNodeIds.has(nodeId));
    if (unknown.length > 0) throw new Error(`FLEET_NODE_UNKNOWN:${unknown.join(",")}`);
    if (selected.length === 0) throw new Error("FLEET_NODE_REQUIRED");

    const recoveredChildren = new Map<string, RuntimeTaskRecord>();
    const pendingRoutes = new Set(selected.map((_, index) => index));
    if (input.idempotencyKey !== undefined && input.dispatchFingerprint !== undefined) {
      for (const [index, entry] of selected.entries()) {
        if (entry.nodeIds.length !== 1) continue;
        const recovered = await this.recoverDeterministicTask({
          route: entry.route,
          nodeId: entry.nodeIds[0]!,
          idempotencyKey: input.idempotencyKey,
          fingerprint: input.dispatchFingerprint,
        });
        if (recovered !== undefined) {
          recoveredChildren.set(String(index), recovered);
          pendingRoutes.delete(index);
        }
      }
      if (pendingRoutes.size === 0) {
        const children = selected.map((_, index) => recoveredChildren.get(String(index))!);
        const aggregate = selected.length === 1 && selected[0]!.nodeIds.length === 1
          ? children[0]!
          : gateFleetTask(this.combineTasks(
          input.goal,
          children,
          `FLEET-${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32)}`,
        ));
        this.taskRoutes.set(aggregate.id, {
          id: aggregate.id,
          provider: selected[0]!.route.provider,
          children,
        });
        this.taskRecords.set(aggregate.id, aggregate);
        this.bumpTaskVersion(aggregate.id);
        this.notifyChange();
        return aggregate;
      }
    }

    if (selected.length === 1 && selected[0]!.nodeIds.length === 1) {
      const entry = selected[0]!;
      const taskId = input.idempotencyKey === undefined
        ? undefined
        : deterministicTaskId(entry.route, input.idempotencyKey, entry.nodeIds);
      const releaseCapacity = capacityReserved ? () => {} : this.reserveHostSlots(entry.nodeIds);
      try {
        const task = gateCompletedTask(await entry.route.provider.dispatch({
          ...input,
          nodeIds: entry.nodeIds,
          ...(taskId === undefined ? {} : { taskId, dispatchFingerprint: input.dispatchFingerprint }),
        }));
        this.taskRoutes.set(task.id, { id: task.id, provider: entry.route.provider, children: [task] });
        this.taskRecords.set(task.id, task);
        this.bumpTaskVersion(task.id);
        this.notifyChange();
        return task;
      } finally {
        releaseCapacity();
      }
    }

    const dispatchIndices = [...pendingRoutes];
    const releaseCapacity = capacityReserved ? () => {} : this.reserveHostSlots(
      selected.flatMap((entry, index) => pendingRoutes.has(index) ? entry.nodeIds : []),
    );
    try {
      const settled = await Promise.allSettled(dispatchIndices.map(async (index) => {
        const entry = selected[index]!;
        const task = await entry.route.provider.dispatch({
          ...input,
          nodeIds: entry.nodeIds,
          ...(input.idempotencyKey === undefined ? {} : {
            taskId: deterministicTaskId(entry.route, input.idempotencyKey, entry.nodeIds),
            dispatchFingerprint: input.dispatchFingerprint,
          }),
        });
        return { index, task };
      }));
      const settledByIndex = new Map<number, PromiseSettledResult<{ index: number; task: RuntimeTaskRecord }>>();
      settled.forEach((result, resultIndex) => {
        settledByIndex.set(dispatchIndices[resultIndex]!, result);
      });
      const now = new Date().toISOString();
      const children = selected.map((route, index) => {
        const recovered = recoveredChildren.get(String(index));
        if (recovered !== undefined) return recovered;
        const settledResult = settledByIndex.get(index)!;
        if (settledResult.status === "fulfilled") return gateCompletedTask(settledResult.value.task);
        const message = errorMessage(settledResult.reason);
        return {
          id: `FLEET-FAILED-${randomUUID()}`,
          goal: input.goal,
          targetNodeIds: [...route.nodeIds],
          transport: "dsh-fleet" as const,
          status: "failed" as const,
          progress: 0,
          evidence: [],
          expectedEvidence: ["summary" as const],
          createdAt: now,
          updatedAt: now,
          error: message,
        };
      });
      const aggregate = gateFleetTask(
        this.combineTasks(
          input.goal,
          children,
          input.idempotencyKey === undefined
            ? `FLEET-${randomUUID()}`
            : `FLEET-${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32)}`,
        ),
      );
      this.taskRoutes.set(aggregate.id, {
        id: aggregate.id,
        provider: selected[0]!.route.provider,
        children,
      });
      this.taskRecords.set(aggregate.id, aggregate);
      this.bumpTaskVersion(aggregate.id);
      this.notifyChange();
      return aggregate;
    } finally {
      releaseCapacity();
    }
  }

  private async recoverDeterministicTask(input: {
    route: FleetRoute;
    nodeId: string;
    idempotencyKey: string;
    fingerprint: string;
  }): Promise<RuntimeTaskRecord | undefined> {
    if (input.route.provider.inspect === undefined) return undefined;
    const taskId = deterministicTaskId(
      input.route,
      input.idempotencyKey,
      [input.nodeId],
    );
    try {
      const task = await this.inspectWithBudget(input.route.provider, taskId);
      if (task.idempotencyKey !== input.idempotencyKey || task.dispatchFingerprint !== input.fingerprint) {
        throw new Error(`FLEET_IDEMPOTENCY_KEY_REUSE:${input.idempotencyKey}`);
      }
      const tagged: RuntimeTaskRecord = {
        ...task,
        idempotencyKey: input.idempotencyKey,
        dispatchFingerprint: input.fingerprint,
      };
      // Probing a child must not publish a result for its parent's key.
      // The caller commits routing and caches only the complete request.
      return gateFleetTask(tagged);
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes("FLEET_IDEMPOTENCY_KEY_REUSE:")) throw error;
      if (isTaskLookupMiss(error)) return undefined;
      // Any other inspect failure is inconclusive, not a miss. In the
      // crash window (remote job started, ledger write never landed) the
      // job may well exist; dispatching again against the same
      // deterministic id would either hard-fail on the providers'
      // *_JOB_ALREADY_EXISTS guard or, on a lenient provider, execute the
      // command twice. Fail closed with a stable, retryable code and let
      // the caller retry once the provider can be inspected again.
      throw new Error(`FLEET_IDEMPOTENCY_RECOVERY_UNCERTAIN:${taskId}`);
    }
  }

  async listTasks(): Promise<RuntimeTaskRecord[]> {
    try {
      void this.refreshTasks().catch(() => {});
    } catch {
      // Background status refresh must never reject the host request.
    }
    return [...this.taskRecords.values()];
  }

  /**
   * Awaits the remote refresh, then returns the settled task records. The
   * request path uses listTasks() so a slow remote never blocks a page load;
   * the background poller uses this so its diff reflects real transitions.
   */
  async readLiveTasks(): Promise<RuntimeTaskRecord[]> {
    await this.refreshTasks();
    return [...this.taskRecords.values()];
  }

  refreshTasks(): Promise<void> {
    if (this.refreshPromise !== undefined) return this.refreshPromise;
    const round: FleetInspectRoundStats = {
      round: ++this.inspectRoundCount,
      attempts: 0,
      failures: 0,
      peakQueueDepth: 0,
      startedAt: Date.now(),
      durationMs: undefined,
    };
    this.openInspectRound = round;
    this.inspectGlobalBudget.resetPeakWaiting();
    for (const budget of this.inspectProviderBudgets.values()) budget.resetPeakWaiting();
    const refresh = this.performRefresh(++this.healthGeneration);
    this.refreshPromise = refresh;
    const settleRound = () => {
      if (this.openInspectRound !== round) return;
      round.peakQueueDepth = this.currentPeakQueueDepth();
      round.durationMs = Date.now() - round.startedAt;
      this.lastInspectRound = round;
      this.openInspectRound = undefined;
    };
    void refresh.then(
      () => {
        settleRound();
        if (this.refreshPromise === refresh) this.refreshPromise = undefined;
      },
      () => {
        settleRound();
        if (this.refreshPromise === refresh) this.refreshPromise = undefined;
      },
    );
    return refresh;
  }

  private currentPeakQueueDepth(): number {
    let peak = this.inspectGlobalBudget.peakWaiting;
    for (const budget of this.inspectProviderBudgets.values()) {
      peak = Math.max(peak, budget.peakWaiting);
    }
    return peak;
  }

  /** Snapshot of inspect effort: cumulative totals plus the latest round. */
  inspectStats(): FleetInspectStats {
    const round = this.openInspectRound ?? this.lastInspectRound;
    if (this.openInspectRound !== undefined) {
      this.openInspectRound.peakQueueDepth = Math.max(
        this.openInspectRound.peakQueueDepth,
        this.currentPeakQueueDepth(),
      );
    }
    return {
      totals: { ...this.inspectTotals },
      lastRound: round === undefined ? undefined : { ...round },
    };
  }

  private async performRefresh(generation: number): Promise<void> {
    let changed = false;
    await Promise.all([...this.taskRoutes.values()].map(async (entry) => {
      const current = this.taskRecords.get(entry.id);
      if (
        current === undefined
        || (!["queued", "claimed", "running", "verifying"].includes(current.status)
          && current.evidence.length > 0)
      ) return;
      const expectedVersion = this.taskVersion(entry.id);
      if (entry.children.length === 1 && entry.children[0]!.id === entry.id) {
        if (entry.provider.inspect === undefined) return;
        const previous = current;
        try {
          const inspected = this.mergeInspectedTask(
            previous,
            await this.inspectProvider(entry.provider, previous.id, generation),
          );
          if (this.taskVersion(entry.id) !== expectedVersion) return;
          entry.children[0] = inspected;
          this.taskRecords.set(entry.id, inspected);
          this.bumpTaskVersion(entry.id);
          changed = changed || JSON.stringify(previous) !== JSON.stringify(inspected);
        } catch {
          // Health records the inspect failure; the previous task remains intact.
        }
        return;
      }
      const settled = await Promise.allSettled(entry.children.map(async (child) => {
        if (child.status === "failed" || child.status === "cancelled") return child;
        if (child.status === "completed" && child.evidence.length > 0) return child;
        const route = this.routes.find((candidate) =>
          child.targetNodeIds.some((nodeId) => candidate.nodeIds.includes(nodeId))
        );
        if (route?.provider.inspect === undefined) return child;
        return this.mergeInspectedTask(
          child,
          await this.inspectProvider(route.provider, child.id, generation),
        );
      }));
      const children = settled.map((result, index) =>
        result.status === "fulfilled" ? result.value : entry.children[index]!
      );
      if (this.taskVersion(entry.id) !== expectedVersion) return;
      entry.children = children;
      const aggregate = this.mergeInspectedTask(current,
        this.combineTasks(current.goal, children, current.id, current.createdAt));
      this.taskRecords.set(entry.id, aggregate);
      this.bumpTaskVersion(entry.id);
      changed = changed || JSON.stringify(current) !== JSON.stringify(aggregate);
    }));
    if (changed) this.notifyChange();
  }

  async inspect(taskId: string): Promise<RuntimeTaskRecord> {
    const entry = this.taskRoutes.get(taskId);
    if (entry === undefined) {
      const routes = this.routes.filter((candidate) =>
        candidate.taskPrefixes?.some((prefix) => taskId.startsWith(prefix))
      );
      if (routes.length === 0) throw new Error(`FLEET_TASK_NOT_FOUND:${taskId}`);
      const expectedVersion = this.taskVersion(taskId);
      let lastError: unknown;
      for (const route of routes) {
        if (route.provider.inspect === undefined) continue;
        const generation = ++this.healthGeneration;
        try {
          const task = this.mergeInspectedTask(
            undefined,
            await this.inspectWithBudget(route.provider, taskId),
          );
          this.recordProviderSuccess(route.provider.id, generation);
          if (this.taskVersion(taskId) !== expectedVersion) {
            const current = this.taskRecords.get(taskId);
            if (current !== undefined) return current;
            return task;
          }
          this.taskRecords.set(taskId, task);
          this.taskRoutes.set(taskId, { id: taskId, provider: route.provider, children: [task] });
          this.bumpTaskVersion(taskId);
          this.notifyChange();
          return task;
        } catch (error) {
          lastError = error;
          if (!isTaskLookupMiss(error)) {
            this.recordProviderFailure(
              route.provider.id,
              `TASK_INSPECT_FAILED:${errorMessage(error)}`,
              generation,
            );
          }
        }
      }
      throw lastError ?? new Error(`FLEET_TASK_INSPECT_UNSUPPORTED:${taskId}`);
    }
    if (entry.children.length === 1 && entry.children[0]!.id === entry.id) {
      if (entry.provider.inspect === undefined) {
        const current = entry.children[0]!;
        if (["completed", "failed", "cancelled"].includes(current.status)) return current;
        throw new Error(`FLEET_TASK_INSPECT_UNSUPPORTED:${taskId}`);
      }
      const expectedVersion = this.taskVersion(taskId);
      const previous = this.taskRecords.get(taskId) ?? entry.children[0]!;
      const task = this.mergeInspectedTask(
        previous,
        await this.inspectProvider(entry.provider, previous.id, ++this.healthGeneration),
      );
      if (this.taskVersion(taskId) !== expectedVersion) {
        return this.taskRecords.get(taskId) ?? previous;
      }
      entry.children[0] = task;
      this.taskRecords.set(taskId, task);
      this.bumpTaskVersion(taskId);
      this.notifyChange();
      return task;
    }
    const expectedVersion = this.taskVersion(taskId);
    const generation = ++this.healthGeneration;
    const settled = await Promise.allSettled(entry.children.map(async (child) => {
      if (child.status === "failed" || child.status === "cancelled") return child;
      if (child.status === "completed" && child.evidence.length > 0) return child;
      const route = this.routes.find((candidate) =>
        child.targetNodeIds.some((nodeId) => candidate.nodeIds.includes(nodeId))
      );
      if (route?.provider.inspect === undefined) return child;
      return this.mergeInspectedTask(
        child,
        await this.inspectProvider(route.provider, child.id, generation),
      );
    }));
    const failures: unknown[] = [];
    const children = settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      failures.push(result.reason);
      return entry.children[index]!;
    });
    if (this.taskVersion(taskId) !== expectedVersion) {
      const current = this.taskRecords.get(taskId);
      if (failures.length > 0) throw failures[0];
      return current ?? this.combineTasks(
        taskId,
        children,
        taskId,
      );
    }
    entry.children = children;
    const current = this.taskRecords.get(taskId);
    const aggregate = this.mergeInspectedTask(current,
      this.combineTasks(current?.goal ?? taskId, children, taskId, current?.createdAt));
    this.taskRecords.set(taskId, aggregate);
    this.bumpTaskVersion(taskId);
    this.notifyChange();
    if (failures.length > 0) throw failures[0];
    return aggregate;
  }

  async doctor(nodeId?: string) {
    const route = nodeId === undefined
      ? this.routes[0]
      : this.routes.find((entry) => entry.nodeIds.includes(nodeId));
    if (route === undefined) throw new Error(nodeId === undefined ? "FLEET_PROVIDER_NOT_CONFIGURED" : `FLEET_NODE_UNKNOWN:${nodeId}`);
    return await route.provider.doctor(nodeId);
  }

  async cancel(taskId: string): Promise<void> {
    const aggregate = this.taskRoutes.get(taskId);
    if (aggregate !== undefined) {
      if (aggregate.children.length === 1 && aggregate.children[0]!.id === aggregate.id) {
        if (["completed", "failed", "cancelled"].includes(aggregate.children[0]!.status)) {
          throw new Error(`FLEET_TASK_ALREADY_TERMINAL:${aggregate.children[0]!.status}`);
        }
        await this.cancelWithProvider(
          aggregate.provider,
          aggregate.children[0]!.id,
          ++this.healthGeneration,
        );
        // A successful cancel must survive an inspect that advanced the
        // version while cancellation was in flight. Preserve a settled result.
        const current = this.taskRecords.get(taskId) ?? aggregate.children[0]!;
        if (["completed", "failed", "cancelled"].includes(current.status)) return;
        const cancelled = {
          ...current,
          status: "cancelled" as const,
          updatedAt: new Date().toISOString(),
        };
        aggregate.children[0] = cancelled;
        this.taskRecords.set(aggregate.id, cancelled);
        this.bumpTaskVersion(taskId);
        this.notifyChange();
        return;
      }
      const generation = ++this.healthGeneration;
      const settled = await Promise.allSettled(aggregate.children.map(async (child) => {
        if (["completed", "failed", "cancelled"].includes(child.status)) return child;
        const route = this.routes.find((entry) => entry.nodeIds.some((nodeId) => child.targetNodeIds.includes(nodeId)));
        if (route === undefined) throw new Error(`FLEET_TASK_ROUTE_NOT_FOUND:${child.id}`);
        await this.cancelWithProvider(route.provider, child.id, generation);
        return {
          ...child,
          status: "cancelled" as const,
          updatedAt: new Date().toISOString(),
        };
      }));
      const failures: unknown[] = [];
      const cancelledChildren = settled.map((result, index) => {
        const current = aggregate.children[index]!;
        if (result.status === "rejected") {
          failures.push(result.reason);
          return current;
        }
        if (result.value.status !== "cancelled"
          || ["completed", "failed", "cancelled"].includes(current.status)) return current;
        return { ...current, status: "cancelled" as const, updatedAt: result.value.updatedAt };
      });
      const cancelledAny = cancelledChildren.some((child, index) =>
        child !== aggregate.children[index]
      );
      if (cancelledAny) {
        aggregate.children = cancelledChildren;
        const current = this.taskRecords.get(aggregate.id);
        const updated = this.mergeInspectedTask(current, this.combineTasks(
          current?.goal ?? aggregate.id,
          cancelledChildren,
          aggregate.id,
          current?.createdAt ?? aggregate.children[0]?.createdAt,
        ));
        this.taskRecords.set(aggregate.id, updated);
        this.bumpTaskVersion(taskId);
        this.notifyChange();
      }
      if (failures.length > 0) throw failures[0];
      return;
    }
    const routes = this.routes.filter((entry) =>
      entry.taskPrefixes?.some((prefix) => taskId.startsWith(prefix))
    );
    if (routes.length === 0) throw new Error(`FLEET_TASK_NOT_FOUND:${taskId}`);
    let lastError: unknown;
    let cancelled = false;
    for (const route of routes) {
      if (route.provider.cancel === undefined) continue;
      const generation = ++this.healthGeneration;
      try {
        await route.provider.cancel(taskId);
        this.recordProviderSuccess(route.provider.id, generation);
        cancelled = true;
        break;
      } catch (error) {
        lastError = error;
        if (!isTaskLookupMiss(error)) {
          this.recordProviderFailure(
            route.provider.id,
            `TASK_CANCEL_FAILED:${errorMessage(error)}`,
            generation,
          );
        }
      }
    }
    if (!cancelled) {
      throw lastError ?? new Error(`FLEET_CANCEL_NOT_SUPPORTED:${taskId}`);
    }
    const current = this.taskRecords.get(taskId);
    if (current !== undefined && !["completed", "failed", "cancelled"].includes(current.status)) {
      const updated = { ...current, status: "cancelled" as const, updatedAt: new Date().toISOString() };
      this.taskRecords.set(taskId, updated);
      const registered = this.taskRoutes.get(taskId);
      if (registered?.children.length === 1 && registered.children[0]!.id === taskId) {
        registered.children[0] = updated;
      }
      this.bumpTaskVersion(taskId);
      this.notifyChange();
    }
  }

  private async cancelWithProvider(
    provider: RoutableFleetProvider,
    taskId: string,
    generation: number,
  ): Promise<void> {
    try {
      if (provider.cancel === undefined) {
        throw new Error(`FLEET_CANCEL_NOT_SUPPORTED:${provider.id}`);
      }
      await provider.cancel(taskId);
      this.recordProviderSuccess(provider.id, generation);
    } catch (error) {
      this.recordProviderFailure(
        provider.id,
        `TASK_CANCEL_FAILED:${errorMessage(error)}`,
        generation,
      );
      throw error;
    }
  }

  private providerInspectBudget(providerId: string): InspectSemaphore {
    let budget = this.inspectProviderBudgets.get(providerId);
    if (budget === undefined) {
      budget = new InspectSemaphore(this.inspectPerProviderLimit);
      this.inspectProviderBudgets.set(providerId, budget);
    }
    return budget;
  }

  // Every provider inspect the router issues goes through this budget,
  // whichever path (refresh, direct inspect, deterministic recovery)
  // requested it. Acquire the per-provider slot before the global one
  // (the order is the same everywhere) so one provider queuing for the
  // global budget holds at most its own cap of slots.
  private async inspectWithBudget(
    provider: RoutableFleetProvider,
    taskId: string,
  ): Promise<RuntimeTaskRecord> {
    // An attempt counts when the inspect is issued to the budget,
    // including the time it spends queued; failures count when the
    // provider inspect itself rejects. There is no router-level
    // inspect timeout, so no timeout counter is fabricated here:
    // provider timeouts surface as failures.
    this.inspectTotals.attempts += 1;
    if (this.openInspectRound !== undefined) this.openInspectRound.attempts += 1;
    const providerBudget = this.providerInspectBudget(provider.id);
    await providerBudget.acquire();
    await this.inspectGlobalBudget.acquire();
    try {
      return await provider.inspect!(taskId);
    } catch (error) {
      this.inspectTotals.failures += 1;
      if (this.openInspectRound !== undefined) this.openInspectRound.failures += 1;
      throw error;
    } finally {
      this.inspectGlobalBudget.release();
      providerBudget.release();
    }
  }

  private async inspectProvider(
    provider: RoutableFleetProvider,
    taskId: string,
    generation: number,
  ): Promise<RuntimeTaskRecord> {
    if (provider.inspect === undefined) {
      throw new Error(`FLEET_TASK_INSPECT_UNSUPPORTED:${taskId}`);
    }
    try {
      const task = await this.inspectWithBudget(provider, taskId);
      this.recordProviderSuccess(provider.id, generation);
      return task;
    } catch (error) {
      this.recordProviderFailure(
        provider.id,
        `TASK_INSPECT_FAILED:${errorMessage(error)}`,
        generation,
      );
      throw error;
    }
  }

  private taskVersion(taskId: string): number {
    return this.taskVersions.get(taskId) ?? 0;
  }

  private bumpTaskVersion(taskId: string): number {
    const version = this.taskVersion(taskId) + 1;
    this.taskVersions.set(taskId, version);
    return version;
  }

  private recordProviderSuccess(providerId: string, generation: number): void {
    const previousSuccess = this.providerSuccessGenerations.get(providerId) ?? 0;
    this.providerSuccessGenerations.set(
      providerId,
      Math.max(previousSuccess, generation),
    );
    const error = this.providerHealthErrors.get(providerId);
    if (error !== undefined && error.generation < generation) {
      this.providerHealthErrors.delete(providerId);
    }
  }

  private recordProviderFailure(
    providerId: string,
    message: string,
    generation: number,
  ): void {
    const newerSuccess = this.providerSuccessGenerations.get(providerId) ?? 0;
    if (generation < newerSuccess) return;
    const existing = this.providerHealthErrors.get(providerId);
    if (existing !== undefined && existing.generation > generation) return;
    this.providerHealthErrors.set(providerId, {
      generation,
      message,
      recordedAt: Date.now(),
    });
  }

  private async awaitPendingRefresh(): Promise<void> {
    const refresh = this.refreshPromise;
    if (refresh === undefined) return;
    try {
      await refresh;
    } catch {
      // The health snapshot still reflects any failure recorded by the round.
    }
  }

  private activeHealthErrors(): Array<{ providerId: string; message: string }> {
    const errors = [...this.providerHealthErrors.entries()].map(([providerId, error]) => ({
      providerId,
      message: error.message,
    }));
    if (this.ledgerDurabilityError !== undefined) {
      errors.push({
        providerId: this.id,
        message: this.ledgerDurabilityError.message,
      });
    }
    return errors;
  }

  private pruneProviderHealthErrors(): void {
    const now = Date.now();
    for (const [providerId, error] of this.providerHealthErrors) {
      if (now - error.recordedAt >= PROVIDER_HEALTH_ERROR_TTL_MS) {
        this.providerHealthErrors.delete(providerId);
      }
    }
  }

  private providerRouteForTask(task: RuntimeTaskRecord): FleetRoute | undefined {
    const targetRoute = this.routes.find((entry) =>
      task.targetNodeIds.some((nodeId) => entry.nodeIds.includes(nodeId))
      || task.childTaskRefs?.some((child) =>
        child.targetNodeIds.some((nodeId) => entry.nodeIds.includes(nodeId))
      ) === true
    );
    if (targetRoute !== undefined) return targetRoute;
    return this.routes.find((entry) =>
      entry.taskPrefixes?.some((prefix) => task.id.startsWith(prefix)) === true
    );
  }

  private mergeInspectedTask(
    previous: RuntimeTaskRecord | undefined,
    inspected: RuntimeTaskRecord,
  ): RuntimeTaskRecord {
    if (previous === undefined) return gateFleetTask(inspected);
    return gateFleetTask({
      ...inspected,
      goal: previous.goal,
      createdAt: previous.createdAt,
      targetNodeIds: previous.targetNodeIds.length === 0
        ? inspected.targetNodeIds
        : [...previous.targetNodeIds],
      ...(previous.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: previous.idempotencyKey }),
      ...(previous.dispatchFingerprint === undefined
        ? {}
        : { dispatchFingerprint: previous.dispatchFingerprint }),
      ...(previous.requestedByBotId === undefined
        ? {}
        : { requestedByBotId: previous.requestedByBotId }),
      ...(previous.dependsOnTaskIds === undefined
        ? {}
        : { dependsOnTaskIds: [...previous.dependsOnTaskIds] }),
    });
  }

  private async loadFleet() {
    if (this.cachedLoad !== undefined && Date.now() - this.cachedLoad.at < 1_000) {
      return this.cachedLoad.results;
    }
    if (this.loading !== undefined) return await this.loading;
    this.loading = Promise.all(this.routes.map(async (route) => {
      try {
        const nodes = await route.provider.listNodes();
        return { route, nodes: nodes.map((node) => this.withHostAccess(node)) };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          route,
          // Keep the node visible. Dropping it would make an unreachable
          // node indistinguishable from one that was never configured, and
          // the fleet total would shrink without explaining why.
          nodes: this.offlineNodesFor(route, reason),
          error: reason,
        };
      }
    })).finally(() => {
      this.loading = undefined;
    });
    try {
      const results = await this.loading;
      this.cachedLoad = { at: Date.now(), results };
      return results;
    } catch (error) {
      throw error;
    }
  }

  /**
   * The route's nodes as they should appear when the provider is unreachable.
   *
   * A provider that can describe its own nodes keeps them with their real
   * identity; otherwise the route's declared node ids are used, so a node is
   * never silently missing from the fleet.
   */
  private offlineNodesFor(route: FleetRoute, reason: string): RuntimeNodeRecord[] {
    const described = route.provider.describeNodes?.() ?? [];
    const known = described.length > 0
      ? described
      : route.nodeIds.map((nodeId) => ({
        id: nodeId,
        externalId: nodeId,
        providerId: route.provider.id,
        name: nodeId,
        platform: "linux" as const,
        roles: ["worker" as const],
        status: "offline" as const,
        transports: [] as RuntimeNodeRecord["transports"],
        capabilities: [] as string[],
        configState: "unknown" as const,
      }));
    return known.map((node): RuntimeNodeRecord => ({
      ...node,
      status: "offline",
      unavailableReason: reason,
    })).map((node) => this.withHostAccess(node));
  }

  private combineTasks(
    goal: string,
    children: RuntimeTaskRecord[],
    id: string,
    createdAt = new Date().toISOString(),
  ): RuntimeTaskRecord {
    const progress = averageProgress(children);
    const failures = children.flatMap((task) => task.error === undefined ? [] : [task.error]);
    return {
      id,
      goal,
      targetNodeIds: children.flatMap((task) => task.targetNodeIds),
      transport: "dsh-fleet",
      status: aggregateStatus(children),
      ...(failures.length === 0 ? {} : { error: failures.join(" | ") }),
      ...(progress === undefined ? {} : { progress }),
      evidence: children.flatMap((task) => task.evidence.map((item) => ({
        ...item,
        label: `[${task.targetNodeIds[0] ?? "node"}] ${item.label}`,
      }))),
      expectedEvidence: [...new Set(children.flatMap((task) => task.expectedEvidence ?? []))],
      childTaskRefs: children.map((task) => ({
        id: task.id,
        targetNodeIds: [...task.targetNodeIds],
        status: task.status,
        ...(task.progress === undefined ? {} : { progress: task.progress }),
      })),
      createdAt,
      updatedAt: new Date().toISOString(),
    };
  }

  private notifyChange(): void {
    if (this.onChange === undefined) return;
    this.ledgerDirtyTasks = [...this.taskRecords.values()];
    this.clearLedgerRetryTimer();
    this.startLedgerWrite(0);
  }

  private startLedgerWrite(attempt: number): void {
    if (this.onChange === undefined || this.ledgerWriteInFlight) return;
    const snapshot = this.ledgerDirtyTasks;
    if (snapshot === undefined) return;
    this.clearLedgerRetryTimer();
    this.ledgerDirtyTasks = undefined;
    this.ledgerWriteInFlight = true;
    const generation = ++this.healthGeneration;
    let write: void | Promise<void>;
    try {
      write = this.onChange(snapshot);
    } catch (error) {
      this.handleLedgerWriteFailure(error, generation, attempt, snapshot);
      return;
    }
    void Promise.resolve(write).then(
      () => {
        this.handleLedgerWriteSuccess(generation);
      },
      (error: unknown) => {
        this.handleLedgerWriteFailure(error, generation, attempt, snapshot);
      },
    );
  }

  private handleLedgerWriteSuccess(generation: number): void {
    this.ledgerWriteInFlight = false;
    this.clearLedgerRetryTimer();
    if (
      this.ledgerDurabilityError === undefined
      || this.ledgerDurabilityError.generation <= generation
    ) {
      this.ledgerDurabilityError = undefined;
    }
    if (this.ledgerDirtyTasks !== undefined) {
      this.startLedgerWrite(0);
    }
  }

  private handleLedgerWriteFailure(
    error: unknown,
    generation: number,
    attempt: number,
    snapshot: RuntimeTaskRecord[],
  ): void {
    this.ledgerWriteInFlight = false;
    const message = `LEDGER_WRITE_FAILED:${errorMessage(error)}`;
    if (
      this.ledgerDurabilityError === undefined
      || this.ledgerDurabilityError.generation <= generation
    ) {
      this.ledgerDurabilityError = { generation, message };
    }
    if (this.ledgerDirtyTasks !== undefined) {
      this.startLedgerWrite(0);
      return;
    }
    this.ledgerDirtyTasks = snapshot;
    if (attempt >= LEDGER_MAX_RETRIES) return;
    const delay = LEDGER_RETRY_BASE_DELAY_MS * (2 ** attempt);
    this.ledgerRetryTimer = setTimeout(() => {
      this.ledgerRetryTimer = undefined;
      this.startLedgerWrite(attempt + 1);
    }, delay);
  }

  private clearLedgerRetryTimer(): void {
    if (this.ledgerRetryTimer === undefined) return;
    clearTimeout(this.ledgerRetryTimer);
    this.ledgerRetryTimer = undefined;
  }
}
