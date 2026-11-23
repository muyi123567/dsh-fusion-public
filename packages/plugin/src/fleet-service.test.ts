import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWhaleFleetService, FleetServiceError } from "./fleet-service.js";
import type { FleetHostManifest } from "./fleet-environment.js";

const HASH = "a".repeat(64);
const SHA = `sha256:${HASH}`;

function manifest(hostId: string, overrides: Partial<FleetHostManifest> = {}): FleetHostManifest {
  return {
    contractVersion: 1,
    hostId,
    displayName: "host",
    observedAt: "2026-11-22T10:00:00.000Z",
    dsh: { version: "0.2.3-alpha.2", profile: "web", node: "24.11.1", platform: "linux", arch: "x64" },
    bundles: [{ name: "dsh-fusion", version: "0.2.0-beta.14", enabled: true, availability: "profile", rows: [] }],
    patches: { profile: null, home: null },
    capabilities: {},
    workspaces: [],
    providers: ["deepseek"],
    mcpServers: [],
    secrets: { present: [] },
    environmentDigest: SHA,
    signature: { alg: "ed25519", keyId: "host:test", value: `${"A".repeat(86)}==` },
    ...overrides,
  };
}

describe("whaleFleet service", () => {
  it("caches the collected manifest until the ttl expires", async () => {
    let now = 1_000;
    let version = "1.0.0";
    const collect = vi.fn(async () => manifest(SHA, { displayName: version }));
    const service = createWhaleFleetService({
      collect, directory: mkdtempSync(join(tmpdir(), "fleet-service-")), ttlMs: 5_000, now: () => now,
    });
    expect((await service.manifest()).displayName).toBe("1.0.0");
    version = "2.0.0";
    now = 3_000;
    expect((await service.manifest()).displayName).toBe("1.0.0");
    now = 7_000;
    expect((await service.manifest()).displayName).toBe("2.0.0");
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it("returns unknown when no expected environment is configured", async () => {
    const service = createWhaleFleetService({
      collect: async () => manifest(SHA), directory: mkdtempSync(join(tmpdir(), "fleet-service-")),
    });
    const report = await service.diff(SHA);
    expect(report.overall).toBe("unknown");
    expect(report.reason).toContain("期望");
  });

  it("matches a digest-only expectation without a lock file", async () => {
    const service = createWhaleFleetService({
      collect: async () => manifest(SHA), directory: mkdtempSync(join(tmpdir(), "fleet-service-")),
    });
    expect((await service.diff(SHA, SHA)).overall).toBe("match");
    const other = `sha256:${"b".repeat(64)}`;
    expect((await service.diff(SHA, other)).overall).toBe("drift");
  });

  it("diffs against a configured expected manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-service-"));
    const expectedPath = join(dir, "expected.json");
    writeFileSync(expectedPath, JSON.stringify(manifest(SHA, { displayName: "expected" })));
    const service = createWhaleFleetService({
      collect: async () => manifest(SHA, { displayName: "expected" }), directory: dir, expectedManifestPath: expectedPath,
    });
    expect((await service.diff(SHA)).overall).toBe("match");
  });

  it("lists the local host and cached remote manifests, and marks stale ones unknown", async () => {
    let now = Date.parse("2026-11-22T12:00:00Z");
    const dir = mkdtempSync(join(tmpdir(), "fleet-service-"));
    mkdirSync(join(dir, "hosts"));
    const remote = manifest(`sha256:${"b".repeat(64)}`, { observedAt: "2026-11-20T10:00:00.000Z" });
    writeFileSync(join(dir, "hosts", `${remote.hostId.slice(7)}.json`), JSON.stringify(remote));
    const service = createWhaleFleetService({
      collect: async () => manifest(SHA), directory: dir, staleAfterSeconds: 900, now: () => now,
    });
    const hosts = await service.listHosts();
    expect(hosts.map(host => host.hostId)).toEqual([SHA, remote.hostId]);
    const report = await service.diff(remote.hostId);
    expect(report.overall).toBe("unknown");
    expect(report.stale).toBe(true);
    now += 1;
  });

  it("rejects an unknown host with a stable error code", async () => {
    const service = createWhaleFleetService({
      collect: async () => manifest(SHA), directory: mkdtempSync(join(tmpdir(), "fleet-service-")),
    });
    await expect(service.diff(`sha256:${"c".repeat(64)}`)).rejects.toBeInstanceOf(FleetServiceError);
    await expect(service.diff(`sha256:${"c".repeat(64)}`)).rejects.toMatchObject({ code: "whale/host-unknown" });
  });

  it("never turns a failed signature check into a match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-service-"));
    const expectedPath = join(dir, "expected.json");
    writeFileSync(expectedPath, JSON.stringify(manifest(SHA)));
    const service = createWhaleFleetService({
      collect: async () => manifest(SHA), directory: dir, expectedManifestPath: expectedPath,
      verifyManifest: () => false,
    });
    const report = await service.diff(SHA);
    expect(report.overall).toBe("unknown");
    expect(report.reason).toContain("签名");
  });

  it("builds a compact panel view without leaking the full manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-service-"));
    const expectedPath = join(dir, "expected.json");
    writeFileSync(expectedPath, JSON.stringify(manifest(SHA, { displayName: "expected" })));
    const service = createWhaleFleetService({
      collect: async () => manifest(SHA, { displayName: "expected" }), directory: dir, expectedManifestPath: expectedPath,
    });
    const view = await service.panelView();
    expect(view).toMatchObject({ overall: "match", hostId: SHA, signed: true });
    expect(JSON.stringify(view)).not.toContain("secrets");
  });

  it("turns a drift report into alignment steps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-service-"));
    const expectedPath = join(dir, "expected.json");
    writeFileSync(expectedPath, JSON.stringify(manifest(SHA, {
      bundles: [{ name: "dsh-fusion", version: "1.0.0", enabled: true, availability: "profile", rows: [] }],
    })));
    const service = createWhaleFleetService({
      collect: async () => manifest(SHA), directory: dir, expectedManifestPath: expectedPath,
    });
    const plan = await service.plan(SHA);
    expect(plan.overall).toBe("plan");
    expect(plan.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "update", target: "dsh-fusion", requiresRestart: true }),
    ]));
  });

  it("saves one host manifest as the expected environment and then matches it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-service-"));
    const service = createWhaleFleetService({
      collect: async () => manifest(SHA), directory: dir,
    });
    const saved = await service.saveExpected(SHA);
    expect(saved).toMatchObject({ hostId: SHA, digest: SHA });
    expect(saved.path).toBe(join(dir, "expected-manifest.json"));
    expect(JSON.parse(readFileSync(saved.path, "utf8"))).toMatchObject({ hostId: SHA, environmentDigest: SHA });
    expect((await service.diff(SHA)).overall).toBe("match");
  });
});
