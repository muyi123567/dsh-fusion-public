export type DshCompatibilityState =
  | "verified"
  | "untested"
  | "unsupported"
  | "unknown";

export type DshCompatibilitySource =
  | "config"
  | "environment"
  | "package"
  | "unknown";

export interface DshCompatibilityMatrix {
  minimum: string;
  maximumExclusive: string;
  recommended: string;
  tested: readonly string[];
  candidates: readonly string[];
}

export interface DshCompatibilityReport {
  schemaVersion: 1;
  state: DshCompatibilityState;
  version?: string;
  source: DshCompatibilitySource;
  reasonCode:
    | "TESTED_HOST"
    | "UNTESTED_HOST"
    | "HOST_TOO_OLD"
    | "HOST_TOO_NEW"
    | "VERSION_MISSING"
    | "VERSION_INVALID";
  matrix: DshCompatibilityMatrix;
}

interface ParsedVersion {
  core: readonly [number, number, number];
  prerelease: readonly (string | number)[];
}

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(value.trim());
  if (match === null) return undefined;
  const prerelease = match[4] === undefined
    ? []
    : match[4].split(".").map((identifier) =>
        /^\d+$/u.test(identifier) ? Number(identifier) : identifier
      );
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  };
}

function compareCore(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left.core[index]! - right.core[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  const core = compareCore(left, right);
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

function copyMatrix(matrix: DshCompatibilityMatrix): DshCompatibilityMatrix {
  return {
    minimum: matrix.minimum,
    maximumExclusive: matrix.maximumExclusive,
    recommended: matrix.recommended,
    tested: [...matrix.tested],
    candidates: [...matrix.candidates],
  };
}

/**
 * Classifies a host version without turning missing evidence into support.
 * The upper bound is a major policy boundary, so 0.3.0 prereleases are outside
 * the 0.2 line even though SemVer orders them below 0.3.0.
 */
export function evaluateDshCompatibility(input: {
  version?: string;
  source: DshCompatibilitySource;
  matrix: DshCompatibilityMatrix;
}): DshCompatibilityReport {
  const matrix = copyMatrix(input.matrix);
  if (input.version === undefined || input.version.trim() === "") {
    return {
      schemaVersion: 1,
      state: "unknown",
      source: input.source,
      reasonCode: "VERSION_MISSING",
      matrix,
    };
  }
  const version = parseVersion(input.version);
  if (version === undefined) {
    return {
      schemaVersion: 1,
      state: "unknown",
      source: input.source,
      reasonCode: "VERSION_INVALID",
      matrix,
    };
  }
  const minimum = parseVersion(matrix.minimum);
  const maximum = parseVersion(matrix.maximumExclusive);
  if (minimum === undefined || maximum === undefined) {
    throw new Error("DSH_COMPATIBILITY_MATRIX_INVALID");
  }
  if (compareCore(version, maximum) >= 0 || compareVersions(version, minimum) < 0) {
    return {
      schemaVersion: 1,
      state: "unsupported",
      version: input.version.trim(),
      source: input.source,
      reasonCode: compareVersions(version, minimum) < 0 ? "HOST_TOO_OLD" : "HOST_TOO_NEW",
      matrix,
    };
  }
  const tested = matrix.tested.some((candidate) => {
    const parsed = parseVersion(candidate);
    return parsed !== undefined && compareVersions(version, parsed) === 0;
  });
  return {
    schemaVersion: 1,
    state: tested ? "verified" : "untested",
    version: input.version.trim(),
    source: input.source,
    reasonCode: tested ? "TESTED_HOST" : "UNTESTED_HOST",
    matrix,
  };
}
