import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  diffFleetManifests,
  FLEET_CONTRACT_VERSION,
  isFleetHostManifest,
  type FleetDriftItem,
  type FleetDriftReport,
  type FleetHostManifest,
} from "./fleet-environment.js";
import type { FleetDoctorReport } from "./fleet-doctor.js";
import { planFleetAlignment, type FleetPlanReport } from "./fleet-plan.js";

export interface FleetHostSummary {
  hostId: string;
  displayName: string;
  observedAt: string;
  digest: string;
  overall: "match" | "drift" | "unknown";
  stale: boolean;
  signed: boolean;
}

export interface FleetPanelView {
  hostId: string;
  displayName: string;
  observedAt: string;
  digest: string;
  expectedDigest?: string;
  overall: "match" | "drift" | "unknown";
  reason?: string;
  stale: boolean;
  signed: boolean;
  items: FleetDriftItem[];
  counts: { block: number; warn: number; info: number };
}

export interface WhaleFleetServiceV1 {
  readonly contractVersion: 1;
  manifest(): Promise<FleetHostManifest>;
  host(hostId: string): Promise<FleetHostManifest | undefined>;
  listHosts(): Promise<FleetHostSummary[]>;
  diff(hostId: string, expectedDigest?: string): Promise<FleetDriftReport>;
  panelView(): Promise<FleetPanelView>;
  doctor?(): Promise<FleetDoctorReport>;
  plan(hostId: string, expectedDigest?: string): Promise<FleetPlanReport>;
  saveExpected(hostId: string): Promise<{ hostId: string; digest: string; path: string }>;
  subscribe(listener: (event: { hostId: string; digest: string }) => void): () => void;
}

export class FleetServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FleetServiceError";
  }
}

interface ExpectedManifest {
  manifest?: FleetHostManifest;
  digest?: string;
}

