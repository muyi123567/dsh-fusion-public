import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PresetError, createFleetPresetService } from "./fleet-presets.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "fusion-presets-"));
  roots.push(value);
  return value;
}

describe("fleet presets", () => {
  it("lists skill, config and plugin presets", () => {
    const service = createFleetPresetService({ skillsDirectory: join(root(), "skills") });
    const list = service.list();
    expect(list.map(preset => preset.id)).toEqual(expect.arrayContaining([
      "whale-fleet-ops", "strict-trust", "chief-approvals", "cloud-materials", "config-hot-backup", "popular-companions",
    ]));
    expect(list.find(preset => preset.id === "whale-fleet-ops")?.status).toMatchObject({ state: "not-installed" });
    expect(list.find(preset => preset.id === "popular-companions")?.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "@xmanrui/dsh-im" }),
    ]));
  });

  it("installs the bundled skill, reports it, and refuses a silent overwrite", () => {
    const skills = join(root(), "skills");
    const service = createFleetPresetService({ skillsDirectory: skills, now: () => Date.parse("2026-11-24T00:00:00Z") });
    const installed = service.installSkill("whale-fleet-ops");
    expect(installed.files).toContain("SKILL.md");
    expect(readFileSync(join(installed.path, "SKILL.md"), "utf8")).toContain("whale_list_hosts");
    expect(service.get("whale-fleet-ops")?.status).toMatchObject({ state: "installed" });
    expect(service.installSkill("whale-fleet-ops")).toMatchObject({ already: true });

    writeFileSync(join(installed.path, "SKILL.md"), "modified", { mode: 0o644 });
    expect(service.get("whale-fleet-ops")?.status).toMatchObject({ state: "modified" });
    expect(codeOf(() => service.installSkill("whale-fleet-ops"))).toBe("preset/modified");
    expect(() => service.uninstallSkill("whale-fleet-ops")).toThrow();
    expect(service.uninstallSkill("whale-fleet-ops", { force: true })).toBe(true);
    expect(service.get("whale-fleet-ops")?.status).toMatchObject({ state: "not-installed" });
  });

  it("does not delete an unrelated directory that lacks preset metadata", () => {
    const skills = join(root(), "skills");
    mkdirSync(join(skills, "whale-fleet-ops"), { recursive: true });
    writeFileSync(join(skills, "whale-fleet-ops", "notes.txt"), "keep");
    const service = createFleetPresetService({ skillsDirectory: skills });
    expect(codeOf(() => service.installSkill("whale-fleet-ops"))).toBe("preset/exists");
    expect(codeOf(() => service.uninstallSkill("whale-fleet-ops"))).toBe("preset/foreign");
    expect(readFileSync(join(skills, "whale-fleet-ops", "notes.txt"), "utf8")).toBe("keep");
  });
});

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof PresetError ? error.code : (error as { code?: string }).code;
  }
}
