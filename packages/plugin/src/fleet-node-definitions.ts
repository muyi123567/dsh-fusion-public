import type { HostAccessPolicy } from "@dsh-fusion/core";

export interface FleetSshNodeDefinition {
  nodeId: string;
  host: string;
  keyPath: string;
  knownHostsPath: string;
  name?: string;
  sshPath?: string;
  jobRoot?: string;
  outputLimitBytes?: number;
  hostAccess?: HostAccessPolicy;
}

export interface FleetInstaboxNodeDefinition {
  nodeId: string;
  machineName: string;
  name?: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
  jobRoot?: string;
  outputLimitBytes?: number;
  hostAccess?: HostAccessPolicy;
}

export interface FleetNodeDefinitionInput {
  sshNodes?: FleetSshNodeDefinition[];
  instaboxNodes?: FleetInstaboxNodeDefinition[];
}

const SAFE_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(code);
  return normalized;
}

function optional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function normalizeHostAccess(
  nodeId: string,
  input: HostAccessPolicy | undefined,
): HostAccessPolicy | undefined {
  if (input === undefined) return undefined;
  const ownerId = optional(input.ownerId);
  const sharingMode = input.sharingMode ?? "dedicated";
  if (sharingMode !== "dedicated" && sharingMode !== "shared") {
    throw new Error(`FLEET_HOST_SHARING_INVALID:${nodeId}`);
  }
  if (sharingMode === "shared" && ownerId === undefined) {
    throw new Error(`FLEET_HOST_OWNER_REQUIRED:${nodeId}`);
  }
  const maxConcurrentTasks = input.maxConcurrentTasks;
  if (
    maxConcurrentTasks !== undefined
    && (
      !Number.isInteger(maxConcurrentTasks)
      || maxConcurrentTasks < 1
      || maxConcurrentTasks > 64
    )
  ) {
    throw new Error(`FLEET_HOST_CONCURRENCY_INVALID:${nodeId}`);
  }
  if (ownerId === undefined && input.sharingMode === undefined && maxConcurrentTasks === undefined) {
    return undefined;
  }
  return {
    ...(ownerId === undefined ? {} : { ownerId }),
    sharingMode,
    ...(maxConcurrentTasks === undefined ? {} : { maxConcurrentTasks }),
  };
}

export function normalizeFleetNodeDefinitions(
  input: FleetNodeDefinitionInput,
): Required<FleetNodeDefinitionInput> {
  const sshNodes = (input.sshNodes ?? []).map((node) => {
    const nodeId = required(node.nodeId, "FLEET_NODE_ID_REQUIRED");
    if (!SAFE_NODE_ID.test(nodeId)) throw new Error(`FLEET_NODE_ID_INVALID:${nodeId}`);
    const outputLimitBytes = node.outputLimitBytes;
    if (
      outputLimitBytes !== undefined
      && (
        !Number.isInteger(outputLimitBytes)
        || outputLimitBytes < 16
        || outputLimitBytes > 512 * 1024
      )
    ) {
      throw new Error(`FLEET_OUTPUT_LIMIT_INVALID:${nodeId}`);
    }
    const hostAccess = normalizeHostAccess(nodeId, node.hostAccess);
    return {
      nodeId,
      host: required(node.host, `FLEET_SSH_HOST_REQUIRED:${nodeId}`),
      keyPath: required(node.keyPath, `FLEET_SSH_KEY_REQUIRED:${nodeId}`),
      knownHostsPath: required(
        node.knownHostsPath,
        `FLEET_SSH_KNOWN_HOSTS_REQUIRED:${nodeId}`,
      ),
      ...(optional(node.name) === undefined ? {} : { name: optional(node.name)! }),
      ...(optional(node.sshPath) === undefined ? {} : { sshPath: optional(node.sshPath)! }),
      ...(optional(node.jobRoot) === undefined ? {} : { jobRoot: optional(node.jobRoot)! }),
      ...(outputLimitBytes === undefined ? {} : { outputLimitBytes }),
      ...(hostAccess === undefined ? {} : { hostAccess }),
    };
  });
  const instaboxNodes = (input.instaboxNodes ?? []).map((node) => {
    const nodeId = required(node.nodeId, "FLEET_NODE_ID_REQUIRED");
    if (!SAFE_NODE_ID.test(nodeId)) throw new Error(`FLEET_NODE_ID_INVALID:${nodeId}`);
    const timeoutMs = node.timeoutMs;
    if (
      timeoutMs !== undefined
      && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    ) {
      throw new Error(`FLEET_TIMEOUT_INVALID:${nodeId}`);
    }
    const outputLimitBytes = node.outputLimitBytes;
    if (
      outputLimitBytes !== undefined
      && (
        !Number.isInteger(outputLimitBytes)
        || outputLimitBytes < 16
        || outputLimitBytes > 512 * 1024
      )
    ) {
      throw new Error(`FLEET_OUTPUT_LIMIT_INVALID:${nodeId}`);
    }
    const hostAccess = normalizeHostAccess(nodeId, node.hostAccess);
    return {
      nodeId,
      machineName: required(
        node.machineName,
        `FLEET_INSTABOX_MACHINE_REQUIRED:${nodeId}`,
      ),
      ...(optional(node.name) === undefined ? {} : { name: optional(node.name)! }),
      ...(optional(node.apiBaseUrl) === undefined
        ? {}
        : { apiBaseUrl: optional(node.apiBaseUrl)! }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(optional(node.jobRoot) === undefined ? {} : { jobRoot: optional(node.jobRoot)! }),
      ...(outputLimitBytes === undefined ? {} : { outputLimitBytes }),
      ...(hostAccess === undefined ? {} : { hostAccess }),
    };
  });

  const nodeIds = new Set<string>();
  for (const nodeId of [
    ...sshNodes.map((node) => node.nodeId),
    ...instaboxNodes.map((node) => node.nodeId),
  ]) {
    if (nodeIds.has(nodeId)) throw new Error(`FLEET_NODE_ID_DUPLICATE:${nodeId}`);
    nodeIds.add(nodeId);
  }

  return { sshNodes, instaboxNodes };
}
