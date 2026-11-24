import { execFile } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readInstalledDshVersion } from "./compatibility.js";
import {
  canonicalJson,
  finalizeFleetManifest,
  hostIdFromPublicKey,
  sha256Hex,
  type FleetBundle,
  type FleetHostManifest,
  type FleetMcpServer,
  type FleetPatchRef,
  type FleetWorkspace,
} from "./fleet-environment.js";

export interface FleetCollectorContext {
  get?: (name: string) => unknown;
}

export interface FleetCollectorOptions {
  ctx: FleetCollectorContext;
  directory: string;
  displayName?: string;
  secretNames?: string[];
  staleAfterSeconds?: number;
  dshVersion?: string;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  readText?: (path: string) => string;
  readVcs?: (cwd: string) => Promise<{ commit: string | null; dirty: boolean | null }> | { commit: string | null; dirty: boolean | null };
}

export interface CollectedFleetManifest {
  manifest: FleetHostManifest;
  publicKeyPem: string;
}

interface ProfileContextLike {
  name?: string;
  dir?: string;
  patchPath?: string;
  home?: string;
  cwd?: string;
}

interface BundleLike {
  name?: unknown;
  version?: unknown;
  enabled?: unknown;
  installed?: unknown;
  availability?: unknown;
  official?: unknown;
  optional?: unknown;
  source?: unknown;
  rows?: unknown;
  overrides?: unknown;
}

export async function collectFleetManifest(options: FleetCollectorOptions): Promise<CollectedFleetManifest> {
  const readText = options.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const keys = loadOrCreateHostKey(options.directory);
  const publicKeyPem = keys.publicKeyPem;
  const hostId = hostIdFromPublicKey(publicKeyPem);
  const profile = readProfileContext(options.ctx);
  const capabilities: Record<string, boolean> = {
    pluginManager: false,
    profileContext: profile !== undefined,
    llm: false,
    mcpManager: false,
    patchesReadable: false,
    secretScan: Array.isArray(options.secretNames),
    workspaceVcs: false,
  };

  const bundles = await readBundles(options.ctx, capabilities);
  const patches = readPatches(profile, readText, capabilities);
  const compatibility = readCompatibility(profile, readText);
  const providers = readProviders(options.ctx, capabilities);
  const mcpServers = readMcpServers(options.ctx, capabilities);
  const workspaces = await readWorkspaces(profile, options.readVcs ?? defaultReadVcs, capabilities);
  const present = (options.secretNames ?? [])
    .map(name => name.trim())
    .filter(name => /^[A-Z][A-Z0-9_]{2,127}$/u.test(name) && (env[name] ?? "") !== "")
    .sort();

  const body = {
    contractVersion: 1 as const,
    hostId,
    displayName: options.displayName ?? hostname() ?? `host-${hostId.slice(7, 15)}`,
    observedAt: now().toISOString(),
    ...(options.staleAfterSeconds === undefined ? {} : { staleAfterSeconds: options.staleAfterSeconds }),
    dsh: {
      version: options.dshVersion ?? process.env.DSH_VERSION ?? readInstalledDshVersion() ?? "unknown",
      profile: profile?.name ?? "unknown",
      node: process.version.replace(/^v/u, ""),
      platform: process.platform,
      arch: process.arch,
    },
    bundles,
    patches,
    ...(compatibility === undefined ? {} : { compatibility }),
    capabilities,
    workspaces,
    providers,
    mcpServers,
    secrets: { present },
  };

  return {
    manifest: finalizeFleetManifest(body, { privateKeyPem: keys.privateKeyPem }),
    publicKeyPem,
  };
}

