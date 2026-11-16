import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const setupScript = join(pluginRoot, "scripts", "setup.mjs");

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copyInstalledPackage(target) {
  mkdirSync(target, { recursive: true });
  for (const name of ["package.json", "release.json", "compatibility.json", "cordis.patch.yml"]) {
    cpSync(join(pluginRoot, name), join(target, name));
  }
  for (const name of ["dist", "vendor", "scripts"]) {
    cpSync(join(pluginRoot, name), join(target, name), { recursive: true });
  }
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "dsh-fusion-setup-"));
  const dshHome = join(root, "dsh-home");
  const profileDir = join(dshHome, "profiles", "web");
  const nodeModules = join(profileDir, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  writeJson(join(profileDir, "package.json"), {
    name: "dsh-profile-web",
    private: true,
    dependencies: {
      "dsh-fusion": "file:fixture.tgz",
    },
    dsh: {
      profile: {
        bundles: ["dsh-fusion"],
      },
    },
  });
  writeFileSync(join(profileDir, "cordis.patch.yml"), "existing-cordis\n", "utf8");
  writeFileSync(join(profileDir, "pnpm-lock.yaml"), "lockfileVersion: fixture\n", "utf8");
  copyInstalledPackage(join(nodeModules, "dsh-fusion"));

  const fakeScript = join(root, "fake-dsh.mjs");
  writeFileSync(fakeScript, `
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const args = process.argv.slice(2);
const dshHome = process.env.DSH_HOME;
const log = process.env.FAKE_DSH_LOG;
if (log) appendFileSync(log, JSON.stringify(args) + "\\n");
if (args[0] === "--version") {
  process.stdout.write((process.env.FAKE_DSH_VERSION ?? "0.2.0-rc.2") + "\\n");
  process.exit(0);
}
const profileIndex = args.indexOf("--profile");
const profile = profileIndex >= 0 ? args[profileIndex + 1] : args[0];
const profileDir = join(dshHome, "profiles", profile);
const profileManifest = join(profileDir, "package.json");
if (args.includes("--from-default-profile")) {
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(profileManifest, JSON.stringify({ name: "created", dependencies: {} }) + "\\n");
  process.exit(0);
}
if (args.includes("--dump-config")) {
  const manifest = JSON.parse(readFileSync(profileManifest, "utf8"));
  for (const name of Object.keys(manifest.dependencies ?? {})) process.stdout.write(name + "\\n");
  for (const name of ["dsh-fusion", "dsh-agent-team-room", "@nanmicoder/dsh-agent-teams", "dsh-agent-bus"]) {
    if (existsSync(join(profileDir, "node_modules", name, "package.json"))) {
      process.stdout.write(name + "\\n");
    }
  }
  process.exit(0);
}
const actionIndex = args.findIndex((value) => value === "add" || value === "install");
const action = actionIndex >= 0 ? args[actionIndex] : undefined;
if (action === "install") process.exit(0);
if (action !== "add") process.exit(2);
const bundle = args[actionIndex + 1];
const bundleName = basename(bundle);
const packageName = bundleName.startsWith("dsh-agent-team-room")
  ? "dsh-agent-team-room"
  : bundleName.startsWith("dsh-agent-bus")
    ? "dsh-agent-bus"
    : bundleName.includes("dsh-agent-teams")
      ? "@nanmicoder/dsh-agent-teams"
      : "dsh-fusion";
if (!existsSync(profileManifest)) {
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(profileManifest, JSON.stringify({ name: "created", dependencies: {} }) + "\\n");
}
const packageDir = join(profileDir, "node_modules", packageName);
if (process.env.FAKE_DSH_FAIL === "1") {
  const manifestPath = join(profileDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies = { ...manifest.dependencies, "dsh-fusion": "corrupt" };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\\n");
  writeFileSync(join(profileDir, "compatibility.json"), "{}\\n");
  writeFileSync(join(profileDir, "cordis.patch.yml"), "corrupt-cordis\\n");
  process.stderr.write("simulated install failure\\n");
  process.exit(42);
}
mkdirSync(packageDir, { recursive: true });
if (packageName !== "dsh-fusion") {
  const version = packageName === "dsh-agent-team-room"
    ? "0.7.0"
    : packageName === "dsh-agent-bus"
      ? "0.1.1"
      : "0.1.30";
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: packageName, version }) + "\\n");
} else {
  const source = process.env.FAKE_DSH_PACKAGE_ROOT;
  for (const name of ["package.json", "release.json", "compatibility.json", "cordis.patch.yml"]) {
    writeFileSync(join(packageDir, name), readFileSync(join(source, name)));
  }
  for (const name of ["dist", "vendor", "scripts"]) {
    cpSync(join(source, name), join(packageDir, name), { recursive: true });
  }
}
const manifest = JSON.parse(readFileSync(profileManifest, "utf8"));
manifest.dependencies = {
  ...(manifest.dependencies ?? {}),
  [packageName]: packageName === "dsh-fusion" ? "file:fusion.tgz" : \`file:\${bundleName}\`,
};
writeFileSync(profileManifest, JSON.stringify(manifest, null, 2) + "\\n");
process.exit(0);
`, "utf8");
  const fakeDsh = join(root, process.platform === "win32" ? "fake-dsh.cmd" : "fake-dsh");
  if (process.platform === "win32") {
    writeFileSync(
      fakeDsh,
      `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`,
      "utf8",
    );
  } else {
    writeFileSync(fakeDsh, `#!${process.execPath}\n`, "utf8");
    writeFileSync(fakeDsh, `${readFileSync(fakeDsh, "utf8")}${readFileSync(fakeScript, "utf8")}`, "utf8");
    chmodSync(fakeDsh, 0o755);
  }
  const logPath = join(root, "dsh-calls.jsonl");
  return { root, dshHome, profileDir, fakeDsh, logPath };
}

