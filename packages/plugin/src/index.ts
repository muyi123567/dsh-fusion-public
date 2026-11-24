import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  FUSION_PLUGIN_VERSION,
  type DshCompatibilityReport,
  type HostAccessPolicy,
} from "@dsh-fusion/core";
import {
  buildFusionDoctorReport,
  createDemoSnapshot,
  createEmptySnapshot,
  DemoStore,
  FusionEventBus,
  FusionStateHub,
  createHuaweiSshRunner,
  createJsonFetcher,
  defaultInstaboxNodeId,
  encodeSseEventFrame,
  encodeSseGapFrame,
  HuaweiSshProvider,
  InstaboxProvider,
  loadFleetNodeConfig,
  loadAgentBusSnapshot,
  loadAgentTeamsSnapshot,
  JsonFetchError,
  loadRoomSessionSnapshot,
  emptyRoomBridgeResult,
  RemoteNodeConfigService,
  SessionHub,
  SessionHubError,
  SshPtyError,
  SshPtyService,
  type FusionDoctorReport,
  type FusionWatchSnapshot,
  type RemoteNodeConfigInput,
  type SessionControllerLike,
  type SessionHubBridgeSource,
  type Ssh2ModuleLike,
  type SshPtyEvent,
  type SshPtyServiceLike,
  type SshPtyTerminal,
} from "@dsh-fusion/host";
import { WebSocketServer, type RawData } from "ws";
import {
  FUSION_DSH_COMPATIBILITY_MATRIX,
  assertDshInstallable,
  readInstalledDshVersion,
  resolveDshCompatibility,
} from "./compatibility.js";
import {
  forwardedWebBaseUrl,
  headerValue,
  isJsonRequest,
  isSameOriginMutation,
  isSameOriginWebSocket,
  loopbackUrlFromHost,
  normalizeCommandAllowlist,
  parseCommandAllowlist,
  rejectUnauthenticated,
  validateTaskGoal,
  webServerBaseUrl,
} from "./auth.js";
import { FleetStateCache, fleetObservability, type FleetObservability } from "./fleet-cache.js";
import {
  normalizeFleetNodeDefinitions,
  type FleetInstaboxNodeDefinition,
  type FleetSshNodeDefinition,
} from "./fleet-node-definitions.js";
import { FleetRouter } from "./fleet-router.js";
import { ReadCounts } from "./read-counts.js";
import { loadNativeAgentTeams } from "./native-agent-teams.js";
import {
  createNativeTaskExecution,
  type NativeExecutionJob,
} from "./native-task-execution.js";
import { createNativeExecutionRoutes } from "./native-execution-routes.js";
import { collectFleetManifest } from "./fleet-environment-collector.js";
import { hostIdFromPublicKey, verifyFleetManifest, type FleetDriftReport } from "./fleet-environment.js";
import { createWhaleFleetService, FleetServiceError } from "./fleet-service.js";
import { createFleetRoutes } from "./fleet-routes.js";
import { buildFleetDoctorReport, type FleetDoctorReport } from "./fleet-doctor.js";
import { createFleetMcpServer } from "./fleet-mcp.js";
import { FleetMcpStore } from "./fleet-mcp-store.js";
import { createFleetDispatchRequests } from "./fleet-dispatch-requests.js";
import { createFleetDispatchRoutes } from "./fleet-dispatch-routes.js";
import type { FleetNotificationEvent } from "./fleet-notifications.js";
import {
  createFleetNotificationService,
  type DshImNotifier,
  type FleetNotificationAdapterConfig,
  type WhaleNotificationServiceV1,
} from "./fleet-notification-adapters.js";
import {
  CloudConnectorRegistry,
  createCloudConnectorService,
  type CloudConnectorInstanceConfig,
  type WhaleConnectorServiceV1,
} from "./cloud-connectors.js";
import { registerBuiltinCloudConnectors } from "./cloud-providers.js";
import { createFleetConnectorRoutes } from "./fleet-connector-routes.js";
import { createFleetNotificationRoutes } from "./fleet-notification-routes.js";
import { FleetTrustStore } from "./fleet-trust.js";
import { createFleetTrustRoutes } from "./fleet-trust-routes.js";
import { createFleetPresetService, type WhalePresetServiceV1 } from "./fleet-presets.js";
import { createFleetBackupService, type WhaleBackupServiceV1 } from "./fleet-backup.js";
import { createFleetPresetRoutes } from "./fleet-preset-routes.js";
import { createFleetBackupRoutes } from "./fleet-backup-routes.js";
import {
  createFleetAlignmentService,
  type AlignmentPluginManager,
  type WhaleAlignmentServiceV1,
} from "./fleet-alignment.js";
import { createFleetAlignmentRoutes } from "./fleet-alignment-routes.js";

export {
  FLEET_CONTRACT_VERSION,
  computeEnvironmentDigest,
  computeSecretPresenceDigest,
  canonicalJson,
  finalizeFleetManifest,
  hostIdFromPublicKey,
  sha256Hex,
  verifyFleetManifest,
} from "./fleet-environment.js";
export type {
  FleetBundle,
  FleetDriftItem,
  FleetDriftReport,
  FleetHostManifest,
  FleetManifestBody,
  FleetMcpServer,
  FleetPatchRef,
  FleetWorkspace,
} from "./fleet-environment.js";
export type {
  FleetHostSummary,
  FleetPanelView,
  WhaleFleetServiceV1,
} from "./fleet-service.js";
export {
  CloudConnectorError,
  CloudConnectorRegistry,
  createCloudConnectorService,
} from "./cloud-connectors.js";
export type {
  CloudConnector,
  CloudConnectorDefinition,
  CloudConnectorEntry,
  CloudConnectorFactory,
  CloudConnectorFactoryContext,
  CloudConnectorField,
  CloudConnectorInstanceConfig,
  CloudConnectorInstanceStatus,
  CloudConnectorSink,
  CloudListInput,
  CloudPullInput,
  CloudPullResult,
  WhaleConnectorServiceV1,
} from "./cloud-connectors.js";
export { registerBuiltinCloudConnectors } from "./cloud-providers.js";
export {
  FleetNotificationRegistry,
  NotificationAdapterError,
  createFleetNotificationService,
  registerBuiltinNotificationAdapters,
} from "./fleet-notification-adapters.js";
export { FleetTrustError, FleetTrustStore } from "./fleet-trust.js";
export type {
  FleetTrustEntry,
  FleetTrustSource,
  FleetTrustVerification,
  FleetTrustVerificationState,
} from "./fleet-trust.js";
export type { FleetTrustReport } from "./fleet-service.js";
export { PresetError, createFleetPresetService } from "./fleet-presets.js";
export type {
  FleetPreset,
  PresetInstallResult,
  PresetKind,
  PresetSkillStatus,
  PresetStatus,
  WhalePresetServiceV1,
} from "./fleet-presets.js";
export { BackupError, createFleetBackupService } from "./fleet-backup.js";
export type {
  BackupFile,
  BackupManifest,
  BackupRestorePlan,
  BackupSource,
  BackupSummary,
  BackupVerifyResult,
  WhaleBackupServiceV1,
} from "./fleet-backup.js";
export {
  AlignmentError,
  createFleetAlignmentService,
} from "./fleet-alignment.js";
export type {
  AlignmentBundle,
  AlignmentPluginManager,
  AlignmentStatus,
  AlignmentStepPlan,
  AlignmentStepResult,
  FleetAlignmentPlan,
  FleetAlignmentRequest,
  WhaleAlignmentServiceV1,
} from "./fleet-alignment.js";
export type {
  DshImNotifier,
  FleetDeliveryReceipt,
  FleetNotificationAdapter,
  FleetNotificationAdapterConfig,
  FleetNotificationAdapterDefinition,
  FleetNotificationAdapterStatus,
  FleetNotificationFactory,
  FleetNotificationFactoryContext,
  WhaleNotificationServiceV1,
} from "./fleet-notification-adapters.js";
import {
  BridgeRoundCache,
  type BridgeRound,
  type BridgeRoundSources,
  type Settled,
} from "./bridge-round-cache.js";
import {
  WRITE_CAPABILITIES_SCHEMA,
  writeCapabilitiesSnapshot,
  type WriteCapabilitiesSnapshot,
} from "./write-capabilities.js";
import { createDispatchPreviewService } from "./dispatch-preview.js";
import { jsonResponse } from "./http.js";
import {
  DEFAULT_PTY_IDLE_TTL_MS,
  MAX_PTY_BUFFERED_BYTES,
  MAX_PTY_MESSAGE_BYTES,
  PTY_AUTH_TIMEOUT_MS,
  PtyCapabilityRegistry,
  chunkPtyOutput,
  encodePtyServerMessage,
  parsePtyClientMessage,
  validatePtyCloseRequest,
  validatePtyCreateRequest,
  type PtyServerMessage,
} from "./pty-protocol.js";
import {
  inspectTaskLedger,
  loadTaskLedger,
  saveTaskLedger,
} from "./task-ledger.js";
import {
  createFusionRuntime,
  type CachedFleetState,
  type FusionRuntimeSnapshot,
  type RuntimeNodeRecord,
  type RuntimeTaskRecord,
} from "./plugin-runtime.js";
import {
  createAgentTeamsWriteGuard,
  createAgentTeamsWriteTools,
  type FusionToolDefinition,
  type FusionToolRegistry,
} from "./upstream-tools.js";
import {
  createAgentBusWriteGuard,
  createAgentBusWriteTools,
} from "./agent-bus-upstream-tools.js";
import {
  createRoomWriteGuard,
  createRoomWriteTools,
} from "./room-upstream-tools.js";

export {
  FUSION_DSH_COMPATIBILITY_MATRIX,
  assertDshInstallable,
  readInstalledDshVersion,
  resolveDshCompatibility,
};

export const inject = ["tools"] as const;

export interface FusionStatus {
  nodes: number;
  onlineNodes: number;
  bots: number;
  tasks: number;
  runningTasks: number;
  driftNodes: number;
  agentTeams: number;
  agentFlows: number;
  rooms: number;
  providers: Array<{ id: string; state: string }>;
  /** Per-action write capability snapshot. The fusion_status
   * tool's output schema requires this field and its execute
   * returns it (validated with `satisfies FusionStatus`), so
   * the public type must carry it — consumers typed against
   * FusionStatus previously could not see a field the
   * runtime always sends. */
  writeCapabilities: WriteCapabilitiesSnapshot;
}

export type {
  WriteActionCapability,
  WriteCapabilitiesSnapshot,
  WriteFamilyCapability,
} from "./write-capabilities.js";

export interface FusionHostContext {
  tools?: FusionToolRegistry;
  get?: (name: string) => unknown;
  connection?: DshConnection;
  on?: (event: string, listener: (...args: unknown[]) => void) => () => void;
  inject?: (
    dependencies: string[],
    callback: (context: FusionHostContext & {
      webServer?: DshWebServer;
      connection?: DshConnection;
    }) => void,
  ) => unknown;
  effect?: (callback: () => () => void, label?: string) => void;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
  /** Cordis service registration; absent on older hosts. */
  provide?: (name: string, value: unknown) => unknown;
}

export interface FusionHostConfig {
  dshVersion?: string;
  webBaseUrl?: string;
  trustedWebHosts?: string[];
  roomSessionId?: string;
  timeoutMs?: number;
  actionTimeoutMs?: number;
  taskLedgerPath?: string;
  /** Opt-in jobs selected by an authenticated browser operator. */
  nativeTaskExecution?: {
    jobs: NativeExecutionJob[];
    /** Ed25519 public keys. Reviewer private keys stay outside the host. */
    reviewerKeys?: Record<string, string>;
    directory?: string;
  };
  /**
   * Read-only fleet environment facts. The directory holds the host identity
   * key, cached remote manifests and the optional expected manifest. No
   * profile or plugin configuration is changed by collection.
   */
  fleetEnvironment?: {
    directory?: string;
    expectedManifestPath?: string;
    trustFile?: string;
    trustMode?: "manual" | "tofu";
    staleAfterSeconds?: number;
    secretNames?: string[];
    displayName?: string;
  };
  /**
   * Local read-only MCP endpoint for DS-Bot bots and external agents. Disabled
   * by default; tokens are stored as SHA-256 only.
   */
  fleetMcp?: {
    enabled?: boolean;
    port?: number;
    tokenFile?: string;
  };
  /** Optional proactive notification adapter; disabled by default. */
  fleetNotifications?: {
    dshIm?: { botId: string; targetId: string; format?: "plain" | "markdown" };
    webhook?: { url: string; secret?: string; secretEnv?: string; timeoutMs?: number };
    directory?: string;
    adapters?: FleetNotificationAdapterConfig[];
  };
  /**
   * Read-only open cloud-drive connectors. Credentials are named by
   * environment variable and never stored in this configuration.
   */
  fleetConnectors?: {
    directory?: string;
    maxBytes?: number;
    connectors?: CloudConnectorInstanceConfig[];
  };
  fleetPresets?: {
    skillsDirectory?: string;
  };
  fleetBackup?: {
    directory?: string;
    retention?: number;
    maxFileBytes?: number;
    auto?: boolean;
    files?: string[];
  };
  modelTaskCommands?: string[];
  /**
   * Enables the three high-privilege AgentTeams write proxies:
   * fusion_team_approve, fusion_team_resume, and fusion_team_send_message.
   *
   * Defaults to off. FUSION_ALLOW_AGENT_TEAM_WRITES=true also enables them.
   */
  allowAgentTeamWrites?: boolean;
  /**
   * Enables the six AgentBus write proxies for send_note, create_flow,
   * create_task, report_task, settle_task, and cancel_task.
   *
   * Defaults to off. FUSION_ALLOW_AGENT_BUS_WRITES=true also enables them.
   * ctx.tools.guard support is required whether or not any write
   * switch is enabled — the guards enforce the disabled state on
   * direct upstream calls — and without it apply fails closed.
   */
  allowAgentBusWrites?: boolean;
  /**
   * Enables the six fixed Agent Team Room write proxies.
   * Defaults to off. FUSION_ALLOW_ROOM_WRITES=true also enables them.
   */
  allowRoomWrites?: boolean;
  /**
   * Whether a model may apply the remote node configuration.
   *
   * This gates the `fusion_config_apply` tool only. The browser route is
   * gated by {@link allowConfigApply}, because the two paths have different
   * trust boundaries: the tool is reachable by the model, the route is
   * reachable by anything holding an authenticated DSH browser session.
   */
  allowModelConfigApply?: boolean;
  /**
   * Whether the browser route may apply the remote node configuration.
   *
   * The route is reachable by any authenticated DSH session, including an
   * agent that drives a browser with the operator's session. An operator who
   * exposes browser control to an agent should turn this off. It defaults to
   * on so the panel keeps working out of the box.
   */
  allowConfigApply?: boolean;
  /**
   * Enables the opt-in remote Huawei PTY. Both FUSION_ALLOW_REMOTE_PTY=true
   * and an explicit config value are accepted; every other value is off.
   */
  allowRemotePty?: boolean;
  /** Test seam for the host PTY service. Production creates SshPtyService. */
  ptyService?: SshPtyServiceLike;
  /** Test seam for one PTY service per configured SSH node. */
  ptyServices?: Record<string, SshPtyServiceLike>;
  /** Test seam for the noServer WebSocket dispatcher. */
  ptyWebSocketServer?: PtyWebSocketServerLike;
  /** Test seam for the bridge round cache: injectable TTL
   * and clock so live-route tests do not depend on the real
   * 2s freshness window. Production uses the defaults. */
  bridgeRoundCache?: { ttlMs?: number; now?: () => number };
  ptyIdleTtlMs?: number;
  ptyAuthTimeoutMs?: number;
  knownIncompatibilities?: Array<{ id: string; message: string }>;
  stateRefreshIntervalMs?: number;
  demo?: boolean;
  huaweiSsh?: {
    host?: string;
    keyPath?: string;
    knownHostsPath?: string;
    sshPath?: string;
    jobRoot?: string;
    outputLimitBytes?: number;
    nodeId?: string;
    name?: string;
  };
  /** Additional SSH workers. Node ids must be unique across provider families. */
  sshNodes?: FleetSshNodeDefinition[];
  instabox?: {
    machineName?: string;
    apiBaseUrl?: string;
    nodeId?: string;
    name?: string;
    timeoutMs?: number;
    jobRoot?: string;
    outputLimitBytes?: number;
  };
  /** Additional Instabox workers using the process INSTABOX_API_KEY by reference. */
  instaboxNodes?: FleetInstaboxNodeDefinition[];
  remoteConfig?: {
    path?: string;
    backupPath?: string;
    fleetConfigPath?: string;
    fleetNodeId?: string;
  };
}

interface DshRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
  on?: (event: string, listener: () => void) => unknown;
}

interface DshResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: string): void;
  write?: (chunk: string) => boolean;
  on?: (event: string, listener: () => void) => unknown;
}

interface DshWebRoute {
  kind: "exact";
  path: string;
  handler: (request: DshRequest, response: DshResponse) => void | Promise<void>;
}

