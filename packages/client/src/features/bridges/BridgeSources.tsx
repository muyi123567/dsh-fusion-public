import { useMemo, type ReactNode } from "react";
import { Bot, Cable, GitBranch, MessagesSquare } from "lucide-react";
import type {
  AgentFlowRecord,
  AgentTeamRecord,
  RoomRecord,
} from "@dsh-fusion/core";
import {
  orderedProviderStatuses,
  providerLabel,
  providerStateLabel,
  providerStatusDetail,
  resolveBridgeSources,
  type BridgeFallbackReason,
  type BridgeProviderStatus,
  type FusionProviderStatusMap,
  type BridgeSourceMode,
} from "./bridge-sources-model.js";
import "./bridge-sources.css";

function fallbackLabel(reason: BridgeFallbackReason): string {
  if (reason === "unavailable") return "Provider 不可用";
  return reason === "missing" ? "接口未返回 · 演示回退" : "实时为空 · 演示回退";
}

function sourceModeLabel(mode: BridgeSourceMode): string {
  if (mode === "live") return "实时数据";
  if (mode === "demo") return "演示回退";
  return "来源不可用";
}

function SourceStatus({ status }: { status?: BridgeProviderStatus }) {
  const state = status?.state ?? "unknown";
  return (
    <span className={`fusion-bridge-provider-state ${state}`} title={providerStatusDetail(status)}>
      <span className="fusion-bridge-state-dot" />
      {providerStateLabel(status?.state)}
    </span>
  );
}

function SourceColumn({
  icon,
  title,
  mode,
  fallbackReason,
  status,
  summary,
  records,
}: {
  icon: ReactNode;
  title: string;
  mode: BridgeSourceMode;
  fallbackReason?: BridgeFallbackReason;
  status?: BridgeProviderStatus;
  summary: string;
  records: string[];
}) {
  return (
    <article className="fusion-bridge-source">
      <div className="fusion-bridge-source-head">
        <span className="fusion-bridge-source-icon">{icon}</span>
        <strong>{title}</strong>
        <SourceStatus {...(status === undefined ? {} : { status })} />
      </div>
      <div className="fusion-bridge-source-meta">
        <span className={`is-${mode}`}>
          {sourceModeLabel(mode)}
        </span>
        {fallbackReason === undefined ? null : <small>{fallbackLabel(fallbackReason)}</small>}
      </div>
      <p>{summary}</p>
      <ul aria-label={`${title} 记录`}>
        {records.length === 0
          ? <li className="is-empty">暂无实时记录</li>
          : records.map((record) => <li key={record} title={record}>{record}</li>)}
      </ul>
      <small className="fusion-bridge-source-detail">{providerStatusDetail(status)}</small>
    </article>
  );
}

function sumBy<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function teamRecords(teams: readonly AgentTeamRecord[]): string[] {
  return teams.slice(0, 3).map((team) => team.phase === "archived" ? `${team.name} · 已归档` : team.name);
}

function flowRecords(flows: readonly AgentFlowRecord[]): string[] {
  return flows.slice(0, 3).map((flow) => flow.archived ? `${flow.name} · 已归档` : flow.name);
}

function roomRecords(rooms: readonly RoomRecord[]): string[] {
  return rooms.flatMap((room) => {
    const message = room.conversation?.messages.at(-1);
    if (message !== undefined) {
      const preview = message.text.replace(/\s+/gu, " ").slice(0, 72);
      return [`${room.name} · ${message.authorName}: ${preview}`];
    }
    const activity = room.activity?.at(-1);
    if (activity !== undefined) return [`${room.name} · ${activity.label}`];
    return [room.status === "closed" ? `${room.name} · 已关闭` : room.name];
  }).slice(0, 3);
}

export interface BridgeSourcesProps {
  agentTeams?: readonly AgentTeamRecord[] | null;
  agentFlows?: readonly AgentFlowRecord[] | null;
  rooms?: readonly RoomRecord[] | null;
  providers?: FusionProviderStatusMap;
  allowDemo?: boolean;
}

