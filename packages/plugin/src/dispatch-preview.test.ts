import { describe, expect, it, vi } from "vitest";
import type { ExecCapabilityObservation, NodeRecord } from "@dsh-fusion/core";
import { createDispatchPreviewService } from "./dispatch-preview.js";

const now = 1_800_000_000_000;
const node: NodeRecord = { id: "n1", externalId: "n1", providerId: "p1", name: "Worker",
  platform: "linux", roles: ["worker"], status: "online", transports: ["ssh"], capabilities: [], configState: "unknown" };
const observation: ExecCapabilityObservation = { nodeId: "n1", providerId: "p1", state: "supported",
  checkedAt: now, expiresAt: now + 30_000, source: "fixture", checks: [{ id: "bash", ok: true }], reasonCodes: [] };

function fixture() {
  const listNodes = vi.fn(async () => [node]);
  const probeExecCapabilities = vi.fn(async (_ids: string[]) => [observation]);
  const dispatch = vi.fn();
  const fleet = { listNodes, probeExecCapabilities, dispatch };
  const service = createDispatchPreviewService({ configuredNodeIds: new Set(["n1", "n2"]),
    fleet, now: () => now });
  return { service, listNodes, probeExecCapabilities, dispatch };
}

describe("dispatch preview service", () => {
  it.each([null, [], {}, { nodeIds: [] }, { nodeIds: [1] }, { nodeIds: [""] },
    { nodeIds: [" "] }, { nodeIds: ["n1", "not-configured"] }, { nodeIds: ["a".repeat(201)] },
    { nodeIds: Array(101).fill("n1") }, { nodeIds: ["n1"], command: "date" },
    { nodeIds: ["n1"], nodes: [node] }, { nodeIds: ["n1"], observations: [observation] },
  ])("rejects invalid input before provider calls: %j", async (body) => {
    const f = fixture();
    await expect(f.service(body)).rejects.toThrow("PREVIEW_INPUT_INVALID");
    expect(f.listNodes).not.toHaveBeenCalled();
    expect(f.probeExecCapabilities).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("uses trusted nodes, deduplicates explicitly selected ids and never dispatches", async () => {
    const f = fixture();
    const preview = await f.service({ nodeIds: ["n1", "n1"] });
    expect(preview).toMatchObject({ version: 1, ready: true, selectedNodeIds: ["n1"],
      scope: "infrastructure-only", businessRequirements: "unverified" });
    expect(preview.nodes[0]).toMatchObject({ name: "Worker", decision: "eligible" });
    expect(f.probeExecCapabilities).toHaveBeenCalledExactlyOnceWith(["n1"]);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("keeps an offline trusted node blocked despite a supported probe", async () => {
    const f = fixture();
    f.listNodes.mockResolvedValue([{ ...node, status: "offline" }]);
    expect(await f.service({ nodeIds: ["n1"] })).toMatchObject({ ready: false,
      nodes: [expect.objectContaining({ decision: "blocked" })] });
  });

  it("preserves the core display window for a stale negative diagnostic", async () => {
    const f = fixture();
    f.probeExecCapabilities.mockResolvedValue([{ ...observation, checkedAt: now - 30_001, expiresAt: now - 1 }]);
    const preview = await f.service({ nodeIds: ["n1"] });
    expect(preview.ready).toBe(false);
    expect(preview.expiresAt).toBe(now + 30_000);
    expect(preview.nodes[0]).toMatchObject({ decision: "unknown", reasonCodes: ["OBSERVATION_EXPIRED"],
      observation: { expiresAt: now - 1 } });
  });

  it("bounds a hung node snapshot without fabricating eligible nodes", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.listNodes.mockReturnValue(new Promise(() => {}));
      const result = f.service({ nodeIds: ["n1"] }).catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toBe("PREVIEW_NODES_UNAVAILABLE");
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
