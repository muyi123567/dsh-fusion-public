import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

export const FLEET_CONTRACT_VERSION = 1 as const;

export interface FleetBundle {
  name: string;
  version: string;
  enabled: boolean;
  installed?: boolean;
  availability: "installation" | "profile" | "missing";
  official?: boolean;
  optional?: boolean;
  source?: string;
  rows: string[];
  overrides?: string[];
  digest?: string;
}

export interface FleetPatchRef {
  sha256: string;
  bytes: number;
}

export interface FleetWorkspace {
  id: string;
  rootHash: string;
  vcsCommit: string | null;
  dirty: boolean | null;
  digest: string;
}

export interface FleetMcpServer {
  name: string;
  transport: "stdio" | "streamable-http" | "unknown";
  digest?: string;
}

export interface FleetSignature {
  alg: "ed25519";
  keyId: string;
  value: string;
}

export interface FleetHostManifest {
  contractVersion: typeof FLEET_CONTRACT_VERSION;
  hostId: string;
  displayName: string;
  observedAt: string;
  staleAfterSeconds?: number;
  dsh: {
    version: string;
    profile: string;
    node: string;
    platform: string;
    arch: string;
  };
  bundles: FleetBundle[];
  patches: {
    profile: FleetPatchRef | null;
    home: FleetPatchRef | null;
    lock?: FleetPatchRef | null;
  };
  compatibility?: { exemptions: string[] };
  capabilities: Record<string, boolean | string | number>;
  workspaces: FleetWorkspace[];
  providers: string[];
  mcpServers: FleetMcpServer[];
  secrets: { present: string[] };
  environmentDigest: string;
  secretPresenceDigest?: string;
  signature: FleetSignature;
}

export type FleetManifestBody = Omit<
  FleetHostManifest,
  "environmentDigest" | "secretPresenceDigest" | "signature"
>;

export interface FleetDriftItem {
  code: string;
  severity: "block" | "warn" | "info";
  path: string;
  expected?: unknown;
  actual?: unknown;
  remedy?: string;
}

export interface FleetDriftReport {
  contractVersion: typeof FLEET_CONTRACT_VERSION;
  hostId: string;
  expectedDigest: string | null;
  observedDigest: string | null;
  checkedAt: string;
  stale?: boolean;
  overall: "match" | "drift" | "unknown";
  reason?: string;
  items: FleetDriftItem[];
}

const VOLATILE_FIELDS = new Set(["observedAt", "environmentDigest", "secretPresenceDigest", "signature"]);
const SEVERITY_ORDER = { block: 0, warn: 1, info: 2 } as const;

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key]);
    return sorted;
  }
  return value;
}

export function computeEnvironmentDigest(input: object): string {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!VOLATILE_FIELDS.has(key)) body[key] = value;
  }
  return `sha256:${sha256Hex(canonicalJson(["dsh-fleet-environment/v1", body]))}`;
}

export function computeSecretPresenceDigest(present: readonly string[], providers: readonly string[]): string {
  return `sha256:${sha256Hex(canonicalJson([
    "dsh-fleet-secret-presence/v1",
    [...present].sort(),
    [...providers].sort(),
  ]))}`;
}

function signaturePayload(manifest: Record<string, unknown>): Buffer {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key !== "signature") body[key] = value;
  }
  return Buffer.from(canonicalJson(["dsh-fleet-manifest-signature/v1", body]), "utf8");
}