export function BridgeSources({
  agentTeams,
  agentFlows,
  rooms,
  providers,
  allowDemo,
}: BridgeSourcesProps) {
  const bridge = useMemo(
    () => resolveBridgeSources({
      agentTeams,
      agentFlows,
      rooms,
      ...(providers === undefined ? {} : { providers }),
      ...(allowDemo === undefined ? {} : { allowDemo }),
    }),
    [agentTeams, agentFlows, rooms, providers, allowDemo],
  );
  const liveSources = [bridge.agentTeams.mode, bridge.agentFlows.mode, bridge.rooms.mode]
    .filter((mode) => mode === "live").length;
  const extraProviders = orderedProviderStatuses(bridge.providers)
    .filter(([providerId]) => providerId !== "agentTeams" && providerId !== "agentBus" && providerId !== "room");

  return (
    <section className="fusion-bridge-sources" aria-label="Bridge 与 Source 状态">
      <header className="fusion-bridge-head">
        <div>
          <span className="fusion-bridge-head-icon"><Cable size={15} /></span>
          <div>
            <strong>Bridge / Source</strong>
            <small>统一领域数据与 Provider 健康状态</small>
          </div>
        </div>
        <span className={`fusion-bridge-live-count ${liveSources === 3 ? "is-complete" : ""}`}>
          {liveSources}/3 实时来源
        </span>
      </header>

      <div className="fusion-bridge-source-grid">
        <SourceColumn
          icon={<Bot size={15} />}
          title="AgentTeams"
          mode={bridge.agentTeams.mode}
          {...(bridge.agentTeams.fallbackReason === undefined ? {} : { fallbackReason: bridge.agentTeams.fallbackReason })}
          {...(bridge.providers.agentTeams === undefined ? {} : { status: bridge.providers.agentTeams })}
          summary={`${bridge.agentTeams.items.length} 个小组 · ${sumBy(bridge.agentTeams.items, (team) => team.memberIds.length)} 成员 · ${sumBy(bridge.agentTeams.items, (team) => team.taskIds.length)} 任务`}
          records={teamRecords(bridge.agentTeams.items)}
        />
        <SourceColumn
          icon={<GitBranch size={15} />}
          title="AgentBus"
          mode={bridge.agentFlows.mode}
          {...(bridge.agentFlows.fallbackReason === undefined ? {} : { fallbackReason: bridge.agentFlows.fallbackReason })}
          {...(bridge.providers.agentBus === undefined ? {} : { status: bridge.providers.agentBus })}
          summary={`${bridge.agentFlows.items.length} 条流程 · ${sumBy(bridge.agentFlows.items, (flow) => flow.taskIds.length)} 任务绑定`}
          records={flowRecords(bridge.agentFlows.items)}
        />
        <SourceColumn
          icon={<MessagesSquare size={15} />}
          title="Rooms"
          mode={bridge.rooms.mode}
          {...(bridge.rooms.fallbackReason === undefined ? {} : { fallbackReason: bridge.rooms.fallbackReason })}
          {...(bridge.providers.room === undefined ? {} : { status: bridge.providers.room })}
          summary={`${bridge.rooms.items.length} 个房间 · ${sumBy(bridge.rooms.items, (room) => room.memberIds.length)} 成员 · ${sumBy(bridge.rooms.items, (room) => room.activityCount)} 活动`}
          records={roomRecords(bridge.rooms.items)}
        />
      </div>

      {extraProviders.length === 0 ? null : (
        <div className="fusion-bridge-provider-strip" aria-label="其他 Provider 状态">
          {extraProviders.map(([providerId, status]) => (
            <span key={providerId} title={providerStatusDetail(status)}>
              <strong>{providerLabel(providerId)}</strong>
              <span className={`fusion-bridge-provider-state ${status.state}`}>
                <span className="fusion-bridge-state-dot" />
                {providerStateLabel(status.state)}
              </span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
