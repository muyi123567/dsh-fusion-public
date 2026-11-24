import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FleetTrustError,
  FleetTrustStore,
} from "./fleet-trust.js";
import {
  finalizeFleetManifest,
  hostIdFromPublicKey,
  type FleetHostManifest,
  type FleetManifestBody,
} from "./fleet-environment.js";

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKeyPem, publicKeyPem, hostId: hostIdFromPublicKey(publicKeyPem) };
}

function body(hostId: string): FleetManifestBody {
  return {
    contractVersion: 1,
    hostId,
    displayName: "host-b",
    observedAt: "2026-11-23T12:00:00.000Z",
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

function manifest(privateKeyPem: string, hostId: string): FleetHostManifest {
  return finalizeFleetManifest(body(hostId), { privateKeyPem });
}

function store(): FleetTrustStore {
  return new FleetTrustStore({ path: join(mkdtempSync(join(tmpdir(), "fleet-trust-")), "trusted-hosts.json") });
}

describe("FleetTrustStore", () => {
  it("pins a key, persists it with 0600, and verifies signed manifests", () => {
    const b = keypair();
    const trust = store();
    const entry = trust.trust(b.hostId, b.publicKeyPem, "manual");
    expect(entry).toMatchObject({ hostId: b.hostId, source: "manual" });
    expect(entry.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const reloaded = new FleetTrustStore({ path: (trust as unknown as { path: string }).path });
    expect(reloaded.list()).toEqual([expect.objectContaining({ hostId: b.hostId })]);
    expect(reloaded.verify(manifest(b.privateKeyPem, b.hostId), { mode: "manual" }))
      .toMatchObject({ state: "verified" });
    expect((readFileSync((trust as unknown as { path: string }).path, "utf8")).includes("PRIVATE"))
      .toBe(false);
  });

  it("rejects a mismatched host id and a silent key rotation", () => {
    const a = keypair();
    const b = keypair();
    const trust = store();
    expect(codeOf(() => trust.trust(b.hostId, a.publicKeyPem, "manual"))).toBe("trust/key-mismatch");
    trust.trust(b.hostId, b.publicKeyPem, "manual");
    const rotated = keypair();
    expect(() => trust.trust(rotated.hostId, rotated.publicKeyPem, "manual")).not.toThrow();
    expect(trust.list()).toHaveLength(2);
    const sameHostNewKey = keypair();
    expect(codeOf(() => trust.trust(b.hostId, sameHostNewKey.publicKeyPem, "manual")))
      .toBe("trust/key-mismatch");
  });

  it("keeps the host id bound to its key and allows metadata replacement only", () => {
    const trust = store();
    const first = keypair();
    trust.trust(first.hostId, first.publicKeyPem, "manual");

    // A host id is derived from its key, so a new key is a new host identity.
    // The store never rebinds an existing host id to a different key.
    const rotated = keypair();
    const rotatedManifest = manifest(rotated.privateKeyPem, first.hostId);
    expect(trust.verify(rotatedManifest, { mode: "manual" })).toMatchObject({ state: "invalid" });
    expect(codeOf(() => trust.trust(first.hostId, rotated.publicKeyPem, "manual")))
      .toBe("trust/key-mismatch");
    expect(() => trust.trust(first.hostId, first.publicKeyPem, "manual", true)).not.toThrow();
    expect(trust.verify(manifest(first.privateKeyPem, first.hostId), { mode: "manual" }))
      .toMatchObject({ state: "verified" });
  });

  it("supports opt-in tofu only after the candidate key verifies the manifest", () => {
    const b = keypair();
    const trust = store();
    const value = manifest(b.privateKeyPem, b.hostId);
    expect(trust.verify(value, { mode: "manual", candidatePublicKeyPem: b.publicKeyPem }))
      .toMatchObject({ state: "untrusted" });
    expect(trust.list()).toEqual([]);
    expect(trust.verify(value, { mode: "tofu", candidatePublicKeyPem: b.publicKeyPem }))
      .toMatchObject({ state: "verified", pinned: true });
    expect(trust.list()).toEqual([expect.objectContaining({ hostId: b.hostId, source: "tofu" })]);

    const tampered = { ...value, displayName: "tampered" };
    expect(trust.verify(tampered, { mode: "tofu" })).toMatchObject({ state: "invalid" });
  });

  it("revokes trust and ignores a corrupt store", () => {
    const b = keypair();
    const trust = store();
    trust.trust(b.hostId, b.publicKeyPem, "manual");
    expect(trust.revoke(b.hostId)).toBe(true);
    expect(trust.verify(manifest(b.privateKeyPem, b.hostId), { mode: "manual" }))
      .toMatchObject({ state: "untrusted" });

    const path = (trust as unknown as { path: string }).path;
    writeFileSync(path, "{not json");
    const corrupt = new FleetTrustStore({ path });
    expect(corrupt.list()).toEqual([]);
  });

  it("does not expose private key material through list()", () => {
    const b = keypair();
    const trust = store();
    trust.trust(b.hostId, b.publicKeyPem, "manual");
    expect(JSON.stringify(trust.list())).not.toContain("PRIVATE");
    expect(JSON.stringify(trust.list())).toContain("PUBLIC KEY");
  });
});

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (error instanceof FleetTrustError) return error.code;
    return (error as { code?: string }).code;
  }
}
