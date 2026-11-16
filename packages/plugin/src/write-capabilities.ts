import {
  AGENT_TEAMS_WRITE_ACTIONS,
  type FusionToolHostContext,
} from "./upstream-tools.js";
import { AGENT_BUS_WRITE_ACTIONS } from "./agent-bus-upstream-tools.js";
import { ROOM_WRITE_ACTIONS } from "./room-upstream-tools.js";

/**
 * Per-action write capability snapshot (review 04 P1-3, gaps
 * G6 + G8). Until now a write action whose prerequisites were
 * broken simply failed at call time — or, at registration
 * time, silently never appeared — and "the upstream tool is
 * not there" was indistinguishable from "the upstream tool
 * ran and failed". This snapshot is the read-only answer: for
 * each of the fifteen bridge write actions it reports whether
 * every Fusion-side prerequisite currently holds (opt-in
 * switch, registry execute capability, approval service where
 * the action needs one), with a stable reason code per failed
 * prerequisite, and a checkedAt stamp.
 *
 * Upstream existence is reported as "unknown" on purpose: the
 * registry surface offers no lookup, so Fusion cannot probe
 * whether an upstream tool exists without executing it. A
 * "ready" action can therefore still fail at execution time;
 * that failure keeps the execution layer's own versioned
 * codes (FUSION_UPSTREAM_TOOLS_UNAVAILABLE when the registry
 * has no execute capability at all, UpstreamToolError with
 * the upstream code when execution itself fails).
 */
export interface WriteActionCapability {
  action: string;
  upstream: string;
  approvalRequired: boolean;
  state: "ready" | "unavailable";
  reasons: string[];
}

export interface WriteFamilyCapability {
  writesEnabled: boolean;
  executeCapability: boolean;
  /** null when the family has no approval step at all. */
  approvalService: boolean | null;
  upstreamExistence: "unknown";
  actions: WriteActionCapability[];
}

export interface WriteCapabilitiesSnapshot {
  checkedAt: number;
  families: {
    agentTeams: WriteFamilyCapability;
    agentBus: WriteFamilyCapability;
    room: WriteFamilyCapability;
  };
}

export interface WriteCapabilitySwitches {
  agentTeams: boolean;
  agentBus: boolean;
  room: boolean;
}

/**
 * Non-throwing mirror of the bridges' approval validators
 * (approvalService / roomApprovalService): a throwing ctx.get,
 * a null/non-object service, or a non-callable request all
 * mean approval is unavailable.
 */
function approvalServiceAvailable(ctx: FusionToolHostContext): boolean {
  let service: unknown;
  try {
    service = ctx.get?.("approval");
  } catch {
    return false;
  }
  return (
    service !== null
    && typeof service === "object"
    && typeof (service as { request?: unknown }).request === "function"
  );
}

interface ActionDescriptor {
  action: string;
  upstream: string;
  approvalRequired: boolean;
}

function familyCapability(
  descriptors: readonly ActionDescriptor[],
  writesEnabled: boolean,
  executeCapability: boolean,
  approvalService: boolean | null,
): WriteFamilyCapability {
  return {
    writesEnabled,
    executeCapability,
    approvalService,
    upstreamExistence: "unknown",
    actions: descriptors.map((descriptor) => {
      const reasons: string[] = [];
      if (!writesEnabled) reasons.push("WRITES_DISABLED");
      if (!executeCapability) reasons.push("UPSTREAM_EXECUTE_UNAVAILABLE");
      if (descriptor.approvalRequired && approvalService !== true) {
        reasons.push("APPROVAL_UNAVAILABLE");
      }
      return {
        action: descriptor.action,
        upstream: descriptor.upstream,
        approvalRequired: descriptor.approvalRequired,
        state: reasons.length === 0 ? "ready" as const : "unavailable" as const,
        reasons,
      };
    }),
  };
}

export function writeCapabilitiesSnapshot(
  ctx: FusionToolHostContext,
  switches: WriteCapabilitySwitches,
  checkedAt: number,
): WriteCapabilitiesSnapshot {
  const executeCapability = typeof ctx.tools?.execute === "function";
  const approval = approvalServiceAvailable(ctx);
  return {
    checkedAt,
    families: {
      agentTeams: familyCapability(
        AGENT_TEAMS_WRITE_ACTIONS,
        switches.agentTeams,
        executeCapability,
        approval,
      ),
      agentBus: familyCapability(
        AGENT_BUS_WRITE_ACTIONS,
        switches.agentBus,
        executeCapability,
        null,
      ),
      room: familyCapability(
        ROOM_WRITE_ACTIONS,
        switches.room,
        executeCapability,
        approval,
      ),
    },
  };
}

const FAMILY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    writesEnabled: { type: "boolean" },
    executeCapability: { type: "boolean" },
    approvalService: {
      oneOf: [{ type: "boolean" }, { type: "null" }],
    },
    upstreamExistence: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string" },
          upstream: { type: "string" },
          approvalRequired: { type: "boolean" },
          state: { type: "string" },
          reasons: { type: "array", items: { type: "string" } },
        },
        required: ["action", "upstream", "approvalRequired", "state", "reasons"],
      },
    },
  },
  required: ["writesEnabled", "executeCapability", "approvalService", "upstreamExistence", "actions"],
} as const;

/** JSON schema for the snapshot, for tool output declarations. */
export const WRITE_CAPABILITIES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    checkedAt: { type: "number" },
    families: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentTeams: FAMILY_SCHEMA,
        agentBus: FAMILY_SCHEMA,
        room: FAMILY_SCHEMA,
      },
      required: ["agentTeams", "agentBus", "room"],
    },
  },
  required: ["checkedAt", "families"],
} as const;
