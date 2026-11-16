import type { FusionEventInput, TaskStatus } from "@dsh-fusion/core";
import { FusionEventBus } from "./event-bus.js";

export interface FusionWatchNode {
  id: string;
  status: string;
  configState: string;
}

export interface FusionWatchTask {
  id: string;
  status: string;
  progress?: number;
}

export interface FusionWatchProvider {
  state: string;
}

export interface FusionWatchBot {
  id: string;
  /** The bot's working state, when the upstream bridge reported one. */
  status?: string;
}

export interface FusionWatchSession {
  id: string;
  status?: string;
  updatedAt?: string;
}

export interface FusionWatchConfig {
  nodeId: string;
  state: string;
  hash?: string;
}

export interface FusionWatchSnapshot {
  nodes: readonly FusionWatchNode[];
  tasks: readonly FusionWatchTask[];
  bridgeTasks: readonly FusionWatchTask[];
  /**
   * The observed configuration state of each node.
   *
   * The node list carries a `configState` too, but a configuration change is
   * its own event: it is what an operator waits for, and it must not be
   * buried in a generic node update.
   */
  config?: readonly FusionWatchConfig[];
  providers: Readonly<Record<string, FusionWatchProvider | undefined>>;
  agentTeams: ReadonlyArray<{ id: string }>;
  agentFlows: ReadonlyArray<{ id: string }>;
  rooms: ReadonlyArray<{
    id: string;
    status?: string;
    memberIds?: readonly string[];
  }>;
  bots: ReadonlyArray<FusionWatchBot>;
  groups: ReadonlyArray<{ id: string }>;
  sessions: ReadonlyArray<FusionWatchSession>;
}

export type FusionWatchScope =
  | "agentTeams"
  | "agentFlows"
  | "rooms"
  | "bots"
  | "groups"
  | "sessions";

const COLLECTION_SCOPES: readonly FusionWatchScope[] = [
  "agentTeams",
  "agentFlows",
  "bots",
  "groups",
  "sessions",
];

function roomSignature(room: FusionWatchSnapshot["rooms"][number]): string {
  return JSON.stringify([
    room.status ?? null,
    [...(room.memberIds ?? [])].sort(),
  ]);
}

const FLEET_PROVIDER_IDS = ["nodes", "huawei"] as const;

function pickFleetFields(
  snapshot: Partial<FusionWatchSnapshot>,
): Partial<FusionWatchSnapshot> {
  const providers: Record<string, FusionWatchProvider> = {};
  for (const [providerId, provider] of Object.entries(snapshot.providers ?? {})) {
    if ((FLEET_PROVIDER_IDS as readonly string[]).includes(providerId) && provider !== undefined) {
      providers[providerId] = provider;
    }
  }
  return {
    ...(snapshot.nodes === undefined ? {} : { nodes: snapshot.nodes }),
    ...(snapshot.tasks === undefined ? {} : { tasks: snapshot.tasks }),
    ...(snapshot.config === undefined ? {} : { config: snapshot.config }),
    ...(Object.keys(providers).length === 0 ? {} : { providers }),
  };
}

function pickBridgeFields(
  snapshot: Partial<FusionWatchSnapshot>,
): Partial<FusionWatchSnapshot> {
  const providers: Record<string, FusionWatchProvider> = {};
  for (const [providerId, provider] of Object.entries(snapshot.providers ?? {})) {
    if (!(FLEET_PROVIDER_IDS as readonly string[]).includes(providerId) && provider !== undefined) {
      providers[providerId] = provider;
    }
  }
  const bridge: Partial<FusionWatchSnapshot> = { ...snapshot };
  delete bridge.nodes;
  delete bridge.tasks;
  delete bridge.config;
  bridge.providers = providers;
  return bridge;
}

