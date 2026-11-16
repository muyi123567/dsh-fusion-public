import { buildExecutionPreview, type ExecutionPreview } from "@dsh-fusion/core";
import type { FleetRouter } from "./fleet-router.js";

export function createDispatchPreviewService(options: {
  configuredNodeIds: ReadonlySet<string>;
  fleet: Pick<FleetRouter, "listNodes" | "probeExecCapabilities">;
  now?: () => number;
}): (body: unknown) => Promise<ExecutionPreview> {
  return async (body) => {
    // Only server configuration and provider observations are trusted. Reject
    // commands, client snapshots and every other extra field before any I/O.
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("PREVIEW_INPUT_INVALID");
    }
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some((key) => key !== "nodeIds")
      || !Array.isArray(input.nodeIds) || input.nodeIds.length === 0 || input.nodeIds.length > 100
      || input.nodeIds.some((id: unknown) => typeof id !== "string" || id.trim() === ""
        || id.length > 200 || !options.configuredNodeIds.has(id))) {
      throw new Error("PREVIEW_INPUT_INVALID");
    }
    const nodeIds = [...new Set(input.nodeIds as string[])];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const nodes = await Promise.race([
      Promise.resolve().then(() => options.fleet.listNodes()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("PREVIEW_NODES_UNAVAILABLE")), 5_000);
      }),
    ]).catch(() => { throw new Error("PREVIEW_NODES_UNAVAILABLE"); })
      .finally(() => { if (timer !== undefined) clearTimeout(timer); });
    const observations = await options.fleet.probeExecCapabilities(nodeIds);
    return buildExecutionPreview({ nodes, nodeIds, observations, now: (options.now ?? Date.now)() });
  };
}
