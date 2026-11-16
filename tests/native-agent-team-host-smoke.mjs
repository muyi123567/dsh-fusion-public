/**
 * Real Cordis + official DSH rc.3 task-board smoke, with no prompt/model provider.
 * Run only on the authorized Instabox, after workspace dependency builds:
 * DSH_NATIVE_RUNTIME_ROOT=/tmp/dsh-fusion-harness-20261116/dsh-runtime \
 *   node tests/native-agent-team-host-smoke.mjs
 * Every generated file lives in a new scratch directory; source is read-only.
 * The read-controller seam below serves real SessionProjectionRegistry snapshots.
 * This proves the board service and adapter, not HTTP routes or model execution.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const sourceRoot = resolve(process.env.DSH_FUSION_SOURCE_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const runtimeRoot = process.env.DSH_NATIVE_RUNTIME_ROOT;
assert.ok(runtimeRoot, "DSH_NATIVE_RUNTIME_ROOT must name the installed official rc.3 runtime");
const runtimeRequire = createRequire(join(resolve(runtimeRoot), "package.json"));
const pluginRequire = createRequire(join(sourceRoot, "packages/plugin/package.json"));
const scratch = await mkdtemp(join(tmpdir(), "dsh-native-team-host-"));
const deadline = setTimeout(() => {
  console.error("NATIVE_TEAM_HOST_EXIT=1 deadline exceeded");
  process.exit(1);
}, 60_000);
deadline.unref();

async function official(name) {
  const manifest = JSON.parse(await readFile(runtimeRequire.resolve(name + "/package.json"), "utf8"));
  if (name.startsWith("@deepseek-ai/dsh-")) assert.equal(manifest.version, "0.2.2-rc.3", name);
  return await import(pathToFileURL(runtimeRequire.resolve(name)).href);
}

const { Context } = await official("@deepseek-ai/cordis");
const ctx = new Context();
const mounted = [];
let handle;
let reader;
try {
  const services = [
    ["@deepseek-ai/dsh-session", {}],
    ["@deepseek-ai/dsh-session-projection", {}],
    ["@deepseek-ai/dsh-agent", {}],
    ["@deepseek-ai/dsh-llm", {}],
    ["@deepseek-ai/dsh-system-prompt", {}],
    ["@deepseek-ai/dsh-tools", {}],
    ["@deepseek-ai/dsh-fs-local", { cwd: scratch }],
    ["@deepseek-ai/dsh-working-directory", { defaultDirectory: scratch }],
    ["@deepseek-ai/dsh-subagent", {}],
    ["@deepseek-ai/dsh-session-persistence-jsonl", { root: join(scratch, "sessions") }],
    ["@deepseek-ai/dsh-agent-loop", {}],
    ["@deepseek-ai/dsh-agent-team", {}],
  ];
  for (const [name, config] of services) {
    const module = await official(name);
    const fiber = ctx.plugin(module.default ?? module, config);
    mounted.push(fiber);
    await fiber.await();
  }
  for (const name of ["sessions", "sessionProjections", "agents", "agentLoop", "subagents", "sessionPersistence", "agentTeams"]) {
    assert.ok(ctx.get(name), "official service did not activate: " + name);
  }

  // No LLM adapter is registered and no prompt is sent. AgentLoop creates an idle
  // real Agent so Team's runtime authority checks and durability listener run.
  const sessionId = "fusion-host-smoke-" + randomUUID();
  handle = await ctx.agents.create({ sessionId, meta: { cwd: scratch } });
  const lead = handle.agent;
  assert.equal(ctx.sessions.get(sessionId), lead.session);
  assert.equal(ctx.subagents.rootOf(lead), lead);
  assert.equal(ctx.agentTeams.isEnabled(lead), false);
  await ctx.agentTeams.setEnabled(lead, true);
  assert.equal(ctx.agentTeams.isEnabled(lead), true);
  const design = await ctx.agentTeams.createTask(lead, {
    subject: "Fixture design",
    description: "Created through the real upstream Team service",
    writeScopes: ["packages/plugin/src/native-agent-teams.ts"],
  });
  const implementation = await ctx.agentTeams.createTask(lead, {
    subject: "Fixture implementation",
    description: "Blocked by the first real task",
    blockedBy: [design.id],
    writeScopes: ["packages/plugin/src/native-agent-teams.test.ts"],
  });
  assert.equal(design.revision, 1);
  assert.equal(design.ready, true);
  assert.equal(implementation.ready, false);

  const snapshot = ctx.sessionProjections.snapshot(lead.session);
  assert.equal(snapshot.values.agentTeam.enabled, true);
  assert.equal(snapshot.values.agentTeam.tasks.length, 2);
  assert.equal(snapshot.values.agentTeam.failure, undefined);
  assert.ok(Number.isSafeInteger(snapshot.asOfSeq) && snapshot.asOfSeq >= 2);
  reader = await ctx.sessionPersistence.open(sessionId, "read");
  const durable = await reader.read();
  assert.equal(durable.events.filter((event) => event.type === "team/task").length, 2);
  await reader.close();
  reader = undefined;

  const { build } = pluginRequire("esbuild");
  const adapterFile = join(scratch, "native-adapter.mjs");
  await build({
    stdin: {
      contents: await readFile(process.env.DSH_NATIVE_ADAPTER_ENTRY
        ?? join(sourceRoot, "packages/plugin/src/native-agent-teams.ts"), "utf8"),
      resolveDir: join(sourceRoot, "packages/plugin/src"), loader: "ts",
      sourcefile: "native-agent-teams.ts",
    },
    outfile: adapterFile, bundle: true, platform: "node", format: "esm",
    target: "node24", logLevel: "silent",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
  const { loadNativeAgentTeams } = await import(pathToFileURL(adapterFile).href);
  const liveController = {
    async list(_request, signal) {
      signal.throwIfAborted();
      return { items: [{
        sessionId, updatedAt: Date.now(), running: false, blank: false,
        agentAvailable: true, cwd: scratch,
        projections: { kind: "sequenced", ...ctx.sessionProjections.snapshot(lead.session) },
      }] };
    },
    async projections({ sessionId: requested }, signal) {
      signal.throwIfAborted();
      const session = ctx.sessions.get(requested);
      return session === undefined ? null : { kind: "sequenced", ...ctx.sessionProjections.snapshot(session) };
    },
  };
  const result = await loadNativeAgentTeams(liveController);
  assert.equal(result.agentTeams.length, 1);
  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.bots, []);
  assert.deepEqual(result.sessions, []);
  const first = result.tasks.find((task) => task.agentTeamTask.taskId === design.id);
  const second = result.tasks.find((task) => task.agentTeamTask.taskId === implementation.id);
  assert.ok(first && second);
  assert.equal(first.status, "queued");
  assert.equal(first.agentTeamTask.revision, 1);
  assert.equal(first.agentTeamTask.ready, true);
  assert.equal(second.agentTeamTask.ready, false);
  assert.deepEqual(second.dependsOnTaskIds, [first.id]);
  assert.deepEqual(second.agentTeamTask.blockedBy, [design.id]);
  assert.deepEqual(first.agentTeamTask.writeScopes, design.writeScopes);
  assert.deepEqual(second.agentTeamTask.writeScopeWarnings, implementation.writeScopeWarnings);
  assert.deepEqual(result.agentTeams[0].taskIds, [first.id, second.id]);
  assert.equal(result.agentTeams[0].captainSessionId, sessionId);
  assert.equal(first.createdAt, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(first.evidence, []);

  // Exercise real upstream revisions and readiness recalculation, still no prompt.
  const claimed = await ctx.agentTeams.updateTask(lead, {
    taskId: design.id, expectedRevision: design.revision, action: "claim",
  });
  const running = await loadNativeAgentTeams(liveController);
  const observedRunning = running.tasks.find((task) => task.agentTeamTask.taskId === design.id);
  assert.equal(observedRunning.status, "running");
  assert.equal(observedRunning.agentTeamTask.ownerId, sessionId);
  assert.equal(observedRunning.agentTeamTask.revision, claimed.revision);
  await ctx.agentTeams.updateTask(lead, {
    taskId: design.id, expectedRevision: claimed.revision, action: "complete",
  });
  const after = await loadNativeAgentTeams(liveController);
  assert.equal(after.tasks.find((task) => task.agentTeamTask.taskId === design.id).status, "completed");
  assert.equal(after.tasks.find((task) => task.agentTeamTask.taskId === implementation.id).agentTeamTask.ready, true);
  await ctx.agentTeams.setEnabled(lead, false);
  assert.equal(ctx.sessionProjections.snapshot(lead.session).values.agentTeam.tasks.length, 2);
  assert.deepEqual((await loadNativeAgentTeams(liveController)).tasks, []);
  console.log(JSON.stringify({
    fixture: "real-cordis-native-team", upstreamVersion: "0.2.2-rc.3",
    machineId: process.env.INSTABOX_MACHINE_ID ?? "authorized-isolated-host", scratch,
    createdTaskCount: 2, durableTaskRecords: 2, projectionAsOfSeq: snapshot.asOfSeq,
    verified: ["Session factory", "Team enable", "createTask", "real projection snapshot",
      "JSONL flush readback", "Fusion nonempty mapping", "dependency/readiness",
      "claim/completion revision", "disabled retained board"],
    modelExecutionVerified: false, httpControllerVerified: false, promptCalls: 0,
  }));
} finally {
  clearTimeout(deadline);
  if (reader) await reader.close();
  if (handle) await handle.dispose();
  for (const fiber of mounted.reverse()) await fiber.dispose();
}
console.log("NATIVE_TEAM_HOST_EXIT=0");
