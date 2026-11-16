import { describe, expect, it } from "vitest";
import {
  evaluateDshCompatibility,
  type DshCompatibilityMatrix,
  type DshCompatibilityState,
} from "@dsh-fusion/core";
import { buildFusionDoctorReport } from "./fusion-doctor.js";

const matrix: DshCompatibilityMatrix = {
  minimum: "0.2.0-rc.2",
  maximumExclusive: "0.3.0",
  recommended: "0.2.0-rc.2",
  tested: ["0.2.0-rc.2"],
  candidates: ["0.2.1-rc.5"],
};

function compatibility(state: DshCompatibilityState, version?: string) {
  if (state === "verified") {
    return evaluateDshCompatibility({ version: "0.2.0-rc.2", source: "config", matrix });
  }
  if (state === "untested") {
    return evaluateDshCompatibility({ version: "0.2.1-rc.5", source: "package", matrix });
  }
  if (state === "unsupported") {
    return evaluateDshCompatibility({ version: "0.1.5-rc.2", source: "config", matrix });
  }
  return evaluateDshCompatibility({
    ...(version === undefined ? {} : { version }),
    source: "unknown",
    matrix,
  });
}

const baseInput = {
  dshCompatibility: compatibility("verified"),
  providers: {
    nodes: { state: "connected" },
    agentTeams: { state: "connected" },
    agentBus: { state: "offline", message: "HTTP 404" },
    room: { state: "connected" },
    huawei: { state: "connected" },
  },
  nodes: [
    { id: "n1", name: "Node 1", status: "online", configState: "current", providerId: "ssh" },
    { id: "n2", name: "Node 2", status: "online", configState: "unknown", providerId: "instabox" },
  ],
  tasks: [
    { id: "t1", status: "completed", targetNodeIds: ["n1"] },
  ],
  now: () => 1_700_000_000_000,
};