function loadOrCreateHostKey(directory: string): { privateKeyPem: string; publicKeyPem: string } {
  const privatePath = join(directory, "host-key.pem");
  const publicPath = join(directory, "host-public.pem");
  let privateKeyPem: string | undefined;
  try {
    privateKeyPem = readFileSync(privatePath, "utf8");
  } catch {
    privateKeyPem = undefined;
  }
  if (privateKeyPem === undefined) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    writeFileSync(privatePath, privateKeyPem, { mode: 0o600 });
    writeFileSync(publicPath, publicKeyPem, { mode: 0o644 });
    try { chmodSync(privatePath, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    return { privateKeyPem, publicKeyPem };
  }
  try {
    return { privateKeyPem, publicKeyPem: readFileSync(publicPath, "utf8") };
  } catch {
    const publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem))
      .export({ type: "spki", format: "pem" }).toString();
    writeFileSync(publicPath, publicKeyPem, { mode: 0o644 });
    return { privateKeyPem, publicKeyPem };
  }
}

function readProfileContext(ctx: FleetCollectorContext): ProfileContextLike | undefined {
  const value = ctx.get?.("profileContext");
  if (value === null || typeof value !== "object") return undefined;
  return value as ProfileContextLike;
}

async function readBundles(ctx: FleetCollectorContext, capabilities: Record<string, boolean>): Promise<FleetBundle[]> {
  const manager = ctx.get?.("pluginManager") as { listBundles?: () => Promise<unknown> } | undefined;
  if (typeof manager?.listBundles !== "function") return [];
  try {
    const listed = await manager.listBundles();
    if (!Array.isArray(listed)) return [];
    capabilities.pluginManager = true;
    const bundles: FleetBundle[] = [];
    for (const value of listed) {
      const bundle = toBundle(value);
      if (bundle === undefined) {
        capabilities.bundleInventoryPartial = true;
        continue;
      }
      bundles.push(bundle);
    }
    return bundles;
  } catch {
    return [];
  }
}

function toBundle(value: unknown): FleetBundle | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const bundle = value as BundleLike;
  if (typeof bundle.name !== "string" || bundle.name === "" || typeof bundle.version !== "string" || bundle.version === "") return undefined;
  if (typeof bundle.enabled !== "boolean") return undefined;
  const availability: FleetBundle["availability"] | undefined =
    bundle.availability === "installation" || bundle.availability === "profile" || bundle.availability === "missing"
    ? bundle.availability : undefined;
  if (availability === undefined) return undefined;
  const rows = Array.isArray(bundle.rows)
    ? bundle.rows.flatMap(row => typeof row === "string" ? [row] : isRecord(row) && typeof row.rowId === "string" ? [row.rowId] : [])
    : [];
  const overrides = Array.isArray(bundle.overrides) ? bundle.overrides.filter((row): row is string => typeof row === "string") : [];
  const normalized = {
    name: bundle.name,
    version: bundle.version,
    enabled: bundle.enabled,
    ...(typeof bundle.installed === "boolean" ? { installed: bundle.installed } : {}),
    availability,
    ...(typeof bundle.official === "boolean" ? { official: bundle.official } : {}),
    ...(typeof bundle.optional === "boolean" ? { optional: bundle.optional } : {}),
    ...(typeof bundle.source === "string" ? { source: sanitizeBundleSource(bundle.source) } : {}),
    rows,
    ...(overrides.length === 0 ? {} : { overrides }),
  };
  return { ...normalized, digest: `sha256:${sha256Hex(canonicalJson(normalized))}` };
}

function sanitizeBundleSource(value: string): string {
  const raw = value.trim().slice(0, 512);
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:token|access_token|api_?key|key|secret|password|signature|sig|auth)$/iu.test(key)) {
        url.searchParams.set(key, "<redacted>");
      }
    }
    return url.toString();
  } catch {
    return raw
      .replace(/\/\/[^/@\s]+:[^/@\s]+@/gu, "//")
      .replace(/([?&](?:token|access_token|api_?key|key|secret|password|signature|sig|auth)=)[^&\s]+/giu, "$1<redacted>");
  }
}