export interface FleetServiceOptions {
  collect: () => Promise<FleetHostManifest>;
  directory: string;
  expectedManifestPath?: string;
  staleAfterSeconds?: number;
  ttlMs?: number;
  now?: () => number;
  readFile?: (path: string) => string;
  readdir?: (path: string) => string[];
  verifyManifest?: (manifest: FleetHostManifest) => boolean | undefined;
  doctor?: () => Promise<FleetDoctorReport>;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_STALE_SECONDS = 900;
const HOST_ID = /^sha256:[a-f0-9]{64}$/u;

export function createWhaleFleetService(options: FleetServiceOptions): WhaleFleetServiceV1 {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const readdir = options.readdir ?? ((path: string) => readdirSync(path));
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_SECONDS;
  const listeners = new Set<(event: { hostId: string; digest: string }) => void>();
  let cached: { manifest: FleetHostManifest; at: number } | undefined;
  let inflight: Promise<FleetHostManifest> | undefined;

  const manifest = async (): Promise<FleetHostManifest> => {
    if (cached !== undefined && now() - cached.at < ttlMs) return cached.manifest;
    if (inflight !== undefined) return inflight;
    inflight = options.collect().then(value => {
      const previous = cached?.manifest;
      cached = { manifest: value, at: now() };
      inflight = undefined;
      if (previous === undefined || previous.environmentDigest !== value.environmentDigest) {
        for (const listener of listeners) {
          try { listener({ hostId: value.hostId, digest: value.environmentDigest }); } catch { /* observers cannot break collection */ }
        }
      }
      return value;
    }, error => {
      inflight = undefined;
      throw error instanceof FleetServiceError
        ? error
        : new FleetServiceError("whale/collect-failed", error instanceof Error ? error.message : String(error));
    });
    return inflight;
  };

  const host = async (hostId: string): Promise<FleetHostManifest | undefined> => {
    if (!HOST_ID.test(hostId)) throw new FleetServiceError("whale/invalid-input", "hostId 无效");
    const local = await manifest();
    if (local.hostId === hostId) return local;
    return readCachedHost(hostId).manifest;
  };

  const diff = async (hostId: string, expectedDigest?: string): Promise<FleetDriftReport> => {
    const observed = await host(hostId);
    if (observed === undefined) throw new FleetServiceError("whale/host-unknown", "未知主机：" + hostId);
    const local = await manifest();
    // A locally collected manifest is fresh by construction. Only cached
    // remote manifests can exceed their staleness budget.
    const stale = observed.hostId !== local.hostId && isStale(observed);
    if (stale) {
      return {
        contractVersion: FLEET_CONTRACT_VERSION,
        hostId,
        expectedDigest: expectedDigest ?? loadExpected()?.manifest?.environmentDigest ?? null,
        observedDigest: observed.environmentDigest,
        checkedAt: new Date(now()).toISOString(),
        stale: true,
        overall: "unknown",
        reason: "来源已过期，不能当作匹配",
        items: [],
      };
    }
    const expected = loadExpected();
    const verified = verifyOne(observed);
    const expectedDigestValue = expectedDigest ?? expected?.digest;
    if (expected?.manifest === undefined && expectedDigestValue === undefined) {
      return unknown(observed, expectedDigest ?? null, "未配置期望环境，无法判断漂移", verified);
    }
    if (expectedDigest !== undefined && expected?.digest !== undefined && expected.digest !== expectedDigest) {
      return unknown(observed, expectedDigest, "期望清单摘要与锁不一致", verified);
    }
    if (expected?.manifest === undefined) {
      const digest = expectedDigestValue;
      if (digest === observed.environmentDigest) {
        return {
          contractVersion: FLEET_CONTRACT_VERSION,
          hostId,
          expectedDigest: digest ?? null,
          observedDigest: observed.environmentDigest,
          checkedAt: new Date(now()).toISOString(),
          overall: "match",
          items: [],
        };
      }
      return {
        contractVersion: FLEET_CONTRACT_VERSION,
        hostId,
        expectedDigest: digest ?? null,
        observedDigest: observed.environmentDigest,
        checkedAt: new Date(now()).toISOString(),
        overall: "drift",
        items: [{
          code: "manifest.digest", severity: "block", path: "environmentDigest",
          expected: digest, actual: observed.environmentDigest,
          remedy: "提供完整期望清单以定位具体差异",
        }],
      };
    }
    const report = diffFleetManifests(expected.manifest, observed, {
      stale: false,
      ...(verified === undefined ? {} : { signatureVerified: verified }),
      now: new Date(now()),
    });
    return expectedDigest === undefined ? report : { ...report, expectedDigest };
  };

  const listHosts = async (): Promise<FleetHostSummary[]> => {
    const local = await manifest();
    const hosts = [local, ...readCachedHosts()];
    const seen = new Set<string>();
    const unique = hosts.filter(candidate => {
      if (seen.has(candidate.hostId)) return false;
      seen.add(candidate.hostId);
      return true;
    });
    const summaries: FleetHostSummary[] = [];
    for (const candidate of unique) {
      const report = await diff(candidate.hostId);
      summaries.push({
        hostId: candidate.hostId,
        displayName: candidate.displayName,
        observedAt: candidate.observedAt,
        digest: candidate.environmentDigest,
        overall: report.overall,
        stale: isStale(candidate),
        signed: candidate.signature.alg === "ed25519",
      });
    }
    return summaries.sort((left, right) =>
      Number(right.hostId === local.hostId) - Number(left.hostId === local.hostId)
      || left.displayName.localeCompare(right.displayName));
  };

  const plan = async (hostId: string, expectedDigest?: string): Promise<FleetPlanReport> => {
    const observed = await host(hostId);
    if (observed === undefined) throw new FleetServiceError("whale/host-unknown", "未知主机：" + hostId);
    const expected = loadExpected();
    if (expected?.manifest === undefined) {
      return {
        contractVersion: 1, hostId, expectedDigest: expectedDigest ?? expected?.digest ?? "",
        observedDigest: observed.environmentDigest, overall: "unknown", steps: [],
        note: "没有完整期望清单，无法生成逐项对齐计划",
      };
    }
    const report = await diff(hostId, expectedDigest);
    return planFleetAlignment(expected.manifest, observed, report);
  };

  const saveExpected = async (hostId: string) => {
    const observed = await host(hostId);
    if (observed === undefined) throw new FleetServiceError("whale/host-unknown", "未知主机：" + hostId);
    if (verifyOne(observed) === false) throw new FleetServiceError("whale/signature-invalid", "清单签名未通过");
    const path = options.expectedManifestPath ?? join(options.directory, "expected-manifest.json");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(observed, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    renameSync(temporary, path);
    return { hostId: observed.hostId, digest: observed.environmentDigest, path };
  };

  const panelView = async (): Promise<FleetPanelView> => {
    const local = await manifest();
    const report = await diff(local.hostId);
    const counts = { block: 0, warn: 0, info: 0 };
    for (const item of report.items) counts[item.severity] += 1;
    return {
      hostId: local.hostId,
      displayName: local.displayName,
      observedAt: local.observedAt,
      digest: local.environmentDigest,
      ...(report.expectedDigest === null ? {} : { expectedDigest: report.expectedDigest }),
      overall: report.overall,
      ...(report.reason === undefined ? {} : { reason: report.reason }),
      stale: report.stale === true,
      signed: local.signature.alg === "ed25519",
      items: report.items,
      counts,
    };
  };

  const subscribe = (listener: (event: { hostId: string; digest: string }) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const loadExpected = (): ExpectedManifest | undefined => {
    const candidates = [
      options.expectedManifestPath,
      join(options.directory, "expected-manifest.json"),
      join(options.directory, "fleet.lock.json"),
    ].filter((value): value is string => value !== undefined && value !== "");
    for (const path of candidates) {
      try {
        const parsed: unknown = JSON.parse(readFile(path));
        if (isFleetHostManifest(parsed)) return { manifest: parsed, digest: parsed.environmentDigest };
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          if (isFleetHostManifest(record.manifest)) {
            return { manifest: record.manifest, digest: record.manifest.environmentDigest };
          }
          if (typeof record.environmentDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(record.environmentDigest)) {
            return { digest: record.environmentDigest };
          }
        }
      } catch {
        continue;
      }
    }
    return undefined;
  };

  const readCachedHost = (hostId: string): { manifest?: FleetHostManifest } => {
    for (const name of [`${hostId}.json`, `${hostId.slice(7)}.json`]) {
      try {
        const parsed: unknown = JSON.parse(readFile(join(options.directory, "hosts", name)));
        if (isFleetHostManifest(parsed) && parsed.hostId === hostId) return { manifest: parsed };
      } catch {
        continue;
      }
    }
    return {};
  };

  const readCachedHosts = (): FleetHostManifest[] => {
    let names: string[];
    try {
      names = readdir(join(options.directory, "hosts")).filter(name => name.endsWith(".json")).sort();
    } catch {
      return [];
    }
    const hosts: FleetHostManifest[] = [];
    for (const name of names) {
      try {
        const parsed: unknown = JSON.parse(readFile(join(options.directory, "hosts", name)));
        if (isFleetHostManifest(parsed)) hosts.push(parsed);
      } catch {
        continue;
      }
    }
    return hosts;
  };

  const isStale = (manifest: FleetHostManifest): boolean => {
    const observed = Date.parse(manifest.observedAt);
    if (!Number.isFinite(observed)) return true;
    const limit = (manifest.staleAfterSeconds ?? staleAfterSeconds) * 1_000;
    return now() - observed > limit;
  };

  const verifyOne = (manifest: FleetHostManifest): boolean | undefined => {
    if (options.verifyManifest === undefined) return undefined;
    try {
      return options.verifyManifest(manifest);
    } catch {
      return false;
    }
  };

  return Object.freeze({
    contractVersion: 1 as const,
    manifest,
    host,
    listHosts,
    diff,
    panelView,
    plan,
    saveExpected,
    ...(options.doctor === undefined ? {} : { doctor: options.doctor }),
    subscribe,
  });
}

function unknown(
  observed: FleetHostManifest,
  expectedDigest: string | null,
  reason: string,
  signatureVerified?: boolean,
): FleetDriftReport {
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    hostId: observed.hostId,
    expectedDigest,
    observedDigest: observed.environmentDigest,
    checkedAt: new Date().toISOString(),
    overall: "unknown",
    reason: signatureVerified === false ? "清单签名未验证" : reason,
    items: [],
  };
}
