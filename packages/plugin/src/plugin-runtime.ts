import type {
  AgentBusBridgeResult,
  AgentTeamsBridgeResult,
  FleetDispatchInput,
  HuaweiSshProvider,
  RoomBridgeResult,
} from "@dsh-fusion/host";
import { BridgeSchemaMismatchError } from "@dsh-fusion/host";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_ACTION_TIMEOUT_MS = 60_000;
const ROUTE_JSON_FALLBACK = "{\"error\":\"ROUTE_JSON_SERIALIZATION_FAILED\"}";

export type RuntimeNodeRecord = Awaited<ReturnType<HuaweiSshProvider["listNodes"]>>[number];
export type RuntimeTaskRecord = Awaited<ReturnType<HuaweiSshProvider["dispatch"]>>;
export type RuntimeTaskEvidence = Awaited<ReturnType<HuaweiSshProvider["doctor"]>>["evidence"][number];
export type RuntimeProviderHealthStatus = Awaited<ReturnType<HuaweiSshProvider["health"]>>;
export type RuntimeBotRecord = AgentTeamsBridgeResult["bots"][number];
export type RuntimeGroupRecord = AgentTeamsBridgeResult["groups"][number];
export type RuntimeSessionRecord = AgentTeamsBridgeResult["sessions"][number];
export type RuntimeAgentTeamRecord = AgentTeamsBridgeResult["agentTeams"][number];
export type RuntimeAgentFlowRecord = AgentBusBridgeResult["agentFlows"][number];
export type RuntimeRoomRecord = RoomBridgeResult["rooms"][number];

export type RuntimeProviderName = "nodes" | "agentTeams" | "agentBus" | "room" | "huawei";
export type RuntimeProviderErrorCode = "LOAD_FAILED" | "TIMEOUT" | "SCHEMA_MISMATCH";

/**
 * The observed configuration state of each node.
 *
 * `state` is `"current"` when the node runs the desired configuration,
 * `"drift"` when it runs something else, and `"unknown"` when the node has
 * no configuration to compare against.
 */
export interface RuntimeConfigState {
  nodeId: string;
  state: string;
  hash?: string;
}

export interface RuntimeProviderError {
  code: RuntimeProviderErrorCode;
  message: string;
}

export interface RuntimeProviderStatus extends RuntimeProviderHealthStatus {
  error?: RuntimeProviderError;
}

export interface RuntimeProviderStatuses {
  nodes: RuntimeProviderStatus;
  agentTeams: RuntimeProviderStatus;
  agentBus: RuntimeProviderStatus;
  room: RuntimeProviderStatus;
  huawei: RuntimeProviderStatus;
  /**
   * Per-provider entries for the fleet providers.
   *
   * The named keys above are the fixed surfaces the panel knows about. The
   * fleet's own providers (one per configured machine) are reported under
   * their provider id, so a provider that could not be reached is visible
   * instead of only shrinking the fleet.
   */
  [providerId: string]: RuntimeProviderStatus;
}

export type RuntimeNodeLoaderResult = RuntimeNodeRecord[] | { nodes: RuntimeNodeRecord[] };

export interface RuntimeAgentTeamsLoaderResult {
  bots: RuntimeBotRecord[];
  groups: RuntimeGroupRecord[];
  sessions: RuntimeSessionRecord[];
  tasks: RuntimeTaskRecord[];
  agentTeams: RuntimeAgentTeamRecord[];
  /** When this data was actually fetched, when the loader
   * can know it (a bridge round cache hit reports the
   * round's fetch time). The runtime stamps the provider's
   * checkedAt from it instead of the snapshot moment. */
  fetchedAt?: number;
}

export interface RuntimeAgentBusLoaderResult {
  sessions: RuntimeSessionRecord[];
  tasks: RuntimeTaskRecord[];
  agentFlows: RuntimeAgentFlowRecord[];
  /** See RuntimeAgentTeamsLoaderResult.fetchedAt. */
  fetchedAt?: number;
}

export interface RuntimeRoomLoaderResult {
  groups: RuntimeGroupRecord[];
  sessions: RuntimeSessionRecord[];
  rooms: RuntimeRoomRecord[];
  /** See RuntimeAgentTeamsLoaderResult.fetchedAt. */
  fetchedAt?: number;
}

