import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { closePublicTypes } from "./public-types.mjs";
import { writeThirdPartyNotices } from "./third-party-notices.mjs";

const require = createRequire(import.meta.url);
const packageRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const output = resolve(packageRoot, "dist");
const unavailableNative = resolve(packageRoot, "src/optional-native-unavailable.ts");
// Never follow a junction/symlink to another workspace when cleaning output.
if (dirname(output) !== packageRoot || (existsSync(output) && realpathSync(output) !== output)) {
  throw new Error(`DSH_FUSION_UNSAFE_BUILD_OUTPUT:${output}`);
}
rmSync(output, { recursive: true, force: true });

function run(script, extra = [], env = process.env) {
  const result = spawnSync(process.execPath, [script, ...extra], { cwd: packageRoot, stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`DSH_FUSION_BUILD_FAILED:${result.status}`);
}

run(require.resolve("typescript/bin/tsc"), ["-p", "tsconfig.build.json"]);
console.log(`Closed public types over ${closePublicTypes(packageRoot)} workspace declaration files.`);
const hostBuild = await build({
  absWorkingDir: packageRoot, entryPoints: ["src/index.ts"], outfile: "dist/index.js",
  bundle: true, platform: "node", format: "esm", metafile: true,
  external: ["fastify"],
  alias: {
    "cpu-features": unavailableNative,
    "bufferutil": unavailableNative,
    "utf-8-validate": unavailableNative,
  },
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(process.cwd() + '/dsh-fusion.cjs');" },
});
const standaloneBuild = await build({
  absWorkingDir: packageRoot, entryPoints: ["src/standalone.ts"], outfile: "dist/standalone.js",
  bundle: true, platform: "node", format: "esm", metafile: true,
  external: ["fastify"],
  alias: {
    "cpu-features": unavailableNative,
    "bufferutil": unavailableNative,
    "utf-8-validate": unavailableNative,
  },
});
const vite = resolve(dirname(require.resolve("vite/package.json")), "bin/vite.js");
const noticeInputs = mkdtempSync(resolve(tmpdir(), "dsh-fusion-notice-inputs-"));
try {
  for (const entry of ["launcher", "workspace", "terminal", "habitat", "native-ocean", "ocean-scene"]) {
    run(vite, ["build"], {
      ...process.env, DSH_FUSION_CLIENT_ENTRY: entry, DSH_FUSION_NOTICE_INPUTS: noticeInputs,
    });
  }
  const manifests = ["launcher", "workspace", "terminal", "habitat", "native-ocean", "ocean-scene"].map((entry) =>
    JSON.parse(readFileSync(resolve(noticeInputs, entry + ".json"), "utf8")));
  const notices = await writeThirdPartyNotices({
    metafiles: [hostBuild.metafile, standaloneBuild.metafile], manifests,
    workingDirectory: packageRoot, outfile: resolve(output, "THIRD_PARTY_NOTICES.txt"),
  });
  console.log(`Third-party notices: ${notices.packages} packages, ${notices.bytes} bytes.`);
} finally {
  rmSync(noticeInputs, { recursive: true, force: true });
}

copyFileSync(resolve(packageRoot,"../client/src/features/whale/ambient/assets/LICENSE.txt"),resolve(output,"WHALE_ASSET_LICENSE.txt"));
