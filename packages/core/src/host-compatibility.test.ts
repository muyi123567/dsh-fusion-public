import { describe, expect, it } from "vitest";
import {
  evaluateDshCompatibility,
  type DshCompatibilityMatrix,
} from "./host-compatibility.js";

const matrix: DshCompatibilityMatrix = {
  minimum: "0.2.0-rc.2",
  maximumExclusive: "0.3.0",
  recommended: "0.2.0-rc.2",
  tested: ["0.2.0-rc.2"],
  candidates: ["0.2.1-rc.5"],
};

describe("evaluateDshCompatibility", () => {
  it("reports the exact tested host as verified", () => {
    expect(evaluateDshCompatibility({
      version: "0.2.0-rc.2",
      source: "config",
      matrix,
    })).toEqual({
      schemaVersion: 1,
      state: "verified",
      version: "0.2.0-rc.2",
      source: "config",
      reasonCode: "TESTED_HOST",
      matrix,
    });
  });

  it("allows a newer in-range host as untested", () => {
    const report = evaluateDshCompatibility({
      version: "0.2.1-rc.5",
      source: "package",
      matrix,
    });

    expect(report.state).toBe("untested");
    expect(report.version).toBe("0.2.1-rc.5");
    expect(report.source).toBe("package");
    expect(report.reasonCode).toBe("UNTESTED_HOST");
  });

  it("does not treat the next major prerelease as in range", () => {
    expect(evaluateDshCompatibility({
      version: "0.3.0-alpha.1",
      source: "environment",
      matrix,
    }).state).toBe("unsupported");
  });

  it.each(["0.1.5-rc.2", "0.2.0-rc.1", "0.3.0"])(
    "rejects out-of-range host %s",
    (version) => {
      const report = evaluateDshCompatibility({ version, source: "config", matrix });
      expect(report.state).toBe("unsupported");
      expect(["HOST_TOO_OLD", "HOST_TOO_NEW"]).toContain(report.reasonCode);
    },
  );

  it.each([undefined, "", "not-a-version", "v0.2.0"])(
    "keeps an unavailable or malformed version unknown: %s",
    (version) => {
      const report = evaluateDshCompatibility({
        ...(version === undefined ? {} : { version }),
        source: version === undefined ? "unknown" : "environment",
        matrix,
      });
      expect(report.state).toBe("unknown");
      expect(report.reasonCode).toBe(
        version === undefined || version.trim() === "" ? "VERSION_MISSING" : "VERSION_INVALID",
      );
      expect(report.version).toBeUndefined();
    },
  );

  it("orders prerelease identifiers without treating rc.10 as rc.1", () => {
    expect(evaluateDshCompatibility({
      version: "0.2.1-rc.10",
      source: "config",
      matrix,
    }).state).toBe("untested");
    expect(evaluateDshCompatibility({
      version: "0.2.0-rc.10",
      source: "config",
      matrix,
    }).state).toBe("untested");
  });
});