export interface FusionRuntimeLoaders {
  nodes?: () => Promise<RuntimeNodeLoaderResult>;
  agentTeams?: () => Promise<RuntimeAgentTeamsLoaderResult>;
  agentBus?: () => Promise<RuntimeAgentBusLoaderResult>;
  room?: () => Promise<RuntimeRoomLoaderResult>;
  tasks?: () => Promise<RuntimeTaskRecord[]>;
}

export type RuntimeTaskDispatchInput = FleetDispatchInput;

export interface RuntimeNodeDoctorResult {
  node: RuntimeNodeRecord;
  evidence: RuntimeTaskEvidence[];
}

export interface HuaweiRuntimeProvider {
  readonly id: string;
  health(): Promise<RuntimeProviderHealthStatus>;
  dispatch(input: RuntimeTaskDispatchInput): Promise<RuntimeTaskRecord>;
  doctor(nodeId?: string): Promise<RuntimeNodeDoctorResult>;
  inspect?(taskId: string): Promise<RuntimeTaskRecord>;
  cancel?(taskId: string): Promise<void>;
}

export interface FusionRuntimeOptions {
  loaders?: FusionRuntimeLoaders;
  huaweiProvider?: HuaweiRuntimeProvider;
  /**
   * Pre-probed fleet state. When present the runtime reuses it instead of
   * probing every remote node again, so a push-driven client does not turn
   * each refresh into another round of remote commands.
   */
  cachedFleet?: CachedFleetState;
  timeoutMs?: number;
  actionTimeoutMs?: number;
}

export interface CachedFleetState {
  nodes: RuntimeNodeRecord[];
  tasks: RuntimeTaskRecord[];
  huawei: RuntimeProviderStatus;
  nodeProvider?: RuntimeProviderStatus;
  /**
   * The health of each fleet provider, keyed by provider id.
   *
   * The aggregate fleet health cannot say which provider failed. These
   * entries do, so every configured provider has a visible status.
   */
  providerStatuses?: Record<string, RuntimeProviderStatus>;
  /** The observed configuration state of each node that has one. */
  configStates?: RuntimeConfigState[];
}

export interface FusionRuntimeSnapshot {
  nodes: RuntimeNodeRecord[];
  bots: RuntimeBotRecord[];
  groups: RuntimeGroupRecord[];
  sessions: RuntimeSessionRecord[];
  tasks: RuntimeTaskRecord[];
  /** Tasks owned by the local fleet providers, without upstream bridge tasks. */
  fleetTasks: RuntimeTaskRecord[];
  /** Tasks reported by AgentTeams and Agent Bus. */
  bridgeTasks: RuntimeTaskRecord[];
  /** The observed configuration state of each node. */
  config: RuntimeConfigState[];
  agentTeams: RuntimeAgentTeamRecord[];
  agentFlows: RuntimeAgentFlowRecord[];
  rooms: RuntimeRoomRecord[];
  providers: RuntimeProviderStatuses;
}

interface LoadOutcome<T> {
  data: T;
  status: RuntimeProviderStatus;
}

export class FusionRuntimeTimeoutError extends Error {
  readonly code = "TIMEOUT";

  constructor(
    readonly provider: string,
    readonly timeoutMs: number,
  ) {
    super(`${provider} timed out after ${timeoutMs}ms`);
    this.name = "FusionRuntimeTimeoutError";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return "unknown provider error";
  }
}

function notConfigured(provider: RuntimeProviderName): RuntimeProviderStatus {
  return {
    state: "not-configured",
    checkedAt: Date.now(),
    message: `${provider} provider not configured`,
  };
}

