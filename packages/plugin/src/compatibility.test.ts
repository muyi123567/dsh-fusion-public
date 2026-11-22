import { describe, expect, it } from "vitest";
import {
  FUSION_DSH_COMPATIBILITY_MATRIX,
  assertDshInstallable,
  resolveDshCompatibility,
} from "./compatibility.js";

describe("Fusion DSH compatibility", () => {
  it("uses config before environment and installed package versions", () => {
    const report = resolveDshCompatibility({
      configuredVersion: "0.2.1-rc.5",
      environmentVersion: "0.2.0-rc.2",
      packageVersion: "0.2.0-rc.2",
    });

    expect(report).toMatchObject({
      state: "untested",
      version: "0.2.1-rc.5",
      source: "config",
      reasonCode: "UNTESTED_HOST",
    });
  });

  it("uses the environment when config is absent", () => {
    expect(resolveDshCompatibility({
      environmentVersion: "0.2.0-rc.2",
      packageVersion: "0.2.1-rc.5",
    })).toMatchObject({
      state: "untested",
      version: "0.2.0-rc.2",
      source: "environment",
    });
  });

  it("uses the installed package version when no explicit version exists", () => {
    expect(resolveDshCompatibility({
      packageVersion: "0.2.2-rc.1",
    })).toMatchObject({
      state: "untested",
      version: "0.2.2-rc.1",
      source: "package",
    });
  });

  it("keeps a missing version unknown", () => {
    expect(resolveDshCompatibility({})).toMatchObject({
      state: "unknown",
      source: "unknown",
      reasonCode: "VERSION_MISSING",
    });
  });

  it("blocks only unsupported hosts from loading", () => {
    expect(() => assertDshInstallable(resolveDshCompatibility({
      configuredVersion: "0.2.0-rc.1",
    }))).toThrow("DSH_INCOMPATIBLE_VERSION:0.2.0-rc.1");
    expect(() => assertDshInstallable(resolveDshCompatibility({
      configuredVersion: "0.2.1-rc.5",
    }))).not.toThrow();
    expect(() => assertDshInstallable(resolveDshCompatibility({}))).not.toThrow();
  });

  it("keeps the verified matrix narrow and the candidate visible", () => {
    expect(FUSION_DSH_COMPATIBILITY_MATRIX).toEqual({
      minimum: "0.2.0-rc.2",
      maximumExclusive: "0.3.0",
      recommended: "0.2.2-rc.5",
      tested: ["0.2.2-rc.5", "0.2.3-alpha.2"],
      candidates: ["0.2.0-rc.2", "0.2.2-rc.1", "0.2.2-rc.3"],
    });
  });

  it("verifies the latest stable and alpha hosts and leaves rc.3 untested", () => {
    const report = resolveDshCompatibility({
      packageVersion: "0.2.2-rc.5",
    });

    expect(report).toMatchObject({
      state: "verified",
      version: "0.2.2-rc.5",
      source: "package",
      reasonCode: "TESTED_HOST",
    });
    expect(resolveDshCompatibility({ packageVersion: "0.2.3-alpha.2" })).toMatchObject({
      state: "verified",
      reasonCode: "TESTED_HOST",
    });
    expect(resolveDshCompatibility({
      packageVersion: "0.2.2-rc.3",
    })).toMatchObject({
      state: "untested",
      reasonCode: "UNTESTED_HOST",
    });
  });
});
