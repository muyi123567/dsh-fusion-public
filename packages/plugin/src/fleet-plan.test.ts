import { describe, expect, it } from "vitest";
import { planFleetAlignment } from "./fleet-plan.js";
import type { FleetDriftReport, FleetHostManifest } from "./fleet-environment.js";

const SHA = `sha256:${"a".repeat(64)}`;

function manifest(overrides: Partial<FleetHostManifest> = {}): FleetHostManifest {
  return {
    contractVersion: 1, hostId: SHA, displayName: "host", observedAt: "2026-11-22T10:00:00.000Z",
    dsh: { version: "0.2.2-rc.5", profile: "web", node: "24.11.1", platform: "linux", arch: "x64" },
    bundles: [{ name: "dsh-fusion", version: "0.2.0-beta.14", enabled: true, availability: "profile", rows: [] }],
    patches: { profile: null, home: null }, capabilities: {}, workspaces: [],
    providers: [], mcpServers: [], secrets: { present: [] }, environmentDigest: SHA,
    signature: { alg: "ed25519", keyId: "host:test", value: `${"A".repeat(86)}==` },
    ...overrides,
  };
}

function drift(items: FleetDriftReport["items"], overall: FleetDriftReport["overall"] = "drift"): FleetDriftReport {
  return {
    contractVersion: 1, hostId: SHA, expectedDigest: SHA, observedDigest: SHA,
    checkedAt: "2026-11-22T10:00:00.000Z", overall, items,
  };
}

describe("fleet alignment plan", () => {
  it("returns ready for a matching environment", () => {
    const report = planFleetAlignment(manifest(), manifest(), drift([], "match"));
    expect(report.overall).toBe("ready");
    expect(report.steps).toEqual([]);
  });

  it("turns bundle, workspace and secret drift into ordered actions", () => {
    const report = planFleetAlignment(manifest(), manifest(), drift([
      { code: "bundle.missing", severity: "block", path: "bundles[missing]" },
      { code: "bundle.version", severity: "block", path: "bundles[dsh-fusion].version", expected: "0.2.0-beta.15", actual: "0.2.0-beta.14" },
      { code: "workspace.commit", severity: "block", path: "workspaces[profile].vcsCommit", expected: "b".repeat(40), actual: "c".repeat(40) },
      { code: "secret.missing", severity: "block", path: "secrets.present", expected: "DEEPSEEK_API_KEY" },
    ]));
    expect(report.overall).toBe("plan");
    expect(report.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "install", target: "missing" }),
      expect.objectContaining({ action: "update", target: "dsh-fusion", requiresRestart: true }),
      expect.objectContaining({ action: "checkout", target: "profile" }),
      expect.objectContaining({ action: "credential", target: "DEEPSEEK_API_KEY" }),
    ]));
  });

  it("marks risky manual steps instead of inventing commands", () => {
    const report = planFleetAlignment(manifest(), manifest(), drift([
      { code: "patch.digest", severity: "block", path: "patches.profile" },
      { code: "workspace.dirty", severity: "warn", path: "workspaces[profile].dirty" },
      { code: "manifest.digest", severity: "block", path: "environmentDigest" },
    ]));
    expect(report.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "restore-patch", risk: "high" }),
      expect.objectContaining({ action: "clean", risk: "high" }),
      expect.objectContaining({ action: "review", risk: "high" }),
    ]));
  });

  it("adds an exact install spec only when the expected bundle pins it", () => {
    const expected = manifest({
      bundles: [{ name: "missing", version: "1.2.3", enabled: true, availability: "profile", rows: [] }],
    });
    const report = planFleetAlignment(expected, manifest(), drift([
      { code: "bundle.missing", severity: "block", path: "bundles[missing]" },
    ]));
    expect(report.steps).toEqual([
      expect.objectContaining({ action: "install", target: "missing", spec: "missing@1.2.3" }),
    ]);
  });

  it("does not add a digest review when only the enabled flag differs", () => {
    const expected = manifest({
      bundles: [{ name: "existing", version: "1.0.0", enabled: true, availability: "profile", rows: [], digest: "sha256:enabled" }],
    });
    const observed = manifest({
      bundles: [{ name: "existing", version: "1.0.0", enabled: false, availability: "profile", rows: [], digest: "sha256:disabled" }],
    });
    const report = planFleetAlignment(expected, observed, drift([
      { code: "bundle.enabled", severity: "block", path: "bundles[existing].enabled", expected: true, actual: false },
      { code: "bundle.digest", severity: "block", path: "bundles[existing].digest", expected: "sha256:enabled", actual: "sha256:disabled" },
    ]));
    expect(report.steps).toEqual([
      expect.objectContaining({ action: "enable", target: "existing" }),
    ]);
  });

  it("never turns unknown into a ready plan", () => {
    const report = planFleetAlignment(manifest(), manifest(), drift([], "unknown"));
    expect(report.overall).toBe("unknown");
    expect(report.steps).toEqual([]);
  });
});