function failedStatus(provider: string, error: unknown): RuntimeProviderStatus {
  const message = errorMessage(error);
  // A bridge schema mismatch is an incompatibility signal,
  // not a transport failure: it gets its own code so
  // consumers can tell "upstream changed shape" apart from
  // "upstream unreachable". The class check covers the
  // decoders' own errors; the message prefix covers the
  // same published code after a re-wrap.
  const code: RuntimeProviderErrorCode = error instanceof FusionRuntimeTimeoutError
    ? "TIMEOUT"
    : error instanceof BridgeSchemaMismatchError || message.startsWith("BRIDGE_SCHEMA_MISMATCH:")
      ? "SCHEMA_MISMATCH"
      : "LOAD_FAILED";
  return {
    state: "offline",
    checkedAt: Date.now(),
    message,
    error: { code, message },
  };
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, provider: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new FusionRuntimeTimeoutError(provider, timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function normalizeNodeResult(result: RuntimeNodeLoaderResult): { nodes: RuntimeNodeRecord[] } {
  return Array.isArray(result) ? { nodes: result } : result;
}

async function loadProvider<T>(
  provider: RuntimeProviderName,
  loader: (() => Promise<T>) | undefined,
  empty: T,
  timeoutMs: number,
): Promise<LoadOutcome<T>> {
  if (loader === undefined) {
    return { data: empty, status: notConfigured(provider) };
  }

  try {
    const data = await withTimeout(Promise.resolve().then(loader), timeoutMs, provider);
    const fetchedAt = (data as { fetchedAt?: unknown }).fetchedAt;
    return {
      data,
      status: {
        state: "connected",
        // A loader that knows when its data was fetched (a
        // bridge round served from cache) reports that time:
        // the provider's checkedAt is the data's fetch time,
        // not the moment this snapshot re-served it.
        checkedAt: typeof fetchedAt === "number" && Number.isFinite(fetchedAt)
          ? fetchedAt
          : Date.now(),
      },
    };
  } catch (error) {
    if (
      provider === "agentTeams"
      && error instanceof Error
      && error.message === "NATIVE_AGENT_TEAMS_UNAVAILABLE"
    ) {
      return { data: empty, status: notConfigured(provider) };
    }
    return { data: empty, status: failedStatus(provider, error) };
  }
}

function emptyAgentTeams(): RuntimeAgentTeamsLoaderResult {
  return { bots: [], groups: [], sessions: [], tasks: [], agentTeams: [] };
}

function emptyAgentBus(): RuntimeAgentBusLoaderResult {
  return { sessions: [], tasks: [], agentFlows: [] };
}

function emptyRoom(): RuntimeRoomLoaderResult {
  return { groups: [], sessions: [], rooms: [] };
}

async function loadOptional<T>(
  loader: (() => Promise<T>) | undefined,
  empty: T,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (loader === undefined) return empty;
  try {
    return await withTimeout(Promise.resolve().then(loader), timeoutMs, label);
  } catch {
    return empty;
  }
}

function mergeById<T extends { id: string }>(...collections: ReadonlyArray<readonly T[]>): T[] {
  const merged = new Map<string, T>();
  for (const collection of collections) {
    for (const item of collection) {
      if (!merged.has(item.id)) merged.set(item.id, item);
    }
  }
  return [...merged.values()];
}

export function serializeRouteJson(value: unknown): string {
  try {
    const ancestors = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, nested: unknown) => {
      if (typeof nested === "bigint") return nested.toString();
      if (nested !== null && typeof nested === "object") {
        if (ancestors.has(nested)) return "[Circular]";
        ancestors.add(nested);
      }
      return nested;
    });
    return serialized ?? "null";
  } catch {
    return ROUTE_JSON_FALLBACK;
  }
}

export class FusionRuntime {
  private readonly loaders: FusionRuntimeLoaders;
  private readonly huaweiProvider: HuaweiRuntimeProvider | undefined;
  private readonly cachedFleet: CachedFleetState | undefined;
  private readonly timeoutMs: number;
  private readonly actionTimeoutMs: number;

  constructor(options: FusionRuntimeOptions = {}) {
    this.loaders = options.loaders ?? {};
    this.huaweiProvider = options.huaweiProvider;
    this.cachedFleet = options.cachedFleet;
    this.timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Math.trunc(options.timeoutMs!)
      : DEFAULT_TIMEOUT_MS;
    this.actionTimeoutMs = Number.isFinite(options.actionTimeoutMs) && (options.actionTimeoutMs ?? 0) > 0
      ? Math.trunc(options.actionTimeoutMs!)
      : DEFAULT_ACTION_TIMEOUT_MS;
  }

