import { describe, expect, it } from "vitest";
import { buildFleetDoctorReport, type FleetDoctorInput } from "./fleet-doctor.js";

const SHA = `sha256:${"a".repeat(64)}`;

function input(overrides: Partial<FleetDoctorInput> = {}): FleetDoctorInput {
  return {
    dsh: { version: "0.2.2-rc.5", state: "verified" },
    environment: {
      available: true, digest: SHA, signed: true,
      report: {
        contractVersion: 1, hostId: SHA, expectedDigest: SHA, observedDigest: SHA,
        checkedAt: "2026-11-22T10:00:00.000Z", overall: "match", items: [],
      },
    },
    mcp: { enabled: true, listening: true, registered: true, port: 8797, clients: 2 },
    execution: { jobs: 1, nodes: 1, ledgerConfigured: true, directoryConfigured: true },
    bundles: [
      { name: "dsh-fusion", version: "0.2.0-beta.14", enabled: true, availability: "profile" },
      { name: "ds-bot", version: "0.3.9", enabled: true, availability: "profile" },
    ],
    ...overrides,
  };
}

describe("fleet doctor", () => {
  it("reports a clean install and detects DS-Bot", () => {
    const report = buildFleetDoctorReport(input(), new Date("2026-11-22T10:00:00Z"));
    expect(report.overall).toBe("ok");
    expect(report.checks.every(check => check.status === "ok")).toBe(true);
    expect(report.integrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ds-bot", installed: true, enabled: true, version: "0.3.9", transport: "mcp" }),
      expect.objectContaining({ id: "dsh-im", installed: false }),
    ]));
    expect(report.nextActions).toEqual([]);
  });

  it("fails on an unsupported kernel, blocking drift and a broken MCP endpoint", () => {
    const report = buildFleetDoctorReport(input({
      dsh: { version: "0.3.0", state: "unsupported" },
      environment: {
        available: true, digest: SHA, signed: true,
        report: {
          contractVersion: 1, hostId: SHA, expectedDigest: SHA, observedDigest: SHA,
          checkedAt: "2026-11-22T10:00:00.000Z", overall: "drift",
          items: [{ code: "bundle.version", severity: "block", path: "bundles[dsh-fusion].version" }],
        },
      },
      mcp: { enabled: true, listening: false, registered: false, clients: 0, error: "EADDRINUSE" },
    }), new Date("2026-11-22T10:00:00Z"));
    expect(report.overall).toBe("fail");
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "dsh.version", status: "fail" }),
      expect.objectContaining({ id: "environment.drift", status: "fail" }),
      expect.objectContaining({ id: "mcp.endpoint", status: "fail" }),
    ]));
    expect(report.nextActions.length).toBeGreaterThan(0);
  });

  it("warns on untested kernels, missing expectations and unregistered MCP", () => {
    const report = buildFleetDoctorReport(input({
      dsh: { version: "0.2.3-alpha.2", state: "untested" },
      environment: { available: true, digest: SHA, signed: false },
      mcp: { enabled: true, listening: true, registered: false, port: 8797, clients: 0 },
      execution: { jobs: 0, nodes: 0, ledgerConfigured: false, directoryConfigured: false },
    }), new Date("2026-11-22T10:00:00Z"));
    expect(report.overall).toBe("warn");
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "dsh.version", status: "warn" }),
      expect.objectContaining({ id: "environment.manifest", status: "warn" }),
      expect.objectContaining({ id: "mcp.manager", status: "warn" }),
      expect.objectContaining({ id: "execution.jobs", status: "warn" }),
    ]));
  });
});
