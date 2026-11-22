export type ProviderKind =
  | "bot"
  | "fleet"
  | "session"
  | "transport"
  | "terminal"
  | "orchestration"
  | "config";

export type ProviderHealthState =
  | "connected"
  | "degraded"
  | "offline"
  | "not-configured";

export interface ProviderStatus {
  state: ProviderHealthState;
  checkedAt: number;
  message?: string;
  version?: string;
}

export type NodePlatform = "windows" | "linux" | "macos" | "unknown";
export type NodeRole = "control" | "worker";
export type NodeStatus = "online" | "offline" | "degraded";
export type TransportKind = "seekfleet" | "dsh-fleet" | "yobiru" | "tincan" | "ssh";
export type ConfigState = "current" | "drift" | "unknown";
export type HostSharingMode = "dedicated" | "shared";

export interface HostAccessPolicy {
  ownerId?: string;
  sharingMode: HostSharingMode;
  maxConcurrentTasks?: number;
}

export interface NodeRecord {
  id: string;
  externalId: string;
  providerId: string;
  name: string;
  platform: NodePlatform;
  roles: NodeRole[];
  status: NodeStatus;
  transports: TransportKind[];
  capabilities: string[];
  dshVersion?: string;
  configHash?: string;
  configState: ConfigState;
  lastHeartbeat?: string;
  cpuPercent?: number;
  memoryPercent?: number;
  /**
   * Raw `systemctl is-system-running` value reported by the node host.
   *
   * Kept separate from `status` on purpose: a "degraded" systemd state only
   * means some unit failed, not that the node stopped accepting work.
   * Empty when the host does not run systemd.
   */
  systemdState?: string;
  /** Number of failed systemd units reported by the node host. */
  failedUnits?: number;
  /** Ownership and task-admission policy for this execution host. */
  hostAccess?: HostAccessPolicy;
  /**
   * Why the node could not be observed, when a probe failed.
   *
   * An unreachable node has to stay visible with this reason attached.
   * Dropping it would make "unreachable" indistinguishable from "never
   * existed", and a shrinking fleet total hides the failure.
   */
  unavailableReason?: string;
}

export type BotStatus = "idle" | "working" | "offline";

export interface BotRecord {
  id: string;
  providerId: string;
  name: string;
  role: string;
  model: string;
  reasoningEffort?: string;
  isMain: boolean;
  status: BotStatus;
  memoryCount?: number;
  usageTokens?: number;
  recentMessages?: BotMessageRecord[];
}

export interface BotMessageRecord {
  id?: string;
  from: string;
  content: string;
  at?: string;
}

export interface GroupRecord {
  id: string;
  providerId: string;
  name: string;
  adminBotId?: string;
  memberBotIds: string[];
  unreadCount: number;
}

export type SessionStatus = "live" | "idle" | "finished" | "error";

export interface SessionRecord {
  id: string;
  providerId: string;
  nodeId?: string;
  botId?: string;
  title: string;
  status: SessionStatus;
  updatedAt: string;
}

export type SessionHubProviderState =
  | "available"
  | "partial"
  | "failed"
  | "unavailable";

export type SessionHubSourceState = "available" | "failed" | "unavailable";

export interface SessionHubSourceStatus {
  sourceId: string;
  state: SessionHubSourceState;
  sessionCount: number;
  error?: string;
}

export interface SessionHubSessionRecord {
  id: string;
  sourceId: string;
  nativeSessionId: string;
  title: string;
  running: boolean;
  agentAvailable: boolean;
  blank: boolean;
  updatedAt: number;
  /**
   * The native projection sequence this record's session content
   * had reached when listed (local source only). Lets history
   * readers tell "this session changed" from "something else
   * changed" without comparing wall-clock timestamps.
   */
  historySeq?: number;
  cwd?: string;
  parentNativeId?: string;
  subagentMode?: "one-shot" | "continuable" | "unknown";
  origin?: "subagent";
  lastError?: string;
}

export interface SessionHubSnapshot {
  provider: SessionHubProviderState;
  sessions: SessionHubSessionRecord[];
  sources: SessionHubSourceStatus[];
  checkedAt: number;
}

export type SessionHistoryRole = "user" | "assistant";

export interface SessionHistoryMessage {
  role: SessionHistoryRole;
  text: string;
  seq: number;
  time: number;
}

export interface SessionHubHistory {
  messages: SessionHistoryMessage[];
  hasMore: boolean;
  /**
   * The projection sequence the returned page was pinned to. This
   * is the version the reader actually holds; it may be ahead of
   * the listing's historySeq when the two reads race.
   */
  asOfSeq?: number;
}

export type TaskStatus =
  | "queued"
  | "claimed"
  | "running"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskEvidence {
  kind: "command" | "log" | "artifact" | "git" | "summary";
  label: string;
  value: string;
  sha256?: string;
}

export type TaskEvidenceKind = TaskEvidence["kind"];

/** A versioned worker-reported description of execution materials. */
export interface ExecutionMaterialArtifact {
  path: string;
  digest: string;
  bytes: number;
}