function readPatches(
  profile: ProfileContextLike | undefined,
  readText: (path: string) => string,
  capabilities: Record<string, boolean>,
): { profile: FleetPatchRef | null; home: FleetPatchRef | null; lock?: FleetPatchRef | null } {
  let failed = false;
  const read = (path: string | undefined): FleetPatchRef | null => {
    if (path === undefined || path === "") {
      failed = true;
      return null;
    }
    try {
      const text = readText(path);
      return { sha256: `sha256:${sha256Hex(text)}`, bytes: Buffer.byteLength(text, "utf8") };
    } catch (error) {
      // A missing optional file is an absent fact, not an unreadable one.
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") failed = true;
      return null;
    }
  };
  if (profile === undefined) return { profile: null, home: null };
  const patches = {
    profile: read(profile.patchPath ?? (profile.dir === undefined ? undefined : join(profile.dir, "cordis.patch.yml"))),
    home: read(profile.home === undefined ? undefined : join(profile.home, "cordis.patch.yml")),
    ...(profile.dir === undefined ? {} : { lock: read(join(profile.dir, "pnpm-lock.yaml")) }),
  };
  capabilities.patchesReadable = !failed;
  return patches;
}

function readCompatibility(
  profile: ProfileContextLike | undefined,
  readText: (path: string) => string,
): { exemptions: string[] } | undefined {
  if (profile?.dir === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(readText(join(profile.dir, "compatibility.json")));
    if (!isRecord(parsed)) return undefined;
    return { exemptions: Object.keys(parsed).sort() };
  } catch {
    return undefined;
  }
}

function readProviders(ctx: FleetCollectorContext, capabilities: Record<string, boolean>): string[] {
  const llm = ctx.get?.("llm") as { listProviders?: () => unknown } | undefined;
  if (typeof llm?.listProviders !== "function") return [];
  try {
    const listed = llm.listProviders();
    if (!Array.isArray(listed)) return [];
    capabilities.llm = true;
    return [...new Set(listed.flatMap(item => isRecord(item) && typeof item.id === "string" ? [item.id] : []))].sort();
  } catch {
    return [];
  }
}

function readMcpServers(ctx: FleetCollectorContext, capabilities: Record<string, boolean>): FleetMcpServer[] {
  const manager = ctx.get?.("mcpManager") as { list?: () => unknown } | undefined;
  if (typeof manager?.list !== "function") return [];
  try {
    const listed = manager.list();
    if (!Array.isArray(listed)) return [];
    capabilities.mcpManager = true;
    return listed.flatMap(item =>
      isRecord(item) && typeof item.name === "string" && item.name !== ""
        ? [{ name: item.name, transport: "unknown" as const, digest: `sha256:${sha256Hex(`mcp:${item.name}`)}` }]
        : []);
  } catch {
    return [];
  }
}

async function readWorkspaces(
  profile: ProfileContextLike | undefined,
  readVcs: (cwd: string) => Promise<{ commit: string | null; dirty: boolean | null }> | { commit: string | null; dirty: boolean | null },
  capabilities: Record<string, boolean>,
): Promise<FleetWorkspace[]> {
  if (profile?.cwd === undefined || profile.cwd === "") return [];
  const rootHash = `sha256:${sha256Hex(profile.cwd)}`;
  const vcs = await readVcs(profile.cwd);
  const digest = `sha256:${sha256Hex(canonicalJson({ rootHash, commit: vcs.commit, dirty: vcs.dirty }))}`;
  capabilities.workspaceVcs = vcs.commit !== null;
  return [{ id: "profile", rootHash, vcsCommit: vcs.commit, dirty: vcs.dirty, digest }];
}

const runFile = promisify(execFile) as (
  file: string,
  args: string[],
  options: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

async function defaultReadVcs(cwd: string): Promise<{ commit: string | null; dirty: boolean | null }> {
  try {
    const [head, statusOutput] = await Promise.all([
      runFile("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 2_000 }),
      runFile("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8", timeout: 2_000 }),
    ]);
    const commit = head.stdout.trim();
    const status = statusOutput.stdout.trim();
    return { commit: /^[a-f0-9]{40}$/u.test(commit) ? commit : null, dirty: status !== "" };
  } catch {
    return { commit: null, dirty: null };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

