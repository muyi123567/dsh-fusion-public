import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const dist = new URL("../dist/", import.meta.url);
test("task panel stays light and the optional sea arrives through native chunks", () => {
  const workspace = readFileSync(new URL("client.workspace.js", dist), "utf8");
  assert.ok(Buffer.byteLength(workspace) < 250_000, "task panel must not bundle Three or whale assets");
  assert.match(workspace, /\.async\(["']\.\/client\.native-ocean\.js["']\)/);
  assert.doesNotMatch(workspace, /WebGLRenderer|data:model\/gltf|xterm\.js/);
  for (const name of ["native-ocean", "ocean-scene"]) {
    const source = readFileSync(new URL("client." + name + ".js", dist), "utf8");
    let registration;
    runInNewContext(source, { window: { __ModuleLoader__: { load: value => { registration = value; } } } });
    assert.equal(registration.id, "dsh-fusion");
    assert.equal(registration.chunk, "client." + name + ".js");
    assert.equal(typeof registration.factory, "function");
    assert.doesNotMatch(source, /\bimport\s*\(|(?<![.\w])\w+\(["']\.\//);
    if (name === "native-ocean") assert.match(source, /\.async\(["']\.\/client\.ocean-scene\.js["']\)/);
  }
});
