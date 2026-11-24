import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FleetTrustStore } from "./fleet-trust.js";
import { createWhaleFleetService } from "./fleet-service.js";
import {
  finalizeFleetManifest,
  hostIdFromPublicKey,
  verifyFleetManifest,
  type FleetHostManifest,
  type FleetManifestBody,
} from "./fleet-environment.js";

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function body(hostId: string, displayName: string): FleetManifestBody {
  return {
    contractVersion: 1,
    hostId,
    displayName,
    observedAt: new Date().toISOString(),
    dsh: { version: "0.2.3-alpha.2", profile: "web", node: "24.11.1", platform: "linux", arch: "arm64" },
    bundles: [],
    patches: { profile: null, home: null },
    capabilities: {},
    workspaces: [],
    providers: ["deepseek"],
    mcpServers: [],
    secrets: { present: [] },
  };
}

function setup(options: { mode?: "manual" | "tofu"; sidecar?: boolean } = {}) {
  const a = keypair();
  const b = keypair();
  const aHostId = hostIdFromPublicKey(a.publicKeyPem);
  const bHostId = hostIdFromPublicKey(b.publicKeyPem);
  const aManifest = finalizeFleetManifest(body(aHostId, "host-a"), { privateKeyPem: a.privateKeyPem });
  const bManifest = finalizeFleetManifest(body(bHostId, "host-b"), { privateKeyPem: b.privateKeyPem });
  const dir = mkdtempSync(join(tmpdir(), "fleet-trust-service-"));
  mkdirSync(join(dir, "hosts"));
  writeFileSync(join(dir, "hosts", `${bHostId.slice(7)}.json`), JSON.stringify(bManifest));
  if (options.sidecar === true) {
    writeFileSync(join(dir, "hosts", `${bHostId}.pub.pem`), b.publicKeyPem);
  }
  const trust = new FleetTrustStore({ path: join(dir, "trusted-hosts.json") });
  const service = createWhaleFleetService({
    collect: async () => aManifest,
    directory: dir,
    verifyManifest: manifest => verifyFleetManifest(manifest, a.publicKeyPem),
    trust,
    trustMode: options.mode ?? "manual",
    readPublicKey: hostId => {
      try {
        return readFileSync(join(dir, "hosts", `${hostId}.pub.pem`), "utf8");
      } catch {
        return undefined;
      }
    },
  });
  return { dir, trust, service, a, b, aHostId, bHostId, bManifest };
}

describe("fleet service remote trust", () => {
  it("blocks an untrusted remote manifest and refuses to save it as expected", async () => {
    const { service, bHostId, bManifest, dir } = setup();
    const report = await service.diff(bHostId, bManifest.environmentDigest);
    expect(report).toMatchObject({ overall: "unknown", reason: "远端清单未受信任" });
    const hosts = await service.listHosts();
    expect(hosts.find(host => host.hostId === bHostId)).toMatchObject({
      trust: "untrusted", verified: false, signed: true,
    });
    await expect(service.saveExpected(bHostId)).rejects.toMatchObject({ code: "whale/trust-required" });
    expect(statSync(join(dir, "trusted-hosts.json"), { throwIfNoEntry: false })?.mode).toBeUndefined();
  });

  it("verifies after explicit trust and persists the trust entry at 0600", async () => {
    const { service, b, bHostId, bManifest, dir } = setup();
    await service.trust!(bHostId, b.publicKeyPem);
    expect((await service.diff(bHostId, bManifest.environmentDigest)).overall).toBe("match");
    const saved = await service.saveExpected(bHostId);
    expect(saved.digest).toBe(bManifest.environmentDigest);
    expect(statSync(join(dir, "trusted-hosts.json")).mode & 0o777).toBe(0o600);
    const report = await service.trustReport!();
    expect(report.entries).toEqual([expect.objectContaining({ hostId: bHostId, source: "manual" })]);
    expect(report.hosts.find(host => host.hostId === bHostId)).toMatchObject({ trust: "verified", verified: true });
  });

  it("fails closed when a trusted manifest is tampered with", async () => {
    const { service, b, bHostId, bManifest, dir } = setup();
    await service.trust!(bHostId, b.publicKeyPem);
    const tampered: FleetHostManifest = { ...bManifest, displayName: "tampered" };
    writeFileSync(join(dir, "hosts", `${bHostId.slice(7)}.json`), JSON.stringify(tampered));
    const report = await service.diff(bHostId, bManifest.environmentDigest);
    expect(report).toMatchObject({ overall: "unknown", reason: "远端清单签名无效" });
  });

  it("pins a sidecar key only in opt-in tofu mode", async () => {
    const { service, bHostId, bManifest, dir } = setup({ mode: "tofu", sidecar: true });
    expect((await service.diff(bHostId, bManifest.environmentDigest)).overall).toBe("match");
    const report = await service.trustReport!();
    expect(report.mode).toBe("tofu");
    expect(report.entries).toEqual([expect.objectContaining({ hostId: bHostId, source: "tofu" })]);
    expect(statSync(join(dir, "trusted-hosts.json")).mode & 0o777).toBe(0o600);
  });

  it("keeps manual mode from pinning a sidecar key", async () => {
    const { service, bHostId, bManifest } = setup({ mode: "manual", sidecar: true });
    expect((await service.diff(bHostId, bManifest.environmentDigest)).overall).toBe("unknown");
    expect((await service.trustReport!()).entries).toEqual([]);
  });

  it("rejects a key that does not derive the requested host id", async () => {
    const { service, b, aHostId } = setup();
    await expect(service.trust!(aHostId, b.publicKeyPem)).rejects.toMatchObject({ code: "trust/key-mismatch" });
  });

  it("revokes trust and falls back to unknown", async () => {
    const { service, b, bHostId, bManifest } = setup();
    await service.trust!(bHostId, b.publicKeyPem);
    expect(await service.revokeTrust!(bHostId)).toBe(true);
    expect((await service.diff(bHostId, bManifest.environmentDigest)).overall).toBe("unknown");
  });
});
