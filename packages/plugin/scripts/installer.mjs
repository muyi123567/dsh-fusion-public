import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  assertDshHostInstallable,
  evaluateDshHostCompatibility,
  assertSupportedNode,
  loadReleaseContract,
  readJson,
  sha256,
} from "./release-contract.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "cordis.patch.yml",
  "compatibility.json",
];
const INSTALLED_REQUIRED_FILES = [
  "dist/index.js",
  "dist/client.js",
  "cordis.patch.yml",
  "compatibility.json",
  "release.json",
];

function usage() {
  return [
    "Usage: dsh-fusion-setup [options]",
    "",
    "Install and verify Fusion's supported companion bundle in a DSH profile.",
    "",
    "Options:",
    "  --dsh-home <path>    DSH home (default: DSH_HOME or ~/.dsh)",
    "  --profile <name>     DSH profile (default: web)",
    "  --dsh-bin <path>     DSH executable (default: DSH_BIN or dsh)",
    "  --fusion-tgz <path>  Install this Fusion tarball before companions",
    "  --without-companions Do not install Room, AgentTeams, or AgentBus",
    "  --without-room       Do not install the bundled Room package",
    "  --force-companions   Replace different installed companion versions",
    "  --force-room         Replace a different installed Room version",
    "  --dry-run            Validate and print the plan without writing",
    "  --verify             Verify the current profile without installing",
    "  --help               Show this help",
  ].join("\n");
}