  async snapshot(): Promise<FusionRuntimeSnapshot> {
    const loadNodes = this.loaders.nodes;
    const nodeLoader = loadNodes === undefined
      ? undefined
      : async () => normalizeNodeResult(await loadNodes());

    const [nodes, teams, bus, rooms, huawei, localTasks] = await Promise.all([
      this.cachedFleet === undefined
        ? loadProvider("nodes", nodeLoader, { nodes: [] }, this.timeoutMs)
        : Promise.resolve({
            data: { nodes: this.cachedFleet.nodes },
            status: this.cachedFleet.nodeProvider ?? {
              state: "connected" as const,
              checkedAt: Date.now(),
            },
          }),
      loadProvider("agentTeams", this.loaders.agentTeams, emptyAgentTeams(), this.timeoutMs),
      loadProvider("agentBus", this.loaders.agentBus, emptyAgentBus(), this.timeoutMs),
      loadProvider("room", this.loaders.room, emptyRoom(), this.timeoutMs),
      this.cachedFleet === undefined
        ? this.loadHuaweiStatus()
        : Promise.resolve(this.cachedFleet.huawei),
      this.cachedFleet === undefined
        ? loadOptional(this.loaders.tasks, [], this.actionTimeoutMs, "tasks")
        : Promise.resolve(this.cachedFleet.tasks),
    ]);

    return {
      nodes: mergeById(nodes.data.nodes),
      bots: mergeById(teams.data.bots),
      groups: mergeById(teams.data.groups, rooms.data.groups),
      sessions: mergeById(teams.data.sessions, bus.data.sessions, rooms.data.sessions),
      tasks: mergeById(teams.data.tasks, bus.data.tasks, localTasks),
      fleetTasks: localTasks,
      bridgeTasks: mergeById(teams.data.tasks, bus.data.tasks),
      config: this.cachedFleet?.configStates ?? [],
      agentTeams: mergeById(teams.data.agentTeams),
      agentFlows: mergeById(bus.data.agentFlows),
      rooms: mergeById(rooms.data.rooms),
      providers: {
        nodes: nodes.status,
        agentTeams: teams.status,
        agentBus: bus.status,
        room: rooms.status,
        huawei,
        ...(this.cachedFleet?.providerStatuses ?? {}),
      },
    };
  }

  async dispatchTask(input: RuntimeTaskDispatchInput): Promise<RuntimeTaskRecord> {
    const provider = this.requireHuaweiProvider();
    return await withTimeout(
      Promise.resolve().then(() => provider.dispatch(input)),
      this.actionTimeoutMs,
      "huawei dispatch",
    );
  }

  async doctorNode(nodeId?: string): Promise<RuntimeNodeDoctorResult> {
    const provider = this.requireHuaweiProvider();
    return await withTimeout(
      Promise.resolve().then(() => provider.doctor(nodeId)),
      this.actionTimeoutMs,
      "huawei doctor",
    );
  }

  async cancelTask(taskId: string): Promise<void> {
    const provider = this.requireHuaweiProvider();
    if (provider.cancel === undefined) throw new Error("HUAWEI_CANCEL_NOT_AVAILABLE");
    const normalizedTaskId = taskId.trim();
    if (normalizedTaskId === "") throw new Error("HUAWEI_TASK_ID_REQUIRED");
    await withTimeout(
      Promise.resolve().then(() => provider.cancel!(normalizedTaskId)),
      this.actionTimeoutMs,
      "huawei cancel",
    );
  }

  async inspectTask(taskId: string): Promise<RuntimeTaskRecord> {
    const provider = this.requireHuaweiProvider();
    if (provider.inspect === undefined) throw new Error("HUAWEI_TASK_INSPECT_NOT_AVAILABLE");
    const normalizedTaskId = taskId.trim();
    if (normalizedTaskId === "") throw new Error("HUAWEI_TASK_ID_REQUIRED");
    return await withTimeout(
      Promise.resolve().then(() => provider.inspect!(normalizedTaskId)),
      this.actionTimeoutMs,
      "remote task inspect",
    );
  }

  serializeRouteJson(value: unknown): string {
    return serializeRouteJson(value);
  }

  private async loadHuaweiStatus(): Promise<RuntimeProviderStatus> {
    const provider = this.huaweiProvider;
    if (provider === undefined) return notConfigured("huawei");

    try {
      return await withTimeout(
        Promise.resolve().then(() => provider.health()),
        this.timeoutMs,
        "huawei",
      );
    } catch (error) {
      return failedStatus("huawei", error);
    }
  }

  private requireHuaweiProvider(): HuaweiRuntimeProvider {
    if (this.huaweiProvider === undefined) {
      throw new Error("HUAWEI_PROVIDER_NOT_CONFIGURED");
    }
    return this.huaweiProvider;
  }
}

export function createFusionRuntime(options: FusionRuntimeOptions = {}): FusionRuntime {
  return new FusionRuntime(options);
}
