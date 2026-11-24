import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectFleetManifest } from "./fleet-environment-collector.js";
import { verifyFleetManifest } from "./fleet-environment.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "fleet-collector-"));
  const home = join(root, "home");
  const profile = join(root, "profile");
  mkdirSync(home);
  mkdirSync(profile);
  writeFileSync(join(profile, "cordis.patch.yml"), "- id: whale\n");
  writeFileSync(join(home, "cordis.patch.yml"), "[]\n");
  writeFileSync(join(profile, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(profile, "compatibility.json"), JSON.stringify({ "x@1.0.0": ["0.2.3"] }));
  return { root, home, profile };
}

function context(fixture: ReturnType<typeof makeFixture>, bundles: unknown[] = []) {
  return {
    get: (name: string) => {
      if (name === "pluginManager") return { listBundles: async () => bundles };
      if (name === "profileContext") {
        return {
          name: "web", dir: fixture.profile, patchPath: join(fixture.profile, "cordis.patch.yml"),
          home: fixture.home, cwd: fixture.profile, startedBundles: ["dsh-fusion"], overlayPaths: [],
        };
      }
      if (name === "llm") return { listProviders: () => [{ id: "deepseek", name: "DeepSeek" }] };
      if (name === "mcpManager") return { list: () => [{ name: "whale-fleet", configured: false }] };
      return undefined;
    },
  };
}

describe("fleet environment collector", () => {
  it("collects bundles, patches, providers, MCP names and secret presence", async () => {
    const fixtureFiles = makeFixture();
    const bundle = {
      name: "dsh-fusion", version: "0.2.0-beta.14", enabled: true, installed: true,
      availability: "profile", rows: [{ rowId: "whale" }], overrides: [], source: "github:test",
    };
    const { manifest, publicKeyPem } = await collectFleetManifest({
      ctx: context(fixtureFiles, [bundle]),
      directory: join(fixtureFiles.root, "fleet"),
      secretNames: ["DEEPSEEK_API_KEY", "MISSING_KEY"],
      env: { DEEPSEEK_API_KEY: "present" },
      now: () => new Date("2026-11-22T10:00:00Z"),
      readVcs: () => ({ commit: "b".repeat(40), dirty: false }),
    });
    expect(manifest.dsh).toMatchObject({ profile: "web", platform: process.platform, arch: process.arch });
    expect(manifest.bundles).toEqual([expect.objectContaining({
      name: "dsh-fusion", version: "0.2.0-beta.14", enabled: true, availability: "profile", rows: ["whale"],
    })]);
    expect(manifest.patches.profile?.sha256).toBe(`sha256:${sha256("- id: whale\n")}`);
    expect(manifest.providers).toEqual(["deepseek"]);
    expect(manifest.mcpServers).toEqual([expect.objectContaining({ name: "whale-fleet", transport: "unknown" })]);
    expect(manifest.secrets.present).toEqual(["DEEPSEEK_API_KEY"]);
    expect(manifest.compatibility?.exemptions).toEqual(["x@1.0.0"]);
    expect(manifest.workspaces[0]).toMatchObject({ vcsCommit: "b".repeat(40), dirty: false });
    expect(verifyFleetManifest(manifest, publicKeyPem)).toBe(true);
  });

  it("keeps a stable host identity across collections", async () => {
    const fixtureFiles = makeFixture();
    const options = {
      ctx: context(fixtureFiles, []),
      directory: join(fixtureFiles.root, "fleet"),
      now: () => new Date("2026-11-22T10:00:00Z"),
    };
    const first = await collectFleetManifest(options);
    const second = await collectFleetManifest(options);
    expect(first.manifest.hostId).toBe(second.manifest.hostId);
    expect(first.manifest.environmentDigest).toBe(second.manifest.environmentDigest);
  });

  it("redacts credentials from bundle sources", async () => {
    const fixtureFiles = makeFixture();
    const { manifest } = await collectFleetManifest({
      ctx: context(fixtureFiles, [{
        name: "private", version: "1.0.0", enabled: true, availability: "profile", rows: [],
        source: "https://user:pass@example.com/repo.git?token=abc&ref=main",
      }]),
      directory: join(fixtureFiles.root, "fleet"),
      now: () => new Date("2026-11-24T07:00:00Z"),
    });
    const source = manifest.bundles[0]?.source ?? "";
    expect(source).toContain("example.com/repo.git");
    expect(source).not.toContain("user");
    expect(source).not.toContain("pass");
    expect(source).not.toContain("abc");
    expect(decodeURIComponent(source)).toContain("<redacted>");
  });

  it("degrades to an unknown inventory instead of inventing bundles", async () => {
    const fixtureFiles = makeFixture();
    const { manifest } = await collectFleetManifest({
      ctx: { get: () => undefined },
      directory: join(fixtureFiles.root, "fleet"),
      now: () => new Date("2026-11-22T10:00:00Z"),
    });
    expect(manifest.bundles).toEqual([]);
    expect(manifest.patches).toEqual({ profile: null, home: null });
    expect(manifest.capabilities).toMatchObject({ pluginManager: false, profileContext: false, llm: false, mcpManager: false });
  });

  it("does not let a read failure become a clean patch digest", async () => {
    const fixtureFiles = makeFixture();
    const { manifest } = await collectFleetManifest({
      ctx: context(fixtureFiles, []),
      directory: join(fixtureFiles.root, "fleet"),
      now: () => new Date("2026-11-22T10:00:00Z"),
      readText: vi.fn(() => { throw new Error("EACCES"); }),
    });
    expect(manifest.patches.profile).toBeNull();
    expect(manifest.capabilities).toMatchObject({ patchesReadable: false });
  });

  it("treats a missing optional patch as absent, not unreadable", async () => {
    const fixtureFiles = makeFixture();
    const { manifest } = await collectFleetManifest({
      ctx: context(fixtureFiles, []),
      directory: join(fixtureFiles.root, "fleet"),
      now: () => new Date("2026-11-22T10:00:00Z"),
      readText: (path) => {
        if (path.includes(`${join("home", "cordis.patch.yml")}`)) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return `content:${path}`;
      },
    });
    expect(manifest.patches.home).toBeNull();
    expect(manifest.patches.profile).not.toBeNull();
    expect(manifest.capabilities).toMatchObject({ patchesReadable: true });
  });
});
