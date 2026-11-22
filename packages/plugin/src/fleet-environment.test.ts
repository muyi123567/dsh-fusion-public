import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  computeEnvironmentDigest,
  diffFleetManifests,
  finalizeFleetManifest,
  verifyFleetManifest,
  type FleetHostManifest,
} from "./fleet-environment.js";

const HASH = "a".repeat(64);
const SHA = `sha256:${HASH}`;

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function baseManifest(privateKeyPem: string): FleetHostManifest {
  return finalizeFleetManifest({
    contractVersion: 1,
    hostId: SHA,
    displayName: "worker-b",
    observedAt: "2026-11-22T10:00:00.000Z",
    dsh: { version: "0.2.3-alpha.2", profile: "web", node: "24.11.1", platform: "linux", arch: "x64" },
    bundles: [{ name: "dsh-fusion", version: "0.2.0-beta.14", enabled: true, availability: "profile", rows: ["whale"] }],
    patches: { profile: { sha256: SHA, bytes: 12 }, home: null },
    capabilities: { ssh: true },
    workspaces: [{ id: "ws", rootHash: SHA, vcsCommit: "b".repeat(40), dirty: false, digest: SHA }],
    providers: ["deepseek"],
    mcpServers: [{ name: "whale-fleet", transport: "stdio" }],
    secrets: { present: ["DEEPSEEK_API_KEY"] },
  }, { privateKeyPem });
}

describe("fleet environment canonical form", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(canonicalJson({ b: 1, a: [{ z: 1, y: 2 }, "x"] })).toBe('{"a":[{"y":2,"z":1},"x"],"b":1}');
  });

  it("keeps the digest stable across observation time and signature", () => {
    const { privateKeyPem } = keys();
    const manifest = baseManifest(privateKeyPem);
    const later = { ...manifest, observedAt: "2026-11-23T10:00:00.000Z" };
    expect(computeEnvironmentDigest(later)).toBe(manifest.environmentDigest);
    expect(computeEnvironmentDigest(manifest)).toBe(manifest.environmentDigest);
  });

  it("signs and verifies the manifest, and rejects tampering", () => {
    const { privateKeyPem, publicKeyPem } = keys();
    const manifest = baseManifest(privateKeyPem);
    expect(verifyFleetManifest(manifest, publicKeyPem)).toBe(true);
    const tampered = {
      ...manifest,
      bundles: [{ ...manifest.bundles[0]!, version: "9.9.9" }],
    };
    expect(verifyFleetManifest(tampered, publicKeyPem)).toBe(false);
  });
});

describe("fleet drift", () => {
  it("reports a clean match", () => {
    const { privateKeyPem } = keys();
    const expected = baseManifest(privateKeyPem);
    const report = diffFleetManifests(expected, expected);
    expect(report.overall).toBe("match");
    expect(report.items).toEqual([]);
    expect(report.expectedDigest).toBe(expected.environmentDigest);
    expect(report.observedDigest).toBe(expected.environmentDigest);
  });

  it("blocks version, missing bundle, workspace and secret drift", () => {
    const { privateKeyPem } = keys();
    const expected = baseManifest(privateKeyPem);
    const observed = {
      ...expected,
      bundles: [{ ...expected.bundles[0]!, version: "0.2.0-beta.13" }],
      workspaces: [{ ...expected.workspaces[0]!, vcsCommit: "c".repeat(40) }],
      secrets: { present: [] },
    };
    const report = diffFleetManifests(expected, observed);
    expect(report.overall).toBe("drift");
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "bundle.version", severity: "block" }),
      expect.objectContaining({ code: "workspace.commit", severity: "block" }),
      expect.objectContaining({ code: "secret.missing", severity: "block" }),
    ]));
  });

  it("marks missing and extra bundles with different severities", () => {
    const { privateKeyPem } = keys();
    const expected = baseManifest(privateKeyPem);
    const observed = {
      ...expected,
      bundles: [
        ...expected.bundles,
        { name: "extra-plugin", version: "1.0.0", enabled: true, availability: "profile" as const, rows: [] },
      ],
    };
    const report = diffFleetManifests(expected, observed);
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "bundle.extra", severity: "info", path: "bundles[extra-plugin]" }),
    ]));
  });

  it("warns on provider differences and blocks missing capabilities", () => {
    const { privateKeyPem } = keys();
    const expected = baseManifest(privateKeyPem);
    const observed = {
      ...expected,
      providers: ["deepseek", "openai"],
      capabilities: { ssh: false },
    };
    const report = diffFleetManifests(expected, observed);
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "provider.extra", severity: "info", path: "providers" }),
      expect.objectContaining({ code: "capability.missing", severity: "block", path: "capabilities.ssh" }),
    ]));
  });

  it("never reports match for a stale or unknown comparison", () => {
    const { privateKeyPem } = keys();
    const expected = baseManifest(privateKeyPem);
    expect(diffFleetManifests(expected, expected, { stale: true }).overall).toBe("unknown");
    expect(diffFleetManifests(expected, expected, { stale: true }).reason).toContain("过期");
    expect(diffFleetManifests(undefined, expected).overall).toBe("unknown");
  });
});