function runSetup(fixture, args, extraEnv = {}) {
  return spawnSync(process.execPath, [setupScript, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      DSH_HOME: fixture.dshHome,
      FAKE_DSH_LOG: fixture.logPath,
      FAKE_DSH_PACKAGE_ROOT: pluginRoot,
      ...extraEnv,
    },
    timeout: 30_000,
  });
}

function calls(fixture) {
  if (!existsSync(fixture.logPath)) return [];
  return readFileSync(fixture.logPath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("dry-run validates release, DSH version and bundle plan without writes", () => {
  const fixture = createFixture();
  try {
    const result = runSetup(fixture, [
      "--dsh-bin", fixture.fakeDsh,
      "--profile", "web",
      "--without-companions",
      "--dry-run",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.dshVersion, "0.2.0-rc.2");
    assert.equal(plan.hostCompatibility.state, "verified");
    assert.equal(plan.dryRun, true);
    assert.equal(plan.bundles.length, 0);
    assert.equal(calls(fixture).some((args) => args.includes("add")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("default dry-run plans the complete companion bundle", () => {
  const fixture = createFixture();
  try {
    const result = runSetup(fixture, [
      "--dsh-bin", fixture.fakeDsh,
      "--profile", "web",
      "--dry-run",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.deepEqual(
      plan.bundles.map((bundle) => bundle.name),
      ["dsh-agent-team-room", "@nanmicoder/dsh-agent-teams", "dsh-agent-bus"],
    );
    assert.deepEqual(plan.companionActions, {
      room: "install",
      "agent-teams": "install",
      "agent-bus": "install",
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("out-of-range DSH version fails before any profile mutation", () => {
  const fixture = createFixture();
  try {
    const before = readFileSync(join(fixture.profileDir, "package.json"), "utf8");
    const result = runSetup(
      fixture,
      ["--dsh-bin", fixture.fakeDsh, "--profile", "web", "--without-companions"],
      { FAKE_DSH_VERSION: "0.2.0-rc.1" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DSH_FUSION_DSH_VERSION_UNSUPPORTED/u);
    assert.equal(readFileSync(join(fixture.profileDir, "package.json"), "utf8"), before);
    assert.equal(calls(fixture).some((args) => args.includes("add")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("older in-range DSH version is installable with an explicit untested warning", () => {
  const fixture = createFixture();
  try {
    const result = runSetup(
      fixture,
      ["--dsh-bin", fixture.fakeDsh, "--profile", "web", "--without-companions", "--dry-run"],
      { FAKE_DSH_VERSION: "0.2.1-rc.5" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /DSH_FUSION_DSH_HOST_UNTESTED:0\.2\.1-rc\.5/u);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.dshVersion, "0.2.1-rc.5");
    assert.equal(plan.hostCompatibility.state, "untested");
    assert.equal(plan.hostCompatibility.reasonCode, "UNTESTED_HOST");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("verified latest DSH version installs without an untested warning", () => {
  const fixture = createFixture();
  try {
    const result = runSetup(
      fixture,
      ["--dsh-bin", fixture.fakeDsh, "--profile", "web", "--without-companions", "--dry-run"],
      { FAKE_DSH_VERSION: "0.2.2-rc.1" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /DSH_FUSION_DSH_HOST_UNTESTED/u);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.dshVersion, "0.2.2-rc.1");
    assert.equal(plan.hostCompatibility.state, "verified");
    assert.equal(plan.hostCompatibility.reasonCode, "TESTED_HOST");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("setup installs all companions, verifies the package contract and writes a receipt", () => {
  const fixture = createFixture();
  try {
    const result = runSetup(fixture, ["--dsh-bin", fixture.fakeDsh, "--profile", "web"]);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.status, "ok");
    assert.equal(receipt.hostCompatibility.state, "verified");
    assert.equal(receipt.hostCompatibility.version, "0.2.0-rc.2");
    assert.equal(receipt.verification.ok, true);
    assert.deepEqual(receipt.companionActions, {
      room: "install",
      "agent-teams": "install",
      "agent-bus": "install",
    });
    assert.ok(existsSync(join(fixture.profileDir, "node_modules", "dsh-agent-team-room", "package.json")));
    assert.ok(existsSync(join(fixture.profileDir, "node_modules", "@nanmicoder", "dsh-agent-teams", "package.json")));
    assert.ok(existsSync(join(fixture.profileDir, "node_modules", "dsh-agent-bus", "package.json")));
    assert.ok(existsSync(join(fixture.profileDir, "dsh-fusion-setup.json")));

    const verify = runSetup(fixture, [
      "--dsh-bin", fixture.fakeDsh,
      "--profile", "web",
      "--verify",
    ]);
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(JSON.parse(verify.stdout).status, "ok");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed setup restores exact profile metadata and reports dependency rollback", () => {
  const fixture = createFixture();
  try {
    const packageBefore = readFileSync(join(fixture.profileDir, "package.json"), "utf8");
    const cordisBefore = readFileSync(join(fixture.profileDir, "cordis.patch.yml"), "utf8");
    const result = runSetup(
      fixture,
      ["--dsh-bin", fixture.fakeDsh, "--profile", "web"],
      { FAKE_DSH_FAIL: "1" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /simulated install failure/u);
    assert.match(result.stderr, /DSH_FUSION_ROLLBACK_OK/u);
    assert.equal(readFileSync(join(fixture.profileDir, "package.json"), "utf8"), packageBefore);
    assert.equal(readFileSync(join(fixture.profileDir, "cordis.patch.yml"), "utf8"), cordisBefore);
    assert.equal(existsSync(join(fixture.profileDir, "compatibility.json")), false);
    assert.ok(calls(fixture).some((args) => args.includes("install") && args.includes("--frozen-lockfile")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fresh shipped web profile is initialized by the plugin command", () => {
  const fixture = createFixture();
  try {
    rmSync(fixture.profileDir, { recursive: true, force: true });
    const fusionTgz = join(fixture.root, "dsh-fusion-fixture.tgz");
    writeFileSync(fusionTgz, "fixture", "utf8");

    const result = runSetup(fixture, [
      "--dsh-bin", fixture.fakeDsh,
      "--profile", "web",
      "--fusion-tgz", fusionTgz,
      "--without-companions",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(fixture.profileDir, "package.json")));
    assert.ok(calls(fixture).some((args) => args.includes("add")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("profile path traversal is rejected before any profile access", () => {
  const fixture = createFixture();
  try {
    const result = runSetup(fixture, [
      "--dsh-bin", fixture.fakeDsh,
      "--profile", "..\\escaped-profile",
      "--without-companions",
      "--dry-run",
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /single safe DSH profile name/u);
    assert.equal(existsSync(join(fixture.dshHome, "escaped-profile")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("installing the same companion versions is an idempotent no-op", () => {
  const fixture = createFixture();
  try {
    const first = runSetup(fixture, ["--dsh-bin", fixture.fakeDsh, "--profile", "web"]);
    assert.equal(first.status, 0, first.stderr);
    rmSync(fixture.logPath, { force: true });

    const second = runSetup(fixture, ["--dsh-bin", fixture.fakeDsh, "--profile", "web"]);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout).companionActions, {
      room: "skip",
      "agent-teams": "skip",
      "agent-bus": "skip",
    });
    assert.equal(calls(fixture).some((args) => args.includes("add")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a different companion version fails closed unless replacement is explicit", () => {
  const fixture = createFixture();
  try {
    const first = runSetup(fixture, ["--dsh-bin", fixture.fakeDsh, "--profile", "web"]);
    assert.equal(first.status, 0, first.stderr);
    writeJson(join(fixture.profileDir, "node_modules", "@nanmicoder", "dsh-agent-teams", "package.json"), {
      name: "@nanmicoder/dsh-agent-teams",
      version: "0.1.25",
    });

    const conflict = runSetup(fixture, ["--dsh-bin", fixture.fakeDsh, "--profile", "web"]);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /DSH_FUSION_COMPANION_VERSION_CONFLICT:agent-teams/u);

    const replaced = runSetup(fixture, [
      "--dsh-bin", fixture.fakeDsh,
      "--profile", "web",
      "--force-companions",
    ]);
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.equal(JSON.parse(replaced.stdout).companionActions["agent-teams"], "replace");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a failed fresh-profile install removes only the incomplete profile", () => {
  const fixture = createFixture();
  try {
    rmSync(fixture.profileDir, { recursive: true, force: true });
    const fusionTgz = join(fixture.root, "dsh-fusion-fixture.tgz");
    writeFileSync(fusionTgz, "fixture", "utf8");

    const result = runSetup(
      fixture,
      [
        "--dsh-bin", fixture.fakeDsh,
        "--profile", "web",
        "--fusion-tgz", fusionTgz,
        "--without-companions",
      ],
      { FAKE_DSH_FAIL: "1" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /fresh-profile-removed/u);
    assert.equal(existsSync(fixture.profileDir), false);
    assert.ok(existsSync(fixture.root));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
