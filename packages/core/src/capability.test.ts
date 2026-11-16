import { describe, expect, it } from "vitest";
import { buildExecutionPreview, type ExecCapabilityObservation } from "./capability.js";
import type { NodeRecord } from "./types.js";

const now = 100_000;
function node(id: string, status: NodeRecord["status"] = "online"): NodeRecord {
  return { id, externalId: id, providerId: "fixture", name: id, platform: "linux", roles: ["worker"], status,
    transports: ["ssh"], capabilities: ["linux"], configState: "unknown" };
}
function observed(id: string, patch: Partial<ExecCapabilityObservation> = {}): ExecCapabilityObservation {
  return { nodeId: id, providerId: "fixture", state: "supported", checkedAt: now - 100, expiresAt: now + 29_900,
    source: "fixture-readonly", reasonCodes: ["BASIC_CHECKS_PASSED"], checks: [{ id: "job-tools", ok: true }], ...patch };
}
function preview(nodes: NodeRecord[], observations: ExecCapabilityObservation[], nodeIds = nodes.map(n => n.id)) {
  return buildExecutionPreview({ nodes, observations, nodeIds, now });
}

describe("execution preview", () => {
  it("does not infer exec capability from online or labels", () => {
    const result = preview([node("a")], []);
    expect(result.ready).toBe(false);
    expect(result.nodes[0]).toMatchObject({ nodeId: "a", decision: "unknown", reasonCodes: ["PROBE_UNAVAILABLE"] });
    expect(result.scope).toBe("infrastructure-only");
    expect(result.businessRequirements).toBe("unverified");
    expect(result.expiresAt).toBe(now + 30_000);
  });
  it("reports observed basic support without claiming business acceptance", () => {
    const result = preview([node("a")], [observed("a")]);
    expect(result.ready).toBe(true);
    expect(result.nodes[0]?.decision).toBe("eligible");
    expect(result.expiresAt).toBe(now + 29_900);
  });
  it("blocks a mixed selection as a group and never drops or expands targets", () => {
    const result = preview([node("a"), node("b", "offline"), node("c"), node("unused")], [observed("a"), observed("b")], ["a", "b", "c"]);
    expect(result.ready).toBe(false);
    expect(result.selectedNodeIds).toEqual(["a", "b", "c"]);
    expect(result.nodes.map(n => n.decision)).toEqual(["eligible", "blocked", "unknown"]);
  });
  it.each([
    { expiresAt: now }, { checkedAt: now + 1 }, { checkedAt: NaN }, { expiresAt: Infinity },
    { checkedAt: now - 1, expiresAt: now - 2 },
  ])("rejects invalid or stale time evidence: %o", (patch) => {
    const result = preview([node("a")], [observed("a", patch)]);
    expect(result.nodes[0]?.decision).toBe("unknown");
    expect(Number.isFinite(result.expiresAt)).toBe(true);
    expect(result.expiresAt).toBeGreaterThanOrEqual(now);
  });
  it("keeps unsupported distinct from unavailable and preserves reasons", () => {
    const result = preview([node("a")], [observed("a", { state: "unsupported", reasonCodes: ["PREREQUISITES_MISSING"], checks: [{ id: "flock", ok: false }] })]);
    expect(result.nodes[0]).toMatchObject({ decision: "blocked", reasonCodes: ["PREREQUISITES_MISSING"] });
  });
  it("does not accept observations from a different provider", () => {
    expect(preview([node("a")], [observed("a", { providerId: "other" })]).nodes[0]?.decision).toBe("unknown");
  });
  it("does not accept supported observations with missing or failing checks", () => {
    for (const checks of [[], [{ id: "job-tools", ok: false }]]) {
      expect(preview([node("a")], [observed("a", { checks })]).ready).toBe(false);
    }
  });
  it("deduplicates deterministically, preserves selection order and does not mutate inputs", () => {
    const nodes = [node("a"), node("b")];
    const observations = [observed("a"), observed("b")];
    const before = structuredClone({ nodes, observations });
    const result = preview(nodes, observations, ["b", "a", "b"]);
    expect(result.selectedNodeIds).toEqual(["b", "a"]);
    expect(result.nodes.map(n => n.nodeId)).toEqual(["b", "a"]);
    expect({ nodes, observations }).toEqual(before);
  });
  it("does not substitute an unknown selected node or accept an empty scope", () => {
    expect(preview([node("a")], [observed("a")], ["missing"]).nodes[0]).toMatchObject({ nodeId: "missing", decision: "blocked", reasonCodes: ["NODE_NOT_FOUND"] });
    expect(preview([node("a")], [observed("a")], []).ready).toBe(false);
  });
  it("policy denial overrides positive observations without new execution", () => {
    const result = buildExecutionPreview({ nodes: [node("a")], observations: [observed("a")], nodeIds: ["a"], now, policyAllowsExecution: false });
    expect(result.ready).toBe(false);
    expect(result.nodes[0]?.reasonCodes).toEqual(["POLICY_BLOCKED"]);
  });
  it.each([
    { state: "invalid-state" }, { checks: undefined }, { reasonCodes: undefined },
    { checks: [{ id: "tool_bash", ok: "yes" }] }, { state: "unsupported", source: "" },
    { state: "unsupported", checks: [] }, { checkedAt: -1, expiresAt: 1 },
  ])("fails closed on malformed adapter observations: %o", (patch) => {
    const corrupt = { ...observed("a"), ...patch } as ExecCapabilityObservation;
    const result = preview([node("a")], [corrupt]);
    expect(result.ready).toBe(false);
    expect(result.nodes[0]?.decision).toBe("unknown");
    expect(result.nodes[0]?.reasonCodes).toEqual(["PROBE_INCOMPLETE"]);
  });
});