export function finalizeFleetManifest(
  body: FleetManifestBody,
  options: { privateKeyPem: string },
): FleetHostManifest {
  const digest = computeEnvironmentDigest(body);
  const secretPresenceDigest = computeSecretPresenceDigest(body.secrets.present, body.providers);
  const unsigned = { ...body, environmentDigest: digest, secretPresenceDigest };
  const privateKey = createPrivateKey(options.privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("FLEET_HOST_KEY_NOT_ED25519");
  const signature = sign(null, signaturePayload(unsigned), privateKey).toString("base64");
  const keyId = keyIdFromPrivateKey(options.privateKeyPem);
  return {
    ...unsigned,
    signature: { alg: "ed25519", keyId, value: signature },
  } as FleetHostManifest;
}

function keyIdFromPrivateKey(privateKeyPem: string): string {
  const publicKey = createPublicKey(createPrivateKey(privateKeyPem));
  return `host:${sha256Hex(publicKey.export({ type: "spki", format: "der" })).slice(0, 16)}`;
}

export function hostIdFromPublicKey(publicKeyPem: string): string {
  const publicKey = createPublicKey(publicKeyPem);
  return `sha256:${sha256Hex(publicKey.export({ type: "spki", format: "der" }))}`;
}

export function verifyFleetManifest(manifest: FleetHostManifest, publicKeyPem: string): boolean {
  try {
    if (manifest.contractVersion !== FLEET_CONTRACT_VERSION) return false;
    if (manifest.environmentDigest !== computeEnvironmentDigest(manifest)) return false;
    const expectedSecretDigest = computeSecretPresenceDigest(manifest.secrets.present, manifest.providers);
    if (manifest.secretPresenceDigest !== undefined && manifest.secretPresenceDigest !== expectedSecretDigest) return false;
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") return false;
    return verify(
      null,
      signaturePayload(manifest as unknown as Record<string, unknown>),
      publicKey,
      Buffer.from(manifest.signature.value, "base64"),
    );
  } catch {
    return false;
  }
}

export function isFleetHostManifest(value: unknown): value is FleetHostManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Partial<FleetHostManifest>;
  return manifest.contractVersion === FLEET_CONTRACT_VERSION
    && typeof manifest.hostId === "string" && /^sha256:[a-f0-9]{64}$/u.test(manifest.hostId)
    && typeof manifest.displayName === "string"
    && typeof manifest.observedAt === "string"
    && typeof manifest.dsh?.version === "string"
    && Array.isArray(manifest.bundles)
    && manifest.patches !== null && typeof manifest.patches === "object"
    && Array.isArray(manifest.workspaces)
    && Array.isArray(manifest.providers)
    && Array.isArray(manifest.mcpServers)
    && manifest.secrets !== null && typeof manifest.secrets === "object" && Array.isArray(manifest.secrets.present)
    && typeof manifest.environmentDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(manifest.environmentDigest)
    && manifest.signature !== null && typeof manifest.signature === "object"
    && manifest.signature.alg === "ed25519";
}

export interface DiffOptions {
  policy?: "exact" | "compatible";
  stale?: boolean;
  signatureVerified?: boolean;
  now?: Date;
}

export function diffFleetManifests(
  expected: FleetHostManifest | undefined,
  observed: FleetHostManifest,
  options: DiffOptions = {},
): FleetDriftReport {
  const items: FleetDriftItem[] = [];
  const observedDigest = observed.environmentDigest;
  if (observed.contractVersion !== FLEET_CONTRACT_VERSION) {
    return unknownReport(observed.hostId, expected?.environmentDigest ?? null, observedDigest, "清单契约版本不受支持");
  }
  if (options.stale === true) {
    return unknownReport(observed.hostId, expected?.environmentDigest ?? null, observedDigest, "来源已过期，不能当作匹配");
  }
  if (options.signatureVerified === false) {
    return unknownReport(observed.hostId, expected?.environmentDigest ?? null, observedDigest, "清单签名未验证");
  }
  if (expected === undefined) {
    return unknownReport(observed.hostId, null, observedDigest, "未配置期望环境，无法判断漂移");
  }

  const policy = options.policy ?? "exact";
  compareRuntime(expected, observed, policy, items);
  compareBundles(expected, observed, policy, items);
  comparePatches(expected, observed, items);
  compareWorkspaces(expected, observed, items);
  compareProviders(expected, observed, items);
  compareMcpServers(expected, observed, items);
  compareSecrets(expected, observed, items);
  compareCapabilities(expected, observed, items);
  compareExemptions(expected, observed, items);

  if (items.length === 0 && expected.environmentDigest !== observed.environmentDigest) {
    items.push({
      code: "manifest.digest", severity: "block", path: "environmentDigest",
      expected: expected.environmentDigest, actual: observed.environmentDigest,
      remedy: "检查未归类的清单差异",
    });
  }

  const sorted = items.sort((left, right) =>
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || left.code.localeCompare(right.code)
    || left.path.localeCompare(right.path));

  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    hostId: observed.hostId,
    expectedDigest: expected.environmentDigest,
    observedDigest,
    checkedAt: (options.now ?? new Date()).toISOString(),
    overall: sorted.length === 0 ? "match" : "drift",
    items: sorted,
  };
}

