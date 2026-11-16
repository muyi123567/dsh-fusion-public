import { describe, expect, it } from "vitest";
import type { NodeRecord } from "@dsh-fusion/core";
import { mergeNodes } from "./node-model.js";

const base = {
  platform: "linux",
  roles: ["worker"],
  status: "online",
  configState: "current",
} satisfies Partial<NodeRecord>;

describe("mergeNodes", () => {
  it("merges SSH and SeekFleet views for the same stable node id", () => {
    const merged = mergeNodes([
      { ...base, id: "tencent", externalId: "fleet-1", providerId: "seekfleet", name: "腾讯 Worker", transports: ["seekfleet"], capabilities: ["fleet"] } as NodeRecord,
      { ...base, id: "tencent", externalId: "ssh-1", providerId: "ssh", name: "腾讯 Worker", transports: ["ssh"], capabilities: ["ssh"] } as NodeRecord,
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.capabilities).toEqual(expect.arrayContaining(["fleet", "ssh"]));
    expect(merged[0]?.transports).toEqual(expect.arrayContaining(["seekfleet", "ssh"]));
  });

  it("does not retain online from a stale provider when a newer heartbeat is offline", () => {
    const merged = mergeNodes([
      { ...base, id: "tencent", externalId: "fleet-1", providerId: "seekfleet", name: "腾讯 Worker", transports: ["seekfleet"], capabilities: ["fleet"], lastHeartbeat: "2026-10-20T00:00:00.000Z" } as NodeRecord,
      { ...base, id: "tencent", externalId: "ssh-1", providerId: "ssh", name: "腾讯 Worker", status: "offline", transports: ["ssh"], capabilities: ["ssh"], lastHeartbeat: "2026-10-20T00:01:00.000Z" } as NodeRecord,
    ]);

    expect(merged[0]?.status).toBe("offline");
  });
});