export interface ExecutionMaterialFile {
  path: string;
  digest: string;
}

export interface ExecutionRuntimeMaterial extends ExecutionMaterialFile {
  evidence: "declared" | "measured";
}

export interface ExecutionMaterialManifest {
  version: 1;
  workspace: { id: string; path: string };
  source: { revision: string; digest: string };
  code: ExecutionMaterialFile;
  input: ExecutionMaterialFile;
  runtime: ExecutionRuntimeMaterial;
  config: ExecutionMaterialFile;
  artifacts: ExecutionMaterialArtifact[];
}

/** Trusted profile pins configured for a job; source is pinned from DSH at attempt time. */
export interface ExecutionMaterialPins {
  code: ExecutionMaterialFile;
  input: ExecutionMaterialFile;
  runtime: ExecutionRuntimeMaterial;
  config: ExecutionMaterialFile;
  artifacts: ExecutionMaterialArtifact[];
}

export interface ExpectedExecutionMaterials {
  source: { revision: string; digest: string };
  code: ExecutionMaterialFile;
  input: ExecutionMaterialFile;
  runtime: ExecutionRuntimeMaterial;
  config: ExecutionMaterialFile;
  artifacts: ExecutionMaterialArtifact[];
}

/** The native receipt keeps expected pins separate from adapter-observed bytes. */
export interface VerifiedExecutionMaterials {
  expected: ExpectedExecutionMaterials;
  observed: ExecutionMaterialManifest;
}

/** Terminal metadata and complete stream digests read from an execution worker. */
export interface WorkerExecutionObservation {
  taskId: string;
  nodeId: string;
  commandSha256: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  stdout: { sha256: string; bytes: number };
  stderr: { sha256: string; bytes: number };
  /** Untrusted worker claim; never sufficient by itself for a verified receipt. */
  reportedMaterials?: ExecutionMaterialManifest;
}

export interface TaskChildReference {
  id: string;
  targetNodeIds: string[];
  status?: TaskStatus;
  progress?: number;
}

/** Observed DSH task-board fields; write-scope warnings are advisory, never a lock. */
export interface AgentTeamTaskProjection {
  teamId: string;
  taskId: string;
  revision?: number;
  ownerId?: string;
  ownerName?: string;
  blockedBy: string[];
  writeScopes: string[];
  ready?: boolean;
  writeScopeWarnings?: string[];
}

export interface TaskRecord {
  id: string;
  goal: string;
  description?: string;
  /** Client-supplied id used to coalesce retries of one dispatch intent. */
  idempotencyKey?: string;
  /** Hash of the dispatch payload, so a key cannot be reused for other work. */
  dispatchFingerprint?: string;
  requestedByBotId?: string;
  targetNodeIds: string[];
  dependsOnTaskIds?: string[];
  agentTeamTask?: AgentTeamTaskProjection;
  transport: TransportKind;
  status: TaskStatus;
  progress?: number;
  sessionId?: string;
  evidence: TaskEvidence[];
  executionObservation?: WorkerExecutionObservation;
  expectedEvidence?: TaskEvidenceKind[];
  childTaskRefs?: TaskChildReference[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface ConfigSnapshot {
  revision: string;
  hash: string;
  desiredCommit?: string;
  appliedCommit?: string;
  pluginVersions: Record<string, string>;
  nodeStates: Record<string, ConfigState>;
}

export interface AgentTeamRecord {
  id: string;
  providerId: string;
  name: string;
  workspace: string;
  phase: "staged" | "running" | "archived";
  captainSessionId: string;
  memberIds: string[];
  taskIds: string[];
}

export interface AgentFlowRecord {
  id: string;
  providerId: string;
  name: string;
  description?: string;
  workspacePath: string;
  taskIds: string[];
  archived: boolean;
}

export interface RoomActivityRecord {
  id: string;
  type: string;
  at: string;
  label: string;
  actorMemberId?: string;
  targetMemberId?: string;
  acceptedCount?: number;
  failedCount?: number;
}

export interface RoomMessageRecord {
  id: string;
  at: string;
  role: "leader" | "member";
  authorMemberId: string;
  authorName: string;
  recipientMemberIds: string[];
  text: string;
  status: "accepted" | "completed";
  sessionId?: string;
  relayId?: string;
  mode?: "direct" | "broadcast";
  replyTo?: string[];
}

export interface RoomConversationRecord {
  messages: RoomMessageRecord[];
  unavailableMemberIds: string[];
  hiddenMixedReplyCount: number;
}

export interface RoomRecord {
  id: string;
  providerId: string;
  name: string;
  topic?: string;
  status: "open" | "closed";
  leaderSessionId: string;
  memberIds: string[];
  activityCount: number;
  activity?: RoomActivityRecord[];
  conversation?: RoomConversationRecord;
}

export interface BridgedSnapshot {
  bots: BotRecord[];
  groups: GroupRecord[];
  sessions: SessionRecord[];
  tasks: TaskRecord[];
  agentTeams: AgentTeamRecord[];
  agentFlows: AgentFlowRecord[];
  rooms: RoomRecord[];
}