function unknownReport(
  hostId: string,
  expectedDigest: string | null,
  observedDigest: string | null,
  reason: string,
): FleetDriftReport {
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    hostId,
    expectedDigest,
    observedDigest,
    checkedAt: new Date().toISOString(),
    overall: "unknown",
    reason,
    items: [],
  };
}

function compareRuntime(
  expected: FleetHostManifest,
  observed: FleetHostManifest,
  policy: "exact" | "compatible",
  items: FleetDriftItem[],
): void {
  const versionMatches = policy === "exact"
    ? expected.dsh.version === observed.dsh.version
    : majorMinor(expected.dsh.version) === majorMinor(observed.dsh.version);
  if (!versionMatches) {
    items.push({
      code: "runtime.version", severity: "block", path: "dsh.version",
      expected: expected.dsh.version, actual: observed.dsh.version,
      remedy: "安装匹配的 DSH 版本并重启 profile",
    });
  }
  if (expected.dsh.platform !== observed.dsh.platform) {
    items.push({
      code: "runtime.platform", severity: "block", path: "dsh.platform",
      expected: expected.dsh.platform, actual: observed.dsh.platform,
    });
  }
  if (expected.dsh.arch !== observed.dsh.arch) {
    items.push({
      code: "runtime.arch", severity: "block", path: "dsh.arch",
      expected: expected.dsh.arch, actual: observed.dsh.arch,
    });
  }
  if (major(expected.dsh.node) !== major(observed.dsh.node)) {
    items.push({
      code: "runtime.node", severity: "warn", path: "dsh.node",
      expected: expected.dsh.node, actual: observed.dsh.node,
    });
  }
}

function compareBundles(
  expected: FleetHostManifest,
  observed: FleetHostManifest,
  policy: "exact" | "compatible",
  items: FleetDriftItem[],
): void {
  const actual = new Map(observed.bundles.map(bundle => [bundle.name, bundle]));
  for (const wanted of expected.bundles) {
    const found = actual.get(wanted.name);
    const path = `bundles[${wanted.name}]`;
    if (found === undefined) {
      items.push({ code: "bundle.missing", severity: "block", path, expected: wanted.version, remedy: "在目标主机安装该 bundle" });
      continue;
    }
    if (found.version !== wanted.version) {
      items.push({
        code: "bundle.version",
        severity: policy === "exact" ? "block" : "warn",
        path: `${path}.version`, expected: wanted.version, actual: found.version,
        remedy: "在目标主机升级到锁定版本并重启 profile",
      });
    }
    if (found.enabled !== wanted.enabled) {
      items.push({
        code: "bundle.enabled", severity: "block", path: `${path}.enabled`,
        expected: wanted.enabled, actual: found.enabled,
      });
    }
    if (found.availability === "missing") {
      items.push({
        code: "bundle.availability", severity: "block", path: `${path}.availability`,
        expected: wanted.availability, actual: found.availability,
      });
    }
    if (wanted.digest !== undefined && found.digest !== undefined && wanted.digest !== found.digest) {
      items.push({
        code: "bundle.digest", severity: "block", path: `${path}.digest`,
        expected: wanted.digest, actual: found.digest,
      });
    }
  }
  const expectedNames = new Set(expected.bundles.map(bundle => bundle.name));
  for (const found of observed.bundles) {
    if (!expectedNames.has(found.name) && found.enabled) {
      items.push({
        code: "bundle.extra", severity: "info", path: `bundles[${found.name}]`,
        actual: found.version,
      });
    }
  }
}

function comparePatches(expected: FleetHostManifest, observed: FleetHostManifest, items: FleetDriftItem[]): void {
  for (const key of ["profile", "home"] as const) {
    const wanted = expected.patches[key];
    const found = observed.patches[key];
    const path = `patches.${key}`;
    if (wanted === null && found !== null) {
      items.push({ code: "patch.extra", severity: "warn", path, actual: found.sha256, remedy: "确认目标主机的本地补丁是否为有意差异" });
      continue;
    }
    if (wanted !== null && found === null) {
      items.push({ code: "patch.missing", severity: "block", path, expected: wanted.sha256 });
      continue;
    }
    if (wanted !== null && found !== null && wanted.sha256 !== found.sha256) {
      items.push({
        code: "patch.digest", severity: "block", path,
        expected: wanted.sha256, actual: found.sha256,
        remedy: "恢复锁定的补丁文件或更新期望环境",
      });
    }
  }
}

