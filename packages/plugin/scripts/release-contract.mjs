import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u;
const MINIMUM_NODE_PATTERN = /^>=\s*(\d+\.\d+\.\d+)$/u;
const DSH_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function compareVersions(left, right) {
  const normalize = (value) => value.split("-", 1)[0].split(".").map(Number);
  const a = normalize(left);
  const b = normalize(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function assertSafePackagePath(packageRoot, path) {
  const resolved = resolve(packageRoot, path);
  const relativePath = relative(packageRoot, resolved);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`DSH_FUSION_UNSAFE_RELEASE_PATH:${path}`);
  }
  return resolved;
}

export function loadReleaseContract(packageRoot) {
  const packageJson = readJson(resolve(packageRoot, "package.json"));
  const releasePath = resolve(packageRoot, "release.json");
  const compatibilityPath = resolve(packageRoot, "compatibility.json");
  if (!existsSync(releasePath)) {
    throw new Error("DSH_FUSION_RELEASE_MANIFEST_MISSING:release.json");
  }
  if (!existsSync(compatibilityPath)) {
    throw new Error("DSH_FUSION_COMPATIBILITY_MANIFEST_MISSING:compatibility.json");
  }
  const release = readJson(releasePath);
  const hostCompatibility = readJson(compatibilityPath);
  if (release.schemaVersion !== 2) {
    throw new Error(`DSH_FUSION_RELEASE_SCHEMA_UNSUPPORTED:${String(release.schemaVersion)}`);
  }
  if (release.runtime?.dsh !== packageJson.dsh?.compatibility?.dsh) {
    throw new Error(
      `DSH_FUSION_RELEASE_DSH_MISMATCH:${String(release.runtime?.dsh)}:${String(packageJson.dsh?.compatibility?.dsh)}`,
    );
  }
  if (
    hostCompatibility.schemaVersion !== 1
    || typeof hostCompatibility.installRange !== "string"
    || typeof hostCompatibility.minimum !== "string"
    || typeof hostCompatibility.maximumExclusive !== "string"
    || typeof hostCompatibility.recommended !== "string"
    || !Array.isArray(hostCompatibility.tested)
    || !hostCompatibility.tested.every((value) => typeof value === "string")
    || !Array.isArray(hostCompatibility.candidates)
    || !hostCompatibility.candidates.every((value) => typeof value === "string")
  ) {
    throw new Error("DSH_FUSION_COMPATIBILITY_MANIFEST_INVALID");
  }
  if (
    packageJson.engines?.dsh !== hostCompatibility.installRange
    || release.runtime?.dsh !== hostCompatibility.installRange
  ) {
    throw new Error("DSH_FUSION_COMPATIBILITY_RANGE_MISMATCH");
  }
  if (
    release.runtime?.recommendedDsh !== hostCompatibility.recommended
    || JSON.stringify(release.runtime?.testedDsh) !== JSON.stringify(hostCompatibility.tested)
    || JSON.stringify(release.runtime?.candidateDsh) !== JSON.stringify(hostCompatibility.candidates)
  ) {
    throw new Error("DSH_FUSION_COMPATIBILITY_MATRIX_MISMATCH");
  }
  if (typeof release.runtime?.node !== "string" || !MINIMUM_NODE_PATTERN.test(release.runtime.node)) {
    throw new Error(`DSH_FUSION_RELEASE_NODE_RANGE_INVALID:${String(release.runtime?.node)}`);
  }
  if (!Array.isArray(release.companions)) {
    throw new Error("DSH_FUSION_RELEASE_COMPANIONS_INVALID");
  }
  const companions = release.companions.map((companion) => {
    if (
      typeof companion?.id !== "string"
      || typeof companion.name !== "string"
      || typeof companion.version !== "string"
      || typeof companion.path !== "string"
      || !/^[a-f0-9]{64}$/u.test(companion.sha256)
    ) {
      throw new Error(`DSH_FUSION_RELEASE_COMPANION_INVALID:${String(companion?.id)}`);
    }
    const file = assertSafePackagePath(packageRoot, companion.path);
    if (!existsSync(file)) {
      throw new Error(`DSH_FUSION_RELEASE_COMPANION_MISSING:${companion.path}`);
    }
    const actual = sha256(file);
    if (actual !== companion.sha256) {
      throw new Error(
        `DSH_FUSION_RELEASE_COMPANION_HASH_MISMATCH:${companion.id}:${actual}:${companion.sha256}`,
      );
    }
    return { ...companion, file };
  });
  return { packageJson, release, companions, hostCompatibility };
}

export function assertSupportedNode(runtimeRange, currentVersion = process.versions.node) {
  const match = MINIMUM_NODE_PATTERN.exec(runtimeRange);
  if (match === null) {
    throw new Error(`DSH_FUSION_RELEASE_NODE_RANGE_INVALID:${runtimeRange}`);
  }
  if (compareVersions(currentVersion, match[1]) < 0) {
    throw new Error(
      `DSH_FUSION_NODE_UNSUPPORTED:${currentVersion}:${runtimeRange}`,
    );
  }
}

export function extractVersion(output) {
  return VERSION_PATTERN.exec(output)?.[0];
}

function parseDshVersion(value) {
  const match = DSH_VERSION_PATTERN.exec(value);
  if (match === null) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined
      ? []
      : match[4].split(".").map((identifier) =>
          /^\d+$/u.test(identifier) ? Number(identifier) : identifier),
  };
}

function compareDshCore(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left.core[index] - right.core[index];
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function compareDshVersions(left, right) {
  const core = compareDshCore(left, right);
  if (core !== 0) return core;
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return Math.sign(a - b);
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return a.localeCompare(b);
  }
  return 0;
}

export function evaluateDshHostCompatibility(contract, output) {
  const actual = extractVersion(output);
  if (actual === undefined) {
    return {
      schemaVersion: 1,
      state: "unknown",
      source: "installer",
      reasonCode: "VERSION_UNREADABLE",
      matrix: contract.hostCompatibility,
    };
  }
  const version = parseDshVersion(actual);
  const minimum = parseDshVersion(contract.hostCompatibility.minimum);
  const maximum = parseDshVersion(contract.hostCompatibility.maximumExclusive);
  if (version === undefined || minimum === undefined || maximum === undefined) {
    return {
      schemaVersion: 1,
      state: "unknown",
      source: "installer",
      reasonCode: "VERSION_INVALID",
      matrix: contract.hostCompatibility,
    };
  }
  if (compareDshCore(version, maximum) >= 0 || compareDshVersions(version, minimum) < 0) {
    return {
      schemaVersion: 1,
      state: "unsupported",
      version: actual,
      source: "installer",
      reasonCode: compareDshVersions(version, minimum) < 0 ? "HOST_TOO_OLD" : "HOST_TOO_NEW",
      matrix: contract.hostCompatibility,
    };
  }
  const tested = contract.hostCompatibility.tested.some((candidate) => {
    const parsed = parseDshVersion(candidate);
    return parsed !== undefined && compareDshVersions(version, parsed) === 0;
  });
  return {
    schemaVersion: 1,
    state: tested ? "verified" : "untested",
    version: actual,
    source: "installer",
    reasonCode: tested ? "TESTED_HOST" : "UNTESTED_HOST",
    matrix: contract.hostCompatibility,
  };
}

export function assertDshHostInstallable(report) {
  if (report.state !== "unsupported") return report.version;
  throw new Error(
    `DSH_FUSION_DSH_VERSION_UNSUPPORTED:${report.version ?? "unknown"}:${report.reasonCode}`,
  );
}
