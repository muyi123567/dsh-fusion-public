import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const pluginRoot = realpathSync(new URL("..", import.meta.url));

test("published public declarations typecheck in a consumer with no private workspace packages", () => {
  const consumer = mkdtempSync(join(tmpdir(), "dsh-fusion-type-consumer-"));
  try {
    const modules = join(consumer, "node_modules");
    const installed = join(modules, "dsh-fusion");
    mkdirSync(installed, { recursive: true });
    cpSync(join(pluginRoot, "dist"), join(installed, "dist"), { recursive: true });
    cpSync(join(pluginRoot, "package.json"), join(installed, "package.json"));
    cpSync(join(pluginRoot, "compatibility.json"), join(installed, "compatibility.json"));
    // Supply only the published Fastify runtime and host-shared React types.
    // ssh2/ws and their optional native accelerators are bundled or externalized.
    for (const id of ["fastify", "react", "@types/react", "@types/node"]) {
      const source = dirname(require.resolve(`${id}/package.json`));
      const target = join(modules, id);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target, "junction");
    }
    writeFileSync(join(consumer, "package.json"), '{"type":"module"}');
    const entry = join(consumer, "consumer.ts");
    writeFileSync(entry, `
import { apply, resolveRemoteConfig, type FusionHostConfig } from "dsh-fusion";
import {
  FusionLauncher,
  FusionOverlay,
  type FusionTaskViewDefinition,
  type FusionTaskViewProps,
  type FusionWorkspaceProps,
} from "dsh-fusion/client";
import { startStandalone, type StandaloneOptions } from "dsh-fusion/standalone";
const config: FusionHostConfig = { dshVersion: "0.2.0-rc.2" };
const props: FusionWorkspaceProps = { roomCommand: async (input: string) => { void input; } };
const standalone: StandaloneOptions = { port: 0 };
const view: FusionTaskViewDefinition = {
  id: "consumer-view",
  label: "Consumer view",
  actions: ["cancel"],
  Component: (_props: FusionTaskViewProps) => null,
};
// @ts-expect-error extension actions are a closed capability set
const invalidView: FusionTaskViewDefinition = { ...view, actions: ["remote-shell"] };
// @ts-expect-error the public config remains strongly typed after closure
const invalid: FusionHostConfig = { dshVersion: 123 };
void [apply, resolveRemoteConfig, FusionLauncher, FusionOverlay, startStandalone, config, props, standalone, view, invalidView, invalid];
`);
    const program = ts.createProgram([entry], {
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022, strict: true, noEmit: true, skipLibCheck: false,
      types: ["node"], typeRoots: [join(modules, "@types")],
    });
    const errors = ts.getPreEmitDiagnostics(program);
    const text = ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (file) => file, getCurrentDirectory: () => consumer, getNewLine: () => "\n",
    });
    assert.equal(errors.length, 0, text);
    const workspaceReads = program.getSourceFiles().filter((file) => /packages[\\/](host|core|config)[\\/]dist/.test(file.fileName));
    assert.equal(workspaceReads.length, 0, "consumer must resolve entirely from installed package declarations");
  } finally {
    // Remove only the exact directory created by mkdtemp, with links left intact.
    assert.equal(dirname(consumer), resolve(tmpdir()));
    rmSync(consumer, { recursive: true, force: true });
  }
});
