import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import { configHash } from "./hash.js";
import {
  fleetConfigSchema,
  type FleetConfig,
  type RenderedNodeConfig,
} from "./schema.js";

export function loadFleetConfig(sourceOrPath: string): FleetConfig {
  const source =
    !sourceOrPath.includes("\n") && existsSync(sourceOrPath)
      ? readFileSync(sourceOrPath, "utf8")
      : sourceOrPath;
  return fleetConfigSchema.parse(YAML.parse(source));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function lastDefined<T, K extends keyof T>(values: T[], key: K): T[K] | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && value !== null && value[key] !== undefined) return value[key];
  }
  return undefined;
}

export function renderNode(config: FleetConfig, nodeId: string): RenderedNodeConfig {
  const node = config.nodes[nodeId];
  if (node === undefined) throw new Error(`unknown node: ${nodeId}`);

  const roleOverlays = node.roles.map((role) => config.roles[role] ?? { paths: {}, capabilities: [] });
  const paths = Object.assign(
    {},
    config.base.paths,
    ...roleOverlays.map((role) => role.paths),
    node.paths,
  );
  const capabilities = unique([
    ...config.base.capabilities,
    ...roleOverlays.flatMap((role) => role.capabilities),
    ...node.capabilities,
  ]);
  const transport =
    node.transport ??
    lastDefined(roleOverlays, "transport") ??
    config.defaults.transport;
  const dshVersion =
    node.dshVersion ??
    lastDefined(roleOverlays, "dshVersion") ??
    config.defaults.dshVersion;

  const rendered = {
    nodeId,
    platform: node.platform,
    roles: node.roles,
    paths,
    workspaceRoots: node.workspaceRoots,
    capabilities,
    transport,
    dshVersion,
  };

  return { ...rendered, hash: configHash(rendered) };
}
