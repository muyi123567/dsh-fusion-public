import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FUSION_PLUGIN_VERSION } from "@dsh-fusion/core";
import configPkg from "../packages/config/package.json";
import corePkg from "../packages/core/package.json";
import pkg from "../packages/plugin/package.json";

function readVendoredManifest(relativePath: string): {
  peerDependencies?: Record<string, string>;
} {
  const tarball = fileURLToPath(new URL(relativePath, import.meta.url));
  return JSON.parse(execFileSync(
    "tar",
    ["-xOf", tarball, "package/package.json"],
    { encoding: "utf8" },
  )) as { peerDependencies?: Record<string, string> };
}

describe("dsh-fusion package", () => {
  it("declares both host bundle and web client", () => {
    expect(pkg.dsh.bundle.patch).toBe("./cordis.patch.yml");
    expect(pkg.dsh.client.platform).toBe("web");
  });

  it("exports built JavaScript for Node runtime packages", () => {
    expect(corePkg.exports["."].default).toBe("./dist/index.js");
    expect(configPkg.exports["."].default).toBe("./dist/index.js");
  });

  it("exports and emits the standalone development entry", () => {
    expect(pkg.exports["./standalone"]).toEqual({
      types: "./dist/standalone.d.ts",
      default: "./dist/standalone.js",
    });
    expect(existsSync(new URL("../packages/plugin/dist/standalone.d.ts", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../packages/plugin/dist/standalone.js", import.meta.url))).toBe(true);
  });

  it("ships the one-command setup entry and verified companion bundle", () => {
    expect(pkg.bin["dsh-fusion-setup"]).toBe("./scripts/setup.mjs");
    expect(existsSync(new URL("../packages/plugin/scripts/setup.mjs", import.meta.url))).toBe(true);
    expect(existsSync(new URL(
      "../packages/plugin/vendor/dsh-agent-team-room-0.7.0.tgz",
      import.meta.url,
    ))).toBe(true);
    expect(existsSync(new URL(
      "../packages/plugin/vendor/nanmicoder-dsh-agent-teams-0.1.30.tgz",
      import.meta.url,
    ))).toBe(true);
    expect(existsSync(new URL(
      "../packages/plugin/vendor/dsh-agent-bus-0.1.1-dsh02.tgz",
      import.meta.url,
    ))).toBe(true);
    expect(pkg.files).toContain("vendor/dsh-agent-team-room-0.7.0.tgz");
    expect(pkg.files).toContain("vendor/nanmicoder-dsh-agent-teams-0.1.30.tgz");
    expect(pkg.files).toContain("vendor/dsh-agent-bus-0.1.1-dsh02.tgz");
    expect(pkg.files).toContain("release.json");
    expect(pkg.files).toContain("scripts/installer.mjs");
    expect(pkg.private).toBeUndefined();
    expect(pkg.publishConfig.access).toBe("public");
  });

  it("keeps the shared runtime version aligned with the package manifest", () => {
    expect(FUSION_PLUGIN_VERSION).toBe(pkg.version);
  });

  it("publishes the DSH 0.2.2-compatible AgentTeams companion", () => {
    const release = JSON.parse(readFileSync(
      new URL("../packages/plugin/release.json", import.meta.url),
      "utf8",
    )) as { companions: Array<{ id: string; version: string }> };
    expect(release.companions.find((companion) => companion.id === "agent-teams"))
      .toMatchObject({ version: "0.1.30" });
  });

  it("preserves the published AgentTeams delivery safety contracts", () => {
    execFileSync(process.execPath, [
      "--experimental-vm-modules",
      "--test",
      fileURLToPath(new URL(
        "../packages/plugin/vendor/agent-teams-compat.contract.mjs",
        import.meta.url,
      )),
    ], { encoding: "utf8", timeout: 30_000 });
  });

  it("ranges vendored AgentBus DSH peers across the supported 0.2 line", () => {
    const manifest = readVendoredManifest(
      "../packages/plugin/vendor/dsh-agent-bus-0.1.1-dsh02.tgz",
    );
    expect(manifest.peerDependencies?.["@deepseek-ai/dsh-agent"])
      .toBe(">=0.2.0-rc.2 <0.3.0");
    expect(manifest.peerDependencies?.["@deepseek-ai/dsh-tools"])
      .toBe(">=0.2.0-rc.2 <0.3.0");
  });
});
