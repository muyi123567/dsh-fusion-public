import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const LEGAL_FILE = /^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/iu;
const LEGAL_DIRECTORY = /^(?:licen[cs]es?|notices?|legal)$/iu;
const RUNTIME_FALLBACK = new Set(["react", "react-dom"]);

function packageName(specifier) {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

function sourceOf(manifest) {
  const repository = typeof manifest.repository === "string"
    ? manifest.repository : manifest.repository?.url;
  return repository ?? manifest.homepage ?? ("https://www.npmjs.com/package/" + manifest.name);
}

function inputFile(input, workingDirectory) {
  if (input.startsWith("\0") || input.startsWith("<")) return undefined;
  const plain = input.replace(/[?#].*$/u, "");
  if (plain.startsWith("file:")) return fileURLToPath(plain);
  return isAbsolute(plain) ? plain : resolve(workingDirectory, plain);
}

async function ownerOf(input, workingDirectory) {
  const file = inputFile(input, workingDirectory);
  if (file === undefined) return undefined;
  let canonical;
  try { canonical = await realpath(file); } catch (error) {
    if (error.code === "ENOENT") throw new Error("THIRD_PARTY_INPUT_MISSING:" + input);
    throw error;
  }
  // Real workspace symlinks are first-party, even when reached via node_modules.
  if (!canonical.split(sep).includes("node_modules")) return undefined;
  let root = dirname(canonical);
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      if (typeof manifest.name === "string" && typeof manifest.version === "string") {
        return { root, manifest };
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(root);
    if (parent === root) throw new Error("THIRD_PARTY_PACKAGE_NOT_FOUND:" + input);
    root = parent;
  }
}

async function legalTexts(root) {
  const files = [];
  async function visit(directory, depth) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isFile() && (LEGAL_FILE.test(entry.name) || depth > 0)) {
        const text = await readFile(path, "utf8");
        if (text.trim() !== "") files.push({ path: relative(root, path).split(sep).join("/"), text });
      } else if (entry.isDirectory() && depth < 3 && (depth > 0 || LEGAL_DIRECTORY.test(entry.name))) {
        await visit(path, depth + 1);
      }
    }
  }
  await visit(root, 0);
  return files;
}

/** Collect only actual esbuild/Vite inputs, plus observed React runtime externals. */
export async function writeThirdPartyNotices({
  metafiles = [], manifests = [], workingDirectory, outfile,
}) {
  const cwd = resolve(workingDirectory);
  const packages = new Map();
  const inputs = new Set();
  const externals = new Set();
  for (const metafile of metafiles) {
    // Ignore loaded-but-tree-shaken modules when the output contribution map exists.
    for (const output of Object.values(metafile.outputs ?? {})) {
      for (const [input, contribution] of Object.entries(output.inputs ?? {})) {
        if (contribution.bytesInOutput > 0) inputs.add(input);
      }
    }
    if (metafile.outputs === undefined) {
      for (const input of Object.keys(metafile.inputs ?? {})) inputs.add(input);
    }
  }
  for (const manifest of manifests) {
    for (const input of manifest.inputs) inputs.add(input);
    for (const specifier of manifest.externals ?? []) externals.add(specifier);
  }
  async function add(input, usage) {
    const owner = await ownerOf(input, cwd);
    if (owner === undefined) return;
    const { root, manifest } = owner;
    let entry = packages.get(root);
    if (entry === undefined) {
      entry = { root, manifest, usages: new Set() };
      packages.set(root, entry);
    }
    entry.usages.add(usage);
  }
  for (const input of [...inputs].sort()) await add(input, "bundled");
  const require = createRequire(join(cwd, "package.json"));
  for (const specifier of [...externals].sort()) {
    if (RUNTIME_FALLBACK.has(packageName(specifier))) {
      await add(require.resolve(specifier), "referenced external runtime (not bundled)");
    }
  }
  if (packages.size === 0) throw new Error("THIRD_PARTY_NOTICES_EMPTY");
  const records = [];
  for (const entry of packages.values()) {
    const texts = await legalTexts(entry.root);
    if (texts.length === 0) throw new Error("THIRD_PARTY_LICENSE_MISSING:" + entry.manifest.name + "@" + entry.manifest.version);
    records.push({ ...entry, texts });
  }
  records.sort((a, b) => (a.manifest.name + "@" + a.manifest.version)
    .localeCompare(b.manifest.name + "@" + b.manifest.version, "en"));
  // Merge identical physical installs without dropping differing legal texts.
  const unique = new Map();
  for (const entry of records) {
    const key = JSON.stringify([entry.manifest.name, entry.manifest.version, sourceOf(entry.manifest), entry.texts]);
    const prior = unique.get(key);
    if (prior === undefined) unique.set(key, entry);
    else for (const usage of entry.usages) prior.usages.add(usage);
  }
  let notice = "DSH Fusion - Third-party notices\n"
    + "Generated from emitted esbuild outputs and all three Vite entry chunks.\n"
    + "Legal texts below are copied verbatim from the installed dependency packages.\n"
    + "Referenced React runtime externals are identified separately.\n";
  for (const { manifest, usages, texts } of unique.values()) {
    notice += "\n" + "=".repeat(78) + "\n"
      + "Package: " + manifest.name + "\nVersion: " + manifest.version
      + "\nSource: " + sourceOf(manifest)
      + "\nDeclared license: " + (typeof manifest.license === "string" ? manifest.license : JSON.stringify(manifest.license ?? manifest.licenses ?? "See legal texts below"))
      + "\nUsage: " + [...usages].sort().join("; ") + "\n";
    for (const { path, text } of texts) {
      notice += "\n--- " + path + " ---\n" + text + (text.endsWith("\n") ? "" : "\n");
    }
  }
  await writeFile(outfile, notice, "utf8");
  const bytes = (await stat(outfile)).size;
  if (bytes === 0) throw new Error("THIRD_PARTY_NOTICES_EMPTY");
  return { packages: unique.size, bytes, names: [...new Set(records.map((entry) => entry.manifest.name))].sort() };
}