function parseArgs(args) {
  const options = {
    dshHome: process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"),
    profile: "web",
    dshBin: process.env.DSH_BIN?.trim() || "dsh",
    fusionTgz: undefined,
    withCompanions: true,
    withoutRoom: false,
    forceCompanions: false,
    forceRoom: false,
    dryRun: false,
    verify: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help") {
      options.help = true;
      continue;
    }
    if (key === "--without-companions") {
      options.withCompanions = false;
      continue;
    }
    if (key === "--without-room") {
      options.withoutRoom = true;
      continue;
    }
    if (key === "--force-companions") {
      options.forceCompanions = true;
      continue;
    }
    if (key === "--force-room") {
      options.forceRoom = true;
      continue;
    }
    if (key === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (key === "--verify") {
      options.verify = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${key}`);
    index += 1;
    if (key === "--dsh-home") options.dshHome = resolve(value);
    else if (key === "--profile") options.profile = value.trim();
    else if (key === "--dsh-bin") options.dshBin = value.trim();
    else if (key === "--fusion-tgz") options.fusionTgz = resolve(value);
    else throw new Error(`Unknown option: ${key}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(options.profile)
    || options.profile === "node_modules"
    || options.profile === "desktop") {
    throw new Error("--profile must be a single safe DSH profile name");
  }
  if (options.dshBin === "") throw new Error("--dsh-bin must not be empty");
  return options;
}

function runDsh(options, args, label) {
  const windows = process.platform === "win32";
  let executable = options.dshBin;
  let commandArgs = args;
  if (windows) {
    const explicitCmd = /\.(?:cmd|bat)$/iu.test(options.dshBin);
    const located = !/[\\/]/u.test(options.dshBin)
      ? spawnSync("where.exe", [options.dshBin], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        })
      : undefined;
    const cmdFile = explicitCmd
      ? options.dshBin
      : located?.status === 0
        ? located.stdout.split(/\r?\n/u).find((line) => /\.(?:cmd|bat)$/iu.test(line))
        : undefined;
    if (cmdFile !== undefined) {
      executable = process.env.ComSpec || "cmd.exe";
      commandArgs = ["/d", "/s", "/c", cmdFile, ...args];
    }
  }
  const result = spawnSync(executable, commandArgs, {
    env: { ...process.env, DSH_HOME: options.dshHome },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${label} failed with exit ${result.status}${detail === "" ? "" : `\n${detail}`}`);
  }
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function assertPathWithin(parent, target) {
  const rel = relative(resolve(parent), resolve(target));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`DSH_FUSION_UNSAFE_PROFILE_PATH:${target}`);
  }
}

function resolveProfile(options) {
  const profilesRoot = resolve(options.dshHome, "profiles");
  const profileDir = resolve(profilesRoot, options.profile);
  assertPathWithin(profilesRoot, profileDir);
  return {
    profilesRoot,
    profileDir,
    existed: existsSync(join(profileDir, "package.json")),
  };
}

function snapshotProfile(profileDir) {
  const backupDir = join(
    profileDir,
    ".dsh-fusion-backups",
    new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"),
  );
  assertPathWithin(profileDir, backupDir);
  mkdirSync(backupDir, { recursive: true });
  const entries = [];
  for (const file of PROFILE_FILES) {
    const source = join(profileDir, file);
    const existed = existsSync(source);
    if (existed) copyFileSync(source, join(backupDir, file));
    entries.push({ path: file, kind: "file", existed });
  }
  const patches = join(profileDir, "patches");
  const patchesExisted = existsSync(patches);
  if (patchesExisted) cpSync(patches, join(backupDir, "patches"), { recursive: true });
  entries.push({ path: "patches", kind: "directory", existed: patchesExisted });
  const snapshot = { backupDir, entries };
  writeFileSync(join(backupDir, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshot;
}

function restoreProfile(profileDir, snapshot) {
  assertPathWithin(profileDir, snapshot.backupDir);
  for (const entry of snapshot.entries) {
    const target = resolve(profileDir, entry.path);
    assertPathWithin(profileDir, target);
    if (entry.kind === "directory") {
      rmSync(target, { recursive: true, force: true });
      if (entry.existed) cpSync(join(snapshot.backupDir, entry.path), target, { recursive: true });
      continue;
    }
    if (entry.existed) {
      copyFileSync(join(snapshot.backupDir, entry.path), target);
    } else {
      rmSync(target, { force: true });
    }
  }
}

function rollbackNodeModules(options) {
  runDsh(
    options,
    [
      "plugin",
      "--profile",
      options.profile,
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
    "restore profile dependencies",
  );
}

function selectedCompanions(contract, options) {
  if (!options.withCompanions) return [];
  return contract.companions.filter(
    (companion) => !(options.withoutRoom && companion.id === "room"),
  );
}

function verifyInstall(contract, options, profileDir) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });
  const manifestPath = join(profileDir, "package.json");
  add("profile-manifest", existsSync(manifestPath), manifestPath);
  if (!existsSync(manifestPath)) return { ok: false, checks };
  const manifest = readJson(manifestPath);
  const dependency = manifest.dependencies?.[contract.packageJson.name];
  add("profile-dependency", typeof dependency === "string", String(dependency ?? ""));
  const installedRoot = join(profileDir, "node_modules", contract.packageJson.name);
  add("installed-package", existsSync(installedRoot), installedRoot);
  if (existsSync(installedRoot)) {
    const installedManifestPath = join(installedRoot, "package.json");
    add("installed-manifest", existsSync(installedManifestPath), installedManifestPath);
    if (existsSync(installedManifestPath)) {
      const installedManifest = readJson(installedManifestPath);
      add(
        "installed-version",
        installedManifest.version === contract.packageJson.version,
        `${String(installedManifest.version)}:${contract.packageJson.version}`,
      );
    }
    for (const file of INSTALLED_REQUIRED_FILES) {
      add(`installed-file:${file}`, existsSync(join(installedRoot, file)), file);
    }
    try {
      const installedContract = loadReleaseContract(installedRoot);
      add(
        "installed-release-contract",
        installedContract.packageJson.version === contract.packageJson.version,
        installedContract.packageJson.version,
      );
    } catch (error) {
      add(
        "installed-release-contract",
        false,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const companions = selectedCompanions(contract, options);
  for (const companion of companions) {
    const manifestPath = join(profileDir, "node_modules", companion.name, "package.json");
    add(`${companion.id}-installed`, existsSync(manifestPath), manifestPath);
    if (existsSync(manifestPath)) {
      const manifest = readJson(manifestPath);
      add(
        `${companion.id}-version`,
        manifest.version === companion.version,
        `${String(manifest.version)}:${companion.version}`,
      );
    }
  }
  try {
    const composed = runDsh(
      options,
      ["--profile", options.profile, "--dump-config"],
      "validate composed profile",
    );
    add(
      "composed-fusion",
      composed.stdout.includes(contract.packageJson.name),
      composed.stdout.length.toString(),
    );
    for (const companion of companions) {
      add(
        `composed-${companion.id}`,
        composed.stdout.includes(companion.name),
        companion.name,
      );
    }
  } catch (error) {
    add("composed-config", false, error instanceof Error ? error.message : String(error));
  }
  return { ok: checks.every((entry) => entry.ok), checks };
}

function installedPackageVersion(profileDir, name) {
  const manifest = join(profileDir, "node_modules", name, "package.json");
  if (!existsSync(manifest)) return undefined;
  const version = readJson(manifest).version;
  return typeof version === "string" ? version : undefined;
}

function bundlePlan(contract, options) {
  const bundles = [];
  if (options.fusionTgz !== undefined) {
    if (!existsSync(options.fusionTgz)) throw new Error(`bundle not found: ${options.fusionTgz}`);
    bundles.push({
      id: "fusion",
      path: options.fusionTgz,
      sha256: sha256(options.fusionTgz),
    });
  }
  for (const companion of selectedCompanions(contract, options)) {
    bundles.push({
      id: companion.id,
      path: companion.file,
      sha256: companion.sha256,
      name: companion.name,
      version: companion.version,
    });
  }
  return bundles;
}

export async function runSetup(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help === true) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const contract = loadReleaseContract(packageRoot);
  assertSupportedNode(contract.release.runtime.node);
  const hostCompatibility = evaluateDshHostCompatibility(
    contract,
    runDsh(options, ["--version"], "read DSH version").stdout,
  );
  const dshVersion = assertDshHostInstallable(hostCompatibility) ?? "unknown";
  if (hostCompatibility.state === "untested") {
    process.stderr.write(
      `DSH_FUSION_DSH_HOST_UNTESTED:${dshVersion}; `
      + `recommended ${contract.hostCompatibility.recommended}\n`,
    );
  } else if (hostCompatibility.state === "unknown") {
    process.stderr.write(
      `DSH_FUSION_DSH_HOST_UNKNOWN:${hostCompatibility.reasonCode}\n`,
    );
  }
  const {
    profilesRoot,
    profileDir,
    existed: profileExisted,
  } = resolveProfile(options);
  if (options.verify) {
    const verification = verifyInstall(contract, options, profileDir);
    process.stdout.write(`${JSON.stringify({
      status: verification.ok ? "ok" : "failed",
      package: contract.packageJson.name,
      packageVersion: contract.packageJson.version,
      dshVersion,
      hostCompatibility,
      profileDir,
      ...verification,
    }, null, 2)}\n`);
    if (!verification.ok) throw new Error("DSH_FUSION_VERIFY_FAILED");
    return;
  }
  const allBundles = bundlePlan(contract, options);
  const receiptPath = join(profileDir, "dsh-fusion-setup.json");
  const existingReceipt = profileExisted && existsSync(receiptPath)
    ? readJson(receiptPath)
    : undefined;
  const receiptBundles = Array.isArray(existingReceipt?.bundles)
    ? existingReceipt.bundles
    : [];
  const companionActions = {};
  for (const companion of selectedCompanions(contract, options)) {
    const installedVersion = profileExisted
      ? installedPackageVersion(profileDir, companion.name)
      : undefined;
    const receiptBundle = receiptBundles.find(
      (bundle) => bundle.id === companion.id || bundle.name === companion.name,
    );
    const receiptMatches = receiptBundle?.sha256 === companion.sha256
      && receiptBundle?.version === companion.version;
    if (installedVersion === undefined) {
      companionActions[companion.id] = "install";
    } else if (installedVersion === companion.version && receiptMatches) {
      companionActions[companion.id] = "skip";
    } else if (installedVersion === companion.version) {
      companionActions[companion.id] = "install";
    } else if (
      options.forceCompanions
      || (companion.id === "room" && options.forceRoom)
    ) {
      companionActions[companion.id] = "replace";
    } else {
      throw new Error(
        `DSH_FUSION_COMPANION_VERSION_CONFLICT:${companion.id}:`
        + `${installedVersion}:${companion.version}; use --force-companions to replace it`,
      );
    }
  }
  const roomAction = companionActions.room ?? "disabled";
  const installBundles = allBundles.filter(
    (bundle) => bundle.id === "fusion"
      || !["skip", "disabled"].includes(companionActions[bundle.id]),
  );
  if (!profileExisted && options.fusionTgz === undefined) {
    throw new Error("DSH_FUSION_FRESH_PROFILE_REQUIRES_FUSION_TARBALL");
  }
  const plan = {
    package: contract.packageJson.name,
    packageVersion: contract.packageJson.version,
    dshVersion,
    hostCompatibility,
    nodeVersion: process.versions.node,
    dshHome: options.dshHome,
    profile: options.profile,
    profileExisted,
    roomAction,
    companionActions,
    profileDir,
    bundles: allBundles.map(({ id, path, sha256: hash, name, version }) => ({
      id,
      path,
      sha256: hash,
      ...(name === undefined ? {} : { name }),
      ...(version === undefined ? {} : { version }),
    })),
    dryRun: options.dryRun,
  };
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  const snapshot = profileExisted ? snapshotProfile(profileDir) : undefined;
  const warnings = [];
  try {
    for (const bundle of installBundles) {
      const result = runDsh(
        options,
        ["plugin", "--profile", options.profile, "add", bundle.path],
        `install ${bundle.path}`,
      );
      if (result.stderr !== "") warnings.push(result.stderr);
    }
    const verification = verifyInstall(contract, options, profileDir);
    if (!verification.ok) {
      const failed = verification.checks.filter((entry) => !entry.ok);
      throw new Error(`DSH_FUSION_INSTALL_VERIFY_FAILED:${JSON.stringify(failed)}`);
    }
    const receipt = {
      status: "ok",
      completedAt: new Date().toISOString(),
      ...(snapshot === undefined ? {} : { backupDir: snapshot.backupDir }),
      ...(warnings.length === 0 ? {} : { warnings }),
      ...plan,
      verification,
    };
    writeFileSync(
      join(profileDir, "dsh-fusion-setup.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    const original = error instanceof Error ? error.message : String(error);
    if (snapshot === undefined) {
      assertPathWithin(profilesRoot, profileDir);
      rmSync(profileDir, { recursive: true, force: true });
    } else {
      restoreProfile(profileDir, snapshot);
      try {
        rollbackNodeModules(options);
      } catch (rollbackError) {
        const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(
          `${original}\nDSH_FUSION_ROLLBACK_METADATA_OK:${snapshot.backupDir}\n`
          + `DSH_FUSION_ROLLBACK_DEPENDENCIES_FAILED:${detail}`,
        );
      }
    }
    throw new Error(
      `${original}\nDSH_FUSION_ROLLBACK_OK:${snapshot?.backupDir ?? "fresh-profile-removed"}`,
    );
  }
}