interface DshWebUpgradeRoute {
  path: string;
  handler: (
    request: DshRequest,
    socket: DshUpgradeSocket,
    head: Buffer,
  ) => void | Promise<void>;
}

interface DshUpgradeSocket {
  write(chunk: string): boolean;
  end(chunk: string, callback?: () => void): void;
  destroy(): void;
}

interface DshWebServer {
  readonly host?: string;
  readonly port?: number;
  register(route: DshWebRoute): () => void;
  registerUpgrade?(route: DshWebUpgradeRoute): () => void;
}

interface DshConnection {
  requestRejection(request: {
    headers: Record<string, string | string[] | undefined>;
  }): 401 | 403 | undefined;
}

export interface PtyWebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
}

export interface PtyWebSocketServerLike {
  handleUpgrade(
    request: unknown,
    socket: unknown,
    head: Buffer,
    callback: (webSocket: PtyWebSocketLike) => void,
  ): void;
  close?(): void;
}

function snapshotSources(snapshot: FusionRuntimeSnapshot, demoEnabled: boolean) {
  const collectionSource = (
    count: number,
    providers: Array<FusionRuntimeSnapshot["providers"][keyof FusionRuntimeSnapshot["providers"]]>,
  ) => {
    if (count > 0 || providers.some((provider) => provider.state === "connected" || provider.state === "degraded")) {
      return "live";
    }
    return demoEnabled ? "demo" : "unavailable";
  };
  return {
    nodes: collectionSource(snapshot.nodes.length, [snapshot.providers.nodes]),
    bots: collectionSource(snapshot.bots.length, [snapshot.providers.agentTeams]),
    groups: collectionSource(snapshot.groups.length, [
      snapshot.providers.agentTeams,
      snapshot.providers.room,
    ]),
    sessions: collectionSource(snapshot.sessions.length, [
      snapshot.providers.agentTeams,
      snapshot.providers.agentBus,
      snapshot.providers.room,
    ]),
    tasks: collectionSource(snapshot.tasks.length, [
      snapshot.providers.agentTeams,
      snapshot.providers.agentBus,
    ]),
    agentTeams: snapshot.providers.agentTeams.state === "connected" ? "live" : "unavailable",
    agentFlows: snapshot.providers.agentBus.state === "connected" ? "live" : "unavailable",
    rooms: snapshot.providers.room.state === "connected" ? "live" : "unavailable",
  } as const;
}

function watchSnapshotFrom(snapshot: FusionRuntimeSnapshot): FusionWatchSnapshot {
  return {
    nodes: snapshot.nodes.map((node) => ({
      id: node.id,
      status: node.status,
      configState: node.configState,
    })),
    tasks: snapshot.fleetTasks.map((task) => ({
      id: task.id,
      status: task.status,
      ...(task.progress === undefined ? {} : { progress: task.progress }),
    })),
    bridgeTasks: snapshot.bridgeTasks.map((task) => ({
      id: task.id,
      status: task.status,
      ...(task.progress === undefined ? {} : { progress: task.progress }),
    })),
    config: snapshot.config.map((entry) => ({
      nodeId: entry.nodeId,
      state: entry.state,
      ...(entry.hash === undefined ? {} : { hash: entry.hash }),
    })),
    providers: Object.fromEntries(
      Object.entries(snapshot.providers).map(([providerId, provider]) => [
        providerId,
        { state: provider.state },
      ]),
    ),
    agentTeams: snapshot.agentTeams.map((team) => ({ id: team.id })),
    agentFlows: snapshot.agentFlows.map((flow) => ({ id: flow.id })),
    rooms: snapshot.rooms.map((room) => ({ id: room.id })),
    bots: snapshot.bots.map((bot) => ({
      id: bot.id,
      ...(bot.status === undefined ? {} : { status: bot.status }),
    })),
    groups: snapshot.groups.map((group) => ({ id: group.id })),
    sessions: snapshot.sessions.map((session) => ({
      id: session.id,
      ...(session.status === undefined ? {} : { status: session.status }),
      ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
    })),
  };
}

function sessionHubBridgeSources(
  snapshot: FusionRuntimeSnapshot,
): SessionHubBridgeSource[] {
  const routes: Array<{
    providerKey: "agentTeams" | "agentBus" | "room";
    sourceId: string;
  }> = [
    { providerKey: "agentTeams", sourceId: "agent-teams" },
    { providerKey: "agentBus", sourceId: "agent-bus" },
    { providerKey: "room", sourceId: "agent-room" },
  ];
  const sessionsBySource = new Map<string, FusionRuntimeSnapshot["sessions"]>();
  for (const session of snapshot.sessions) {
    const sessions = sessionsBySource.get(session.providerId) ?? [];
    sessions.push(session);
    sessionsBySource.set(session.providerId, sessions);
  }
  return routes.flatMap(({ providerKey, sourceId }) => {
    const provider = snapshot.providers[providerKey];
    const sessions = sessionsBySource.get(sourceId) ?? [];
    if (provider.state === "not-configured" && sessions.length === 0) return [];
    const state = provider.state === "connected" || provider.state === "degraded"
      ? "available" as const
      : provider.state === "offline"
        ? "failed" as const
        : sessions.length > 0
          ? "available" as const
          : "unavailable" as const;
    return [{
      sourceId,
      state,
      sessions,
      ...(provider.message === undefined ? {} : { error: provider.message }),
    }];
  });
}

function abortSignalForRequest(request: DshRequest): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.on?.("aborted", abort);
  request.on?.("close", abort);
  return controller.signal;
}

function parseMaxMessages(value: string | null): number | undefined {
  if (value === null) return 50;
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 200
    ? parsed
    : undefined;
}

interface FusionDoctorInputs {
  dshCompatibility: DshCompatibilityReport;
  snapshot: FusionRuntimeSnapshot;
  /** Observability of the fleet probe behind this report, when a fleet is configured. */
  fleet?: FleetObservability;
  /** The nodes this deployment is configured to run, for the reachability total. */
  configuredNodeIds?: readonly string[];
  ledger: { readable: boolean; taskCount: number; error?: string };
  remoteConfig?: { ok: boolean; state: string; message?: string; activeHash?: string };
  knownIncompatibilities?: Array<{ id: string; message: string }>;
}

interface NormalizedRemoteConfig {
  ok: boolean;
  state: string;
  message?: string;
  activeHash?: string;
}

export type RemoteConfigMode = "legacy" | "yaml";

export interface ResolvedRemoteConfig {
  mode: RemoteConfigMode;
  input: RemoteNodeConfigInput;
}

export interface ResolveRemoteConfigOptions {
  legacyInput: RemoteNodeConfigInput;
  runtimeNodeId: string;
  remoteConfig: FusionHostConfig["remoteConfig"] | undefined;
  getEnv?: (name: string) => string | undefined;
}

export function resolveRemoteConfig(
  options: ResolveRemoteConfigOptions,
): ResolvedRemoteConfig {
  const fleetConfigPath = options.remoteConfig?.fleetConfigPath
    ?? options.getEnv?.("FUSION_FLEET_CONFIG");
  if (fleetConfigPath === undefined) {
    return { mode: "legacy", input: options.legacyInput };
  }
  const fleetNodeId = options.remoteConfig?.fleetNodeId
    ?? options.getEnv?.("FUSION_FLEET_NODE_ID")
    ?? options.runtimeNodeId;
  return {
    mode: "yaml",
    input: loadFleetNodeConfig(fleetConfigPath, {
      fleetNodeId,
      runtimeNodeId: options.runtimeNodeId,
      displayName: options.legacyInput.displayName,
    }),
  };
}

export interface RemoteConfigOverrideOptions {
  mode: RemoteConfigMode;
  input: RemoteNodeConfigInput;
  runtimeNodeId: string;
  body: Record<string, unknown>;
}

export type RemoteConfigOverrideResult =
  | { ok: true; input: RemoteNodeConfigInput }
  | { ok: false; status: 400; error: string };

function overrideNodeId(
  body: Record<string, unknown>,
  input: RemoteNodeConfigInput,
): string {
  return body.nodeId === undefined ? input.nodeId : String(body.nodeId);
}

export function applyRemoteConfigOverrides(
  options: RemoteConfigOverrideOptions,
): RemoteConfigOverrideResult {
  const { body, input, mode, runtimeNodeId } = options;
  const nodeId = overrideNodeId(body, input);
  if (nodeId !== runtimeNodeId) {
    return {
      ok: false,
      status: 400,
      error: `REMOTE_CONFIG_NODE_ID_MISMATCH:${nodeId}`,
    };
  }

  if (mode === "yaml") {
    const forbidden = Object.keys(body)
      .filter((key) => key !== "nodeId" && key !== "displayName")
      .sort();
    if (forbidden.length > 0) {
      return {
        ok: false,
        status: 400,
        error: `REMOTE_CONFIG_BODY_FIELDS_FORBIDDEN:${forbidden.join(",")}`,
      };
    }
    return {
      ok: true,
      input: {
        ...input,
        ...(body.nodeId === undefined ? {} : { nodeId }),
        ...(body.displayName === undefined
          ? {}
          : { displayName: String(body.displayName) }),
      },
    };
  }

  const capabilities = body.capabilities === undefined
    ? {}
    : Array.isArray(body.capabilities)
      ? { capabilities: body.capabilities.map(String) }
      : input.capabilities === undefined
        ? {}
        : { capabilities: input.capabilities };
  return {
    ok: true,
    input: {
      ...input,
      ...(body.nodeId === undefined ? {} : { nodeId }),
      ...(body.displayName === undefined
        ? {}
        : { displayName: String(body.displayName) }),
      ...(body.dshVersion === undefined
        ? {}
        : { dshVersion: String(body.dshVersion) }),
      ...(body.workspaceRoot === undefined
        ? {}
        : { workspaceRoot: String(body.workspaceRoot) }),
      ...capabilities,
    },
  };
}

async function readRemoteConfigDoctor(
  remoteConfig: RemoteNodeConfigService | undefined,
  remoteConfigInput: RemoteNodeConfigInput,
): Promise<NormalizedRemoteConfig | undefined> {
  if (remoteConfig === undefined) return undefined;
  try {
    const report = await remoteConfig.doctor(remoteConfigInput);
    return {
      ok: report.ok,
      state: report.state,
      ...(report.message === undefined ? {} : { message: report.message }),
      ...(report.activeHash === undefined
        ? {}
        : { activeHash: withHashAlgorithm(report.activeHash) }),
    };
  } catch (error) {
    return {
      ok: false,
      state: "unreachable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildDoctorReport(inputs: FusionDoctorInputs): FusionDoctorReport {
  return buildFusionDoctorReport({
    dshCompatibility: inputs.dshCompatibility,
    ...(inputs.fleet === undefined ? {} : { fleet: inputs.fleet }),
    providers: Object.fromEntries(
      Object.entries(inputs.snapshot.providers).map(([providerId, provider]) => [
        providerId,
        { state: provider.state },
      ]),
    ),
    nodes: inputs.snapshot.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      status: node.status,
      configState: node.configState,
      providerId: node.providerId,
    })),
    ...(inputs.configuredNodeIds === undefined
      ? {}
      : { configuredNodeIds: inputs.configuredNodeIds }),
    tasks: inputs.snapshot.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      targetNodeIds: task.targetNodeIds,
      ...(task.childTaskRefs === undefined ? {} : { childTaskRefs: task.childTaskRefs }),
    })),
    ledger: inputs.ledger,
    ...(inputs.remoteConfig === undefined
      ? {}
      : {
          remoteConfig: {
            state: inputs.remoteConfig.state,
            ok: inputs.remoteConfig.ok,
            ...(inputs.remoteConfig.message === undefined
              ? {}
              : { message: inputs.remoteConfig.message }),
            ...(inputs.remoteConfig.activeHash === undefined
              ? {}
              : { activeHash: inputs.remoteConfig.activeHash }),
          },
        }),
    ...(inputs.knownIncompatibilities === undefined
      ? {}
      : { knownIncompatibilities: inputs.knownIncompatibilities }),
  });
}

const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

function configFromNodes(
  nodes: Array<{ id: string; configState: "current" | "drift" | "unknown" }>,
  observedHash?: string,
) {
  return {
    revision: "live",
    // The hash is the observed one when a remote manifest was compared.
    // "unobserved" is a truthful placeholder, but it is not a revision.
    hash: observedHash ?? "sha256:unobserved",
    pluginVersions: {
      "dsh-fusion": FUSION_PLUGIN_VERSION,
    },
    nodeStates: Object.fromEntries(nodes.map((node) => [node.id, node.configState])),
  };
}

/**
 * The configuration hash is a bare hex digest; the panel labels it with the
 * algorithm, so the prefix is added here to keep one format for both the
 * observed value and the "unobserved" placeholder.
 */
function withHashAlgorithm(hash: string): string {
  return hash.includes(":") ? hash : `sha256:${hash}`;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function modelTaskCommandAllowlist(config: FusionHostConfig): Set<string> {
  const configured = config.modelTaskCommands
    ?? (() => {
      const raw = env("FUSION_MODEL_TASK_COMMANDS");
      if (raw === undefined) return [];
      return parseCommandAllowlist(raw);
    })();
  return new Set(normalizeCommandAllowlist(configured));
}

async function readJsonBody(request: DshRequest): Promise<Record<string, unknown>> {
  if (typeof request[Symbol.asyncIterator] !== "function") {
    throw new Error("REQUEST_BODY_UNAVAILABLE");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.reduce((total, item) => total + item.length, 0) > 64 * 1024) {
      throw new Error("REQUEST_BODY_TOO_LARGE");
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  const value = JSON.parse(raw) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("REQUEST_BODY_INVALID");
  }
  return value as Record<string, unknown>;
}

async function loadSsh2Module(): Promise<Ssh2ModuleLike> {
  const loaded = await import("ssh2") as unknown as {
    Client?: Ssh2ModuleLike["Client"];
    default?: { Client?: Ssh2ModuleLike["Client"] };
  };
  const Client = loaded.Client ?? loaded.default?.Client;
  if (Client === undefined) throw new Error("SSH2_CLIENT_UNAVAILABLE");
  return { Client };
}

function rejectUpgrade(
  socket: DshUpgradeSocket,
  status: 400 | 401 | 403 | 404 | 503,
  error: string,
): void {
  const labels: Record<typeof status, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    503: "Service Unavailable",
  };
  const body = JSON.stringify({ error });
  const response = [
    `HTTP/1.1 ${status} ${labels[status]}`,
    "content-type: application/json; charset=utf-8",
    "cache-control: no-store",
    `content-length: ${Buffer.byteLength(body, "utf8")}`,
    "connection: close",
    "",
    body,
  ].join("\r\n");
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    socket.destroy();
  };
  try {
    socket.end(response, destroy);
  } catch {
    destroy();
    return;
  }
  const timer = setTimeout(destroy, 100);
  timer.unref?.();
}

function ptyHttpStatus(error: SshPtyError): number {
  switch (error.code) {
    case "PTY_DIMENSIONS_INVALID":
      return 400;
    case "PTY_LIMIT_REACHED":
      return 409;
    case "PTY_UNKNOWN_TERMINAL":
      return 404;
    case "PTY_NOT_CONNECTED":
      return 409;
    default:
      return 502;
  }
}

function sendPtyMessage(
  socket: PtyWebSocketLike,
  message: PtyServerMessage,
): boolean {
  if (socket.readyState !== 1) return false;
  const encoded = encodePtyServerMessage(message);
  if (socket.bufferedAmount + Buffer.byteLength(encoded, "utf8") > MAX_PTY_BUFFERED_BYTES) {
    socket.close(1013, "PTY_CLIENT_SLOW");
    return false;
  }
  socket.send(encoded, { binary: false });
  return true;
}

