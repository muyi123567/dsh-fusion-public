import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  evaluateDshCompatibility,
  type DshCompatibilityMatrix,
  type DshCompatibilityReport,
} from "@dsh-fusion/core";

const require = createRequire(import.meta.url);

export const FUSION_DSH_COMPATIBILITY_MATRIX: DshCompatibilityMatrix = {
  minimum: "0.2.0-rc.2",
  maximumExclusive: "0.3.0",
  recommended: "0.2.2-rc.5",
  tested: ["0.2.2-rc.5", "0.2.3-alpha.2"],
  candidates: ["0.2.0-rc.2", "0.2.2-rc.1", "0.2.2-rc.3"],
};

export function readInstalledDshVersion(): string | undefined {
  try {
    const path = require.resolve("@deepseek-ai/dsh/package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

function present(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}

export function resolveDshCompatibility(input: {
  configuredVersion?: string;
  environmentVersion?: string;
  packageVersion?: string;
} = {}): DshCompatibilityReport {
  const configuredVersion = present(input.configuredVersion);
  if (configuredVersion !== undefined) {
    return evaluateDshCompatibility({
      version: configuredVersion,
      source: "config",
      matrix: FUSION_DSH_COMPATIBILITY_MATRIX,
    });
  }
  const environmentVersion = present(input.environmentVersion);
  if (environmentVersion !== undefined) {
    return evaluateDshCompatibility({
      version: environmentVersion,
      source: "environment",
      matrix: FUSION_DSH_COMPATIBILITY_MATRIX,
    });
  }
  const packageVersion = present(input.packageVersion);
  if (packageVersion !== undefined) {
    return evaluateDshCompatibility({
      version: packageVersion,
      source: "package",
      matrix: FUSION_DSH_COMPATIBILITY_MATRIX,
    });
  }
  return evaluateDshCompatibility({
    source: "unknown",
    matrix: FUSION_DSH_COMPATIBILITY_MATRIX,
  });
}

export function assertDshInstallable(report: DshCompatibilityReport): void {
  if (report.state !== "unsupported") return;
  throw new Error(
    `DSH_INCOMPATIBLE_VERSION:${report.version ?? "unknown"}:${report.reasonCode}`,
  );
}
