import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dirname, "..");
const checks = [];

function check(id, ok, message) {
  checks.push({ id, ok, message });
}

const packagePath = resolve(root, "packages/plugin/package.json");
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const compatibility = JSON.parse(
  readFileSync(resolve(root, "packages/plugin/compatibility.json"), "utf8"),
);
check("package", pkg.name === "dsh-fusion", "package name is dsh-fusion");
check("bundle", pkg.dsh?.bundle?.patch === "./cordis.patch.yml", "host bundle patch is declared");
check("client", pkg.dsh?.client?.platform === "web", "web client is declared");
check("patch", existsSync(resolve(root, "packages/plugin/cordis.patch.yml")), "bundle patch file exists");
check("client-build", existsSync(resolve(root, "packages/client/dist/index.html")), "client build exists");
check(
  "compatibility",
  pkg.engines?.dsh === compatibility.installRange
    && pkg.dsh?.compatibility?.dsh === compatibility.installRange,
  "package and compatibility manifests declare the same DSH install range",
);
check("client-dependencies", JSON.stringify(pkg.dsh?.client?.inject) === JSON.stringify([
  "@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-api-session-controller",
]), "client package dependencies provide slots and sessions");
for (const [name, entry] of Object.entries(pkg.exports)) {
  for (const file of typeof entry === "string" ? [entry] : Object.values(entry)) {
    check(`export:${name}:${file}`, existsSync(resolve(root, "packages/plugin", file)), `declared export ${file} exists`);
  }
}

try {
  // The bundle build emits ESM to dist/index.js and removes the old CJS
  // artifact on purpose, so the self-check has to load the ESM bundle.
  const host = await import(pathToFileURL(resolve(root, "packages/plugin/dist/index.js")).href);
  check("host-apply", typeof host.apply === "function", "host plugin exports apply(ctx)");
  check("host-inject", Array.isArray(host.inject), "host plugin exports inject declarations");
  const hostSource = readFileSync(resolve(root, "packages/plugin/dist/index.js"), "utf8");
  check("host-self-contained", !hostSource.includes("from \"@dsh-fusion/") && !hostSource.includes("from '@dsh-fusion/"), "host bundle has no workspace package imports");
} catch (error) {
  check("host-load", false, error instanceof Error ? error.message : String(error));
}

try {
  const clientSource = readFileSync(resolve(root, "packages/plugin/dist/client.js"), "utf8");
  // The bundle may emit a style-injection preamble before the loader call,
  // so assert the loader call is present rather than that it comes first.
  check("client-format", clientSource.includes("window.__ModuleLoader__.load"), "client bundle uses DSH ModuleLoader");
  check("client-id", /id\s*:\s*["']dsh-fusion["']/.test(clientSource), "client bundle id is dsh-fusion");
  check("client-slots", clientSource.includes("slots"), "client bundle registers DSH slots");
  check("client-lazy", /\b\w+\.async\(["']\.\/client\.workspace\.js["']\)/.test(clientSource), "launcher requests the native workspace chunk");
  check("client-light", !/xterm|fusion-topbar|\/plugins\/dsh-fusion\/state/.test(clientSource), "launcher does not contain workspace code, styles or xterm");
  const workspaceSource = readFileSync(resolve(root, "packages/plugin/dist/client.workspace.js"), "utf8");
  let registration;
  runInNewContext(workspaceSource, { window: { __ModuleLoader__: { load: (value) => { registration = value; } } } });
  check("workspace-native", registration?.id === "dsh-fusion" && registration?.chunk === "client.workspace.js" && typeof registration?.factory === "function", "workspace registers a package-local native chunk");
  check("workspace-styles", workspaceSource.includes(".fusion-topbar") && !workspaceSource.includes("__DSH_FUSION_WORKSPACE_CSS__"), "workspace owns its collected styles");
  check("workspace-self-contained", !/\bimport\s*\(|(?<![.\w])\w+\(["']\.\//.test(workspaceSource), "workspace has no unresolved ESM or relative shared chunks");
  const runtimeFiles = readdirSync(resolve(root, "packages/plugin/dist")).filter((name) => /\.(?:js|cjs|css|map)$/.test(name)).sort();
  check("clean-runtime-files", JSON.stringify(runtimeFiles) === JSON.stringify(["client.js", "client.terminal.js", "client.workspace.js", "index.js", "standalone.js"]), "runtime output is exactly the launcher, workspace, terminal, host and standalone entries");
  const terminalSource = readFileSync(resolve(root, "packages/plugin/dist/client.terminal.js"), "utf8");
  let terminal;
  runInNewContext(terminalSource, { window: { __ModuleLoader__: { load: (value) => { terminal = value; } } } });
  check("terminal-native", terminal?.id === "dsh-fusion" && terminal?.chunk === "client.terminal.js", "terminal registers a separate native capability chunk");
  check("terminal-lazy", /\b\w+\.async\(["']\.\/client\.terminal\.js["']\)/.test(workspaceSource), "workspace loads xterm through native arrival only when needed");
} catch (error) {
  check("client-load", false, error instanceof Error ? error.message : String(error));
}

const ok = checks.every((entry) => entry.ok);
console.log(JSON.stringify({ ok, checks }, null, 2));
if (!ok) process.exitCode = 1;
