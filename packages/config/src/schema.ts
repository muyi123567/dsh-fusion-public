import { z } from "zod";

const transportSchema = z.enum(["seekfleet", "dsh-fleet", "yobiru", "tincan", "ssh"]);
const platformSchema = z.enum(["windows", "linux", "macos", "unknown"]);
const roleSchema = z.enum(["control", "worker"]);

const overlaySchema = z.object({
  paths: z.record(z.string(), z.string()).default({}),
  capabilities: z.array(z.string()).default([]),
  transport: transportSchema.optional(),
  dshVersion: z.string().optional(),
});

const nodeSchema = overlaySchema.extend({
  platform: platformSchema.default("unknown"),
  roles: z.array(roleSchema).min(1),
  workspaceRoots: z.array(z.string()).default([]),
});

export const fleetConfigSchema = z.object({
  version: z.literal(1),
  defaults: z.object({
    dshVersion: z.string().default("0.2.0-rc.2"),
    transport: transportSchema.default("seekfleet"),
  }),
  base: overlaySchema.default({ paths: {}, capabilities: [] }),
  roles: z.record(z.string(), overlaySchema).default({}),
  nodes: z.record(z.string(), nodeSchema),
});

export type FleetConfig = z.infer<typeof fleetConfigSchema>;
export type FleetNode = FleetConfig["nodes"][string];
export type TransportKind = z.infer<typeof transportSchema>;

export interface RenderedNodeConfig {
  nodeId: string;
  platform: FleetNode["platform"];
  roles: FleetNode["roles"];
  paths: Record<string, string>;
  workspaceRoots: string[];
  capabilities: string[];
  transport: TransportKind;
  dshVersion: string;
  hash: string;
}
