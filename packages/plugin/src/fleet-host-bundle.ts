import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  canonicalJson,
  hostIdFromPublicKey,
  isFleetHostManifest,
  sha256Hex,
  verifyFleetManifest,
  type FleetHostManifest,
} from "./fleet-environment.js";
import type { FleetTrustStore } from "./fleet-trust.js";

export interface FleetHostBundle {
  contractVersion: 1;
  createdAt: string;
  manifest: FleetHostManifest;
  publicKeyPem: string;
  digest: string;
}

export interface FleetHostBundleImportResult {
  hostId: string;
  digest: string;
  cachedPath: string;
  trusted: boolean;
  expectedPath?: string;
  expectedBackupPath?: string;
}

export class FleetBundleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FleetBundleError";
  }
}

export interface WhaleBundleServiceV1 {
  readonly contractVersion: 1;
  exportHost(): Promise<FleetHostBundle>;
  importHost(bundle: unknown, options?: { pinTrust?: boolean; saveExpected?: boolean }): Promise<FleetHostBundleImportResult>;
}

export function createFleetBundleService(options: {
  manifest: () => Promise<FleetHostManifest>;
  publicKeyPem: () => string | undefined;
  directory: string;
  trust: FleetTrustStore;
  expectedManifestPath?: string;
  refresh?: () => Promise<unknown>;
  now?: () => number;
}): WhaleBundleServiceV1 {
  return {
    contractVersion: 1,
    async exportHost() {
      const manifest = await options.manifest();
      const publicKeyPem = options.publicKeyPem();
      if (publicKeyPem === undefined || publicKeyPem.trim() === "") {
        throw new FleetBundleError("bundle/key-unavailable", "本机公钥尚未生成");
      }
      return createFleetHostBundle({
        manifest,
        publicKeyPem,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    },
    async importHost(bundle, importOptions = {}) {
      const result = importFleetHostBundle(bundle, {
        directory: options.directory,
        trust: options.trust,
        pinTrust: importOptions.pinTrust === true,
        saveExpected: importOptions.saveExpected === true,
        ...(options.expectedManifestPath === undefined ? {} : { expectedManifestPath: options.expectedManifestPath }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      await options.refresh?.();
      return result;
    },
  };
}

export function createFleetHostBundle(input: {
  manifest: FleetHostManifest;
  publicKeyPem: string;
  now?: () => number;
}): FleetHostBundle {
  const payload = {
    contractVersion: 1 as const,
    createdAt: new Date((input.now ?? Date.now)()).toISOString(),
    manifest: input.manifest,
    publicKeyPem: input.publicKeyPem,
  };
  return {
    ...payload,
    digest: `sha256:${sha256Hex(canonicalJson(payload))}`,
  };
}

export function verifyFleetHostBundle(bundle: unknown): FleetHostBundle {
  if (bundle === null || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new FleetBundleError("bundle/invalid", "加入包格式无效");
  }
  const value = bundle as Partial<FleetHostBundle>;
  if (value.contractVersion !== 1 || typeof value.createdAt !== "string"
    || typeof value.publicKeyPem !== "string" || typeof value.digest !== "string"
    || !isFleetHostManifest(value.manifest)) {
    throw new FleetBundleError("bundle/invalid", "加入包字段不完整");
  }
  const payload = {
    contractVersion: 1 as const,
    createdAt: value.createdAt,
    manifest: value.manifest,
    publicKeyPem: value.publicKeyPem,
  };
  if (value.digest !== `sha256:${sha256Hex(canonicalJson(payload))}`) {
    throw new FleetBundleError("bundle/digest-invalid", "加入包摘要不匹配");
  }
  let derived: string;
  try {
    derived = hostIdFromPublicKey(value.publicKeyPem);
  } catch {
    throw new FleetBundleError("bundle/key-invalid", "加入包公钥无效");
  }
  if (derived !== value.manifest.hostId) {
    throw new FleetBundleError("bundle/key-mismatch", "公钥与 hostId 不匹配");
  }
  if (!verifyFleetManifest(value.manifest, value.publicKeyPem)) {
    throw new FleetBundleError("bundle/signature-invalid", "加入包清单签名无效");
  }
  return value as FleetHostBundle;
}

export function importFleetHostBundle(bundle: unknown, options: {
  directory: string;
  expectedManifestPath?: string;
  trust?: FleetTrustStore;
  pinTrust?: boolean;
  saveExpected?: boolean;
  now?: () => number;
}): FleetHostBundleImportResult {
  const verified = verifyFleetHostBundle(bundle);
  const hostId = verified.manifest.hostId;
  const hostsDirectory = join(options.directory, "hosts");
  mkdirSync(hostsDirectory, { recursive: true, mode: 0o700 });
  const cachedPath = join(hostsDirectory, `${hostId.slice(7)}.json`);
  atomicJson(cachedPath, verified.manifest);

  let trusted = false;
  if (options.pinTrust === true) {
    if (options.trust === undefined) throw new FleetBundleError("bundle/trust-unavailable", "信任表未配置");
    options.trust.trust(hostId, verified.publicKeyPem, "manual");
    trusted = true;
  }

  let expectedPath: string | undefined;
  let expectedBackupPath: string | undefined;
  if (options.saveExpected === true) {
    expectedPath = options.expectedManifestPath ?? join(options.directory, "expected-manifest.json");
    if (existsSync(expectedPath)) {
      expectedBackupPath = `${expectedPath}.bak-${new Date((options.now ?? Date.now)()).toISOString().replaceAll(/[-:.]/gu, "")}`;
      copyFileSync(expectedPath, expectedBackupPath);
      chmodSync(expectedBackupPath, 0o600);
    }
    atomicJson(expectedPath, verified.manifest);
  }
  return {
    hostId,
    digest: verified.digest,
    cachedPath,
    trusted,
    ...(expectedPath === undefined ? {} : { expectedPath }),
    ...(expectedBackupPath === undefined ? {} : { expectedBackupPath }),
  };
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
  renameSync(temporary, path);
}
