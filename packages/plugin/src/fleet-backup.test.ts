import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFleetBackupService } from "./fleet-backup.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "fusion-backup-"));
  roots.push(value);
  return value;
}

function setup() {
  const dir = root();
  const profile = join(dir, "profile");
  const fleet = join(dir, "fleet");
  mkdirSync(profile, { recursive: true });
  mkdirSync(fleet, { recursive: true });
  const config = join(profile, "cordis.patch.yml");
  const trust = join(fleet, "trusted-hosts.json");
  const key = join(fleet, "host-key.pem");
  writeFileSync(config, "- id: dsh-fusion\n", { mode: 0o644 });
  writeFileSync(trust, "{\"version\":1,\"hosts\":[]}\n", { mode: 0o600 });
  writeFileSync(key, "PRIVATE KEY", { mode: 0o600 });
  const service = createFleetBackupService({
    directory: join(dir, "backups"),
    sources: [
      { label: "profile", path: config },
      { label: "fleet", path: trust },
      { label: "fleet", path: key },
    ],
    now: () => Date.parse("2026-11-24T05:00:00Z"),
  });
  return { dir, config, trust, key, service, backupDir: join(dir, "backups") };
}

describe("fleet config backup", () => {
  it("snapshots allowlisted files, skips private keys, and verifies hashes", async () => {
    const { config, service } = setup();
    const manifest = await service.snapshot("test");
    expect(manifest.files.map(file => file.path)).toEqual(expect.arrayContaining([config]));
    expect(manifest.files).toHaveLength(2);
    expect(manifest.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "denied-name" })]));
    expect(service.list()).toEqual([expect.objectContaining({ id: manifest.id, files: 2 })]);
    expect(service.verify(manifest.id).ok).toBe(true);
  });

  it("detects changed sources and restores only with explicit approval", async () => {
    const { config, trust, service } = setup();
    const manifest = await service.snapshot("test");
    writeFileSync(config, "- id: changed\n");
    writeFileSync(trust, "{\"version\":1,\"hosts\":[1]}\n");
    expect(service.verify(manifest.id).ok).toBe(true);
    expect(service.restorePlan(manifest.id).files).toEqual([
      expect.objectContaining({ path: config, status: "changed" }),
      expect.objectContaining({ path: trust, status: "changed" }),
    ]);

    const dryRun = await service.restore(manifest.id);
    expect(dryRun).toMatchObject({ dryRun: true, approved: false });
    expect(readFileSync(config, "utf8")).toBe("- id: changed\n");
    await expect(service.restore(manifest.id, { dryRun: false })).rejects.toMatchObject({ code: "backup/approval-required" });

    const restored = await service.restore(manifest.id, { dryRun: false, approve: true });
    expect(restored.preRestoreId).toBeDefined();
    expect(readFileSync(config, "utf8")).toBe("- id: dsh-fusion\n");
    expect(readFileSync(trust, "utf8")).toContain("\"hosts\":[]");
    expect(statSync(config).mode & 0o777).toBe(0o644);
    expect(service.list().some(item => item.reason === `pre-restore:${manifest.id}`)).toBe(true);
  });

  it("refuses a corrupt snapshot and invalid ids", async () => {
    const { service } = setup();
    const manifest = await service.snapshot("test");
    await expect(service.restore("../etc/passwd")).rejects.toMatchObject({ code: "backup/id-invalid" });
    expect(() => service.verify("20261124T050000Z-deadbeef")).toThrow();
  });

  it("retains only the configured number of snapshots", async () => {
    const dir = root();
    const file = join(dir, "config.yml");
    writeFileSync(file, "v1");
    let tick = 0;
    const service = createFleetBackupService({
      directory: join(dir, "backups"),
      sources: [{ label: "config", path: file }],
      retention: 2,
      now: () => Date.parse("2026-11-24T05:00:00Z") + (tick += 1_000),
    });
    await service.snapshot("one");
    await service.snapshot("two");
    await service.snapshot("three");
    expect(service.list()).toHaveLength(2);
    expect(service.list().map(item => item.reason)).toEqual(["three", "two"]);
  });

  it("refuses to restore a manifest path outside the current allowlist", async () => {
    const { service, backupDir } = setup();
    const manifest = await service.snapshot("test");
    const path = join(backupDir, manifest.id, "manifest.json");
    const tampered = JSON.parse(readFileSync(path, "utf8"));
    tampered.files[0].path = "/tmp/fusion-evil";
    writeFileSync(path, JSON.stringify(tampered));
    await expect(service.restore(manifest.id, { dryRun: false, approve: true }))
      .rejects.toMatchObject({ code: "backup/path-not-allowed" });
  });
});
