import type { NodeRecord } from "./types.js";

export const DEFAULT_EXEC_CAPABILITY_TTL_MS = 30_000;

export interface ExecCapabilityCheck {
  id: string;
  ok: boolean;
}

/** Observation of job infrastructure; never an authorization or business verdict. */
export interface ExecCapabilityObservation {
  nodeId: string;
  providerId: string;
  state: "supported" | "unsupported" | "unknown";
  checkedAt: number;
  expiresAt: number;
  source: string;
  reasonCodes: string[];
  checks: ExecCapabilityCheck[];
}

export interface ExecutionPreviewNode {
  nodeId: string;
  name: string;
  decision: "eligible" | "blocked" | "unknown";
  reasonCodes: string[];
  observation?: ExecCapabilityObservation;
}

export interface ExecutionPreview {
  version: 1;
  checkedAt: number;
  expiresAt: number;
  selectedNodeIds: string[];
  ready: boolean;
  scope: "infrastructure-only";
  businessRequirements: "unverified";
  nodes: ExecutionPreviewNode[];
}

function hasObservationShape(value: ExecCapabilityObservation): boolean {
  return ["supported", "unsupported", "unknown"].includes(value.state)
    && typeof value.source === "string" && value.source.trim().length > 0
    && Array.isArray(value.reasonCodes) && value.reasonCodes.every(code => typeof code === "string")
    && Array.isArray(value.checks) && value.checks.every(check => check !== null && typeof check === "object"
      && typeof check.id === "string" && check.id.length > 0 && typeof check.ok === "boolean")
    && (value.state === "unknown" || value.checks.length > 0);
}

export function buildExecutionPreview(input: {
  nodes: readonly NodeRecord[];
  nodeIds: readonly string[];
  observations: readonly ExecCapabilityObservation[];
  now: number;
  policyAllowsExecution?: boolean;
}): ExecutionPreview {
  if (!Number.isFinite(input.now)) throw new Error("FUSION_PREVIEW_TIME_INVALID");
  const selectedNodeIds = [...new Set(input.nodeIds)];
  const nodesById = new Map(input.nodes.map(node => [node.id, node]));
  const nodes = selectedNodeIds.map((nodeId): ExecutionPreviewNode => {
    const node = nodesById.get(nodeId);
    const base = { nodeId, name: node?.name ?? nodeId };
    if (node === undefined) return { ...base, decision: "blocked", reasonCodes: ["NODE_NOT_FOUND"] };
    if (input.policyAllowsExecution === false) return { ...base, decision: "blocked", reasonCodes: ["POLICY_BLOCKED"] };
    if (node.status !== "online") return { ...base, decision: "blocked", reasonCodes: ["NODE_OFFLINE"] };
    const candidates = input.observations.filter(item => item !== null && typeof item === "object"
      && item.nodeId === nodeId && item.providerId === node.providerId);
    if (candidates.some(item => !hasObservationShape(item))) {
      return { ...base, decision: "unknown", reasonCodes: ["PROBE_INCOMPLETE"] };
    }
    const latest = candidates.reduce<ExecCapabilityObservation | undefined>((current, item) =>
      current === undefined || item.checkedAt > current.checkedAt ? item : current, undefined);
    if (latest === undefined) return { ...base, decision: "unknown", reasonCodes: ["PROBE_UNAVAILABLE"] };
    const observation: ExecCapabilityObservation = {
      ...latest, reasonCodes: [...latest.reasonCodes], checks: latest.checks.map(check => ({ ...check })),
    };
    const result = { ...base, observation };
    const validTime = Number.isFinite(latest.checkedAt) && Number.isFinite(latest.expiresAt)
      && latest.checkedAt >= 0 && latest.checkedAt <= input.now && latest.expiresAt > latest.checkedAt
      && latest.expiresAt <= latest.checkedAt + DEFAULT_EXEC_CAPABILITY_TTL_MS;
    if (!validTime) return { ...base, decision: "unknown", reasonCodes: ["PROBE_INCOMPLETE"] };
    if (latest.expiresAt <= input.now) return { ...result, decision: "unknown", reasonCodes: ["OBSERVATION_EXPIRED"] };
    if (latest.state === "unknown") return { ...result, decision: "unknown", reasonCodes: latest.reasonCodes.length ? [...latest.reasonCodes] : ["PROBE_FAILED"] };
    if (latest.state === "unsupported") return { ...result, decision: "blocked", reasonCodes: latest.reasonCodes.length ? [...latest.reasonCodes] : ["PREREQUISITES_MISSING"] };
    if (!latest.source.trim() || latest.checks.length === 0 || latest.checks.some(check => !check.ok)) {
      return { ...result, decision: "unknown", reasonCodes: ["PROBE_INCOMPLETE"] };
    }
    return { ...result, decision: "eligible", reasonCodes: ["BASIC_CHECKS_PASSED"] };
  });
  return {
    version: 1,
    checkedAt: input.now,
    // Unknown/blocked findings are useful diagnostic results, not expired grants.
    // Only positive observations shorten the fresh diagnostic display window.
    expiresAt: Math.min(input.now + DEFAULT_EXEC_CAPABILITY_TTL_MS,
      ...nodes.filter(node => node.decision === "eligible").map(node => node.observation!.expiresAt)),
    selectedNodeIds,
    ready: nodes.length > 0 && nodes.every(node => node.decision === "eligible"),
    scope: "infrastructure-only",
    businessRequirements: "unverified",
    nodes,
  };
}
