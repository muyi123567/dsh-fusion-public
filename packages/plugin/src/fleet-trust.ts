import { createPublicKey } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  hostIdFromPublicKey,
  sha256Hex,
  verifyFleetManifest,
  type FleetHostManifest,
} from "./fleet-environment.js";

export type FleetTrustSource = "manual" | "tofu";
export type FleetTrustVerificationState = "verified" | "untrusted" | "invalid" | "key-mismatch";

export interface FleetTrustEntry {
  hostId: string;
  displayName?: string;
  publicKeyPem: string;
  fingerprint: string;
  source: FleetTrustSource;
  addedAt: string;
  updatedAt: string;
}

export interface FleetTrustVerification {
  hostId: string;
  state: FleetTrustVerificationState;
  fingerprint?: string;
  pinned?: boolean;
}

export class FleetTrustError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FleetTrustError";
  }
}

const HOST_ID = /^sha256:[a-f0-9]{64}$/u;

interface TrustFile {
  version: 1;
  hosts: FleetTrustEntry[];
}

export class FleetTrustStore {
  readonly path: string;
  private entries = new Map<string, FleetTrustEntry>();
  private readonly now: () => number;

  constructor(options: { path: string; now?: () => number }) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
    this.entries = load(options.path);
  }

  list(): FleetTrustEntry[] {
    return [...this.entries.values()]
      .map(entry => structuredClone(entry))
      .sort((left, right) => left.hostId.localeCompare(right.hostId));
  }

  get(hostId: string): FleetTrustEntry | undefined {
    const entry = this.entries.get(hostId);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  trust(
    hostId: string,
    publicKeyPem: string,
    source: FleetTrustSource,
    replace = false,
  ): FleetTrustEntry {
    if (!HOST_ID.test(hostId)) throw new FleetTrustError("trust/host-invalid", "hostId 无效");
    let derived: string;
    try {
      createPublicKey(publicKeyPem);
      derived = hostIdFromPublicKey(publicKeyPem);
    } catch {
      throw new FleetTrustError("trust/key-invalid", "公钥无效");
    }
    if (derived !== hostId) throw new FleetTrustError("trust/key-mismatch", "公钥与 hostId 不匹配");

    const existing = this.entries.get(hostId);
    if (existing !== undefined && existing.publicKeyPem.trim() !== publicKeyPem.trim() && !replace) {
      throw new FleetTrustError("trust/key-changed", "主机公钥已变化，需要显式替换");
    }
    const timestamp = new Date(this.now()).toISOString();
    const entry: FleetTrustEntry = {
      hostId,
      publicKeyPem,
      fingerprint: `sha256:${sha256Hex(publicKeyPem)}`,
      source,
      addedAt: existing?.addedAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.entries.set(hostId, entry);
    this.save();
    return structuredClone(entry);
  }

  revoke(hostId: string): boolean {
    const removed = this.entries.delete(hostId);
    if (removed) this.save();
    return removed;
  }

  verify(
    manifest: FleetHostManifest,
    options: { mode: FleetTrustSource; candidatePublicKeyPem?: string } = { mode: "manual" },
  ): FleetTrustVerification {
    const entry = this.entries.get(manifest.hostId);
    if (entry !== undefined) {
      let derived: string;
      try {
        derived = hostIdFromPublicKey(entry.publicKeyPem);
      } catch {
        return { hostId: manifest.hostId, state: "invalid", fingerprint: entry.fingerprint };
      }
      if (derived !== manifest.hostId) {
        return { hostId: manifest.hostId, state: "key-mismatch", fingerprint: entry.fingerprint };
      }
      return {
        hostId: manifest.hostId,
        state: verifyFleetManifest(manifest, entry.publicKeyPem) ? "verified" : "invalid",
        fingerprint: entry.fingerprint,
      };
    }

    const candidate = options.candidatePublicKeyPem?.trim();
    if (candidate === undefined || candidate === "") {
      return { hostId: manifest.hostId, state: "untrusted" };
    }
    let derived: string;
    try {
      derived = hostIdFromPublicKey(candidate);
    } catch {
      return { hostId: manifest.hostId, state: "invalid" };
    }
    if (derived !== manifest.hostId) return { hostId: manifest.hostId, state: "key-mismatch" };
    if (!verifyFleetManifest(manifest, candidate)) return { hostId: manifest.hostId, state: "invalid" };
    if (options.mode !== "tofu") return { hostId: manifest.hostId, state: "untrusted" };
    const pinned = this.trust(manifest.hostId, candidate, "tofu");
    return { hostId: manifest.hostId, state: "verified", fingerprint: pinned.fingerprint, pinned: true };
  }

  private save(): void {
    const file: TrustFile = { version: 1, hosts: this.list() };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
    renameSync(temporary, this.path);
  }
}

function load(path: string): Map<string, FleetTrustEntry> {
  const entries = new Map<string, FleetTrustEntry>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return entries;
  }
  const hosts = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { hosts?: unknown }).hosts
    : undefined;
  if (!Array.isArray(hosts)) return entries;
  for (const value of hosts) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Partial<FleetTrustEntry>;
    if (typeof entry.hostId !== "string" || !HOST_ID.test(entry.hostId)) continue;
    if (typeof entry.publicKeyPem !== "string" || !entry.publicKeyPem.includes("PUBLIC KEY")) continue;
    let derived: string;
    try {
      derived = hostIdFromPublicKey(entry.publicKeyPem);
    } catch {
      continue;
    }
    if (derived !== entry.hostId) continue;
    if (entry.source !== "manual" && entry.source !== "tofu") continue;
    entries.set(entry.hostId, {
      hostId: entry.hostId,
      publicKeyPem: entry.publicKeyPem,
      fingerprint: typeof entry.fingerprint === "string" ? entry.fingerprint : `sha256:${sha256Hex(entry.publicKeyPem)}`,
      source: entry.source,
      addedAt: typeof entry.addedAt === "string" ? entry.addedAt : new Date(0).toISOString(),
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString(),
      ...(typeof entry.displayName === "string" ? { displayName: entry.displayName } : {}),
    });
  }
  return entries;
}