function idSet(items: ReadonlyArray<{ id: string }>): string[] {
  return items.map((item) => item.id).sort();
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Compares two live snapshots and returns the events describing what changed.
 * Pure and side-effect free so the diff rules stay unit-testable.
 */
export function diffFusionSnapshots(
  previous: FusionWatchSnapshot | undefined,
  next: FusionWatchSnapshot,
): FusionEventInput[] {
  if (previous === undefined) {
    return [{ type: "state.updated", scope: "initial" }];
  }

  const events: FusionEventInput[] = [];

  for (const [providerId, provider] of Object.entries(next.providers)) {
    const before = previous.providers[providerId];
    if (before?.state !== provider?.state) {
      events.push({
        type: "provider.status",
        providerId,
        state: provider?.state ?? "not-configured",
      });
    }
  }
  for (const providerId of Object.keys(previous.providers)) {
    if (!(providerId in next.providers)) {
      events.push({ type: "provider.status", providerId, state: "not-configured" });
    }
  }

  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  for (const node of next.nodes) {
    const before = previousNodes.get(node.id);
    if (
      before === undefined
      || before.status !== node.status
      || before.configState !== node.configState
    ) {
      events.push({ type: "node.updated", nodeId: node.id });
    }
  }

  const previousTasks = new Map(previous.tasks.map((task) => [task.id, task]));
  for (const task of next.tasks) {
    const before = previousTasks.get(task.id);
    if (
      before === undefined
      || before.status !== task.status
      || before.progress !== task.progress
    ) {
      events.push({
        type: "task.updated",
        taskId: task.id,
        status: task.status as TaskStatus,
      });
    }
  }

  const previousBridgeTasks = new Map(previous.bridgeTasks.map((task) => [task.id, task]));
  for (const task of next.bridgeTasks) {
    const before = previousBridgeTasks.get(task.id);
    if (
      before === undefined
      || before.status !== task.status
      || before.progress !== task.progress
    ) {
      events.push({
        type: "task.updated",
        taskId: task.id,
        status: task.status as TaskStatus,
      });
    }
  }

  const previousConfig = new Map((previous.config ?? []).map((entry) => [entry.nodeId, entry]));
  for (const entry of next.config ?? []) {
    const before = previousConfig.get(entry.nodeId);
    if (before === undefined || before.state !== entry.state || before.hash !== entry.hash) {
      events.push({ type: "config.updated", nodeId: entry.nodeId });
    }
  }
  for (const entry of previous.config ?? []) {
    if (!(next.config ?? []).some((candidate) => candidate.nodeId === entry.nodeId)) {
      events.push({ type: "config.updated", nodeId: entry.nodeId });
    }
  }

  // A bot that appears, disappears, or changes its working state is a
  // per-entity change. The collection-level `state.updated` event says the
  // set changed; this one says which bot, so a consumer does not have to
  // diff the whole list itself.
  const previousBots = new Map(previous.bots.map((bot) => [bot.id, bot]));
  for (const bot of next.bots) {
    const before = previousBots.get(bot.id);
    if (before === undefined || before.status !== bot.status) {
      events.push({ type: "bot.updated", botId: bot.id });
    }
  }
  for (const bot of previous.bots) {
    if (!next.bots.some((candidate) => candidate.id === bot.id)) {
      events.push({ type: "bot.updated", botId: bot.id });
    }
  }

  // Same for sessions: a session that appears, disappears, or moves
  // between live, idle, finished and error is its own event.
  const previousSessions = new Map(previous.sessions.map((session) => [session.id, session]));
  for (const session of next.sessions) {
    const before = previousSessions.get(session.id);
    if (
      before === undefined
      || before.status !== session.status
      || before.updatedAt !== session.updatedAt
    ) {
      events.push({ type: "session.updated", sessionId: session.id });
    }
  }
  for (const session of previous.sessions) {
    if (!next.sessions.some((candidate) => candidate.id === session.id)) {
      events.push({ type: "session.updated", sessionId: session.id });
    }
  }

  const previousRooms = new Map(previous.rooms.map((room) => [room.id, room]));
  let roomsChanged = false;
  for (const room of next.rooms) {
    const before = previousRooms.get(room.id);
    if (before === undefined || roomSignature(before) !== roomSignature(room)) {
      roomsChanged = true;
      break;
    }
  }
  if (!roomsChanged) {
    roomsChanged = previous.rooms.some(
      (room) => !next.rooms.some((candidate) => candidate.id === room.id),
    );
  }
  if (roomsChanged) {
    events.push({ type: "state.updated", scope: "rooms" });
  }

  for (const scope of COLLECTION_SCOPES) {
    if (!sameIds(idSet(previous[scope]), idSet(next[scope]))) {
      events.push({ type: "state.updated", scope });
    }
  }

  return events;
}

export interface FusionStateHubOptions {
  bus?: FusionEventBus;
  /** How often the fleet slice is refreshed in the background. */
  intervalMs?: number;
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}

/**
 * Owns one merged view of the live state and publishes what changed.
 *
 * The fleet slice (nodes, tasks, fleet provider health) refreshes on a timer
 * because it only needs the plugin's own machine credentials. The bridge
 * slice (AgentTeams, Agent Bus, Room) can only be read inside an
 * authenticated request, so it is merged in from there. Both slices share
 * one diff baseline, so a bridge refresh never emits a false fleet event.
 */
export class FusionStateHub {
  readonly bus: FusionEventBus;
  private readonly intervalMs: number;
  private readonly setInterval: (handler: () => void, ms: number) => unknown;
  private readonly clearInterval: (handle: unknown) => void;
  private readonly onError: (error: unknown) => void;
  private handle: unknown;
  private previous: FusionWatchSnapshot | undefined;
  private fleetSnapshot: Partial<FusionWatchSnapshot> = {};
  private bridgeSnapshot: Partial<FusionWatchSnapshot> = {};
  private fleetReader: (() => Promise<Partial<FusionWatchSnapshot>>) | undefined;
  private fleetPolling = false;

  constructor(options: FusionStateHubOptions = {}) {
    this.bus = options.bus ?? new FusionEventBus();
    this.intervalMs = Math.max(250, Math.trunc(options.intervalMs ?? 10_000));
    this.setInterval = options.setInterval ?? ((handler, ms) => setInterval(handler, ms));
    this.clearInterval = options.clearInterval
      ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
    this.onError = options.onError ?? (() => {});
  }

  get running(): boolean {
    return this.handle !== undefined;
  }

  get lastSeq(): number {
    return this.bus.lastSeq;
  }

  /** Registers the background reader for the credential-free fleet slice. */
  onFleetRefresh(reader: () => Promise<Partial<FusionWatchSnapshot>>): void {
    this.fleetReader = reader;
  }

  /** Records the bridge slice read inside an authenticated request. */
  mergeBridgeSnapshot(snapshot: Partial<FusionWatchSnapshot>): FusionEventInput[] {
    this.bridgeSnapshot = { ...this.bridgeSnapshot, ...pickBridgeFields(snapshot) };
    return this.publishMerged();
  }

  /** Records the fleet slice and publishes the merged diff. */
  mergeFleetSnapshot(snapshot: Partial<FusionWatchSnapshot>): FusionEventInput[] {
    this.fleetSnapshot = { ...this.fleetSnapshot, ...pickFleetFields(snapshot) };
    return this.publishMerged();
  }

  /**
   * Records a full live snapshot read inside an authenticated request. The
   * fleet-owned and bridge-owned fields are separated so the background
   * poller can refresh one slice without discarding the other, and the
   * merged diff is published exactly once.
   */
  mergeLiveSnapshot(snapshot: Partial<FusionWatchSnapshot>): FusionEventInput[] {
    this.fleetSnapshot = { ...this.fleetSnapshot, ...pickFleetFields(snapshot) };
    this.bridgeSnapshot = { ...this.bridgeSnapshot, ...pickBridgeFields(snapshot) };
    return this.publishMerged();
  }

  start(): void {
    if (this.handle !== undefined) return;
    this.handle = this.setInterval(() => {
      void this.refreshFleet();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.handle === undefined) return;
    this.clearInterval(this.handle);
    this.handle = undefined;
  }

  async refreshFleet(): Promise<void> {
    if (this.fleetPolling || this.fleetReader === undefined) return;
    this.fleetPolling = true;
    try {
      this.mergeFleetSnapshot(await this.fleetReader());
    } catch (error) {
      this.onError(error);
    } finally {
      this.fleetPolling = false;
    }
  }

  private publishMerged(): FusionEventInput[] {
    const merged: FusionWatchSnapshot = {
      nodes: this.fleetSnapshot.nodes ?? [],
      tasks: this.fleetSnapshot.tasks ?? [],
      bridgeTasks: this.bridgeSnapshot.bridgeTasks ?? [],
      config: this.fleetSnapshot.config ?? [],
      providers: {
        ...(this.bridgeSnapshot.providers ?? {}),
        ...(this.fleetSnapshot.providers ?? {}),
      },
      agentTeams: this.bridgeSnapshot.agentTeams ?? [],
      agentFlows: this.bridgeSnapshot.agentFlows ?? [],
      rooms: this.bridgeSnapshot.rooms ?? [],
      bots: this.bridgeSnapshot.bots ?? [],
      groups: this.bridgeSnapshot.groups ?? [],
      sessions: this.bridgeSnapshot.sessions ?? [],
    };
    const events = diffFusionSnapshots(this.previous, merged);
    this.previous = merged;
    for (const event of events) this.bus.publish(event);
    return events;
  }
}
