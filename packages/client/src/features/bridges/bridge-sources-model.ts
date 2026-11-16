import type {
  AgentFlowRecord,
  AgentTeamRecord,
  ProviderHealthState,
  ProviderStatus,
  RoomRecord,
} from "@dsh-fusion/core";

export interface BridgeProviderStatus extends ProviderStatus {
  error?: {
    code?: string;
    message?: string;
  };
}

export type FusionProviderStatusMap = Record<string, BridgeProviderStatus>;
export type BridgeFallbackReason = "missing" | "empty" | "unavailable";
export type BridgeSourceMode = "live" | "demo" | "unavailable";

export interface BridgeSourceState<T> {
  items: T[];
  mode: BridgeSourceMode;
  fallbackReason?: BridgeFallbackReason;
}

export interface ResolvedBridgeSources {
  agentTeams: BridgeSourceState<AgentTeamRecord>;
  agentFlows: BridgeSourceState<AgentFlowRecord>;
  rooms: BridgeSourceState<RoomRecord>;
  providers: FusionProviderStatusMap;
}

export const demoAgentTeams: readonly AgentTeamRecord[] = [
  {
    id: "demo:agent-teams:release",
    providerId: "agent-teams",
    name: "发布验收小组",
    workspace: "F:\\AI\\release",
    phase: "running",
    captainSessionId: "demo:agent-teams:captain",
    memberIds: ["demo:agent-teams:reviewer", "demo:agent-teams:builder"],
    taskIds: ["demo:agent-teams:review", "demo:agent-teams:build"],
  },
];

export const demoAgentFlows: readonly AgentFlowRecord[] = [
  {
    id: "demo:agent-bus:release",
    providerId: "agent-bus",
    name: "桌面发布流",
    description: "构建、验收并归档发布产物",
    workspacePath: "F:\\AI\\dsh-fusion",
    taskIds: ["demo:agent-bus:build", "demo:agent-bus:verify"],
    archived: false,
  },
];

export const demoRooms: readonly RoomRecord[] = [
  {
    id: "demo:agent-room:release",
    providerId: "agent-room",
    name: "发布协调室",
    topic: "跟进发布阻塞与验收结论",
    status: "open",
    leaderSessionId: "demo:agent-room:leader",
    memberIds: ["demo:agent-room:captain", "demo:agent-room:reviewer", "demo:agent-room:operator"],
    activityCount: 4,
  },
];

function resolveSource<T>(
  items: readonly T[] | null | undefined,
  demoItems: readonly T[],
  status: BridgeProviderStatus | undefined,
  allowDemo: boolean,
): BridgeSourceState<T> {
  if (status !== undefined) {
    if (status.state === "connected" || status.state === "degraded") {
      return { items: Array.isArray(items) ? [...items] : [], mode: "live" };
    }
    return {
      items: [],
      mode: "unavailable",
      fallbackReason: "unavailable",
    };
  }

  if (Array.isArray(items) && items.length > 0) {
    return { items: [...items], mode: "live" };
  }

  if (!allowDemo) {
    return {
      items: Array.isArray(items) ? [...items] : [],
      mode: "unavailable",
      fallbackReason: "unavailable",
    };
  }

  if (!Array.isArray(items)) {
    return { items: [...demoItems], mode: "demo", fallbackReason: "missing" };
  }
  return { items: [...demoItems], mode: "demo", fallbackReason: "empty" };
}

export function resolveBridgeSources(input: {
  agentTeams?: readonly AgentTeamRecord[] | null | undefined;
  agentFlows?: readonly AgentFlowRecord[] | null | undefined;
  rooms?: readonly RoomRecord[] | null | undefined;
  providers?: FusionProviderStatusMap | undefined;
  allowDemo?: boolean | undefined;
}): ResolvedBridgeSources {
  const providers = input.providers ?? {};
  const allowDemo = input.allowDemo ?? true;
  return {
    agentTeams: resolveSource(input.agentTeams, demoAgentTeams, providers.agentTeams, allowDemo),
    agentFlows: resolveSource(input.agentFlows, demoAgentFlows, providers.agentBus, allowDemo),
    rooms: resolveSource(input.rooms, demoRooms, providers.room, allowDemo),
    providers,
  };
}

export function providerStateLabel(state?: ProviderHealthState): string {
  if (state === "connected") return "已连接";
  if (state === "degraded") return "降级";
  if (state === "offline") return "离线";
  if (state === "not-configured") return "未配置";
  return "未报告";
}

export function providerLabel(providerId: string): string {
  if (providerId === "nodes") return "Nodes";
  if (providerId === "agentTeams") return "AgentTeams";
  if (providerId === "agentBus") return "AgentBus";
  if (providerId === "room") return "Rooms";
  if (providerId === "huawei") return "Remote Nodes";
  return providerId
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function providerStatusDetail(status?: BridgeProviderStatus): string {
  if (status === undefined) return "Provider 未报告状态";
  const message = status.message ?? status.error?.message;
  if (message !== undefined && message.trim() !== "") return message;
  if (status.version !== undefined && status.version.trim() !== "") return `v${status.version}`;
  if (Number.isFinite(status.checkedAt)) {
    const checkedAt = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(status.checkedAt));
    return `${checkedAt} 检查`;
  }
  return "状态正常";
}

const providerOrder = ["nodes", "agentTeams", "agentBus", "room", "huawei"] as const;

export function orderedProviderStatuses(
  providers: FusionProviderStatusMap,
): Array<[string, BridgeProviderStatus]> {
  const rank = new Map<string, number>(providerOrder.map((providerId, index) => [providerId, index]));
  return Object.entries(providers).sort(([left], [right]) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  });
}
