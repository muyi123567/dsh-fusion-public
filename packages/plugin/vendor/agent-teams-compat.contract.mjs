import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SourceTextModule, SyntheticModule } from "node:vm";

// Execute the unmodified published compatibility module. Only its three host
// imports are doubles; relative policy modules come from the same tarball.
// Full Cordis/DSH activation remains a separate Instabox integration gate.
const tarball = process.env.AGENT_TEAMS_TARBALL
  ? resolve(process.env.AGENT_TEAMS_TARBALL)
  : fileURLToPath(new URL("./nanmicoder-dsh-agent-teams-0.1.30.tgz", import.meta.url));
const officialSha256 = "23c6f98947319e7d1c49c906d45bd83055679f98cece9308953d8f73dd6d67e3";
function source(path) {
  return execFileSync("tar", ["-xOf", tarball, path], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
}
class SubagentError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
async function loadCompat() {
  const cache = new Map();
  const host = new Map([
    ["@deepseek-ai/dsh-llm", { createUserMessage: (input) => ({ id: "message", ...input }) }],
    ["@deepseek-ai/dsh-session", { SESSION_FORMAT_VERSION: 4 }],
    ["@deepseek-ai/dsh-subagent", { SubagentError }],
  ]);
  function moduleFor(id) {
    if (cache.has(id)) return cache.get(id);
    const exports = host.get(id);
    const mod = exports === undefined
      ? new SourceTextModule(source(id), { identifier: id })
      : new SyntheticModule(Object.keys(exports), function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { identifier: id });
    cache.set(id, mod);
    return mod;
  }
  const main = moduleFor("package/lib/harness-compat.js");
  await main.link((specifier, parent) => {
    if (specifier.startsWith(".")) return moduleFor(posix.join(posix.dirname(parent.identifier), specifier));
    assert.ok(host.has(specifier), "unexpected host import: " + specifier);
    return moduleFor(specifier);
  });
  await main.evaluate();
  return main.namespace;
}
function treeHost() {
  const root = { id: "captain", session: { header: { version: 4 } } };
  const child = { id: "member", session: { header: { version: 4 } } };
  const calls = [];
  const disposers = [];
  const manager = {
    resident: new Map(),
    async deliverToMember(owner, target, content, options) {
      assert.equal(this, manager, "native manager receiver must survive wrapping");
      options.signal.throwIfAborted();
      options.authorize?.();
      calls.push({ owner, target, content, options });
      return "accepted";
    },
    async dispose(activation) { calls.push({ disposed: activation.childId }); },
  };
  const runtime = {
    manager,
    rootOf(agent) {
      assert.equal(this, runtime);
      if (agent === root || agent === child) return root;
      throw new SubagentError("caller outside tree", "UNAUTHORIZED");
    },
    async prompt(request, signal) {
      return manager.deliverToMember(root, request.childSessionId, request.content, {
        signal, source: { kind: "user" }, delivery: request.delivery,
      });
    },
    async sendMessage(sender, target, content, options) {
      return manager.deliverToMember(this.rootOf(sender), target, content, {
        ...options, source: { kind: "agent" }, delivery: "steer",
      });
    },
  };
  const ctx = {
    subagents: runtime,
    effect(setup) {
      const dispose = setup();
      disposers.push(dispose);
      return dispose;
    },
  };
  return { root, child, calls, manager, runtime, ctx, disposers, signal: new AbortController().signal };
}
test("published AgentTeams companion is the exact official 0.1.30 archive", () => {
  const manifest = JSON.parse(source("package/package.json"));
  assert.equal(manifest.version, "0.1.30");
  assert.equal(manifest.name, "@nanmicoder/dsh-agent-teams");
  assert.equal(createHash("sha256").update(readFileSync(tarball)).digest("hex"), officialSha256);
});

test("tree activation installs the retired-member guard after legacy delivery removal", async () => {
  const compat = await loadCompat();
  const host = treeHost();
  assert.equal(host.runtime.followup, undefined);
  assert.equal(host.runtime[Symbol.for("dsh.subagent.deliverPrompt")], undefined);
  const original = host.manager.deliverToMember;
  assert.doesNotThrow(() => compat.guardSubagentDelivery(host.ctx, async () => false));
  assert.notEqual(host.manager.deliverToMember, original);
  assert.equal(await compat.queueMemberPrompt(host.runtime, host.root, "member", [], host.signal), "accepted");
  assert.equal(host.calls[0].owner, host.root);
  assert.equal(host.calls[0].options.source.kind, "agent-teams");
  host.disposers.pop()();
  assert.equal(host.manager.deliverToMember, original);
});

test("retired cold members reject queue, steer, model and browser delivery before native acceptance", async () => {
  const compat = await loadCompat();
  const host = treeHost();
  assert.equal(host.manager.resident.size, 0, "exercise cold members");
  compat.guardSubagentDelivery(host.ctx, async (owner, target) => {
    assert.equal(owner, host.root);
    return target === "retired";
  });
  const routes = [
    () => compat.queueMemberPrompt(host.runtime, host.root, "retired", [], host.signal),
    () => compat.steerMemberPrompt(host.runtime, host.root, "retired", [], host.signal),
    () => host.runtime.sendMessage(host.child, "retired", [], { signal: host.signal }),
    () => host.runtime.prompt({ childSessionId: "retired", content: [], delivery: "queue" }, host.signal),
  ];
  for (const send of routes) {
    await assert.rejects(send, (error) => error.code === "NOT_RESUMABLE");
  }
  assert.equal(host.calls.length, 0);
  host.disposers.pop()();
});

test("queue and steer retain delivery modes, native source and final caller authorization", async () => {
  const compat = await loadCompat();
  const host = treeHost();
  compat.guardSubagentDelivery(host.ctx, async () => false);
  await compat.queueMemberPrompt(host.runtime, host.root, "member", [], host.signal);
  await compat.steerMemberPrompt(host.runtime, host.root, "member", [], host.signal);
  assert.deepEqual(host.calls.map((call) => call.options.delivery), ["queue", "steer"]);
  assert.deepEqual(host.calls.map((call) => call.options.source.kind), ["agent-teams", "agent-teams"]);
  host.runtime.rootOf = () => ({ id: "different-root" });
  assert.throws(() => host.calls[0].options.authorize(), (error) => error.code === "UNAUTHORIZED");
  host.disposers.pop()();
});

test("incomplete tree managers fail closed before any guard effect is installed", async () => {
  const compat = await loadCompat();
  for (const broken of [
    undefined,
    { resident: new Map(), dispose() {} },
    { resident: new Map(), deliverToMember() {} },
    { resident: {}, deliverToMember() {}, dispose() {} },
  ]) {
    const host = treeHost();
    host.runtime.manager = broken;
    assert.throws(() => compat.guardSubagentDelivery(host.ctx, async () => false),
      /unsupported Harness subagent contract.*missing audited tree delivery manager/u);
    assert.equal(host.disposers.length, 0);
  }
});

test("cancellation during the retired-member lookup prevents native acceptance", async () => {
  const compat = await loadCompat();
  const host = treeHost();
  const controller = new AbortController();
  compat.guardSubagentDelivery(host.ctx, async () => {
    controller.abort();
    return false;
  });
  await assert.rejects(
    compat.queueMemberPrompt(host.runtime, host.root, "member", [], controller.signal),
    (error) => error.name === "AbortError",
  );
  assert.equal(host.calls.length, 0);
  host.disposers.pop()();
});

test("guard cleanup restores inherited native methods without overwriting a later guard", async () => {
  const compat = await loadCompat();
  const host = treeHost();
  const inherited = host.manager.deliverToMember;
  delete host.manager.deliverToMember;
  Object.setPrototypeOf(host.manager, { deliverToMember: inherited });
  compat.guardSubagentDelivery(host.ctx, async () => false);
  assert.equal(Object.hasOwn(host.manager, "deliverToMember"), true);
  host.disposers.pop()();
  assert.equal(Object.hasOwn(host.manager, "deliverToMember"), false);
  assert.equal(host.manager.deliverToMember, inherited);
  compat.guardSubagentDelivery(host.ctx, async () => false);
  const later = async () => "later-owner";
  host.manager.deliverToMember = later;
  host.disposers.pop()();
  assert.equal(host.manager.deliverToMember, later);
});

test("tree member creation preserves flat native request and member options", async () => {
  const compat = await loadCompat();
  const host = treeHost();
  const starts = [];
  host.runtime.startActivation = async function (spec) {
    assert.equal(this, host.runtime);
    starts.push(spec);
    return { childId: "member", result: Promise.resolve() };
  };
  compat.guardSubagentCreation(host.ctx, (parent) => assert.equal(parent, host.root));
  const options = { provider: "test-provider", model: "test-model", reasoningEffort: "max" };
  await compat.startMember(host.runtime, {
    provider: "local", label: "member",
    request: { parent: host.root, prompt: [], agentOptions: options },
    signal: host.signal,
  });
  assert.equal(starts.length, 1);
  assert.equal(starts[0].request, undefined);
  assert.equal(starts[0].parent, host.root);
  assert.equal(starts[0].agentOptions, options);
  assert.equal(starts[0].delivery, "parent");
  host.disposers.pop()();
});

test("targeted teardown keeps siblings and other trees alive", async () => {
  const compat = await loadCompat();
  const host = treeHost();
  const other = { id: "other-captain" };
  for (const activation of [
    { childId: "selected", root: host.root, ancestors: ["captain"] },
    { childId: "descendant", root: host.root, ancestors: ["captain", "selected"] },
    { childId: "sibling", root: host.root, ancestors: ["captain"] },
    { childId: "foreign", root: other, ancestors: ["other-captain", "selected"] },
  ]) host.manager.resident.set(activation.childId, activation);
  host.runtime.drainChildren = () => assert.fail("tree-wide drain must not run");
  await compat.drainMemberChildren(host.runtime, host.root, ["selected"]);
  assert.deepEqual(host.calls.map((call) => call.disposed).sort(), ["descendant", "selected"]);
});

test("legacy host delivery keeps its retired-member guard and exact receiver", async () => {
  const compat = await loadCompat();
  const disposers = [];
  const calls = [];
  const runtime = {
    async followup(...args) {
      assert.equal(this, runtime);
      calls.push(args);
      return "accepted-legacy";
    },
  };
  const original = runtime.followup;
  compat.guardSubagentDelivery({
    subagents: runtime, effect(setup) { disposers.push(setup()); },
  }, async (_parent, target) => target === "retired");
  await assert.rejects(() => runtime.followup({}, "retired", [], {}),
    (error) => error.code === "NOT_RESUMABLE");
  assert.equal(calls.length, 0);
  assert.equal(await runtime.followup({}, "active", [], {}), "accepted-legacy");
  disposers.pop()();
  assert.equal(runtime.followup, original);
});