function compareWorkspaces(expected: FleetHostManifest, observed: FleetHostManifest, items: FleetDriftItem[]): void {
  const actual = new Map(observed.workspaces.map(workspace => [workspace.id, workspace]));
  for (const wanted of expected.workspaces) {
    const found = actual.get(wanted.id);
    const path = `workspaces[${wanted.id}]`;
    if (found === undefined) {
      items.push({ code: "workspace.missing", severity: "block", path, expected: wanted.digest });
      continue;
    }
    if (wanted.vcsCommit !== found.vcsCommit) {
      items.push({
        code: "workspace.commit", severity: "block", path: `${path}.vcsCommit`,
        expected: wanted.vcsCommit, actual: found.vcsCommit,
        remedy: "检出锁定提交后再派发",
      });
    }
    if (wanted.digest !== found.digest) {
      items.push({
        code: "workspace.digest", severity: "block", path: `${path}.digest`,
        expected: wanted.digest, actual: found.digest,
      });
    }
    if (wanted.dirty === false && found.dirty === true) {
      items.push({ code: "workspace.dirty", severity: "warn", path: `${path}.dirty`, actual: true });
    }
  }
}

function compareProviders(expected: FleetHostManifest, observed: FleetHostManifest, items: FleetDriftItem[]): void {
  const actual = new Set(observed.providers);
  const wanted = new Set(expected.providers);
  for (const provider of wanted) {
    if (!actual.has(provider)) items.push({ code: "provider.missing", severity: "warn", path: "providers", expected: provider });
  }
  for (const provider of actual) {
    if (!wanted.has(provider)) items.push({ code: "provider.extra", severity: "info", path: "providers", actual: provider });
  }
}

function compareMcpServers(expected: FleetHostManifest, observed: FleetHostManifest, items: FleetDriftItem[]): void {
  const actual = new Set(observed.mcpServers.map(server => server.name));
  const wanted = new Set(expected.mcpServers.map(server => server.name));
  for (const name of wanted) {
    if (!actual.has(name)) items.push({ code: "mcp.missing", severity: "warn", path: "mcpServers", expected: name });
  }
  for (const name of actual) {
    if (!wanted.has(name)) items.push({ code: "mcp.extra", severity: "info", path: "mcpServers", actual: name });
  }
}

function compareSecrets(expected: FleetHostManifest, observed: FleetHostManifest, items: FleetDriftItem[]): void {
  const actual = new Set(observed.secrets.present);
  const wanted = new Set(expected.secrets.present);
  for (const name of wanted) {
    if (!actual.has(name)) items.push({ code: "secret.missing", severity: "block", path: `secrets.present`, expected: name });
  }
  for (const name of actual) {
    if (!wanted.has(name)) items.push({ code: "secret.extra", severity: "info", path: "secrets.present", actual: name });
  }
}

function compareCapabilities(expected: FleetHostManifest, observed: FleetHostManifest, items: FleetDriftItem[]): void {
  for (const [name, value] of Object.entries(expected.capabilities)) {
    const actual = observed.capabilities[name];
    const path = `capabilities.${name}`;
    if (value === true && actual !== true) {
      items.push({ code: "capability.missing", severity: "block", path, expected: value, actual });
    } else if (typeof value === "string" && actual !== value) {
      items.push({ code: "capability.changed", severity: "warn", path, expected: value, actual });
    } else if (typeof value === "number" && actual !== value) {
      items.push({ code: "capability.changed", severity: "warn", path, expected: value, actual });
    }
  }
}

function compareExemptions(expected: FleetHostManifest, observed: FleetHostManifest, items: FleetDriftItem[]): void {
  const wanted = [...(expected.compatibility?.exemptions ?? [])].sort();
  const actual = [...(observed.compatibility?.exemptions ?? [])].sort();
  if (wanted.join("\n") !== actual.join("\n")) {
    items.push({ code: "compatibility.exemptions", severity: "info", path: "compatibility.exemptions", expected: wanted, actual });
  }
}

function majorMinor(version: string): string {
  const match = /^(\d+)\.(\d+)/u.exec(version);
  return match === null ? version : `${match[1]}.${match[2]}`;
}

function major(version: string): string {
  const match = /^(\d+)/u.exec(version);
  return match === null ? version : match[1]!;
}