describe("buildFusionDoctorReport", () => {
  it("reports ok when every signal is healthy", () => {
    const report = buildFusionDoctorReport({
      ...baseInput,
      providers: {
        nodes: { state: "connected" },
        agentTeams: { state: "connected" },
        agentBus: { state: "connected" },
        room: { state: "connected" },
        huawei: { state: "connected" },
      },
      remoteConfig: { state: "current", ok: true, activeHash: "abc" },
      ledger: { readable: true, taskCount: 1 },
    });

    expect(report.status).toBe("ok");
    expect(report.checkedAt).toBe("2023-11-14T22:13:20.000Z");
    expect(report.summary.failed).toBe(0);
    expect(report.summary.degraded).toBe(0);
  });

  it("carries fleet observability as a check when a fleet read exists", () => {
    const report = buildFusionDoctorReport({
      ...baseInput,
      fleet: {
        checkedAt: 1_700_000_000_000,
        stale: false,
        inspect: {
          totals: { attempts: 9, failures: 2 },
          lastRound: { round: 3, attempts: 5, failures: 2, peakQueueDepth: 3, startedAt: 1_700_000_000_000, durationMs: 45 },
        },
      },
    });
    const fleet = report.checks.find((entry) => entry.id === "fleet.observability");
    expect(fleet?.status).toBe("ok");
    expect(fleet?.details).toMatchObject({
      checkedAt: "2023-11-14T22:13:20.000Z",
      stale: false,
      inspect: { totals: { attempts: 9, failures: 2 } },
    });
  });

  it("degrades the fleet check when the fleet data is stale", () => {
    const report = buildFusionDoctorReport({
      ...baseInput,
      fleet: { checkedAt: 1_700_000_000_000, stale: true },
    });
    const fleet = report.checks.find((entry) => entry.id === "fleet.observability");
    expect(fleet?.status).toBe("degraded");
    expect(fleet?.details).toMatchObject({ stale: true });
  });

  it("omits the fleet check when no fleet is configured", () => {
    const report = buildFusionDoctorReport({ ...baseInput });
    expect(report.checks.some((entry) => entry.id === "fleet.observability")).toBe(false);
  });

  it("fails the version check on an unsupported DSH version", () => {
    const report = buildFusionDoctorReport({
      ...baseInput,
      dshCompatibility: compatibility("unsupported"),
    });
    const version = report.checks.find((entry) => entry.id === "plugin.dsh-version");
    expect(version?.status).toBe("failed");
    expect(report.status).toBe("failed");
  });

  it("degrades an in-range host that is not in the tested matrix", () => {
    const report = buildFusionDoctorReport({
      ...baseInput,
      dshCompatibility: compatibility("untested"),
    });
    const version = report.checks.find((entry) => entry.id === "plugin.dsh-version");
    expect(version?.status).toBe("degraded");
    expect(version?.message).toContain("untested");
    expect(version?.details).toMatchObject({
      state: "untested",
      version: "0.2.1-rc.5",
      recommendedVersion: "0.2.0-rc.2",
    });
  });

  it("degrades an unknown host instead of claiming support", () => {
    const report = buildFusionDoctorReport({
      ...baseInput,
      dshCompatibility: compatibility("unknown"),
    });
    const version = report.checks.find((entry) => entry.id === "plugin.dsh-version");
    expect(version?.status).toBe("degraded");
    expect(version?.message).toContain("unknown");
  });

  it("counts configured nodes that never answered as not online", () => {
    const report = buildFusionDoctorReport({
      ...baseInput,
      nodes: [baseInput.nodes[0]!],
      configuredNodeIds: ["n1", "n2"],
    });
    const online = report.checks.find((entry) => entry.id === "nodes.online");
    expect(online?.status).toBe("degraded");
    expect(online?.details?.total).toBe(2);
    expect(online?.details?.observed).toBe(1);
    expect(online?.details?.unobserved).toEqual(["n2"]);
    expect(online?.message).toContain("1 of 2 node(s) not online");
  });

  it("keeps the configured total when a node reports offline", () => {
    const report = buildFusionDoctorReport({
      ...baseInput,
      nodes: [
        { id: "n1", name: "Node 1", status: "online", configState: "current", providerId: "ssh" },
        { id: "n2", name: "Node 2", status: "offline", configState: "unknown", providerId: "instabox" },
      ],
      configuredNodeIds: ["n1", "n2"],
    });
    const online = report.checks.find((entry) => entry.id === "nodes.online");
    expect(online?.details?.total).toBe(2);
    expect(online?.details?.online).toBe(1);
    expect(online?.details?.offline).toEqual(["n2"]);
  });

  it("falls back to the observed nodes when no configured set is given", () => {
    const report = buildFusionDoctorReport(baseInput);
    const online = report.checks.find((entry) => entry.id === "nodes.online");
    expect(online?.details?.total).toBe(2);
    expect(online?.details?.unobserved).toEqual([]);
  });

  it("degrades on an offline provider without hiding the reason", () => {
    const report = buildFusionDoctorReport(baseInput);
    const bus = report.checks.find((entry) => entry.id === "provider.agentBus");
    expect(bus?.status).toBe("failed");
    expect(bus?.message).toBe("HTTP 404");
    expect(report.status).toBe("failed");
  });

  it("treats a not-configured provider as degraded rather than failed", () => {
    const report = buildFusionDoctorReport({
      ...baseInput,
      providers: { ...baseInput.providers, room: { state: "not-configured" } },
    });
    const room = report.checks.find((entry) => entry.id === "provider.room");
    expect(room?.status).toBe("degraded");
  });

  it("flags drifted configuration and unverified nodes separately", () => {
    const report = buildFusionDoctorReport({
      ...baseInput,
      nodes: [
        { id: "n1", name: "Node 1", status: "online", configState: "drift", providerId: "ssh" },
        { id: "n2", name: "Node 2", status: "degraded", configState: "unknown", providerId: "instabox" },
      ],
    });
    const drift = report.checks.find((entry) => entry.id === "config.drift");
    expect(drift?.status).toBe("degraded");
    expect(drift?.details).toMatchObject({ drift: ["n1"], unverified: ["n2"] });
    const online = report.checks.find((entry) => entry.id === "nodes.online");
    expect(online?.details).toMatchObject({ total: 2, online: 1, degraded: ["n2"] });
  });

  it("detects orphaned child task references", () => {
    const report = buildFusionDoctorReport({
      ...baseInput,
      nodes: [
        { id: "n1", name: "Node 1", status: "online", configState: "current", providerId: "ssh" },
        { id: "n2", name: "Node 2", status: "online", configState: "current", providerId: "instabox" },
      ],
      tasks: [
        {
          id: "FLEET-1",
          status: "running",
          targetNodeIds: ["n1", "n2"],
          childTaskRefs: [
            { id: "HUAWEI-1", targetNodeIds: ["n1"] },
            { id: "INSTABOX-missing", targetNodeIds: ["node-gone"] },
          ],
        },
      ],
    });
    const integrity = report.checks.find((entry) => entry.id === "tasks.integrity");
    expect(integrity?.status).toBe("degraded");
    expect(integrity?.details).toMatchObject({
      orphans: [{ parent: "FLEET-1", child: "INSTABOX-missing" }],
      unknownNodeIds: ["node-gone"],
    });
  });

  it("fails when the task ledger is unreadable", () => {
    const report = buildFusionDoctorReport({
      ...baseInput,
      ledger: { readable: false, taskCount: 0, error: "EACCES" },
    });
    const ledger = report.checks.find((entry) => entry.id === "tasks.ledger");
    expect(ledger?.status).toBe("failed");
    expect(report.status).toBe("failed");
  });

  it("degrades when remote configuration is not current", () => {
    const report = buildFusionDoctorReport({
      ...baseInput,
      remoteConfig: { state: "drift", ok: false, activeHash: "abc" },
    });
    const remote = report.checks.find((entry) => entry.id === "config.remote");
    expect(remote?.status).toBe("degraded");
    expect(remote?.message).toBe("remote node configuration state: drift");
  });

  it("records known upstream incompatibilities without inventing a crash", () => {
    const report = buildFusionDoctorReport({
      ...baseInput,
      knownIncompatibilities: [
        { id: "agent-bus", message: "dsh-agent-bus@0.1.1 is incompatible with DSH 0.2.0-rc.2" },
      ],
    });
    const upstream = report.checks.find((entry) => entry.id === "upstream.agent-bus");
    expect(upstream?.status).toBe("degraded");
    expect(report.status).toBe("failed");
  });
});
