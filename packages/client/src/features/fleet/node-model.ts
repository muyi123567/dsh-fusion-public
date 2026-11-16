import type { ConfigState, NodeRecord, NodeStatus } from "@dsh-fusion/core";

const statusRank: Record<NodeStatus, number> = {
  offline: -1,
  degraded: 1,
  online: 2,
};

const configRank: Record<ConfigState, number> = {
  unknown: 0,
  current: 1,
  drift: 2,
};

function mergeNode(target: NodeRecord, incoming: NodeRecord): NodeRecord {
  const transports = [...new Set([...target.transports, ...incoming.transports])];
  const capabilities = [...new Set([...target.capabilities, ...incoming.capabilities])];
  const roles = [...new Set([...target.roles, ...incoming.roles])];
  const targetHeartbeat = Date.parse(target.lastHeartbeat ?? "");
  const incomingHeartbeat = Date.parse(incoming.lastHeartbeat ?? "");
  const incomingIsNewer = Number.isFinite(incomingHeartbeat)
    && (!Number.isFinite(targetHeartbeat) || incomingHeartbeat > targetHeartbeat);
  const targetIsNewer = Number.isFinite(targetHeartbeat)
    && (!Number.isFinite(incomingHeartbeat) || targetHeartbeat > incomingHeartbeat);
  const status = incomingIsNewer
    ? incoming.status
    : targetIsNewer
      ? target.status
      : statusRank[incoming.status] < statusRank[target.status]
        ? incoming.status
        : target.status;
  const configState = configRank[incoming.configState] > configRank[target.configState]
    ? incoming.configState
    : target.configState;

  return {
    ...target,
    name: target.name || incoming.name,
    platform: target.platform === "unknown" ? incoming.platform : target.platform,
    roles,
    status,
    transports,
    capabilities,
    configState,
    ...(target.dshVersion === undefined && incoming.dshVersion !== undefined
      ? { dshVersion: incoming.dshVersion }
      : {}),
    ...(target.configHash === undefined && incoming.configHash !== undefined
      ? { configHash: incoming.configHash }
      : {}),
    ...(incomingIsNewer && incoming.lastHeartbeat !== undefined
      ? { lastHeartbeat: incoming.lastHeartbeat }
      : {}),
    ...(target.cpuPercent === undefined && incoming.cpuPercent !== undefined
      ? { cpuPercent: incoming.cpuPercent }
      : {}),
    ...(target.memoryPercent === undefined && incoming.memoryPercent !== undefined
      ? { memoryPercent: incoming.memoryPercent }
      : {}),
  };
}

export function mergeNodes(nodes: NodeRecord[]): NodeRecord[] {
  const merged: NodeRecord[] = [];
  const indexes = new Map<string, number>();

  for (const node of nodes) {
    const fallbackKey = `${node.providerId}:${node.externalId}`;
    const key = node.id || fallbackKey;
    const existingIndex = indexes.get(key) ?? indexes.get(fallbackKey);

    if (existingIndex === undefined) {
      indexes.set(key, merged.length);
      indexes.set(fallbackKey, merged.length);
      merged.push({ ...node });
      continue;
    }

    merged[existingIndex] = mergeNode(merged[existingIndex]!, node);
    indexes.set(key, existingIndex);
    indexes.set(fallbackKey, existingIndex);
  }

  return merged;
}