export async function apply(
  ctx: FusionHostContext = {},
  config: FusionHostConfig = {},
): Promise<string | undefined> {
  const installedDshVersion = readInstalledDshVersion();
  const dshCompatibility = resolveDshCompatibility({
    ...(config.dshVersion === undefined ? {} : { configuredVersion: config.dshVersion }),
    ...(process.env.DSH_VERSION === undefined ? {} : { environmentVersion: process.env.DSH_VERSION }),
    ...(installedDshVersion === undefined ? {} : { packageVersion: installedDshVersion }),
  });
  assertDshInstallable(dshCompatibility);
  // Remote manifests need a concrete baseline. Falling back here does not
  // upgrade an unknown or untested host into a verified compatibility claim.
  const version = dshCompatibility.version ?? FUSION_DSH_COMPATIBILITY_MATRIX.recommended;

  const demoEnabled = config.demo === true;
  const store = new DemoStore(demoEnabled ? createDemoSnapshot() : createEmptySnapshot());

  if (typeof ctx.get === "function") {
    if (ctx.tools === undefined) throw new Error("DSH_FUSION_TOOLS_UNAVAILABLE");
    // Every tool registration goes through ctx.tools.register (inside
    // ctx.effect). A registry without a callable register would pass
    // the per-family write checks below and then fail each registration
    // with a bare TypeError — or silently register nothing if the
    // host's effect swallows it — so this prerequisite is checked
    // globally at entry, not per write family.
    if (typeof ctx.tools.register !== "function") {
      throw new Error(
        "DSH_FUSION_TOOL_REGISTER_UNAVAILABLE: apply requires ctx.tools.register",
      );
    }

    const huaweiHost = config.huaweiSsh?.host ?? env("FUSION_HUAWEI_HOST");
    const huaweiKeyPath = config.huaweiSsh?.keyPath ?? env("FUSION_HUAWEI_KEY");
    const huaweiKnownHostsPath = config.huaweiSsh?.knownHostsPath
      ?? env("FUSION_HUAWEI_KNOWN_HOSTS");
    const huaweiNodeId = config.huaweiSsh?.nodeId ?? env("FUSION_HUAWEI_NODE_ID") ?? "huawei-hs-monitor-cn";
    const huaweiName = config.huaweiSsh?.name ?? env("FUSION_HUAWEI_NAME") ?? "华为云 hs-monitor-cn";
    const allowRemotePty = config.allowRemotePty
      ?? (env("FUSION_ALLOW_REMOTE_PTY") === "true");
    const huaweiPartiallyConfigured = [
      huaweiHost,
      huaweiKeyPath,
      huaweiKnownHostsPath,
    ].some((value) => value !== undefined);
    if (
      huaweiPartiallyConfigured
      && (
        huaweiHost === undefined
        || huaweiKeyPath === undefined
        || huaweiKnownHostsPath === undefined
      )
    ) {
      throw new Error("HUAWEI_SSH_CONFIG_REQUIRES_HOST_KEY_AND_KNOWN_HOSTS");
    }
    const ptyServicesByNodeId = new Map<string, SshPtyServiceLike>();
    const ptyServiceByTerminalId = new Map<string, SshPtyServiceLike>();
    const ptyIdleTtlMs = config.ptyIdleTtlMs
      ?? (env("FUSION_REMOTE_PTY_IDLE_TTL_MS") === undefined
        ? DEFAULT_PTY_IDLE_TTL_MS
        : Number(env("FUSION_REMOTE_PTY_IDLE_TTL_MS")));
    const ptyAuthTimeoutMs = config.ptyAuthTimeoutMs
      ?? (env("FUSION_REMOTE_PTY_AUTH_TIMEOUT_MS") === undefined
        ? PTY_AUTH_TIMEOUT_MS
        : Number(env("FUSION_REMOTE_PTY_AUTH_TIMEOUT_MS")));
    if (!Number.isInteger(ptyAuthTimeoutMs) || ptyAuthTimeoutMs < 1 || ptyAuthTimeoutMs > 60_000) {
      throw new Error("FUSION_REMOTE_PTY_AUTH_TIMEOUT_INVALID");
    }
    const ptyCapabilities = new PtyCapabilityRegistry({
      idleTtlMs: ptyIdleTtlMs,
      onIdleExpire: (terminalId) => {
        try {
          ptyServiceByTerminalId.get(terminalId)?.terminate(terminalId);
        } catch {
          // The terminal may already have closed itself.
        }
        ptyServiceByTerminalId.delete(terminalId);
      },
    });
    const legacySshNode: FleetSshNodeDefinition | undefined = huaweiHost !== undefined
      && huaweiKeyPath !== undefined
      && huaweiKnownHostsPath !== undefined
      ? {
          host: huaweiHost,
          keyPath: huaweiKeyPath,
          knownHostsPath: huaweiKnownHostsPath,
          nodeId: huaweiNodeId,
          name: huaweiName,
          ...(config.huaweiSsh?.sshPath === undefined ? {} : { sshPath: config.huaweiSsh.sshPath }),
          ...(config.huaweiSsh?.jobRoot === undefined ? {} : { jobRoot: config.huaweiSsh.jobRoot }),
          ...(config.huaweiSsh?.outputLimitBytes === undefined
            ? {}
            : { outputLimitBytes: config.huaweiSsh.outputLimitBytes }),
          ...(env("FUSION_HUAWEI_JOB_ROOT") === undefined
            ? {}
            : { jobRoot: env("FUSION_HUAWEI_JOB_ROOT")! }),
          ...(env("FUSION_HUAWEI_OUTPUT_LIMIT_BYTES") === undefined
            ? {}
            : { outputLimitBytes: Number(env("FUSION_HUAWEI_OUTPUT_LIMIT_BYTES")) }),
        }
      : undefined;
    const huaweiRunner = huaweiHost !== undefined && huaweiKeyPath !== undefined
      && huaweiKnownHostsPath !== undefined
      ? createHuaweiSshRunner({
          host: huaweiHost,
          keyPath: huaweiKeyPath,
          knownHostsPath: huaweiKnownHostsPath,
          ...(config.huaweiSsh?.sshPath === undefined ? {} : { sshPath: config.huaweiSsh.sshPath }),
        })
      : undefined;
    const instaboxMachineName = config.instabox?.machineName
      ?? env("FUSION_INSTABOX_MACHINE");
    const instaboxApiKey = env("INSTABOX_API_KEY");
    const instaboxNodeId = config.instabox?.nodeId
      ?? (instaboxMachineName === undefined ? "instabox-machine" : defaultInstaboxNodeId(instaboxMachineName));
    if ((config.instaboxNodes?.length ?? 0) > 0 && instaboxApiKey === undefined) {
      throw new Error("INSTABOX_API_KEY_REQUIRED");
    }
    const legacyInstaboxNode: FleetInstaboxNodeDefinition | undefined =
      instaboxMachineName !== undefined && instaboxApiKey !== undefined
        ? {
            machineName: instaboxMachineName,
            nodeId: instaboxNodeId,
            ...(config.instabox?.apiBaseUrl === undefined
              ? {}
              : { apiBaseUrl: config.instabox.apiBaseUrl }),
            ...(config.instabox?.name === undefined ? {} : { name: config.instabox.name }),
            ...(config.instabox?.timeoutMs === undefined
              ? {}
              : { timeoutMs: config.instabox.timeoutMs }),
            ...(config.instabox?.jobRoot === undefined
              ? {}
              : { jobRoot: config.instabox.jobRoot }),
            ...(config.instabox?.outputLimitBytes === undefined
              ? {}
              : { outputLimitBytes: config.instabox.outputLimitBytes }),
            ...(env("FUSION_INSTABOX_JOB_ROOT") === undefined
              ? {}
              : { jobRoot: env("FUSION_INSTABOX_JOB_ROOT")! }),
            ...(env("FUSION_INSTABOX_OUTPUT_LIMIT_BYTES") === undefined
              ? {}
              : { outputLimitBytes: Number(env("FUSION_INSTABOX_OUTPUT_LIMIT_BYTES")) }),
          }
        : undefined;
    const fleetNodeDefinitions = normalizeFleetNodeDefinitions({
      sshNodes: [
        ...(legacySshNode === undefined ? [] : [legacySshNode]),
        ...(config.sshNodes ?? []),
      ],
      instaboxNodes: [
        ...(legacyInstaboxNode === undefined ? [] : [legacyInstaboxNode]),
        ...(config.instaboxNodes ?? []),
      ],
    });
    const hostAccessByNodeId: Record<string, HostAccessPolicy> = {};
    for (const node of [
      ...fleetNodeDefinitions.sshNodes,
      ...fleetNodeDefinitions.instaboxNodes,
    ]) {
      if (node.hostAccess !== undefined) {
        hostAccessByNodeId[node.nodeId] = { ...node.hostAccess };
      }
    }
    if (allowRemotePty) {
      if (config.ptyService !== undefined) {
        ptyServicesByNodeId.set(huaweiNodeId, config.ptyService);
      }
      const primarySshNode = fleetNodeDefinitions.sshNodes[0];
      if (
        primarySshNode !== undefined
        && config.ptyService !== undefined
        && primarySshNode.nodeId !== huaweiNodeId
      ) {
        ptyServicesByNodeId.set(primarySshNode.nodeId, config.ptyService);
      }
      for (const [nodeId, service] of Object.entries(config.ptyServices ?? {})) {
        if (
          nodeId !== huaweiNodeId
          && !fleetNodeDefinitions.sshNodes.some((node) => node.nodeId === nodeId)
        ) {
          throw new Error(`UNKNOWN_PTY_NODE:${nodeId}`);
        }
        ptyServicesByNodeId.set(nodeId, service);
      }
      for (const node of fleetNodeDefinitions.sshNodes) {
        if (ptyServicesByNodeId.has(node.nodeId)) continue;
        ptyServicesByNodeId.set(node.nodeId, new SshPtyService({
          host: node.host,
          keyPath: node.keyPath,
          knownHostsPath: node.knownHostsPath,
          ssh2Factory: loadSsh2Module,
        }));
      }
    }
    const sshProviders = fleetNodeDefinitions.sshNodes.map((node) => ({
      node,
      provider: new HuaweiSshProvider({
        host: node.host,
        keyPath: node.keyPath,
        knownHostsPath: node.knownHostsPath,
        ...(fleetNodeDefinitions.sshNodes.length === 1
          ? {}
          : { providerId: `huawei-ssh:${node.nodeId}` }),
        nodeId: node.nodeId,
        ...(node.name === undefined ? {} : { name: node.name }),
        ...(node.sshPath === undefined ? {} : { sshPath: node.sshPath }),
        ...(node.jobRoot === undefined ? {} : { jobRoot: node.jobRoot }),
        ...(node.outputLimitBytes === undefined
          ? {}
          : { outputLimitBytes: node.outputLimitBytes }),
      }),
    }));
    const instaboxProviders = fleetNodeDefinitions.instaboxNodes.map((node) => ({
      node,
      provider: new InstaboxProvider({
        apiKey: instaboxApiKey!,
        machineName: node.machineName,
        ...(fleetNodeDefinitions.instaboxNodes.length === 1
          ? {}
          : { providerId: `instabox:${node.nodeId}` }),
        nodeId: node.nodeId,
        ...(node.apiBaseUrl === undefined ? {} : { apiBaseUrl: node.apiBaseUrl }),
        ...(node.name === undefined ? {} : { name: node.name }),
        ...(node.timeoutMs === undefined ? {} : { timeoutMs: node.timeoutMs }),
        ...(node.jobRoot === undefined ? {} : { jobRoot: node.jobRoot }),
        ...(node.outputLimitBytes === undefined
          ? {}
          : { outputLimitBytes: node.outputLimitBytes }),
      }),
    }));
    const huaweiProvider = sshProviders[0]?.provider;
    const instaboxProvider = instaboxProviders[0]?.provider;
    const fleetRoutes = [
      ...sshProviders.map(({ node, provider }) => ({
        nodeIds: [node.nodeId],
        provider,
        taskPrefixes: ["HUAWEI-"],
      })),
      ...instaboxProviders.map(({ node, provider }) => ({
        nodeIds: [node.nodeId],
        provider,
        taskPrefixes: ["INSTABOX-"],
      })),
    ];
    const taskLedgerPath = config.taskLedgerPath
      ?? env("FUSION_TASK_LEDGER")
      ?? (env("DSH_HOME") === undefined
        ? undefined
        : resolve(env("DSH_HOME")!, "dsh-fusion-task-ledger.json"));
    const persistedTasks = taskLedgerPath === undefined ? [] : await loadTaskLedger(taskLedgerPath);
    const fleetRouter = fleetRoutes.length === 0
      ? undefined
      : new FleetRouter(fleetRoutes, {
          ...(persistedTasks.length === 0 ? {} : { initialTasks: persistedTasks }),
          ...(Object.keys(hostAccessByNodeId).length === 0
            ? {}
            : { hostAccess: hostAccessByNodeId }),
          ...(taskLedgerPath === undefined
            ? {}
            : {
                onChange: (tasks: RuntimeTaskRecord[]) => saveTaskLedger(taskLedgerPath, tasks),
              }),
        });
    const defaultNodeId = fleetNodeDefinitions.sshNodes[0]?.nodeId
      ?? fleetNodeDefinitions.instaboxNodes[0]?.nodeId
      ?? "";
    let fleetStateCache: FleetStateCache | undefined;
    let fleetProjection:
      | ((fleet: {
          nodes: RuntimeNodeRecord[];
          tasks: RuntimeTaskRecord[];
          huawei: { state: string };
          nodeProvider?: { state: string };
        }) => Partial<FusionWatchSnapshot>)
      | undefined;
    const configuredNodeIds = new Set([
      ...fleetNodeDefinitions.sshNodes.map((node) => node.nodeId),
      ...fleetNodeDefinitions.instaboxNodes.map((node) => node.nodeId),
    ]);
    const executionConfig = config.demo === true ? undefined : config.nativeTaskExecution;
    const executionDirectory = executionConfig?.directory
      ?? (taskLedgerPath === undefined ? undefined : `${taskLedgerPath}.executions`);
    let fleetDoctorProvider: (() => Promise<FleetDoctorReport>) | undefined;
    let fleetEnvironmentGate: ((input: {
      taskId: string; nodeId: string; hostId?: string; requireDigest?: string; policy: "exact" | "compatible";
    }) => Promise<{
      allowed: boolean; hostId?: string; expectedDigest?: string; observedDigest?: string;
      policy: "exact" | "compatible"; matched: boolean; source: "controller-gate";
      items?: Array<{ code: string; severity: "block" | "warn" | "info"; path: string }>; reason?: string;
    }>) | undefined;
    const executionService = executionConfig === undefined || executionDirectory === undefined
      || fleetRouter === undefined ? undefined : createNativeTaskExecution({
        directory: executionDirectory,
        jobs: executionConfig.jobs.filter((job) => job.nodeIds.every((id) => configuredNodeIds.has(id))),
        reviewerKeys: executionConfig.reviewerKeys ?? {},
        readTask: async (taskId) => {
          const controller = ctx.get?.("sessionController") as SessionControllerLike | undefined;
          const board = await loadNativeAgentTeams(controller, config.timeoutMs);
          if (board === undefined) throw new Error("NATIVE_AGENT_TEAMS_UNAVAILABLE");
          return board.tasks.find((task) => task.id === taskId);
        },
        taskIdFor: (nodeId, key) => fleetRouter.executionTaskId(nodeId, key),
        dispatch: async (input) => await createRuntime().dispatchTask(input).finally(() => {
          void refreshFleetNow(true).catch(() => {});
        }),
        inspect: (nodeId, taskId) => fleetRouter.inspectExecution(nodeId, taskId),
        supportsMaterials: (nodeId) => fleetRouter.supportsExecutionMaterials(nodeId),
        verifyMaterials: async (input) => {
          const paths = [
            input.expected.code.path,
            input.expected.input.path,
            input.expected.runtime.path,
            input.expected.config.path,
            ...input.expected.artifacts.map((artifact) => artifact.path),
          ];
          const read = await fleetRouter.readRoutedExecutionMaterialFiles(
            input.nodeId, input.workerTaskId, input.attemptId, paths,
          );
          if (read === undefined || read.workspaceId !== input.attemptId
            || read.sourceRevision !== input.expected.source.revision
            || read.sourceDigest !== input.expected.source.digest) return undefined;
          const byPath = new Map(read.files.map((file) => [file.path, file]));
          const file = (path: string) => byPath.get(path);
          const code = file(input.expected.code.path);
          const inputFile = file(input.expected.input.path);
          const runtime = file(input.expected.runtime.path);
          const config = file(input.expected.config.path);
          if (code === undefined || inputFile === undefined || runtime === undefined || config === undefined) return undefined;
          const artifacts = input.expected.artifacts.map((expected) => {
            const actual = file(expected.path);
            return actual === undefined ? undefined : { path: actual.path, digest: actual.digest, bytes: actual.bytes };
          });
          if (artifacts.some((artifact) => artifact === undefined)) return undefined;
          return {
            version: 1,
            workspace: { id: read.workspaceId, path: read.workspacePath },
            source: { ...input.expected.source },
            code: { path: code.path, digest: code.digest },
            input: { path: inputFile.path, digest: inputFile.digest },
            runtime: { path: runtime.path, digest: runtime.digest, evidence: "measured" as const },
            config: { path: config.path, digest: config.digest },
            artifacts: artifacts as Array<{ path: string; digest: string; bytes: number }>,
          };
        },
        checkEnvironment: async (input) => {
          if (fleetEnvironmentGate === undefined) throw new Error("FLEET_ENVIRONMENT_GATE_UNAVAILABLE");
          return await fleetEnvironmentGate(input);
        },
      });
    const fleetEnvironmentConfig = config.fleetEnvironment;
    const fleetDirectory = fleetEnvironmentConfig?.directory
      ?? env("FUSION_FLEET_DIR")
      ?? join(homedir(), ".dsh-fusion", "fleet");
    const fleetExpectedManifest = fleetEnvironmentConfig?.expectedManifestPath
      ?? env("FUSION_FLEET_EXPECTED_MANIFEST");
    const fleetStaleAfterSeconds = fleetEnvironmentConfig?.staleAfterSeconds
      ?? Number(env("FUSION_FLEET_STALE_SECONDS") ?? "");
    const fleetTrustMode = fleetEnvironmentConfig?.trustMode
      ?? (env("FUSION_FLEET_TRUST_MODE") === "tofu" ? "tofu" : "manual");
    const fleetTrust = new FleetTrustStore({
      path: fleetEnvironmentConfig?.trustFile ?? join(fleetDirectory, "trusted-hosts.json"),
    });
    const readRemotePublicKey = (hostId: string): string | undefined => {
      const candidates = [
        join(fleetDirectory, "hosts", `${hostId}.pub.pem`),
        join(fleetDirectory, "hosts", `${hostId.slice(7)}.pub.pem`),
        join(fleetDirectory, "hosts", `${hostId}.public.pem`),
        join(fleetDirectory, "hosts", `${hostId.slice(7)}.public.pem`),
      ];
      for (const candidate of candidates) {
        try {
          return readFileSync(candidate, "utf8");
        } catch {
          continue;
        }
      }
      return undefined;
    };
    let fleetPublicKeyPem: string | undefined;
    const fleetService = createWhaleFleetService({
      collect: async () => {
        const collected = await collectFleetManifest({
          ctx,
          directory: fleetDirectory,
          ...(fleetEnvironmentConfig?.displayName === undefined ? {} : { displayName: fleetEnvironmentConfig.displayName }),
          ...(fleetEnvironmentConfig?.secretNames === undefined ? {} : { secretNames: fleetEnvironmentConfig.secretNames }),
          ...(Number.isFinite(fleetStaleAfterSeconds) && fleetStaleAfterSeconds > 0
            ? { staleAfterSeconds: fleetStaleAfterSeconds }
            : {}),
          dshVersion: dshCompatibility.version ?? version,
        });
        fleetPublicKeyPem = collected.publicKeyPem;
        return collected.manifest;
      },
      directory: fleetDirectory,
      ...(fleetExpectedManifest === undefined ? {} : { expectedManifestPath: fleetExpectedManifest }),
      ...(Number.isFinite(fleetStaleAfterSeconds) && fleetStaleAfterSeconds > 0
        ? { staleAfterSeconds: fleetStaleAfterSeconds }
        : {}),
      trust: fleetTrust,
      trustMode: fleetTrustMode,
      readPublicKey: readRemotePublicKey,
      verifyManifest: (manifest) => {
        if (fleetPublicKeyPem === undefined) return undefined;
        return manifest.hostId === hostIdFromPublicKey(fleetPublicKeyPem)
          ? verifyFleetManifest(manifest, fleetPublicKeyPem)
          : undefined;
      },
      doctor: async () => {
        if (fleetDoctorProvider === undefined) throw new Error("FLEET_DOCTOR_UNAVAILABLE");
        return await fleetDoctorProvider();
      },
    });
    fleetEnvironmentGate = async (input) => {
      const local = await fleetService.manifest();
      const hostId = input.hostId ?? local.hostId;
      let report: FleetDriftReport;
      try {
        report = await fleetService.diff(hostId, input.requireDigest);
      } catch (error) {
        return {
          allowed: false, hostId, policy: input.policy, matched: false, source: "controller-gate" as const,
          reason: error instanceof FleetServiceError ? error.code : "whale/unavailable",
        };
      }
      const blocked = report.items.some((item) => item.severity === "block");
      const allowed = report.overall === "match"
        || (input.policy === "compatible" && report.overall === "drift" && !blocked);
      return {
        allowed, hostId, policy: input.policy, matched: report.overall === "match",
        source: "controller-gate" as const,
        ...(report.expectedDigest === null ? {} : { expectedDigest: report.expectedDigest }),
        ...(report.observedDigest === null ? {} : { observedDigest: report.observedDigest }),
        ...(report.items.length === 0 ? {} : {
          items: report.items.map((item) => ({ code: item.code, severity: item.severity, path: item.path })),
        }),
        ...(report.reason === undefined ? {} : { reason: report.reason }),
      };
    };
    const connectorRegistry = new CloudConnectorRegistry();
    registerBuiltinCloudConnectors(connectorRegistry);
    const connectorConfig = config.fleetConnectors;
    let whaleConnectorService: WhaleConnectorServiceV1 | undefined;
    try {
      whaleConnectorService = createCloudConnectorService({
        registry: connectorRegistry,
        connectors: connectorConfig?.connectors ?? [],
        importsDirectory: connectorConfig?.directory ?? join(fleetDirectory, "imports"),
        ...(connectorConfig?.maxBytes === undefined ? {} : { maxBytes: connectorConfig.maxBytes }),
      });
    } catch (error) {
      ctx.logger?.warn?.(`dsh-fusion: cloud connectors disabled: ${error instanceof Error ? error.message : String(error)}`);
    }
    let presetService: WhalePresetServiceV1 | undefined;
    try {
      presetService = createFleetPresetService({
        skillsDirectory: config.fleetPresets?.skillsDirectory ?? join(homedir(), ".dsh", "skills"),
      });
    } catch (error) {
      ctx.logger?.warn?.(`dsh-fusion: presets disabled: ${error instanceof Error ? error.message : String(error)}`);
    }
    let backupService: WhaleBackupServiceV1 | undefined;
    try {
      let profileContext: { dir?: string; home?: string } | undefined;
      try {
        profileContext = ctx.get?.("profileContext") as { dir?: string; home?: string } | undefined;
      } catch {
        profileContext = undefined;
      }
      const backupSources: Array<{ label: string; path: string }> = [];
      const addSource = (label: string, path: string | undefined) => {
        if (path !== undefined && path !== "") backupSources.push({ label, path });
      };
      if (profileContext?.dir !== undefined) {
        for (const name of ["package.json", "cordis.yml", "cordis.patch.yml", "pnpm-lock.yaml", "pnpm-workspace.yaml", "compatibility.json"]) {
          addSource("profile", join(profileContext.dir, name));
        }
      }
      if (profileContext?.home !== undefined) addSource("home", join(profileContext.home, "cordis.patch.yml"));
      for (const name of [
        "expected-manifest.json", "fleet.lock.json", "trusted-hosts.json", "mcp.json",
        "dispatch-requests.json", "notification-receipts.json", "alignment-requests.json",
      ]) {
        addSource("fleet", join(fleetDirectory, name));
      }
      for (const path of config.fleetBackup?.files ?? []) addSource("custom", path);
      backupService = createFleetBackupService({
        directory: config.fleetBackup?.directory ?? join(fleetDirectory, "backups"),
        sources: backupSources,
        ...(config.fleetBackup?.retention === undefined ? {} : { retention: config.fleetBackup.retention }),
        ...(config.fleetBackup?.maxFileBytes === undefined ? {} : { maxFileBytes: config.fleetBackup.maxFileBytes }),
      });
      if (config.fleetBackup?.auto === true) {
        let lastBackup = 0;
        if (backupService.list().length === 0) {
          lastBackup = Date.now();
          void backupService.snapshot("startup").catch((error: unknown) => {
            ctx.logger?.warn?.(`dsh-fusion: backup failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        fleetService.subscribe(() => {
          const at = Date.now();
          if (at - lastBackup < 60_000) return;
          lastBackup = at;
          void backupService?.snapshot("manifest-change").catch((error: unknown) => {
            ctx.logger?.warn?.(`dsh-fusion: backup failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        });
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-fusion: backups disabled: ${error instanceof Error ? error.message : String(error)}`);
    }
    let alignmentService: WhaleAlignmentServiceV1 | undefined;
    try {
      alignmentService = createFleetAlignmentService({
        path: join(fleetDirectory, "alignment-requests.json"),
        fleet: fleetService,
        manager: () => {
          try {
            return ctx.get?.("pluginManager") as AlignmentPluginManager | undefined;
          } catch {
            return undefined;
          }
        },
      });
    } catch (error) {
      ctx.logger?.warn?.(`dsh-fusion: alignment disabled: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof ctx.provide === "function") {
      try {
        ctx.provide("whaleFleet", fleetService);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-fusion: whaleFleet service unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (whaleConnectorService !== undefined) {
        try {
          ctx.provide("whaleConnectors", whaleConnectorService);
        } catch (error) {
          ctx.logger?.warn?.(`dsh-fusion: whaleConnectors service unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (presetService !== undefined) {
        try {
          ctx.provide("whalePresets", presetService);
        } catch (error) {
          ctx.logger?.warn?.(`dsh-fusion: whalePresets service unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (backupService !== undefined) {
        try {
          ctx.provide("whaleBackup", backupService);
        } catch (error) {
          ctx.logger?.warn?.(`dsh-fusion: whaleBackup service unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (alignmentService !== undefined) {
        try {
          ctx.provide("whaleAlignment", alignmentService);
        } catch (error) {
          ctx.logger?.warn?.(`dsh-fusion: whaleAlignment service unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else {
      ctx.logger?.info?.("dsh-fusion: host has no ctx.provide; whaleFleet stays local to this plugin");
    }
    const dshImNotification = config.fleetNotifications?.dshIm;
    let dshImService: DshImNotifier | undefined;
    const captureDshIm = (scope: FusionHostContext) => {
      dshImService = ((scope as FusionHostContext & {
        dshIm?: typeof dshImService;
      }).dshIm ?? scope.get?.("dshIm")) as typeof dshImService;
    };
    if (dshImNotification !== undefined) {
      if (typeof ctx.inject === "function") ctx.inject(["dshIm"], (scope) => captureDshIm(scope));
      else captureDshIm(ctx);
    }
    const dshImProxy: DshImNotifier = {
      get sendChecked() { return dshImService?.sendChecked?.bind(dshImService); },
      get send() { return dshImService?.send?.bind(dshImService); },
    };
    const notificationAdapters: FleetNotificationAdapterConfig[] = [];
    if (dshImNotification !== undefined) {
      notificationAdapters.push({
        id: "legacy-dsh-im",
        kind: "dsh-im",
        botId: dshImNotification.botId,
        targetId: dshImNotification.targetId,
        ...(dshImNotification.format === undefined ? {} : { format: dshImNotification.format }),
      });
    }
    if (config.fleetNotifications?.webhook !== undefined) {
      const webhook = config.fleetNotifications.webhook;
      notificationAdapters.push({
        id: "legacy-webhook",
        kind: "webhook",
        url: webhook.url,
        ...(webhook.secret === undefined ? {} : { secret: webhook.secret }),
        ...(webhook.secretEnv === undefined ? {} : { secretEnv: webhook.secretEnv }),
        ...(webhook.timeoutMs === undefined ? {} : { timeoutMs: webhook.timeoutMs }),
      });
    }
    notificationAdapters.push(...(config.fleetNotifications?.adapters ?? []));
    let notificationService: WhaleNotificationServiceV1 | undefined;
    try {
      notificationService = createFleetNotificationService({
        adapters: notificationAdapters,
        dshIm: dshImProxy,
        directory: config.fleetNotifications?.directory ?? join(fleetDirectory, "notification-receipts.json"),
      });
      if (typeof ctx.provide === "function") {
        try {
          ctx.provide("whaleNotifications", notificationService);
        } catch (error) {
          ctx.logger?.warn?.(`dsh-fusion: whaleNotifications service unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-fusion: notifications disabled: ${error instanceof Error ? error.message : String(error)}`);
    }
    const notifyFleet = async (event: FleetNotificationEvent): Promise<void> => {
      if (notificationService === undefined) return;
      const receipts = await notificationService.deliver(event);
      for (const receipt of receipts) {
        if (receipt.status === "failed" || receipt.status === "unknown") {
          ctx.logger?.warn?.(`dsh-fusion: notification ${receipt.adapterId} ${receipt.status} ${receipt.errorCode ?? ""}`.trim());
        }
      }
    };
    const dispatchRequests = executionService === undefined ? undefined : createFleetDispatchRequests({
      path: join(fleetDirectory, "dispatch-requests.json"),
      dispatch: async (input) => await executionService.start(input),
      onEvent: notifyFleet,
    });
    const fleetMcpConfig = config.fleetMcp;
    let fleetMcpStore: FleetMcpStore | undefined;
    try {
      fleetMcpStore = new FleetMcpStore({
        path: fleetMcpConfig?.tokenFile ?? join(fleetDirectory, "mcp.json"),
        defaultPort: fleetMcpConfig?.port ?? 8797,
        enabled: fleetMcpConfig?.enabled === true,
      });
    } catch (error) {
      ctx.logger?.warn?.(`dsh-fusion: fleet MCP disabled: ${error instanceof Error ? error.message : String(error)}`);
    }
    const mcpEnabled = fleetMcpConfig?.enabled ?? fleetMcpStore?.file.enabled ?? false;
    const fleetMcpRuntime = {
      enabled: mcpEnabled,
      listening: false,
      registered: false,
      port: undefined as number | undefined,
      clients: fleetMcpStore?.file.clients.length ?? 0,
      error: undefined as string | undefined,
    };
    if (mcpEnabled && fleetMcpStore !== undefined) {
      const port = fleetMcpConfig?.port ?? fleetMcpStore.file.port;
      if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
        ctx.logger?.warn?.(`dsh-fusion: fleet MCP port invalid: ${String(port)}`);
      } else {
        fleetMcpStore.file.enabled = true;
        fleetMcpStore.file.port = port;
        try {
          fleetMcpStore.save();
          const internalToken = fleetMcpStore.ensureInternalClient();
          const server = createFleetMcpServer({
            service: fleetService,
            store: fleetMcpStore,
            ...(executionService === undefined ? {} : { execution: executionService }),
            ...(dispatchRequests === undefined ? {} : { requests: dispatchRequests }),
            ...(whaleConnectorService === undefined ? {} : { connectors: whaleConnectorService }),
            ...(notificationService === undefined ? {} : { notifications: notificationService }),
            ...(presetService === undefined ? {} : { presets: presetService }),
            ...(backupService === undefined ? {} : { backups: backupService }),
            ...(alignmentService === undefined ? {} : { alignment: alignmentService }),
            version: FUSION_PLUGIN_VERSION,
          });
          const started = await server.start();
          fleetMcpRuntime.listening = true;
          fleetMcpRuntime.port = started.port;
          fleetMcpRuntime.clients = fleetMcpStore.file.clients.length;
          ctx.effect?.(() => () => { void server.stop(); });
          const registerWithManager = (scope: FusionHostContext) => {
            const manager = ((scope as FusionHostContext & {
              mcpManager?: { register?: (name: string, entry: Record<string, unknown>) => (() => void) | undefined };
            }).mcpManager ?? scope.get?.("mcpManager")) as {
              register?: (name: string, entry: Record<string, unknown>) => (() => void) | undefined;
            } | undefined;
            if (typeof manager?.register !== "function") return;
            try {
              const unregister = manager.register("whale-fleet", {
                transport: "streamable-http",
                url: `http://127.0.0.1:${started.port}/mcp`,
                headers: { Authorization: `Bearer ${internalToken}` },
              });
              fleetMcpRuntime.registered = true;
              if (typeof unregister === "function") (scope.effect ?? ctx.effect)?.(() => unregister);
            } catch (error) {
              ctx.logger?.warn?.(`dsh-fusion: MCP manager registration failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          };
          if (typeof ctx.inject === "function") {
            ctx.inject(["mcpManager"], (scope) => registerWithManager(scope));
          } else {
            registerWithManager(ctx);
            if (ctx.get?.("mcpManager") === undefined) {
              ctx.logger?.info?.("dsh-fusion: mcpManager unavailable; fleet MCP is reachable by external clients only");
            }
          }
        } catch (error) {
          fleetMcpRuntime.error = error instanceof Error ? error.message : String(error);
          ctx.logger?.warn?.(`dsh-fusion: fleet MCP failed to start: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    fleetDoctorProvider = async () => {
      const manager = ctx.get?.("pluginManager") as { listBundles?: () => Promise<unknown> } | undefined;
      let bundles: Array<{ name: string; version?: string; enabled: boolean; availability?: string }> = [];
      try {
        const listed = await manager?.listBundles?.();
        if (Array.isArray(listed)) {
          bundles = listed.flatMap((value) => {
            if (value === null || typeof value !== "object") return [];
            const bundle = value as Record<string, unknown>;
            if (typeof bundle.name !== "string" || typeof bundle.enabled !== "boolean") return [];
            return [{
              name: bundle.name,
              enabled: bundle.enabled,
              ...(typeof bundle.version === "string" ? { version: bundle.version } : {}),
              ...(typeof bundle.availability === "string" ? { availability: bundle.availability } : {}),
            }];
          });
        }
      } catch {
        bundles = [];
      }
      let environment: Parameters<typeof buildFleetDoctorReport>[0]["environment"] = { available: false };
      try {
        const manifest = await fleetService.manifest();
        const report = await fleetService.diff(manifest.hostId);
        environment = {
          available: true,
          digest: manifest.environmentDigest,
          signed: manifest.signature.alg === "ed25519",
          report,
        };
      } catch (error) {
        environment = { available: false, error: error instanceof Error ? error.message : String(error) };
      }
      const state = dshCompatibility.state === "verified" || dshCompatibility.state === "unsupported"
        || dshCompatibility.state === "untested" ? dshCompatibility.state : "unknown";
      return buildFleetDoctorReport({
        dsh: { version: dshCompatibility.version ?? version, state },
        environment,
        mcp: {
          enabled: fleetMcpRuntime.enabled,
          listening: fleetMcpRuntime.listening,
          registered: fleetMcpRuntime.registered,
          clients: fleetMcpRuntime.clients,
          ...(fleetMcpRuntime.port === undefined ? {} : { port: fleetMcpRuntime.port }),
          ...(fleetMcpRuntime.error === undefined ? {} : { error: fleetMcpRuntime.error }),
        },
        execution: {
          jobs: executionConfig?.jobs.length ?? 0,
          nodes: fleetNodeDefinitions.sshNodes.length + fleetNodeDefinitions.instaboxNodes.length,
          ledgerConfigured: taskLedgerPath !== undefined,
          directoryConfigured: executionDirectory !== undefined,
        },
        bundles,
      });
    };
    const dispatchPreview = fleetRouter === undefined ? undefined : createDispatchPreviewService({
      configuredNodeIds,
      fleet: {
        // Reuse the authoritative fleet cache instead of adding a new fleet-wide
        // node probe. Capability diagnostics below remain explicitly selected.
        listNodes: async () => {
          const fleet = await readFleetState();
          if (fleet === undefined) throw new Error("PREVIEW_NODES_UNAVAILABLE");
          return fleet.entry.nodes;
        },
        probeExecCapabilities: (nodeIds) => fleetRouter.probeExecCapabilities(nodeIds),
      },
    });
    const resolvedRemoteConfig = resolveRemoteConfig({
      legacyInput: {
        nodeId: huaweiNodeId,
        displayName: huaweiName,
        dshVersion: version,
        workspaceRoot: env("FUSION_REMOTE_WORKSPACE_ROOT") ?? "/srv/projects",
        capabilities: ["linux", "ssh", "monitor", "hindsight", "config"],
      },
      runtimeNodeId: huaweiNodeId,
      remoteConfig: config.remoteConfig,
      getEnv: env,
    });
    const remoteConfigInput = resolvedRemoteConfig.input;
    const remoteConfigMode = resolvedRemoteConfig.mode;
    const remoteConfig = huaweiRunner === undefined
      ? undefined
      : new RemoteNodeConfigService({
          run: huaweiRunner,
          configPath: config.remoteConfig?.path ?? env("FUSION_REMOTE_CONFIG_PATH") ?? "/var/lib/dsh-fusion/node-config.json",
          ...(config.remoteConfig?.backupPath === undefined ? {} : { backupPath: config.remoteConfig.backupPath }),
        });
    const configuredWebBaseUrl = config.webBaseUrl ?? env("FUSION_WEB_BASE_URL");
    const trustedWebHosts = new Set(
      (config.trustedWebHosts ?? env("FUSION_TRUSTED_WEB_HOSTS")?.split(",") ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value !== ""),
    );
    const roomSessionId = config.roomSessionId ?? env("FUSION_ROOM_SESSION_ID");
    const actionTimeoutMs = config.actionTimeoutMs
      ?? Number(env("FUSION_ACTION_TIMEOUT_MS") ?? "");
    const modelTaskCommands = modelTaskCommandAllowlist(config);
    const allowAgentTeamWrites = config.allowAgentTeamWrites === true
      || env("FUSION_ALLOW_AGENT_TEAM_WRITES") === "true";
    const allowAgentBusWrites = config.allowAgentBusWrites === true
      || env("FUSION_ALLOW_AGENT_BUS_WRITES") === "true";
    const allowRoomWrites = config.allowRoomWrites === true
      || env("FUSION_ALLOW_ROOM_WRITES") === "true";
    // Registration prerequisites for the write bridges, checked per
    // family before anything is registered: the guard must exist,
    // and registration itself goes through ctx.effect — without it
    // the tools and guards would be silently skipped while the
    // switches read as enabled. (A missing tools registry already
    // failed at apply entry with DSH_FUSION_TOOLS_UNAVAILABLE; the
    // optional chaining here is belt-and-braces only.)
    if (allowAgentTeamWrites && typeof ctx.tools?.guard !== "function") {
      throw new Error(
        "FUSION_AGENT_TEAM_GUARD_UNAVAILABLE: allowAgentTeamWrites requires ctx.tools.guard",
      );
    }
    if (allowAgentTeamWrites && typeof ctx.effect !== "function") {
      throw new Error(
        "FUSION_AGENT_TEAM_EFFECT_UNAVAILABLE: allowAgentTeamWrites requires ctx.effect",
      );
    }
    if (allowAgentBusWrites && typeof ctx.tools?.guard !== "function") {
      throw new Error(
        "FUSION_AGENT_BUS_GUARD_UNAVAILABLE: allowAgentBusWrites requires ctx.tools.guard",
      );
    }
    if (allowAgentBusWrites && typeof ctx.effect !== "function") {
      throw new Error(
        "FUSION_AGENT_BUS_EFFECT_UNAVAILABLE: allowAgentBusWrites requires ctx.effect",
      );
    }
    if (allowRoomWrites && typeof ctx.tools?.guard !== "function") {
      throw new Error(
        "FUSION_ROOM_GUARD_UNAVAILABLE: allowRoomWrites requires ctx.tools.guard",
      );
    }
    if (allowRoomWrites && typeof ctx.effect !== "function") {
      throw new Error(
        "FUSION_ROOM_EFFECT_UNAVAILABLE: allowRoomWrites requires ctx.effect",
      );
    }
    // The guard surface is an entry-level prerequisite, not only an
    // enabled-family one: the guards also enforce the DISABLED state
    // on direct upstream write calls, so a host without
    // ctx.tools.guard would leave direct upstream writes unguarded
    // exactly when every switch says they must not happen. When a
    // switch is on, the per-family checks above already failed
    // closed with the family's own code; reaching here with no
    // guard means every switch is off, and the load still refuses.
    if (typeof ctx.tools?.guard !== "function") {
      throw new Error(
        "DSH_FUSION_GUARD_UNAVAILABLE: write guards require ctx.tools.guard",
      );
    }
    const allowModelConfigApply = config.allowModelConfigApply === true
      || env("FUSION_ALLOW_MODEL_CONFIG_APPLY") === "true";
    // The route gate is separate from the tool gate. It defaults to on so the
    // panel keeps working, and an operator who exposes browser control to an
    // agent can turn it off with FUSION_ALLOW_CONFIG_APPLY=false.
    const allowConfigApply = env("FUSION_ALLOW_CONFIG_APPLY") !== "false"
      && config.allowConfigApply !== false;

    const stateRefreshIntervalMs = config.stateRefreshIntervalMs
      ?? Number(env("FUSION_STATE_REFRESH_INTERVAL_MS") ?? "");
    const stateHub = new FusionStateHub({
      ...(Number.isFinite(stateRefreshIntervalMs) && stateRefreshIntervalMs > 0
        ? { intervalMs: stateRefreshIntervalMs }
        : {}),
    });
    // Cumulative read fan-out accounting for this apply (review
    // 05 P1-1): routes, bridge loaders, bridge HTTP by path
    // template, and session-controller reads. Surfaced on the
    // state payload; see read-counts.ts.
    const readCounts = new ReadCounts();
    // Whole-round bridge snapshot cache (review 05 P1-1): one
    // settled round of the three bridge loaders, keyed by
    // caller context so different credentials never share a
    // round; see bridge-round-cache.ts.
    const bridgeRounds = new BridgeRoundCache(
      config.bridgeRoundCache?.ttlMs,
      config.bridgeRoundCache?.now,
    );
    const sessionHub = new SessionHub({
      getSessionController: () => {
        const controller = ctx.get?.("sessionController") as SessionControllerLike | undefined;
        if (controller === undefined) return undefined;
        return {
          list: (request, signal) => {
            readCounts.countController("list");
            return controller.list(request, signal);
          },
          projections: (request, signal) => {
            readCounts.countController("projections");
            return controller.projections(request, signal);
          },
          page: (request, signal) => {
            readCounts.countController("page");
            return controller.page(request, signal);
          },
          prompt: (request, signal) => controller.prompt(request, signal),
        };
      },
      ...(ctx.on === undefined
        ? {}
        : { on: (event, listener) => ctx.on!(event, listener) }),
      onChange: (change) => {
        for (const sessionId of change.sessionIds) {
          stateHub.bus.publish({ type: "session.updated", sessionId });
        }
        stateHub.bus.publish({ type: "state.updated", scope: "sessionHub" });
      },
    });

    if (fleetRouter !== undefined) {
      const projectFleet = (fleet: {
        nodes: RuntimeNodeRecord[];
        tasks: RuntimeTaskRecord[];
        huawei: { state: string };
        nodeProvider?: { state: string };
        providerStatuses?: Record<string, { state: string; message?: string }>;
        configStates?: Array<{ nodeId: string; state: string; hash?: string }>;
      }) => ({
        nodes: fleet.nodes.map((node) => ({
          id: node.id,
          status: node.status,
          configState: node.configState,
        })),
        tasks: fleet.tasks.map((task) => ({
          id: task.id,
          status: task.status,
          ...(task.progress === undefined ? {} : { progress: task.progress }),
        })),
        config: (fleet.configStates ?? []).map((entry) => ({
          nodeId: entry.nodeId,
          state: entry.state,
          ...(entry.hash === undefined ? {} : { hash: entry.hash }),
        })),
        providers: {
          nodes: { state: fleet.nodeProvider?.state ?? "connected" },
          huawei: { state: fleet.huawei.state },
          // The per-provider entries let the panel say which provider is
          // down, instead of only reporting a fleet that looks degraded.
          ...Object.fromEntries(Object.entries(fleet.providerStatuses ?? {}).map(
            ([providerId, status]) => [providerId, { state: status.state }],
          )),
        },
      });
      const fleetCache = new FleetStateCache({
        read: async () => {
          let nodeProbeError: string | undefined;
          let taskProbeError: string | undefined;
          let healthProbeError: string | undefined;
          const [nodes, tasks, health, providerStatuses, remoteConfigState] = await Promise.all([
            fleetRouter.listNodes().catch((error: unknown) => {
              nodeProbeError = error instanceof Error ? error.message : String(error);
              return [] as RuntimeNodeRecord[];
            }),
            fleetRouter.readLiveTasks().catch((error: unknown) => {
              taskProbeError = error instanceof Error ? error.message : String(error);
              return [] as RuntimeTaskRecord[];
            }),
            fleetRouter.health().catch((error: unknown) => {
              healthProbeError = error instanceof Error ? error.message : String(error);
              return { state: "offline" as const, checkedAt: Date.now() };
            }),
            fleetRouter.providerHealth().catch(() => ({})),
            readRemoteConfigDoctor(remoteConfig, remoteConfigInput),
          ]);
          // The observed configuration state is part of the same cached probe
          // round, so a panel that asks for state does not pay for another
          // remote command. Only the node the manifest targets has one.
          const configStates = remoteConfigState === undefined
            ? []
            : [{
              nodeId: remoteConfigInput.nodeId,
              state: remoteConfigState.state === "current" || remoteConfigState.state === "drift"
                ? remoteConfigState.state
                : "unknown",
              ...(remoteConfigState.activeHash === undefined
                ? {}
                : { hash: remoteConfigState.activeHash }),
            }];
          // The node record has to carry the observed state too: the panel
          // and the doctor read `node.configState`, and leaving it at
            // "unknown" would hide the drift the probe just found.
          const observedByNode = new Map(configStates.map((entry) => [entry.nodeId, entry]));
          const nodesWithConfig = nodes.map((node) => {
            const observed = observedByNode.get(node.id);
            return observed === undefined
              ? node
              : { ...node, configState: observed.state as RuntimeNodeRecord["configState"] };
          });
          return {
            nodes: nodesWithConfig,
            tasks,
            providerStatuses,
            configStates,
            huawei: {
              state: health.state,
              checkedAt: health.checkedAt,
              ...(healthProbeError === undefined ? {} : { message: healthProbeError }),
            },
            nodeProvider: {
              state: nodeProbeError === undefined ? "connected" : "offline",
              checkedAt: health.checkedAt,
              ...(nodeProbeError === undefined
                ? taskProbeError === undefined
                  ? {}
                  : { message: `task probe failed: ${taskProbeError}` }
                : { message: nodeProbeError }),
            },
          };
        },
        ttlMs: (stateRefreshIntervalMs > 0 ? stateRefreshIntervalMs : 10_000) + 5_000,
      });
      stateHub.onFleetRefresh(async () => {
        const fleet = await fleetCache.refresh();
        return projectFleet(fleet);
      });
      fleetStateCache = fleetCache;
      fleetProjection = projectFleet;
    }

    const readFleetState = async () => {
      if (fleetStateCache === undefined) return undefined;
      // Panel reads must not block on the slowest node's probe round
      // once a snapshot exists; mutations and diagnostics keep using
      // the blocking probeFleetState below. The read keeps its stale
      // flag so state responses can surface data age explicitly.
      return await fleetStateCache.getStaleWhileRevalidate();
    };

    /** Probes the fleet now so a diagnostic reflects the current state. */
    const probeFleetState = async () => {
      if (fleetStateCache === undefined) return undefined;
      return await fleetStateCache.refresh();
    };

    /** Forces a fresh probe so a mutation is visible on the next read. */
    const refreshFleetNow = async (afterAction = false) => {
      if (fleetStateCache === undefined || fleetProjection === undefined) return;
      const fleet = await (afterAction
        ? fleetStateCache.refreshAfterCurrent()
        : fleetStateCache.refresh());
      stateHub.mergeFleetSnapshot(fleetProjection(fleet));
    };

    const createRuntime = (
      headers?: Record<string, string | string[] | undefined>,
      cachedFleet?: CachedFleetState,
      options?: { bypassBridgeCache?: boolean },
    ) => {
      const webBaseUrl = configuredWebBaseUrl
        ?? forwardedWebBaseUrl(headers, trustedWebHosts)
        ?? webServerBaseUrl(ctx.get?.("webServer") as DshWebServer | undefined)
        ?? loopbackUrlFromHost(headerValue(headers, "host"));
      const fetchJson = webBaseUrl === undefined
        ? undefined
        : createJsonFetcher({
            baseUrl: webBaseUrl,
            ...(headers === undefined ? {} : { headers }),
            ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
          });
      const countedFetchJson = fetchJson === undefined
        ? undefined
        : (path: string, init?: Parameters<typeof fetchJson>[1]) => {
            readCounts.countBridgeHttp(path);
            return fetchJson(path, init);
          };
      const controller = ctx.get?.("sessionController") as SessionControllerLike | undefined;
      const nativeController = typeof controller?.list !== "function"
        || typeof controller?.projections !== "function"
        ? undefined
        : {
            list: (request: Record<string, never>, signal: AbortSignal) => {
              readCounts.countController("list");
              return controller.list(request, signal);
            },
            projections: (request: { sessionId: string }, signal: AbortSignal) => {
              readCounts.countController("projections");
              return controller.projections(request, signal);
            },
          };
      const loadTeams = countedFetchJson === undefined && nativeController === undefined
        ? undefined
        : async () => {
            const native = await loadNativeAgentTeams(nativeController, config.timeoutMs);
            if (countedFetchJson === undefined) {
              if (native === undefined) throw new Error("NATIVE_AGENT_TEAMS_UNAVAILABLE");
              return native;
            }
            try {
              const legacy = await loadAgentTeamsSnapshot(countedFetchJson, { failFast: true });
              if (native === undefined) return legacy;
              return {
                bots: [...legacy.bots, ...native.bots],
                groups: [...legacy.groups, ...native.groups],
                sessions: [...legacy.sessions, ...native.sessions],
                tasks: [...legacy.tasks, ...native.tasks],
                agentTeams: [...legacy.agentTeams, ...native.agentTeams],
              };
            } catch (error) {
              // Only an absent optional companion may fall back to the native board.
              if (native !== undefined && error instanceof JsonFetchError && error.status === 404) {
                return native;
              }
              throw error;
            }
          };
      let teamsPromise: ReturnType<NonNullable<typeof loadTeams>> | undefined;
      const getTeams = () => {
        teamsPromise ??= loadTeams!();
        return teamsPromise;
      };
      const loadRooms = countedFetchJson === undefined
        ? undefined
        : async () => {
            let sessionId = roomSessionId;
            if (sessionId === undefined && loadTeams !== undefined) {
              const teams = await getTeams();
              sessionId = teams.agentTeams.find((team) => team.captainSessionId !== "")?.captainSessionId;
            }
            if (sessionId === undefined) return emptyRoomBridgeResult();
            return await loadRoomSessionSnapshot(countedFetchJson, sessionId, { failFast: true });
          };
      // One whole bridge round: the three loaders settled
      // together (Room consumes the Teams result through
      // getTeams, so the round is also the unit that keeps a
      // payload from mixing moments). Each loader below
      // unwraps its own settled source, preserving the
      // runtime's per-source failure semantics exactly.
      const settle = async <T,>(load: () => Promise<T>): Promise<Settled<T>> => {
        try {
          return { ok: true, value: await load() };
        } catch (error) {
          return { ok: false, error };
        }
      };
      const loadBridgeRound = async (): Promise<BridgeRoundSources> => {
        const [agentTeams, agentBus, room] = await Promise.all([
          settle(() => getTeams()),
          settle(() => loadAgentBusSnapshot(countedFetchJson!, { failFast: true })),
          settle(() => loadRooms!()),
        ]);
        return { agentTeams, agentBus, room };
      };
      // Memoized per runtime: the three loaders each ask for
      // the round, but one snapshot must mean one round —
      // in bypass mode nothing else would dedupe them.
      let roundPromise: Promise<BridgeRound> | undefined;
      const bridgeRound = (): Promise<BridgeRound> => {
        if (roundPromise === undefined) {
          roundPromise = (
            options?.bypassBridgeCache === true
            || countedFetchJson === undefined
            || webBaseUrl === undefined
          )
            ? loadBridgeRound().then((round) => ({ ...round, fetchedAt: Date.now() }))
            : bridgeRounds.load(
                bridgeRounds.key({
                  origin: new URL(webBaseUrl).origin,
                  roomSessionId,
                  headers,
                }),
                loadBridgeRound,
              );
        }
        return roundPromise;
      };
      const unwrap = <T,>(settled: Settled<T>): T => {
        if (!settled.ok) throw settled.error;
        return settled.value;
      };
      return createFusionRuntime({
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        ...(Number.isFinite(actionTimeoutMs) && actionTimeoutMs > 0 ? { actionTimeoutMs } : {}),
        ...(fleetRouter === undefined ? {} : { huaweiProvider: fleetRouter }),
        ...(cachedFleet === undefined ? {} : { cachedFleet }),
        loaders: {
          ...(fleetRouter === undefined
            ? {}
            : {
                nodes: () => fleetRouter.listNodes(),
                tasks: () => fleetRouter.listTasks(),
              }),
          ...(countedFetchJson === undefined && loadTeams !== undefined
            ? {
                agentTeams: async () => {
                  readCounts.countLoader("agentTeams");
                  return { ...await getTeams(), fetchedAt: Date.now() };
                },
              }
            : {}),
          ...(countedFetchJson === undefined
            ? {}
            : {
                agentTeams: async () => {
                  readCounts.countLoader("agentTeams");
                  const round = await bridgeRound();
                  return { ...unwrap(round.agentTeams), fetchedAt: round.fetchedAt };
                },
                agentBus: async () => {
                  readCounts.countLoader("agentBus");
                  const round = await bridgeRound();
                  return { ...unwrap(round.agentBus), fetchedAt: round.fetchedAt };
                },
                ...(loadRooms === undefined ? {} : {
                  room: async () => {
                    readCounts.countLoader("room");
                    const round = await bridgeRound();
                    return { ...unwrap(round.room), fetchedAt: round.fetchedAt };
                  },
                }),
              }),
        },
      });
    };

    // Every remaining registration surface — the read-only tools,
    // the fallback web registration, and the state-hub startup —
    // also goes through ctx.effect. The per-family checks above
    // only fire when a write switch is on; without this entry-level
    // prerequisite a host without effect would load the plugin
    // "successfully" with no tools or routes at all, so effect is a
    // hard apply prerequisite from here on. (The inject callback's
    // own context is supplied by the host at inject time and is
    // outside what apply can validate up front.)
    if (typeof ctx.effect !== "function") {
      throw new Error("DSH_FUSION_EFFECT_UNAVAILABLE: apply requires ctx.effect");
    }

    const registerTool = (tool: FusionToolDefinition<any, any>) => {
      ctx.effect?.(() => ctx.tools!.register(tool), `dsh-fusion: ${tool.name}`);
    };
    const registerAgentTeamsWriteGuard = () => {
      ctx.effect?.(
        () => ctx.tools!.guard!(createAgentTeamsWriteGuard(allowAgentTeamWrites)),
        "dsh-fusion: AgentTeams write guard",
      );
    };
    const registerAgentBusWriteGuard = () => {
      ctx.effect?.(
        () => ctx.tools!.guard!(createAgentBusWriteGuard(allowAgentBusWrites)),
        "dsh-fusion: AgentBus write guard",
      );
    };
    const registerRoomWriteGuard = () => {
      ctx.effect?.(
        () => ctx.tools!.guard!(createRoomWriteGuard(allowRoomWrites)),
        "dsh-fusion: Room write guard",
      );
    };

    // All three guards register unconditionally. A guard does
    // not only police Fusion's nested calls — it also enforces
    // the disabled state on the upstream surface itself, so
    // registering it only when writes are enabled would leave
    // direct upstream writes unguarded exactly when the switch
    // says they must not happen (and would make each guard's
    // *_WRITES_DISABLED branch unreachable). The Teams guard
    // covers only the three high-privilege AgentTeams write
    // tools proxied by Fusion; other upstream tools remain
    // outside scope. The guard surface itself is a hard apply
    // prerequisite (checked above with *_GUARD_UNAVAILABLE per
    // enabled family, DSH_FUSION_GUARD_UNAVAILABLE when every
    // switch is off): a host without it does not load, because
    // there is no equivalent protection for direct upstream
    // writes that does not depend on it.
    registerAgentTeamsWriteGuard();
    registerAgentBusWriteGuard();
    registerRoomWriteGuard();

    registerTool({
      name: "fusion_status",
      description: "Read the current DSH Fusion node, bot, task, and configuration status.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            nodes: { type: "number" },
            onlineNodes: { type: "number" },
            bots: { type: "number" },
            tasks: { type: "number" },
            runningTasks: { type: "number" },
            driftNodes: { type: "number" },
            agentTeams: { type: "number" },
            agentFlows: { type: "number" },
            rooms: { type: "number" },
            providers: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  state: { type: "string" },
                },
                required: ["id", "state"],
              },
            },
            writeCapabilities: WRITE_CAPABILITIES_SCHEMA,
          },
          required: [
            "nodes", "onlineNodes", "bots", "tasks", "runningTasks", "driftNodes",
            "agentTeams", "agentFlows", "rooms", "providers", "writeCapabilities",
          ],
        },
        render: (_args, value) => [{
          type: "text",
          text: `nodes=${value.nodes} online=${value.onlineNodes} bots=${value.bots} tasks=${value.tasks} teams=${value.agentTeams} flows=${value.agentFlows} rooms=${value.rooms} providers=${value.providers.map((provider: { id: string; state: string }) => `${provider.id}:${provider.state}`).join(",")}`,
        }],
      },
      async execute() {
        const live = await createRuntime().snapshot();
        return {
          nodes: live.nodes.length,
          onlineNodes: live.nodes.filter((node) => node.status === "online").length,
          bots: live.bots.length,
          tasks: live.tasks.length,
          runningTasks: live.tasks.filter((task) => task.status === "running").length,
          driftNodes: live.nodes.filter((node) => node.configState === "drift").length,
          agentTeams: live.agentTeams.length,
          agentFlows: live.agentFlows.length,
          rooms: live.rooms.length,
          providers: Object.entries(live.providers).map(([id, status]) => ({
            id,
            state: status.state,
          })),
          // Per-action write capability snapshot (review 04
          // P1-3 G6+G8): which bridge write actions are
          // effectively usable right now, and why not.
          writeCapabilities: writeCapabilitiesSnapshot(ctx, {
            agentTeams: allowAgentTeamWrites,
            agentBus: allowAgentBusWrites,
            room: allowRoomWrites,
          }, Date.now()),
        } satisfies FusionStatus;
      },
    });

    registerTool({
      name: "fusion_node_doctor",
      description: "Run a read-only diagnostic on a configured remote node and return evidence.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          nodeId: { type: "string" },
        },
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      execute: async (args) => await createRuntime().doctorNode(
        typeof args.nodeId === "string" ? args.nodeId : undefined,
      ),
    });

    registerTool({
      name: "fusion_doctor",
      description: "Run a read-only health check across the DSH version, providers, nodes, task ledger, and remote configuration.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => {
          const report = value as FusionDoctorReport;
          const failed = report.checks.filter((check) => check.status === "failed");
          const degraded = report.checks.filter((check) => check.status === "degraded");
          const lines = [
            `fusion doctor: ${report.status}`,
            ...report.checks.map((check) => `- [${check.status}] ${check.id}: ${check.message}`),
          ];
          return [{
            type: "text",
            text: `${lines.join("\n")}\nsummary: ok=${report.summary.ok} degraded=${report.summary.degraded} failed=${report.summary.failed}`,
          }];
        },
      },
      execute: async () => {
        // Doctor is a health probe: it must see the bridges as
        // they are now, never a cached round.
        const fleetProbe = await probeFleetState();
        const live = await createRuntime(
          undefined,
          fleetProbe,
          { bypassBridgeCache: true },
        ).snapshot();
        const ledger = await inspectTaskLedger(taskLedgerPath);
        const remoteConfigReport = await readRemoteConfigDoctor(
          remoteConfig,
          remoteConfigInput,
        );
        return buildDoctorReport({
          dshCompatibility,
          snapshot: live,
          ...(fleetProbe === undefined ? {} : {
            fleet: fleetObservability(
              { entry: fleetProbe, stale: false },
              fleetRouter === undefined ? undefined : fleetRouter.inspectStats(),
            ),
          }),
          configuredNodeIds: [...configuredNodeIds],
          ledger,
          ...(remoteConfigReport === undefined
            ? {}
            : {
                remoteConfig: {
                  state: remoteConfigReport.state,
                  ok: remoteConfigReport.ok,
                  ...(remoteConfigReport.message === undefined
                    ? {}
                    : { message: remoteConfigReport.message }),
                  ...(remoteConfigReport.activeHash === undefined
                    ? {}
                    : { activeHash: remoteConfigReport.activeHash }),
                },
              }),
          ...(config.knownIncompatibilities === undefined
            ? {}
            : { knownIncompatibilities: config.knownIncompatibilities }),
        });
      },
    });

    if (modelTaskCommands.size > 0) {
      registerTool({
        name: "fusion_task_dispatch",
        description: "Dispatch an explicitly allowlisted command to a configured remote node and return evidence.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            goal: { type: "string" },
            command: { type: "string", enum: [...modelTaskCommands] },
            nodeId: { type: "string" },
          },
          required: ["goal", "command"],
        },
        output: {
          schema: { type: "object", additionalProperties: true },
          render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
        },
        execute: async (args) => {
          const command = String(args.command).trim();
          if (!modelTaskCommands.has(command)) {
            throw new Error("FUSION_MODEL_TASK_COMMAND_NOT_ALLOWLISTED");
          }
          // The goal is free text chosen by the model. It is stored on the
          // remote job, kept in the task ledger, and rendered in the panel,
          // so it has to be a bounded string rather than whatever the model
          // passed in.
          const goal = validateTaskGoal(args.goal);
          return await createRuntime().dispatchTask({
            goal,
            command,
            nodeIds: [typeof args.nodeId === "string" ? args.nodeId : defaultNodeId],
          }).finally(() => {
            void refreshFleetNow();
          });
        },
      });
    }

    registerTool({
      name: "fusion_task_cancel",
      description: "Cancel a previously dispatched Fusion task by task id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
        },
        required: ["taskId"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            taskId: { type: "string" },
            cancelled: { type: "boolean" },
          },
          required: ["taskId", "cancelled"],
        },
        render: (_args, value) => [{
          type: "text",
          text: `task=${value.taskId} cancelled=${String(value.cancelled)}`,
        }],
      },
      execute: async (args) => {
        const taskId = String(args.taskId).trim();
        await createRuntime().cancelTask(taskId).finally(() => {
          void refreshFleetNow();
        });
        return { taskId, cancelled: true };
      },
    });

    registerTool({
      name: "fusion_task_status",
      description: "Read the latest remote job state and evidence for a Fusion task id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
        },
        required: ["taskId"],
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => [{
          type: "text",
          text: JSON.stringify(value),
        }],
      },
      execute: async (args) => await createRuntime().inspectTask(String(args.taskId)),
    });

    if (allowAgentTeamWrites) {
      for (const tool of createAgentTeamsWriteTools(ctx)) {
        registerTool(tool);
      }
    }

    if (remoteConfig !== undefined) {
      registerTool({
        name: "fusion_config_status",
        description: "Read and validate the Fusion node configuration on the Huawei remote node.",
        parameters: { type: "object", additionalProperties: false, properties: {} },
        output: {
          schema: { type: "object", additionalProperties: true },
          render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
        },
        execute: async () => await remoteConfig.doctor(remoteConfigInput),
      });
      if (allowModelConfigApply && allowConfigApply) {
        registerTool({
          name: "fusion_config_apply",
          description: "Atomically apply the Fusion node configuration on Huawei, with backup and doctor rollback.",
          parameters: { type: "object", additionalProperties: false, properties: {} },
          output: {
            schema: { type: "object", additionalProperties: true },
            render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
          },
          execute: async () => await remoteConfig.apply(remoteConfigInput),
        });
      }
    }

    if (allowAgentBusWrites) {
      for (const tool of createAgentBusWriteTools(ctx)) {
        registerTool(tool);
      }
    }
    if (allowRoomWrites) {
      for (const tool of createRoomWriteTools(ctx)) {
        registerTool(tool);
      }
    }

    // The webServer instance the fallback path already bound. Registering the
    // same path twice on one instance is a hard error in DSH. The injected
    // path does not need this: its child fiber disposes the old routes when
    // the instance changes and re-runs the callback afterwards.
    let fallbackRegisteredWebServer: DshWebServer | undefined;
    // The live event streams this plugin currently holds open. They are
    // tracked so an unload can close them instead of leaving them writing
    // heartbeats into a plugin that no longer exists.
    const connections = new Set<() => void>();
    const ptySockets = new Set<PtyWebSocketLike>();
    const ptyWebSocketServer: PtyWebSocketServerLike = config.ptyWebSocketServer
      ?? new WebSocketServer({
        noServer: true,
        maxPayload: MAX_PTY_MESSAGE_BYTES,
        perMessageDeflate: false,
      }) as unknown as PtyWebSocketServerLike;
    const registerWebSurface = (
      effectScope: FusionHostContext,
      injectedWebServer?: DshWebServer,
      injectedConnection?: DshConnection,
      oncePerServer = false,
    ) => {
      const webServer = injectedWebServer
        ?? ctx.get?.("webServer") as DshWebServer | undefined;
      if (webServer === undefined) return;
      if (oncePerServer) {
        if (fallbackRegisteredWebServer === webServer) return;
        fallbackRegisteredWebServer = webServer;
      }
      const connection = injectedConnection
        ?? ctx.connection
        ?? ctx.get?.("connection") as DshConnection | undefined;
      for (const route of createNativeExecutionRoutes({
        service: executionService,
        authenticate: (request, response) => rejectUnauthenticated(ctx, connection, request, response),
        readBody: readJsonBody,
      })) {
        effectScope.effect?.(() => webServer.register(route), `dsh-fusion: ${route.path}`);
      }
      // The routes are registered on the injected scope, not on the outer
      // plugin scope. `ctx.inject` creates a child fiber, and that fiber is
      // reloaded when the webServer instance changes. Registering on the
      // outer scope would leave the routes bound to the old instance while
      // the new one serves nothing, so the panel would answer 404 with no
      // log at all. DSH's own plugins register the same way.
      effectScope.effect?.(() => webServer.register({
        kind: "exact",
        path: "/plugins/dsh-fusion/state",
        handler: async (request, response) => {
          if (rejectUnauthenticated(ctx, connection, request, response)) return;
          readCounts.countRoute("state");
          try {
            const environmentRead = fleetService.panelView().catch((error: unknown) => ({
              hostId: "unknown",
              displayName: "本机",
              observedAt: new Date().toISOString(),
              digest: "",
              overall: "unknown" as const,
              reason: error instanceof Error ? error.message : String(error),
              stale: true,
              signed: false,
              items: [],
              counts: { block: 0, warn: 0, info: 0 },
            }));
            const fleetRead = await readFleetState();
            const live = await createRuntime(
              request.headers,
              fleetRead?.entry,
            ).snapshot();
            stateHub.mergeLiveSnapshot(watchSnapshotFrom(live));
            sessionHub.setBridgeSources(sessionHubBridgeSources(live));
            const hub = await sessionHub.snapshot(abortSignalForRequest(request));
            const snapshot = store.snapshot();
            const sources = snapshotSources(live, demoEnabled);
            const environment = await environmentRead;
            const nodes = live.nodes.length > 0 || !demoEnabled ? live.nodes : snapshot.nodes;
            const bots = live.bots.length > 0 || !demoEnabled ? live.bots : snapshot.bots;
            const groups = live.groups.length > 0 || !demoEnabled ? live.groups : snapshot.groups;
            const sessions = live.sessions.length > 0 || !demoEnabled ? live.sessions : snapshot.sessions;
            const tasks = live.tasks.length > 0 || !demoEnabled ? live.tasks : snapshot.tasks;
            jsonResponse(response, 200, {
              demo: Object.values(sources).some((source) => source === "demo"),
              sources,
              nodes,
              bots,
              groups,
              sessions,
              tasks,
              agentTeams: live.agentTeams,
              agentFlows: live.agentFlows,
              rooms: live.rooms,
              sessionHub: hub,
              providers: live.providers,
              config: configFromNodes(nodes, live.config[0]?.hash),
              environment,
              // Read fan-out accounting (review 05 P1-1): cumulative
              // route / loader / bridge-HTTP / controller read counts
              // for this plugin apply, including this very request.
              reads: readCounts.snapshot(),
              // Fleet observability: when this payload's fleet data
              // was checked, whether it was served stale, and the
              // router's inspect effort (review 05 P1-2 surfacing).
              ...(fleetRead === undefined ? {} : {
                fleet: fleetObservability(
                  fleetRead,
                  fleetRouter === undefined ? undefined : fleetRouter.inspectStats(),
                ),
              }),
            });
          } catch (error) {
            jsonResponse(response, 503, {
              demo: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }), "dsh-fusion: state route");
      for (const route of createFleetRoutes({
        service: fleetService,
        authenticate: (request, response) => rejectUnauthenticated(ctx, connection, request, response),
        readBody: readJsonBody,
      })) {
        effectScope.effect?.(() => webServer.register(route), `dsh-fusion: ${route.path}`);
      }
      for (const route of createFleetTrustRoutes({
        service: fleetService,
        authenticate: (request, response) => rejectUnauthenticated(ctx, connection, request, response),
        readBody: readJsonBody,
      })) {
        effectScope.effect?.(() => webServer.register(route), `dsh-fusion: ${route.path}`);
      }
      if (presetService !== undefined) {
        for (const route of createFleetPresetRoutes({
          service: presetService,
          authenticate: (request, response) => rejectUnauthenticated(ctx, connection, request, response),
          readBody: readJsonBody,
        })) {
          effectScope.effect?.(() => webServer.register(route), `dsh-fusion: ${route.path}`);
        }
      }
      if (backupService !== undefined) {
        for (const route of createFleetBackupRoutes({
          service: backupService,
          authenticate: (request, response) => rejectUnauthenticated(ctx, connection, request, response),
          readBody: readJsonBody,
        })) {
          effectScope.effect?.(() => webServer.register(route), `dsh-fusion: ${route.path}`);
        }
      }
      if (alignmentService !== undefined) {
        for (const route of createFleetAlignmentRoutes({
          service: alignmentService,
          authenticate: (request, response) => rejectUnauthenticated(ctx, connection, request, response),
          readBody: readJsonBody,
        })) {
          effectScope.effect?.(() => webServer.register(route), `dsh-fusion: ${route.path}`);
        }
      }
      if (whaleConnectorService !== undefined) {
        for (const route of createFleetConnectorRoutes({
          service: whaleConnectorService,
          authenticate: (request, response) => rejectUnauthenticated(ctx, connection, request, response),
          readBody: readJsonBody,
        })) {
          effectScope.effect?.(() => webServer.register(route), `dsh-fusion: ${route.path}`);
        }
      }
      if (notificationService !== undefined) {
        for (const route of createFleetNotificationRoutes({
          service: notificationService,
          authenticate: (request, response) => rejectUnauthenticated(ctx, connection, request, response),
          readBody: readJsonBody,
        })) {
          effectScope.effect?.(() => webServer.register(route), `dsh-fusion: ${route.path}`);
        }
      }
      if (dispatchRequests !== undefined) {
        for (const route of createFleetDispatchRoutes({
          service: dispatchRequests,
          authenticate: (request, response) => rejectUnauthenticated(ctx, connection, request, response),
          readBody: readJsonBody,
        })) {
          effectScope.effect?.(() => webServer.register(route), `dsh-fusion: ${route.path}`);
        }
      }
      effectScope.effect?.(() => webServer.register({
        kind: "exact",
        path: "/plugins/dsh-fusion/session-hub",
        handler: async (request, response) => {
          if (rejectUnauthenticated(ctx, connection, request, response)) return;
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          readCounts.countRoute("sessionHub");
          try {
            const live = await createRuntime(
              request.headers,
              (await readFleetState())?.entry,
            ).snapshot();
            sessionHub.setBridgeSources(sessionHubBridgeSources(live));
          } catch (error) {
            // Session Hub is a read-only compatibility surface. A bridge
            // probe failure must not hide local DSH sessions.
            const message = error instanceof Error ? error.message : String(error);
            sessionHub.setBridgeSources([
              "agent-teams",
              "agent-bus",
              "agent-room",
            ].map((sourceId) => ({
              sourceId,
              state: "failed" as const,
              sessions: [],
              error: message,
            })));
          }
          const signal = abortSignalForRequest(request);
          try {
            jsonResponse(
              response,
              200,
              await sessionHub.snapshot(signal),
            );
          } catch (error) {
            if (signal.aborted) return;
            jsonResponse(response, 500, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }), "dsh-fusion: session hub route");
      effectScope.effect?.(() => webServer.register({
        kind: "exact",
        path: "/plugins/dsh-fusion/session-hub/history",
        handler: async (request, response) => {
          if (rejectUnauthenticated(ctx, connection, request, response)) return;
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          const sourceId = url.searchParams.get("sourceId")?.trim() ?? "";
          const sessionId = url.searchParams.get("sessionId")?.trim() ?? "";
          if (sourceId === "" || sessionId === "") {
            jsonResponse(response, 400, {
              error: "sourceId and sessionId are required",
            });
            return;
          }
          const rawMaxMessages = url.searchParams.get("maxMessages");
          const maxMessages = parseMaxMessages(rawMaxMessages);
          if (maxMessages === undefined) {
            jsonResponse(response, 400, {
              error: "maxMessages must be an integer between 1 and 200",
            });
            return;
          }
          readCounts.countRoute("history");
          const signal = abortSignalForRequest(request);
          try {
            jsonResponse(
              response,
              200,
              await sessionHub.history(
                sourceId,
                sessionId,
                maxMessages,
                signal,
              ),
            );
          } catch (error) {
            if (error instanceof SessionHubError) {
              jsonResponse(response, error.status, { error: error.message });
              return;
            }
            jsonResponse(response, 500, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }), "dsh-fusion: session hub history route");
      effectScope.effect?.(() => webServer.register({
        kind: "exact",
        path: "/plugins/dsh-fusion/session-hub/prompt",
        handler: async (request, response) => {
          if (rejectUnauthenticated(ctx, connection, request, response)) return;
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          if (!isSameOriginMutation(request.headers)) {
            jsonResponse(response, 403, { error: "TRUSTED_ORIGIN_REQUIRED" });
            return;
          }
          if (!isJsonRequest(request.headers)) {
            jsonResponse(response, 415, { error: "APPLICATION_JSON_REQUIRED" });
            return;
          }
          const signal = abortSignalForRequest(request);
          try {
            const body = await readJsonBody(request);
            const allowedKeys = new Set(["sourceId", "sessionId", "text", "mode"]);
            if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
              jsonResponse(response, 400, { error: "UNKNOWN_PROMPT_FIELD" });
              return;
            }
            const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : "";
            const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
            const text = typeof body.text === "string" ? body.text : "";
            const mode = body.mode ?? "queue";
            if (
              sourceId === ""
              || sessionId === ""
              || sessionId.length > 256
              || sessionId.includes("\0")
              || (mode !== "queue" && mode !== "steer")
            ) {
              jsonResponse(response, 400, { error: "SESSION_PROMPT_INVALID" });
              return;
            }
            const result = await sessionHub.prompt(
              sourceId,
              sessionId,
              text,
              mode,
              signal,
            );
            jsonResponse(response, 202, result);
          } catch (error) {
            if (signal.aborted) return;
            if (error instanceof SessionHubError) {
              jsonResponse(response, error.status, { error: error.message });
              return;
            }
            jsonResponse(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }), "dsh-fusion: session hub prompt route");
      effectScope.effect?.(() => webServer.register({
        kind: "exact",
        path: "/plugins/dsh-fusion/events",
        handler: (request, response) => {
          if (rejectUnauthenticated(ctx, connection, request, response)) return;
          if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405, { allow: "GET, HEAD" });
            response.end();
            return;
          }
          if (response.write === undefined) {
            jsonResponse(response, 501, { error: "STREAMING_UNSUPPORTED" });
            return;
          }
          response.writeHead(200, SSE_HEADERS);
          response.write(": connected\n\n");

          // A first connection has no event id to resume from, so there is
          // nothing to replay: the client fetches the authoritative snapshot
          // on its own. Replaying the whole buffer here would re-deliver
          // every historical event to every new panel, and each of them
          // would trigger another snapshot fetch. A reconnect that does send
          // `last-event-id` still resumes exactly where it left off.
          const lastEventIdHeader = headerValue(request.headers, "last-event-id");
          if (lastEventIdHeader !== undefined) {
            const replay = stateHub.bus.replayWithGap(Number(lastEventIdHeader));
            if (replay.gap !== null) {
              response.write(encodeSseGapFrame(replay.gap));
            } else {
              for (const event of replay.events) {
                response.write(encodeSseEventFrame(event as { seq: number } & Record<string, unknown>));
              }
            }
          }

          const unsubscribe = stateHub.bus.subscribe((event) => {
            try {
              response.write?.(encodeSseEventFrame(event as { seq: number } & Record<string, unknown>));
            } catch {
              // The peer may have gone away between the write and the error.
            }
          });
          const heartbeat = setInterval(() => {
            try {
              response.write?.(": keepalive\n\n");
            } catch {
              // The connection is gone; the close handler cleans it up.
            }
          }, 20_000);
          heartbeat.unref?.();
          let cleaned = false;
          const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            clearInterval(heartbeat);
            unsubscribe();
            connections.delete(cleanup);
            try {
              response.end();
            } catch {
              // The peer may have already closed the response.
            }
          };
          connections.add(cleanup);
          response.on?.("close", cleanup);
          request.on?.("close", cleanup);
        },
      }), "dsh-fusion: events route");
      // Unloading the plugin has to tear down the live streams too. The
      // route's own disposer only unregisters the path; without this the open
      // connections would keep writing heartbeats and stay subscribed to the
      // bus until the client happened to disconnect.
      effectScope.effect?.(() => () => {
        for (const close of [...connections]) close();
      }, "dsh-fusion: event stream cleanup");
      effectScope.effect?.(() => webServer.register({
        kind: "exact",
        path: "/plugins/dsh-fusion/pty/create",
        handler: async (request, response) => {
          if (!allowRemotePty) {
            jsonResponse(response, 403, { error: "REMOTE_PTY_DISABLED" });
            return;
          }
          if (rejectUnauthenticated(ctx, connection, request, response)) return;
          if (request.method !== "POST") {
            jsonResponse(response, 405, { error: "METHOD_NOT_ALLOWED" });
            return;
          }
          if (!isSameOriginMutation(request.headers)) {
            jsonResponse(response, 403, { error: "CROSS_SITE_MUTATION_REJECTED" });
            return;
          }
          if (!isJsonRequest(request.headers)) {
            jsonResponse(response, 415, { error: "APPLICATION_JSON_REQUIRED" });
            return;
          }
          try {
            const input = validatePtyCreateRequest(await readJsonBody(request));
            const terminalService = ptyServicesByNodeId.get(input.nodeId);
            if (terminalService === undefined) {
              if (
                !configuredNodeIds.has(input.nodeId)
                && input.nodeId !== huaweiNodeId
              ) {
                jsonResponse(response, 403, { error: "UNKNOWN_PTY_NODE" });
                return;
              }
              jsonResponse(response, 503, { error: "REMOTE_PTY_NOT_CONFIGURED" });
              return;
            }
            const terminal = await terminalService.create({ cols: input.cols, rows: input.rows });
            ptyServiceByTerminalId.set(terminal.id, terminalService);
            let terminalToken: string;
            try {
              terminalToken = ptyCapabilities.issue({
                terminalId: terminal.id,
                nodeId: input.nodeId,
                cols: input.cols,
                rows: input.rows,
              }).terminalToken;
            } catch (error) {
              try {
                terminalService.terminate(terminal.id);
              } catch {
                // The terminal may have failed during capability creation.
              }
              ptyServiceByTerminalId.delete(terminal.id);
              throw error;
            }
            const snapshot = terminal.snapshot();
            jsonResponse(response, 201, {
              terminalId: terminal.id,
              terminalToken,
              nodeId: input.nodeId,
              cols: input.cols,
              rows: input.rows,
              state: terminal.state,
              snapshot: {
                sequence: snapshot.sequence,
                data: snapshot.data.toString("base64"),
                truncated: snapshot.truncated,
              },
            });
          } catch (error) {
            if (error instanceof SshPtyError) {
              jsonResponse(response, ptyHttpStatus(error), { error: error.code });
              return;
            }
            jsonResponse(
              response,
              error instanceof Error && error.message === "PTY_CREATE_INVALID" ? 400 : 502,
              {
                error: error instanceof Error && error.message === "PTY_CREATE_INVALID"
                  ? "PTY_CREATE_INVALID"
                  : "PTY_CREATE_FAILED",
              },
            );
          }
        },
      }), "dsh-fusion: pty create route");
      effectScope.effect?.(() => webServer.register({
        kind: "exact",
        path: "/plugins/dsh-fusion/pty/close",
        handler: async (request, response) => {
          if (!allowRemotePty) {
            jsonResponse(response, 403, { error: "REMOTE_PTY_DISABLED" });
            return;
          }
          if (rejectUnauthenticated(ctx, connection, request, response)) return;
          if (request.method !== "POST") {
            jsonResponse(response, 405, { error: "METHOD_NOT_ALLOWED" });
            return;
          }
          if (!isSameOriginMutation(request.headers)) {
            jsonResponse(response, 403, { error: "CROSS_SITE_MUTATION_REJECTED" });
            return;
          }
          if (!isJsonRequest(request.headers)) {
            jsonResponse(response, 415, { error: "APPLICATION_JSON_REQUIRED" });
            return;
          }
          try {
            const input = validatePtyCloseRequest(await readJsonBody(request));
            const terminalService = ptyServiceByTerminalId.get(input.terminalId);
            if (terminalService === undefined) {
              jsonResponse(response, 503, { error: "REMOTE_PTY_NOT_CONFIGURED" });
              return;
            }
            if (terminalService.get(input.terminalId) === undefined) {
              ptyCapabilities.delete(input.terminalId);
              ptyServiceByTerminalId.delete(input.terminalId);
              jsonResponse(response, 404, { error: "PTY_UNKNOWN_TERMINAL" });
              return;
            }
            if (!ptyCapabilities.verify(input.terminalId, input.terminalToken)) {
              jsonResponse(response, 403, { error: "PTY_CAPABILITY_INVALID" });
              return;
            }
            try {
              terminalService.close(input.terminalId);
            } finally {
              ptyCapabilities.delete(input.terminalId);
              ptyServiceByTerminalId.delete(input.terminalId);
            }
            jsonResponse(response, 200, {
              terminalId: input.terminalId,
              closed: true,
            });
          } catch (error) {
            if (error instanceof SshPtyError) {
              jsonResponse(response, ptyHttpStatus(error), { error: error.code });
              return;
            }
            jsonResponse(
              response,
              error instanceof Error && error.message === "PTY_CLOSE_INVALID" ? 400 : 409,
              {
                error: error instanceof Error && error.message === "PTY_CLOSE_INVALID"
                  ? "PTY_CLOSE_INVALID"
                  : "PTY_CLOSE_FAILED",
              },
            );
          }
        },
      }), "dsh-fusion: pty close route");
      if (webServer.registerUpgrade !== undefined) {
        effectScope.effect?.(() => webServer.registerUpgrade!({
          path: "/plugins/dsh-fusion/pty/ws",
          handler: (request, socket, head) => {
            if (!allowRemotePty) {
              rejectUpgrade(socket, 403, "REMOTE_PTY_DISABLED");
              return;
            }
            if (connection === undefined) {
              rejectUpgrade(socket, 503, "DSH_CONNECTION_UNAVAILABLE");
              return;
            }
            const rejection = connection.requestRejection({ headers: request.headers ?? {} });
            if (rejection !== undefined) {
              rejectUpgrade(
                socket,
                rejection,
                rejection === 401
                  ? "AUTHENTICATION_REQUIRED"
                  : "TRUSTED_ORIGIN_REQUIRED",
              );
              return;
            }
            if (!isSameOriginWebSocket(request.headers)) {
              rejectUpgrade(socket, 403, "TRUSTED_ORIGIN_REQUIRED");
              return;
            }
            if (ptyServicesByNodeId.size === 0) {
              rejectUpgrade(socket, 503, "REMOTE_PTY_NOT_CONFIGURED");
              return;
            }
            try {
              ptyWebSocketServer.handleUpgrade(request as never, socket as never, head, (webSocket) => {
                ptySockets.add(webSocket);
                let disposed = false;
                let authenticated = false;
                let terminalId: string | undefined;
                let terminal: SshPtyTerminal | undefined;
                let unsubscribe = () => {};
                const authTimer = setTimeout(() => {
                  if (authenticated || disposed) return;
                  webSocket.close(4401, "PTY_AUTH_TIMEOUT");
                }, ptyAuthTimeoutMs);
                authTimer.unref?.();

                const cleanup = () => {
                  if (disposed) return;
                  disposed = true;
                  clearTimeout(authTimer);
                  unsubscribe();
                  if (authenticated && terminalId !== undefined) {
                    ptyCapabilities.detach(terminalId);
                    if (ptyServiceByTerminalId.get(terminalId)?.get(terminalId) === undefined) {
                      ptyCapabilities.delete(terminalId);
                      ptyServiceByTerminalId.delete(terminalId);
                    }
                  }
                  ptySockets.delete(webSocket);
                };
                const closeSlow = () => {
                  if (terminalId !== undefined) {
                    try {
                      ptyServiceByTerminalId.get(terminalId)?.terminate(terminalId);
                    } catch {
                      // The terminal may already have closed itself.
                    }
                    ptyCapabilities.delete(terminalId);
                    ptyServiceByTerminalId.delete(terminalId);
                  }
                  try {
                    webSocket.terminate();
                  } catch {
                    // The browser socket may already be gone.
                  }
                  cleanup();
                };
                const send = (message: PtyServerMessage): boolean => {
                  if (disposed) return false;
                  let sent = false;
                  try {
                    sent = sendPtyMessage(webSocket, message);
                  } catch {
                    sent = false;
                  }
                  if (!sent) closeSlow();
                  return sent;
                };
                const handleTerminalEvent = (event: SshPtyEvent) => {
                  if (event.type === "output") {
                    for (const message of chunkPtyOutput("output", {
                      terminalId: event.terminalId,
                      sequence: event.sequence,
                      data: event.data,
                    })) {
                      if (!send(message)) return;
                    }
                    return;
                  }
                  if (event.type === "error") {
                    send({
                      type: "error",
                      terminalId: event.terminalId,
                      sequence: event.sequence,
                      code: event.code,
                      message: event.message,
                    });
                    ptyCapabilities.delete(event.terminalId);
                    ptyServiceByTerminalId.delete(event.terminalId);
                    webSocket.close(1011, "PTY_TERMINAL_ERROR");
                    return;
                  }
                  send({
                    type: "state",
                    terminalId: event.terminalId,
                    sequence: event.sequence,
                    state: event.state,
                  });
                  if (event.state === "closed" || event.state === "error") {
                    ptyCapabilities.delete(event.terminalId);
                    ptyServiceByTerminalId.delete(event.terminalId);
                    webSocket.close(1000, "PTY_TERMINAL_CLOSED");
                  }
                };

                webSocket.once("close", cleanup);
                webSocket.once("error", cleanup);
                webSocket.on("message", (raw: RawData, isBinary: boolean) => {
                  try {
                    const buffer = Buffer.isBuffer(raw)
                      ? raw
                      : Array.isArray(raw)
                        ? Buffer.concat(raw)
                        : Buffer.from(raw);
                    if (buffer.length > MAX_PTY_MESSAGE_BYTES) {
                      throw new Error("PTY_MESSAGE_TOO_LARGE");
                    }
                    if (isBinary) throw new Error("PTY_MESSAGE_BINARY");
                    const message = parsePtyClientMessage(buffer.toString("utf8"));
                    if (!authenticated) {
                      if (message.type !== "auth") throw new Error("PTY_AUTH_REQUIRED");
                      const terminalService = ptyServiceByTerminalId.get(message.terminalId);
                      const candidate = terminalService?.get(message.terminalId);
                      if (candidate === undefined) {
                        webSocket.close(4404, "PTY_UNKNOWN_TERMINAL");
                        return;
                      }
                      if (!ptyCapabilities.attach(message.terminalId, message.terminalToken)) {
                        webSocket.close(4403, "PTY_CAPABILITY_INVALID");
                        return;
                      }
                      authenticated = true;
                      terminalId = message.terminalId;
                      terminal = candidate;
                      clearTimeout(authTimer);
                      unsubscribe = candidate.subscribe(handleTerminalEvent);
                      if (!send({
                        type: "state",
                        terminalId,
                        sequence: candidate.sequence,
                        state: candidate.state,
                      })) return;
                      const snapshot = candidate.snapshot();
                      for (const chunk of chunkPtyOutput("snapshot", {
                        terminalId,
                        sequence: snapshot.sequence,
                        data: snapshot.data,
                        truncated: snapshot.truncated,
                      })) {
                        if (!send(chunk)) return;
                      }
                      return;
                    }
                    if (message.type === "auth" || terminal === undefined || terminalId === undefined) {
                      throw new Error("PTY_PROTOCOL_INVALID");
                    }
                    if (message.type === "input") {
                      terminal.write(message.data);
                    } else if (message.type === "resize") {
                      terminal.resize(message.cols, message.rows);
                    } else {
                      if (!ptyCapabilities.verify(terminalId, message.terminalToken)) {
                        webSocket.close(4403, "PTY_CAPABILITY_INVALID");
                        return;
                      }
                      ptyServiceByTerminalId.get(terminalId)?.close(terminalId);
                      ptyCapabilities.delete(terminalId);
                      ptyServiceByTerminalId.delete(terminalId);
                      webSocket.close(1000, "PTY_CLIENT_CLOSED");
                    }
                  } catch {
                    if (!authenticated) {
                      webSocket.close(1008, "PTY_AUTH_INVALID");
                      return;
                    }
                    send({
                      type: "error",
                      terminalId: terminalId ?? "pty-unknown",
                      sequence: terminal?.sequence ?? 0,
                      code: "PTY_PROTOCOL_INVALID",
                      message: "PTY_PROTOCOL_INVALID",
                    });
                    webSocket.close(1008, "PTY_PROTOCOL_INVALID");
                  }
                });
              });
            } catch {
              rejectUpgrade(socket, 400, "PTY_UPGRADE_REJECTED");
            }
          },
        }), "dsh-fusion: pty websocket route");
      }
      effectScope.effect?.(() => () => {
        for (const socket of [...ptySockets]) {
          try {
            socket.terminate();
          } catch {
            // The browser socket may already be gone.
          }
        }
        ptySockets.clear();
        try {
          ptyWebSocketServer.close?.();
        } catch {
          // A noServer WebSocketServer has no listener to close.
        }
      }, "dsh-fusion: pty websocket cleanup");
      effectScope.effect?.(() => webServer.register({
        kind: "exact",
        path: "/plugins/dsh-fusion/doctor",
        handler: async (request, response) => {
          if (rejectUnauthenticated(ctx, connection, request, response)) return;
          try {
            const fleetProbe = await probeFleetState();
            const live = await createRuntime(
              request.headers,
              fleetProbe,
              { bypassBridgeCache: true },
            ).snapshot();
            const ledger = await inspectTaskLedger(taskLedgerPath);
            const remoteConfigReport = await readRemoteConfigDoctor(
              remoteConfig,
              remoteConfigInput,
            );
            const report = buildDoctorReport({
              dshCompatibility,
              snapshot: live,
              ...(fleetProbe === undefined ? {} : {
                fleet: fleetObservability(
                  { entry: fleetProbe, stale: false },
                  fleetRouter === undefined ? undefined : fleetRouter.inspectStats(),
                ),
              }),
              ledger,
              ...(remoteConfigReport === undefined
                ? {}
                : {
                    remoteConfig: {
                      state: remoteConfigReport.state,
                      ok: remoteConfigReport.ok,
                      ...(remoteConfigReport.message === undefined
                        ? {}
                        : { message: remoteConfigReport.message }),
                      ...(remoteConfigReport.activeHash === undefined
                        ? {}
                        : { activeHash: remoteConfigReport.activeHash }),
                    },
                  }),
              ...(config.knownIncompatibilities === undefined
                ? {}
                : { knownIncompatibilities: config.knownIncompatibilities }),
            });
            jsonResponse(response, report.status === "failed" ? 503 : 200, report);
          } catch (error) {
            jsonResponse(response, 503, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }), "dsh-fusion: doctor route");
      effectScope.effect?.(() => webServer.register({
        kind: "exact",
        path: "/plugins/dsh-fusion/node-doctor",
        handler: async (request, response) => {
          if (rejectUnauthenticated(ctx, connection, request, response)) return;
          try {
            const nodeId = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("nodeId")
              ?? undefined;
            jsonResponse(response, 200, await createRuntime().doctorNode(nodeId));
          } catch (error) {
            jsonResponse(response, 503, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      }), "dsh-fusion: node doctor route");
      effectScope.effect?.(() => webServer.register({
        kind: "exact",
        path: "/plugins/dsh-fusion/tasks",
        handler: async (request, response) => {
          if (rejectUnauthenticated(ctx, connection, request, response)) return;
          if (request.method !== "POST") {
            jsonResponse(response, 405, { error: "METHOD_NOT_ALLOWED" });
            return;
          }
          if (!isSameOriginMutation(request.headers)) {
            jsonResponse(response, 403, { error: "CROSS_SITE_MUTATION_REJECTED" });
            return;
          }
          if (!isJsonRequest(request.headers)) {
            jsonResponse(response, 415, { error: "APPLICATION_JSON_REQUIRED" });
            return;
          }
          try {
            const body = await readJsonBody(request);
            const goal = typeof body.goal === "string" ? body.goal.trim() : "";
            const command = typeof body.command === "string" ? body.command.trim() : "";
            const requestedNodeIds = Array.isArray(body.nodeIds)
              ? body.nodeIds.map(String)
              : typeof body.nodeId === "string"
                ? [body.nodeId]
                : [defaultNodeId];
            const idempotencyKey = headerValue(request.headers, "idempotency-key");
            if (goal === "" || command === "") {
              jsonResponse(response, 400, { error: "goal and command are required" });
              return;
            }
            const invalidNodeIds = requestedNodeIds.filter((nodeId) => !configuredNodeIds.has(nodeId));
            if (invalidNodeIds.length > 0) {
              jsonResponse(response, 400, {
                error: `unknown configured node: ${invalidNodeIds.join(",")}`,
              });
              return;
            }
            const task = await createRuntime().dispatchTask({
              goal,
              command,
              nodeIds: requestedNodeIds,
              ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
            });
            void refreshFleetNow();
            const status = task.status === "completed"
              ? 200
              : task.status === "failed" || task.status === "cancelled"
                ? 409
                : 202;
            jsonResponse(response, status, task);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            jsonResponse(
              response,
              message.startsWith("FLEET_NODE_CONCURRENCY_LIMIT:") ? 429 : 400,
              { error: message },
            );
          }
        },
      }), "dsh-fusion: task dispatch route");
      effectScope.effect?.(() => webServer.register({
        kind: "exact",
        path: "/plugins/dsh-fusion/tasks/preview",
        handler: async (request, response) => {
          if (rejectUnauthenticated(ctx, connection, request, response)) return;
          if (request.method !== "POST") {
            jsonResponse(response, 405, { error: "METHOD_NOT_ALLOWED" });
            return;
          }
          if (!isSameOriginMutation(request.headers)) {
            jsonResponse(response, 403, { error: "CROSS_SITE_MUTATION_REJECTED" });
            return;
          }
          if (!isJsonRequest(request.headers)) {
            jsonResponse(response, 415, { error: "APPLICATION_JSON_REQUIRED" });
            return;
          }
          let body: Record<string, unknown>;
          try {
            body = await readJsonBody(request);
          } catch {
            jsonResponse(response, 400, { error: "PREVIEW_INPUT_INVALID" });
            return;
          }
          if (dispatchPreview === undefined) {
            jsonResponse(response, 400, { error: "PREVIEW_INPUT_INVALID" });
            return;
          }
          try {
            jsonResponse(response, 200, await dispatchPreview(body));
          } catch (error) {
            const invalid = error instanceof Error && error.message === "PREVIEW_INPUT_INVALID";
            jsonResponse(response, invalid ? 400 : 503, {
              error: invalid ? "PREVIEW_INPUT_INVALID" : "PREVIEW_UNAVAILABLE",
            });
          }
        },
      }), "dsh-fusion: read-only task preview route");
      effectScope.effect?.(() => webServer.register({
        kind: "exact",
        path: "/plugins/dsh-fusion/tasks/cancel",
        handler: async (request, response) => {
          if (rejectUnauthenticated(ctx, connection, request, response)) return;
          if (request.method !== "POST") {
            jsonResponse(response, 405, { error: "METHOD_NOT_ALLOWED" });
            return;
          }
          if (!isSameOriginMutation(request.headers)) {
            jsonResponse(response, 403, { error: "CROSS_SITE_MUTATION_REJECTED" });
            return;
          }
          if (!isJsonRequest(request.headers)) {
            jsonResponse(response, 415, { error: "APPLICATION_JSON_REQUIRED" });
            return;
          }
          try {
            const body = await readJsonBody(request);
            const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
            if (taskId === "") {
              jsonResponse(response, 400, { error: "taskId is required" });
              return;
            }
            await createRuntime().cancelTask(taskId);
            void refreshFleetNow();
            jsonResponse(response, 200, { taskId, cancelled: true });
          } catch (error) {
            jsonResponse(response, 409, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }), "dsh-fusion: task cancel route");
      effectScope.effect?.(() => webServer.register({
        kind: "exact",
        path: "/plugins/dsh-fusion/tasks/status",
        handler: async (request, response) => {
          if (rejectUnauthenticated(ctx, connection, request, response)) return;
          if (request.method !== "GET") {
            jsonResponse(response, 405, { error: "METHOD_NOT_ALLOWED" });
            return;
          }
          try {
            const taskId = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("taskId")?.trim();
            if (taskId === undefined || taskId === "") {
              jsonResponse(response, 400, { error: "taskId is required" });
              return;
            }
            jsonResponse(response, 200, await createRuntime().inspectTask(taskId));
          } catch (error) {
            jsonResponse(response, 404, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }), "dsh-fusion: task status route");
      if (remoteConfig !== undefined) {
      effectScope.effect?.(() => webServer.register({
          kind: "exact",
          path: "/plugins/dsh-fusion/config/status",
          handler: async (request, response) => {
            if (rejectUnauthenticated(ctx, connection, request, response)) return;
            try {
              const doctor = await remoteConfig.doctor(remoteConfigInput);
              await refreshFleetNow(true);
              jsonResponse(response, doctor.state === "unreachable" ? 503 : 200, doctor);
            } catch (error) {
              jsonResponse(response, 503, {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          },
        }), "dsh-fusion: config status route");
        effectScope.effect?.(() => webServer.register({
          kind: "exact",
          path: "/plugins/dsh-fusion/config/apply",
          handler: async (request, response) => {
            if (rejectUnauthenticated(ctx, connection, request, response)) return;
            if (request.method !== "POST") {
              jsonResponse(response, 405, { error: "METHOD_NOT_ALLOWED" });
              return;
            }
            if (!allowConfigApply) {
              jsonResponse(response, 403, { error: "CONFIG_APPLY_NOT_ALLOWED" });
              return;
            }
            if (!isSameOriginMutation(request.headers)) {
              jsonResponse(response, 403, { error: "CROSS_SITE_MUTATION_REJECTED" });
              return;
            }
            if (!isJsonRequest(request.headers)) {
              jsonResponse(response, 415, { error: "APPLICATION_JSON_REQUIRED" });
              return;
            }
            try {
              const body = await readJsonBody(request);
              const overridden = applyRemoteConfigOverrides({
                mode: remoteConfigMode,
                input: remoteConfigInput,
                runtimeNodeId: huaweiNodeId,
                body,
              });
              if (!overridden.ok) {
                jsonResponse(response, overridden.status, { error: overridden.error });
                return;
              }
              const result = await remoteConfig.apply(overridden.input);
              await refreshFleetNow(true);
              jsonResponse(
                response,
                result.applied || result.doctor.state === "current" ? 200 : 409,
                result,
              );
            } catch (error) {
              jsonResponse(response, 400, { error: error instanceof Error ? error.message : String(error) });
            }
          },
        }), "dsh-fusion: config apply route");
      }
    };
    if (typeof ctx.inject === "function") {
      ctx.inject(["webServer", "connection"], (webCtx) => {
        registerWebSurface(
          webCtx,
          webCtx.webServer
          ?? webCtx.get?.("webServer") as DshWebServer | undefined,
          webCtx.connection
          ?? webCtx.get?.("connection") as DshConnection | undefined,
        );
      });
    } else {
      registerWebSurface(ctx, undefined, undefined, true);
      ctx.on?.("internal/service", (name: unknown) => {
        if (name === "webServer") registerWebSurface(ctx, undefined, undefined, true);
      });
    }

    ctx.effect?.(() => {
      stateHub.start();
      void refreshFleetNow();
      return () => {
        stateHub.stop();
        sessionHub.dispose();
        ptyCapabilities.clear();
        ptyServiceByTerminalId.clear();
        for (const service of new Set(ptyServicesByNodeId.values())) service.dispose();
        ptyServicesByNodeId.clear();
      };
    }, "dsh-fusion: state hub");

    return undefined;
  }

  ctx.logger?.warn?.("DSH Fusion requires a host context with ctx.get; plugin not started.");
  return undefined;
}
