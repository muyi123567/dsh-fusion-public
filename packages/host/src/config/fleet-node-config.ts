import { existsSync, statSync } from "node:fs";
import { isAbsolute, posix } from "node:path";
import { loadFleetConfig, renderNode } from "@dsh-fusion/config";
import type { RemoteNodeConfigInput } from "./remote-node-config.js";

export interface FleetNodeProjectionOptions {
  fleetNodeId: string;
  runtimeNodeId: string;
  displayName: string;
}

export type ProjectedRemoteNodeConfigInput = RemoteNodeConfigInput & {
  capabilities: string[];
};

function invalidWorkspaceRoot(nodeId: string, reason: string): never {
  throw new Error(`FLEET_CONFIG_WORKSPACE_ROOT_INVALID:${nodeId}:${reason}`);
}

function normalizeWorkspaceRoot(value: string, nodeId: string): string {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return invalidWorkspaceRoot(nodeId, "CONTROL_CHARACTER");
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return invalidWorkspaceRoot(nodeId, "WINDOWS_PATH");
  }
  if (value.startsWith("\\\\")) {
    return invalidWorkspaceRoot(nodeId, "UNC_PATH");
  }
  if (value.includes("\\")) {
    return invalidWorkspaceRoot(nodeId, "WINDOWS_PATH");
  }
  if (value.startsWith("//")) {
    return invalidWorkspaceRoot(nodeId, "UNC_PATH");
  }
  if (!posix.isAbsolute(value)) {
    return invalidWorkspaceRoot(nodeId, "NOT_ABSOLUTE");
  }
  if (value === "/") {
    return invalidWorkspaceRoot(nodeId, "ROOT");
  }
  if (value.split("/").includes("..")) {
    return invalidWorkspaceRoot(nodeId, "PARENT_SEGMENT");
  }

  const normalized = posix.normalize(value).replace(/\/+$/, "");
  if (normalized === "/") {
    return invalidWorkspaceRoot(nodeId, "ROOT");
  }
  return normalized;
}

export function loadFleetNodeConfig(
  path: string,
  options: FleetNodeProjectionOptions,
): ProjectedRemoteNodeConfigInput {
  if (!isAbsolute(path)) {
    throw new Error("FLEET_CONFIG_PATH_NOT_ABSOLUTE");
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error("FLEET_CONFIG_FILE_NOT_FOUND");
  }

  let config;
  try {
    config = loadFleetConfig(path);
  } catch {
    throw new Error("FLEET_CONFIG_INVALID");
  }

  if (config.nodes[options.fleetNodeId] === undefined) {
    throw new Error(`FLEET_CONFIG_NODE_NOT_FOUND:${options.fleetNodeId}`);
  }
  const rendered = renderNode(config, options.fleetNodeId);
  if (rendered.workspaceRoots.length !== 1) {
    throw new Error(
      `FLEET_CONFIG_WORKSPACE_ROOT_COUNT:${options.fleetNodeId}:${rendered.workspaceRoots.length}`,
    );
  }
  if (rendered.platform !== "linux") {
    throw new Error(
      `FLEET_CONFIG_PLATFORM_UNSUPPORTED:${options.fleetNodeId}:${rendered.platform}`,
    );
  }
  if (rendered.transport !== "ssh") {
    throw new Error(
      `FLEET_CONFIG_TRANSPORT_UNSUPPORTED:${options.fleetNodeId}:${rendered.transport}`,
    );
  }
  const workspaceRoot = normalizeWorkspaceRoot(
    rendered.workspaceRoots[0]!,
    options.fleetNodeId,
  );

  return {
    nodeId: options.runtimeNodeId,
    displayName: options.displayName,
    dshVersion: rendered.dshVersion,
    workspaceRoot,
    capabilities: rendered.capabilities,
  };
}
