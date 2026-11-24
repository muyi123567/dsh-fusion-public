import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFleetHostBundle,
  importFleetHostBundle,
  verifyFleetHostBundle,
} from "./fleet-host-bundle.js";
import { FleetTrustStore } from "./fleet-trust.js";
import {
  canonicalJson,
  finalizeFleetManifest,
  hostIdFromPublicKey,
  sha256Hex,
  type FleetManifestBody,
} from "./fleet-environment.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function bundle() {
  const key = keypair();
  const hostId = hostIdFromPublicKey(key.publicKeyPem);
  const body: FleetManifestBody = {
    contractVersion: 1, hostId, displayName: "host-b", observedAt: "2026-11-24T07:00:00.000Z",
    dsh: { version: "0.2.3-alpha.2", profile: "web", node: "24.11.1", platform: "linux", arch: "arm64" },
    bundles: [], patches: { profile: null, home: null }, capabilities: {}, workspaces: [],
    providers: ["deepseek"], mcpServers: [], secrets: { present: ["DEEPSEEK_API_KEY"] },
  };
  const manifest = finalizeFleetManifest(body, { privateKeyPem: key.privateKeyPem });
  const value = createFleetHostBundle({ manifest, publicKeyPem: key.publicKeyPem, now: () => Date.parse("2026-11-24T07:00:00Z") });
  return { key, hostId, manifest, bundle: value };
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "fleet-bundle-"));
  roots.push(value);
  return value;
}

describe("fleet host bundle", () => {
  it("exports a signed, verifiable bundle and imports trust, manifest and expectation", () => {
    const { key, hostId, bundle: value } = bundle();
    expect(verifyFleetHostBundle(value)).toMatchObject({ contractVersion: 1, digest: value.digest });
    expect(JSON.stringify(value)).not.toContain("PRIVATE");

    const dir = root();
    const trust = new FleetTrustStore({ path: join(dir, "trusted-hosts.json") });
    const imported = importFleetHostBundle(value, {
      directory: dir, trust, pinTrust: true, saveExpected: true,
    });
    expect(imported).toMatchObject({ hostId, trusted: true });
    expect(readFileSync(join(dir, "hosts", `${hostId.slice(7)}.json`), "utf8")).toContain("host-b");
    expect(readFileSync(join(dir, "expected-manifest.json"), "utf8")).toContain(hostId);
    expect(trust.get(hostId)).toMatchObject({ hostId, publicKeyPem: key.publicKeyPem });
    expect(statSync(join(dir, "trusted-hosts.json")).mode & 0o777).toBe(0o600);
  });

  it("imports only the cached manifest when trust and expectation are not requested", () => {
    const { bundle: value } = bundle();
    const dir = root();
    const imported = importFleetHostBundle(value, { directory: dir });
    expect(imported).toMatchObject({ trusted: false });
    expect(imported.expectedPath).toBeUndefined();
    expect(existsSync(join(dir, "expected-manifest.json"))).toBe(false);
  });

  it("rejects tampering, wrong keys and invalid signatures", () => {
    const first = bundle();
    const tampered = { ...first.bundle, manifest: { ...first.bundle.manifest, displayName: "tampered" } };
    expect(codeOf(() => verifyFleetHostBundle(tampered))).toBe("bundle/digest-invalid");

    const other = keypair();
    const wrongKey = { ...first.bundle, publicKeyPem: other.publicKeyPem };
    wrongKey.digest = `sha256:${sha256Hex(canonicalJson({
      contractVersion: 1, createdAt: wrongKey.createdAt, manifest: wrongKey.manifest, publicKeyPem: wrongKey.publicKeyPem,
    }))}`;
    expect(codeOf(() => verifyFleetHostBundle(wrongKey))).toBe("bundle/key-mismatch");

    const forgedManifest = { ...first.bundle.manifest, displayName: "forged" } as typeof first.bundle.manifest;
    const forged = { ...first.bundle, manifest: forgedManifest };
    forged.digest = `sha256:${sha256Hex(canonicalJson({
      contractVersion: 1, createdAt: forged.createdAt, manifest: forged.manifest, publicKeyPem: forged.publicKeyPem,
    }))}`;
    expect(codeOf(() => verifyFleetHostBundle(forged))).toBe("bundle/signature-invalid");
  });

  it("writes the joined manifest at 0600", () => {
    const { hostId, bundle: value } = bundle();
    const dir = root();
    importFleetHostBundle(value, { directory: dir, saveExpected: true });
    expect(statSync(join(dir, "hosts", `${hostId.slice(7)}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "expected-manifest.json")).mode & 0o777).toBe(0o600);
  });

  it("backs up an existing expected manifest before overwriting it", () => {
    const { bundle: value } = bundle();
    const dir = root();
    const expected = join(dir, "expected-manifest.json");
    writeFileSync(expected, "{\"old\":true}\n", { mode: 0o600 });
    const result = importFleetHostBundle(value, {
      directory: dir, saveExpected: true, now: () => Date.parse("2026-11-24T07:00:00Z"),
    });
    expect(result.expectedBackupPath).toBeDefined();
    expect(readFileSync(result.expectedBackupPath!, "utf8")).toBe("{\"old\":true}\n");
    expect(readFileSync(expected, "utf8")).toContain(value.manifest.hostId);
    expect(statSync(result.expectedBackupPath!).mode & 0o777).toBe(0o600);
  });
});

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
