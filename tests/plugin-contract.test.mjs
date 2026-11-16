import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as hostPlugin from "../packages/plugin/dist/index.js";
import { assertDshInstallable, resolveDshCompatibility } from "../packages/plugin/dist/index.js";

function createHostContext() {
  const routes = [];
  const tools = [];
  const guards = [];
  const effectDisposers = [];
  const cleanupOrder = [];
  let effectSequence = 0;

  const ctx = new Proxy({
    tools: {
      register(tool) {
        tools.push(tool);
        return () => {
          const index = tools.indexOf(tool);
          if (index >= 0) tools.splice(index, 1);
        };
      },
      guard(guard) {
        guards.push(guard);
        return () => {
          const index = guards.indexOf(guard);
          if (index >= 0) guards.splice(index, 1);
        };
      },
      async execute(input) {
        return { isError: false, value: { upstream: input.name } };
      },
    },
    get(name) {
      if (name === "webServer") {
        return {
          register(route) {
            routes.push(route);
            return () => {
              const index = routes.indexOf(route);
              if (index >= 0) routes.splice(index, 1);
            };
          },
        };
      }
      if (name === "connection") {
        return { requestRejection: () => undefined };
      }
      return undefined;
    },
    on() {
      return () => {};
    },
    effect(callback) {
      const dispose = callback();
      const sequence = ++effectSequence;
      effectDisposers.push(async () => {
        cleanupOrder.push(sequence);
        await dispose();
      });
      return () => {};
    },
  }, {
    get(target, property, receiver) {
      if (property === "config") throw new Error("ctx.config must not be read");
      return Reflect.get(target, property, receiver);
    },
  });

  return {
    ctx,
    routes,
    tools,
    guards,
    async cleanup() {
      while (effectDisposers.length > 0) {
        await effectDisposers.pop()();
      }
      return cleanupOrder;
    },
  };
}

function createJsonRequest(body) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  };
}

function createResponse() {
  const state = { status: 0, body: "" };
  return {
    state,
    response: {
      writeHead(status) {
        state.status = status;
      },
      end(body) {
        state.body = body ?? "";
      },
    },
  };
}

async function applyWithHuawei(remoteConfig) {
  const host = createHostContext();
  await hostPlugin.apply(host.ctx, {
    dshVersion: "0.2.0-rc.2",
    modelTaskCommands: ["uname -a"],
    huaweiSsh: {
      host: "example.invalid",
      keyPath: "C:\\example-key",
      knownHostsPath: "C:\\example-known-hosts",
    },
    remoteConfig,
  });
  return host;
}

test("exports host and client apply functions with declared injections", () => {
  assert.equal(typeof hostPlugin.apply, "function");
  assert.equal(Array.isArray(hostPlugin.inject), true);
  const hostBundle = readFileSync(new URL("../packages/plugin/dist/index.js", import.meta.url), "utf8");
  assert.equal(hostBundle.includes("from \"@dsh-fusion/"), false);
  assert.equal(hostBundle.includes("from '@dsh-fusion/"), false);
  // The bundle legitimately contains import.meta: the compatibility
  // reader uses createRequire(import.meta.url) to locate the
  // installed DSH package. The October-era absence assertion
  // predates that reader and no longer states a real invariant.
  assert.equal(hostBundle.includes('from "cpu-features"'), false);
  assert.equal(hostBundle.includes('from "bufferutil"'), false);
  assert.equal(hostBundle.includes('from "utf-8-validate"'), false);
  for (const marker of [
    "startStandalone",
    "StandaloneOptions",
    "StandaloneServer",
    "CLIENT_BUILD_MISSING",
    "createFusionApp",
    "/api/fusion/overview",
    "/api/fusion/bots",
    "/api/fusion/sessions",
    "/api/fusion/ssh/",
  ]) {
    assert.equal(hostBundle.includes(marker), false, marker);
  }
  const clientBundle = readFileSync(new URL("../packages/plugin/dist/client.js", import.meta.url), "utf8");
  assert.ok(clientBundle.includes("window.__ModuleLoader__.load"));
  assert.ok(clientBundle.includes("dsh-fusion"));
  assert.ok(clientBundle.includes("slots"));
  assert.ok(clientBundle.includes(".async("));
  assert.ok(clientBundle.includes("client.workspace.js"));
  const workspaceBundle = readFileSync(new URL("../packages/plugin/dist/client.workspace.js", import.meta.url), "utf8");
  assert.ok(workspaceBundle.includes("window.__ModuleLoader__.load"));
  assert.ok(workspaceBundle.includes("/plugins/dsh-fusion/state"));
  assert.equal(clientBundle.includes("createRoot"), false);
});

test("does not depend on private workspace packages at install time", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../packages/plugin/package.json", import.meta.url), "utf8"));
  const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});
  assert.equal(runtimeDependencies.some((name) => name.startsWith("@dsh-fusion/")), false);
});

test("loads the built standalone entry", async () => {
  const standalone = await import("dsh-fusion/standalone");
  assert.equal(typeof standalone.startStandalone, "function");
});

test("fails closed on DSH version skew", () => {
  assert.throws(
    () => assertDshInstallable(resolveDshCompatibility({ configuredVersion: "0.1.5-rc.2" })),
    /DSH_INCOMPATIBLE_VERSION/,
  );
  assert.doesNotThrow(
    () => assertDshInstallable(resolveDshCompatibility({ configuredVersion: "0.2.0-rc.2" })),
  );
});

test("keeps legacy input shape when fleet YAML is not configured", () => {
  const legacy = {
    nodeId: "runtime-huawei",
    displayName: "Runtime Huawei",
    dshVersion: "0.2.0-rc.2",
    workspaceRoot: "/srv/projects",
  };

  const resolved = hostPlugin.resolveRemoteConfig({
    legacyInput: legacy,
    runtimeNodeId: legacy.nodeId,
    remoteConfig: undefined,
    getEnv: () => undefined,
  });
  assert.deepEqual(resolved, { mode: "legacy", input: legacy });
  assert.equal(Object.hasOwn(resolved.input, "capabilities"), false);
});

test("projects fleet YAML and keeps authoritative fields out of identity overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-fusion-contract-"));
  const path = join(root, "fleet.yaml");
  try {
    writeFileSync(path, `
version: 1
defaults:
  dshVersion: 0.2.0-rc.2
  transport: seekfleet
base:
  capabilities: [dsh]
roles:
  worker:
    capabilities: [monitor]
nodes:
  huawei-config-node:
    platform: linux
    transport: ssh
    roles: [worker]
    workspaceRoots: [/srv/projects]
    capabilities: [linux, hindsight]
`, "utf8");

    const resolved = hostPlugin.resolveRemoteConfig({
      legacyInput: {
        nodeId: "runtime-huawei",
        displayName: "Runtime Huawei",
        dshVersion: "0.1.5-rc.2",
        workspaceRoot: "/tmp/legacy",
        capabilities: ["legacy"],
      },
      runtimeNodeId: "runtime-huawei",
      remoteConfig: {
        fleetConfigPath: path,
        fleetNodeId: "huawei-config-node",
      },
      getEnv: () => undefined,
    });
    assert.deepEqual(resolved, {
      mode: "yaml",
      input: {
        nodeId: "runtime-huawei",
        displayName: "Runtime Huawei",
        dshVersion: "0.2.0-rc.2",
        workspaceRoot: "/srv/projects",
        capabilities: ["dsh", "monitor", "linux", "hindsight"],
      },
    });

    const applied = hostPlugin.applyRemoteConfigOverrides({
      mode: resolved.mode,
      input: resolved.input,
      runtimeNodeId: "runtime-huawei",
      body: {
        nodeId: "runtime-huawei",
        displayName: "Runtime Huawei from body",
      },
    });
    assert.deepEqual(applied, {
      ok: true,
      input: {
        nodeId: "runtime-huawei",
        displayName: "Runtime Huawei from body",
        dshVersion: "0.2.0-rc.2",
        workspaceRoot: "/srv/projects",
        capabilities: ["dsh", "monitor", "linux", "hindsight"],
      },
    });

    for (const field of ["dshVersion", "workspaceRoot", "capabilities"]) {
      const forbidden = hostPlugin.applyRemoteConfigOverrides({
        mode: resolved.mode,
        input: resolved.input,
        runtimeNodeId: "runtime-huawei",
        body: { [field]: field === "capabilities" ? ["override"] : "override" },
      });
      assert.equal(forbidden.ok, false);
      assert.equal(forbidden.status, 400);
      assert.match(forbidden.error, /REMOTE_CONFIG_BODY_FIELDS_FORBIDDEN/);
    }

    const mismatch = hostPlugin.applyRemoteConfigOverrides({
      mode: resolved.mode,
      input: resolved.input,
      runtimeNodeId: "runtime-huawei",
      body: { nodeId: "other-runtime" },
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.status, 400);
    assert.match(mismatch.error, /REMOTE_CONFIG_NODE_ID_MISMATCH/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps all legacy fields overridable", () => {
  const legacy = {
    nodeId: "runtime-huawei",
    displayName: "Runtime Huawei",
    dshVersion: "0.2.0-rc.2",
    workspaceRoot: "/srv/projects",
  };
  const applied = hostPlugin.applyRemoteConfigOverrides({
    mode: "legacy",
    input: legacy,
    runtimeNodeId: "runtime-huawei",
    body: {
      nodeId: "runtime-huawei",
      displayName: "Legacy override",
      dshVersion: "0.2.0-rc.3",
      workspaceRoot: "/srv/legacy-override",
      capabilities: ["legacy-override"],
    },
  });

  assert.deepEqual(applied, {
    ok: true,
    input: {
      nodeId: "runtime-huawei",
      displayName: "Legacy override",
      dshVersion: "0.2.0-rc.3",
      workspaceRoot: "/srv/legacy-override",
      capabilities: ["legacy-override"],
    },
  });
  assert.equal(Object.hasOwn(applied.input, "capabilities"), true);
});

test("keeps route, tool, and SSE registration stable in YAML mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-fusion-contract-"));
  const path = join(root, "fleet.yaml");
  const previousPath = process.env.FUSION_FLEET_CONFIG;
  const previousNode = process.env.FUSION_FLEET_NODE_ID;
  let legacyHost;
  let yamlHost;
  try {
    delete process.env.FUSION_FLEET_CONFIG;
    delete process.env.FUSION_FLEET_NODE_ID;
    writeFileSync(path, `
version: 1
defaults:
  dshVersion: 0.2.0-rc.2
  transport: seekfleet
base:
  capabilities: [dsh]
roles:
  worker:
    capabilities: [monitor]
nodes:
  huawei-config-node:
    platform: linux
    transport: ssh
    roles: [worker]
    workspaceRoots: [/srv/projects]
    capabilities: [linux, hindsight]
`, "utf8");

    legacyHost = await applyWithHuawei({
      path: "/tmp/dsh-fusion-node-config.json",
    });
    yamlHost = await applyWithHuawei({
      path: "/tmp/dsh-fusion-node-config.json",
      fleetConfigPath: path,
      fleetNodeId: "huawei-config-node",
    });

    assert.deepEqual(
      yamlHost.routes.map((route) => route.path).sort(),
      legacyHost.routes.map((route) => route.path).sort(),
    );
    assert.deepEqual(
      yamlHost.tools.map((tool) => tool.name).sort(),
      legacyHost.tools.map((tool) => tool.name).sort(),
    );
    assert.ok(yamlHost.routes.some((route) => route.path === "/plugins/dsh-fusion/events"));

    const applyRoute = yamlHost.routes.find(
      (route) => route.path === "/plugins/dsh-fusion/config/apply",
    );
    assert.ok(applyRoute);
    const response = createResponse();
    await applyRoute.handler(createJsonRequest({
      dshVersion: "9.9.9",
      workspaceRoot: "/tmp/override",
      capabilities: ["override"],
    }), response.response);
    assert.equal(response.state.status, 400);
    assert.match(
      JSON.parse(response.state.body).error,
      /REMOTE_CONFIG_BODY_FIELDS_FORBIDDEN:capabilities,dshVersion,workspaceRoot/,
    );
  } finally {
    if (legacyHost !== undefined) await legacyHost.cleanup();
    if (yamlHost !== undefined) await yamlHost.cleanup();
    rmSync(root, { recursive: true, force: true });
    if (previousPath === undefined) {
      delete process.env.FUSION_FLEET_CONFIG;
    } else {
      process.env.FUSION_FLEET_CONFIG = previousPath;
    }
    if (previousNode === undefined) {
      delete process.env.FUSION_FLEET_NODE_ID;
    } else {
      process.env.FUSION_FLEET_NODE_ID = previousNode;
    }
  }
});

test("keeps YAML projection failure closed before registration", async () => {
  const previousPath = process.env.FUSION_FLEET_CONFIG;
  const previousNode = process.env.FUSION_FLEET_NODE_ID;
  const root = mkdtempSync(join(tmpdir(), "dsh-fusion-contract-"));
  const host = createHostContext();
  try {
    process.env.FUSION_FLEET_CONFIG = join(root, "missing.yaml");
    process.env.FUSION_FLEET_NODE_ID = "huawei-hs-monitor-cn";

    await assert.rejects(hostPlugin.apply(host.ctx, {
      dshVersion: "0.2.0-rc.2",
      modelTaskCommands: ["uname -a"],
    }), /FLEET_CONFIG_FILE_NOT_FOUND/);
    assert.equal(host.routes.length, 0);
    assert.equal(host.tools.length, 0);
  } finally {
    await host.cleanup();
    rmSync(root, { recursive: true, force: true });
    if (previousPath === undefined) {
      delete process.env.FUSION_FLEET_CONFIG;
    } else {
      process.env.FUSION_FLEET_CONFIG = previousPath;
    }
    if (previousNode === undefined) {
      delete process.env.FUSION_FLEET_NODE_ID;
    } else {
      process.env.FUSION_FLEET_NODE_ID = previousNode;
    }
  }
});

test("does not read fleet YAML when only FUSION_FLEET_NODE_ID is set", async () => {
  const previousPath = process.env.FUSION_FLEET_CONFIG;
  const previousNode = process.env.FUSION_FLEET_NODE_ID;
  const host = createHostContext();
  try {
    delete process.env.FUSION_FLEET_CONFIG;
    process.env.FUSION_FLEET_NODE_ID = "not-configured-without-path";
    await hostPlugin.apply(host.ctx, {
      dshVersion: "0.2.0-rc.2",
      modelTaskCommands: ["uname -a"],
    });
    assert.ok(host.routes.length > 0);
  } finally {
    await host.cleanup();
    if (previousPath === undefined) {
      delete process.env.FUSION_FLEET_CONFIG;
    } else {
      process.env.FUSION_FLEET_CONFIG = previousPath;
    }
    if (previousNode === undefined) {
      delete process.env.FUSION_FLEET_NODE_ID;
    } else {
      process.env.FUSION_FLEET_NODE_ID = previousNode;
    }
  }
});

test("warns and returns when the host context cannot resolve services", async () => {
  const warnings = [];
  const result = await hostPlugin.apply({
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  }, {
    dshVersion: "0.2.0-rc.2",
  });

  assert.equal(result, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ctx\.get/);
});

test("registers routes and keeps high-privilege AgentTeams writes disabled by default", async () => {
  const host = createHostContext();
  try {
    await hostPlugin.apply(host.ctx, {
      dshVersion: "0.2.0-rc.2",
      modelTaskCommands: ["uname -a"],
    });

    const routesByPath = new Map(host.routes.map((route) => [route.path, route]));
    for (const path of [
      "/plugins/dsh-fusion/state",
      "/plugins/dsh-fusion/node-doctor",
      "/plugins/dsh-fusion/tasks",
      "/plugins/dsh-fusion/tasks/cancel",
      "/plugins/dsh-fusion/tasks/status",
    ]) {
      assert.equal(routesByPath.get(path)?.kind, "exact");
    }
    assert.deepEqual(
      host.tools.map((tool) => tool.name),
      [
        "fusion_status",
        "fusion_node_doctor",
        "fusion_doctor",
        "fusion_task_dispatch",
        "fusion_task_cancel",
        "fusion_task_status",
      ],
    );
    assert.equal(
      host.tools.some((tool) => tool.name.startsWith("fusion_bus_")),
      false,
    );
    assert.equal(host.guards.length, 3);
    assert.equal(host.guards[0]({
      name: "send_note",
      callId: "direct-agent-bus-write",
    }), undefined);
    assert.match(host.guards[0]({
      name: "agent_teams_approve",
      callId: "direct-1",
    }), /FUSION_AGENT_TEAM_WRITES_DISABLED/);
    assert.match(host.guards[0]({
      name: "agent_teams_resume",
      callId: "parent-1:fusion:fusion_team_resume:1",
      parent: Symbol("parent"),
    }), /FUSION_AGENT_TEAM_WRITES_DISABLED/);
    // With every write switch off, the Bus and Room guards are
    // registered too: the disabled state is enforced on the
    // upstream surface itself, not only on Fusion's wrappers.
    const busGuard = host.guards.find((guard) => guard({
      name: "send_note",
      callId: "direct-1",
    }) !== undefined);
    assert.match(busGuard({
      name: "send_note",
      callId: "direct-1",
    }), /FUSION_AGENT_BUS_WRITES_DISABLED/);
    assert.match(busGuard({
      name: "settle_task",
      callId: "direct-2",
    }), /FUSION_AGENT_BUS_WRITES_DISABLED/);
    const roomGuard = host.guards.find((guard) => guard({
      name: "room_close",
      callId: "direct-1",
    }) !== undefined);
    assert.match(roomGuard({
      name: "room_close",
      callId: "direct-1",
    }), /FUSION_ROOM_WRITES_DISABLED/);
    assert.match(roomGuard({
      name: "room_send",
      callId: "direct-2",
    }), /FUSION_ROOM_WRITES_DISABLED/);

    let routeBody;
    await routesByPath.get("/plugins/dsh-fusion/state").handler({}, {
      writeHead() {},
      end(body) {
        routeBody = JSON.parse(body);
      },
    });
    assert.equal(routeBody.demo, false);
    assert.ok(Array.isArray(routeBody.groups));
    assert.ok(Array.isArray(routeBody.sessions));
    assert.ok(Array.isArray(routeBody.nodes));
    assert.ok(Array.isArray(routeBody.tasks));
  } finally {
    const cleanupOrder = await host.cleanup();
    assert.deepEqual(
      cleanupOrder,
      Array.from({ length: cleanupOrder.length }, (_, index) => cleanupOrder.length - index),
    );
    assert.equal(host.routes.length, 0);
    assert.equal(host.tools.length, 0);
    assert.equal(host.guards.length, 0);
  }
});

test("enables the six AgentBus proxies and guards direct upstream writes", async () => {
  const host = createHostContext();
  try {
    await hostPlugin.apply(host.ctx, {
      dshVersion: "0.2.0-rc.2",
      allowAgentBusWrites: true,
      modelTaskCommands: ["uname -a"],
    });

    assert.deepEqual(
      host.tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("fusion_bus_")),
      [
        "fusion_bus_send_note",
        "fusion_bus_create_flow",
        "fusion_bus_create_task",
        "fusion_bus_report_task",
        "fusion_bus_settle_task",
        "fusion_bus_cancel_task",
      ],
    );
    assert.equal(host.guards.length, 3);

    const busGuard = host.guards.find((guard) => guard({
      name: "send_note",
      callId: "direct-1",
    }) !== undefined);
    assert.equal(typeof busGuard, "function");
    for (const [upstreamName, fusionName] of [
      ["send_note", "fusion_bus_send_note"],
      ["create_flow", "fusion_bus_create_flow"],
      ["create_task", "fusion_bus_create_task"],
      ["report_task", "fusion_bus_report_task"],
      ["settle_task", "fusion_bus_settle_task"],
      ["cancel_task", "fusion_bus_cancel_task"],
    ]) {
      assert.match(busGuard({
        name: upstreamName,
        callId: "direct-1",
      }), new RegExp(fusionName));
      assert.equal(busGuard({
        name: upstreamName,
        callId: `call-1:fusion:${fusionName}:1`,
        parent: Symbol("parent"),
      }), undefined);
      assert.match(busGuard({
        name: upstreamName,
        callId: `call-1:fusion:${fusionName}:1:ptc:1`,
        parent: Symbol("parent"),
      }), /FUSION_AGENT_BUS_WRITES_GUARDED/);
    }
    assert.equal(busGuard({
      name: "list_peers",
      callId: "read-1",
    }), undefined);
  } finally {
    await host.cleanup();
  }
});

test("enables AgentBus writes through the environment only for true", async () => {
  const previous = process.env.FUSION_ALLOW_AGENT_BUS_WRITES;
  try {
    delete process.env.FUSION_ALLOW_AGENT_BUS_WRITES;
    const disabled = createHostContext();
    try {
      await hostPlugin.apply(disabled.ctx, {
        dshVersion: "0.2.0-rc.2",
        modelTaskCommands: ["uname -a"],
      });
      assert.equal(
        disabled.tools.some((tool) => tool.name.startsWith("fusion_bus_")),
        false,
      );
    } finally {
      await disabled.cleanup();
    }

    process.env.FUSION_ALLOW_AGENT_BUS_WRITES = "1";
    const nonBoolean = createHostContext();
    try {
      await hostPlugin.apply(nonBoolean.ctx, {
        dshVersion: "0.2.0-rc.2",
        modelTaskCommands: ["uname -a"],
      });
      assert.equal(
        nonBoolean.tools.some((tool) => tool.name.startsWith("fusion_bus_")),
        false,
      );
    } finally {
      await nonBoolean.cleanup();
    }

    process.env.FUSION_ALLOW_AGENT_BUS_WRITES = "true";
    const enabled = createHostContext();
    try {
      await hostPlugin.apply(enabled.ctx, {
        dshVersion: "0.2.0-rc.2",
        modelTaskCommands: ["uname -a"],
      });
      assert.equal(
        enabled.tools.some((tool) => tool.name === "fusion_bus_send_note"),
        true,
      );
    } finally {
      await enabled.cleanup();
    }
  } finally {
    if (previous === undefined) {
      delete process.env.FUSION_ALLOW_AGENT_BUS_WRITES;
    } else {
      process.env.FUSION_ALLOW_AGENT_BUS_WRITES = previous;
    }
  }
});

test("fails closed before registration when AgentBus guard support is missing", async () => {
  const host = createHostContext();
  delete host.ctx.tools.guard;

  await assert.rejects(
    hostPlugin.apply(host.ctx, {
      dshVersion: "0.2.0-rc.2",
      allowAgentBusWrites: true,
      modelTaskCommands: ["uname -a"],
    }),
    /FUSION_AGENT_BUS_GUARD_UNAVAILABLE/,
  );
  assert.equal(host.tools.length, 0);
  await host.cleanup();
});

test("fails closed before registration when effect support is missing for write tools", async () => {
  // Registration goes through ctx.effect; without it the write tools
  // and guards would be silently skipped while the switches read as
  // enabled. Each family must refuse with its own stable code.
  const cases = [
    ["allowAgentTeamWrites", /FUSION_AGENT_TEAM_EFFECT_UNAVAILABLE/],
    ["allowAgentBusWrites", /FUSION_AGENT_BUS_EFFECT_UNAVAILABLE/],
    ["allowRoomWrites", /FUSION_ROOM_EFFECT_UNAVAILABLE/],
  ];
  for (const [flag, pattern] of cases) {
    const host = createHostContext();
    delete host.ctx.effect;

    await assert.rejects(
      hostPlugin.apply(host.ctx, {
        dshVersion: "0.2.0-rc.2",
        [flag]: true,
        modelTaskCommands: ["uname -a"],
      }),
      pattern,
    );
    assert.equal(host.tools.length, 0);
    assert.equal(host.guards.length, 0);
    await host.cleanup();
  }
});

test("reports a stable code when the tools registry itself is missing", async () => {
  // The registry is a hard prerequisite of apply itself: a missing
  // registry fails at entry with DSH_FUSION_TOOLS_UNAVAILABLE,
  // before any per-family write check runs.
  const host = createHostContext();
  delete host.ctx.tools;

  await assert.rejects(
    hostPlugin.apply(host.ctx, {
      dshVersion: "0.2.0-rc.2",
      allowAgentTeamWrites: true,
      modelTaskCommands: ["uname -a"],
    }),
    /DSH_FUSION_TOOLS_UNAVAILABLE/,
  );
  await host.cleanup();
});

test("fails at apply entry when tools.register is missing or not a function", async () => {
  // Every tool (read-only, config and the three write families) is
  // registered through ctx.tools.register inside ctx.effect. A host
  // that provides a registry without a callable register previously
  // passed every prerequisite check and then failed each registration
  // with a bare TypeError — or silently registered nothing when the
  // host's effect swallowed it. The prerequisite is global, not
  // per-family: it must fail with no write switches enabled too.
  const configs = [{}, { allowAgentTeamWrites: true }];
  for (const extra of configs) {
    const host = createHostContext();
    delete host.ctx.tools.register;

    await assert.rejects(
      hostPlugin.apply(host.ctx, {
        dshVersion: "0.2.0-rc.2",
        modelTaskCommands: ["uname -a"],
        ...extra,
      }),
      /DSH_FUSION_TOOL_REGISTER_UNAVAILABLE/,
    );
    assert.equal(host.tools.length, 0);
    assert.equal(host.guards.length, 0);
    await host.cleanup();
  }

  const host = createHostContext();
  host.ctx.tools.register = "not-a-function";
  await assert.rejects(
    hostPlugin.apply(host.ctx, {
      dshVersion: "0.2.0-rc.2",
      modelTaskCommands: ["uname -a"],
    }),
    /DSH_FUSION_TOOL_REGISTER_UNAVAILABLE/,
  );
  assert.equal(host.tools.length, 0);
  await host.cleanup();
});

test("fails before registration when ctx.effect is missing, even with no write switches", async () => {
  // The per-family effect checks only fire when a write switch is
  // on. Every other registration surface — the read-only tools and
  // the fallback web registration — also goes through ctx.effect,
  // so a host without effect previously loaded the plugin
  // "successfully" with no tools or routes at all. The prerequisite
  // is entry-level once the write families have had their say.
  const host = createHostContext();
  delete host.ctx.effect;

  await assert.rejects(
    hostPlugin.apply(host.ctx, {
      dshVersion: "0.2.0-rc.2",
      modelTaskCommands: ["uname -a"],
    }),
    /DSH_FUSION_EFFECT_UNAVAILABLE/,
  );
  assert.equal(host.tools.length, 0);
  assert.equal(host.guards.length, 0);
  assert.equal(host.routes.length, 0);
  await host.cleanup();
});

test("enables the six Room proxies and blocks direct upstream writes", async () => {
  const host = createHostContext();
  try {
    await hostPlugin.apply(host.ctx, {
      dshVersion: "0.2.0-rc.2",
      allowRoomWrites: true,
      modelTaskCommands: ["uname -a"],
    });
    assert.deepEqual(
      host.tools
        .filter((tool) => tool.name.startsWith("fusion_room_"))
        .map((tool) => tool.name),
      [
        "fusion_room_create",
        "fusion_room_attach_session",
        "fusion_room_remove_member",
        "fusion_room_send",
        "fusion_room_broadcast",
        "fusion_room_close",
      ],
    );
    assert.equal(host.guards.length, 3);
    const roomGuard = host.guards.find((guard) => guard({
      name: "room_send",
      callId: "direct-1",
    }) !== undefined);
    assert.equal(typeof roomGuard, "function");
    assert.match(roomGuard({
      name: "room_send",
      callId: "direct-1",
    }), /fusion_room_send/);
    assert.equal(roomGuard({
      name: "room_send",
      callId: "call-1:fusion:fusion_room_send:1",
      parent: Symbol("parent"),
    }), undefined);
    assert.match(roomGuard({
      name: "room_send",
      callId: "call-1:fusion:fusion_room_send:1:ptc:1",
      parent: Symbol("parent"),
    }), /FUSION_ROOM_WRITES_GUARDED/);
  } finally {
    await host.cleanup();
  }
});

test("fails closed when Room writes are enabled without guard support", async () => {
  const host = createHostContext();
  delete host.ctx.tools.guard;
  await assert.rejects(
    hostPlugin.apply(host.ctx, {
      dshVersion: "0.2.0-rc.2",
      allowRoomWrites: true,
      modelTaskCommands: ["uname -a"],
    }),
    /FUSION_ROOM_GUARD_UNAVAILABLE/,
  );
  assert.equal(host.tools.length, 0);
  await host.cleanup();
});

test("fails closed when the guard surface is missing even with every write switch off", async () => {
  // Guards register unconditionally so the disabled state holds
  // on the upstream surface: with the switches off, the guards
  // are the ONLY thing standing between a direct upstream write
  // call and the upstream tools. A host without a guard surface
  // therefore cannot load at all — silently skipping guard
  // registration would leave direct Bus/Room writes unguarded
  // exactly when the switches say they must not happen. The
  // enabled case fails closed per family with *_GUARD_
  // UNAVAILABLE (covered above); the all-off case uses the
  // entry-level DSH_FUSION_GUARD_UNAVAILABLE.
  const host = createHostContext();
  delete host.ctx.tools.guard;
  try {
    await assert.rejects(
      hostPlugin.apply(host.ctx, {
        dshVersion: "0.2.0-rc.2",
        modelTaskCommands: ["uname -a"],
      }),
      /DSH_FUSION_GUARD_UNAVAILABLE/,
    );
    assert.equal(host.tools.length, 0);
    assert.equal(host.guards.length, 0);
  } finally {
    await host.cleanup();
  }
});

test("enables Fusion proxies and only permits their nested AgentTeams calls", async () => {
  const host = createHostContext();
  try {
    await hostPlugin.apply(host.ctx, {
      dshVersion: "0.2.0-rc.2",
      allowAgentTeamWrites: true,
      modelTaskCommands: ["uname -a"],
    });

    const toolNames = host.tools.map((tool) => tool.name);
    assert.deepEqual(toolNames.slice(-3), [
      "fusion_team_approve",
      "fusion_team_resume",
      "fusion_team_send_message",
    ]);
    assert.equal(host.guards.length, 3);
    assert.match(host.guards[0]({
      name: "agent_teams_approve",
      callId: "direct-1",
    }), /fusion_team_approve/);
    assert.match(host.guards[0]({
      name: "agent_teams_resume",
      callId: "nested-without-fusion-1",
      parent: Symbol("parent"),
    }), /fusion_team_resume/);
    assert.equal(host.guards[0]({
      name: "agent_teams_send_message",
      callId: "call-1:fusion:fusion_team_send_message:1",
      parent: Symbol("parent"),
    }), undefined);
    assert.match(host.guards[0]({
      name: "agent_teams_send_message",
      callId: "call-1:fusion:fusion_team_send_message:1:ptc:1",
      parent: Symbol("parent"),
    }), /FUSION_AGENT_TEAM_WRITES_GUARDED/);
    assert.equal(host.guards[0]({
      name: "agent_teams_status",
      callId: "direct-status-1",
    }), undefined);
  } finally {
    await host.cleanup();
  }
});

test("fails closed before registration when AgentTeams writes lack guard support", async () => {
  const host = createHostContext();
  delete host.ctx.tools.guard;
  try {
    await assert.rejects(
      hostPlugin.apply(host.ctx, {
        dshVersion: "0.2.0-rc.2",
        allowAgentTeamWrites: true,
        modelTaskCommands: ["uname -a"],
      }),
      /FUSION_AGENT_TEAM_GUARD_UNAVAILABLE/,
    );
    assert.equal(host.tools.length, 0);
    assert.equal(host.routes.length, 0);
  } finally {
    await host.cleanup();
  }
});

test("enables AgentTeams writes through the environment only for true", async () => {
  const previous = process.env.FUSION_ALLOW_AGENT_TEAM_WRITES;
  try {
    delete process.env.FUSION_ALLOW_AGENT_TEAM_WRITES;
    const disabled = createHostContext();
    try {
      await hostPlugin.apply(disabled.ctx, {
        dshVersion: "0.2.0-rc.2",
        modelTaskCommands: ["uname -a"],
      });
      assert.equal(disabled.tools.some((tool) => tool.name === "fusion_team_approve"), false);
    } finally {
      await disabled.cleanup();
    }

    process.env.FUSION_ALLOW_AGENT_TEAM_WRITES = "1";
    const nonBoolean = createHostContext();
    try {
      await hostPlugin.apply(nonBoolean.ctx, {
        dshVersion: "0.2.0-rc.2",
        modelTaskCommands: ["uname -a"],
      });
      assert.equal(nonBoolean.tools.some((tool) => tool.name === "fusion_team_approve"), false);
    } finally {
      await nonBoolean.cleanup();
    }

    process.env.FUSION_ALLOW_AGENT_TEAM_WRITES = "true";
    const enabled = createHostContext();
    try {
      await hostPlugin.apply(enabled.ctx, {
        dshVersion: "0.2.0-rc.2",
        modelTaskCommands: ["uname -a"],
      });
      assert.equal(enabled.tools.some((tool) => tool.name === "fusion_team_approve"), true);
    } finally {
      await enabled.cleanup();
    }
  } finally {
    if (previous === undefined) {
      delete process.env.FUSION_ALLOW_AGENT_TEAM_WRITES;
    } else {
      process.env.FUSION_ALLOW_AGENT_TEAM_WRITES = previous;
    }
  }
});

test("unloads every write surface and reloads with an identical inventory", async () => {
  const options = {
    dshVersion: "0.2.0-rc.2",
    allowAgentTeamWrites: true,
    allowAgentBusWrites: true,
    allowRoomWrites: true,
    modelTaskCommands: ["uname -a"],
  };
  const first = createHostContext();
  await hostPlugin.apply(first.ctx, options);
  const firstTools = first.tools.map((tool) => tool.name).sort();
  const firstRoutes = first.routes.map((route) => route.path).sort();
  // All fifteen write proxies plus the read-only tools, three
  // guards, and the full route surface are live after apply.
  assert.equal(firstTools.filter((name) => name.startsWith("fusion_team_")).length, 3);
  assert.equal(firstTools.filter((name) => name.startsWith("fusion_bus_")).length, 6);
  assert.equal(firstTools.filter((name) => name.startsWith("fusion_room_")).length, 6);
  assert.equal(first.guards.length, 3);
  assert.ok(firstRoutes.includes("/plugins/dsh-fusion/state"));

  // Unload runs every effect disposer: nothing Fusion
  // registered may remain reachable through the host.
  await first.cleanup();
  assert.equal(first.tools.length, 0);
  assert.equal(first.guards.length, 0);
  assert.equal(first.routes.length, 0);

  // A fresh apply (the host's reload) must reproduce the exact
  // same inventory and guard behaviour — no leaked state from
  // the previous load may suppress or duplicate registrations.
  const second = createHostContext();
  try {
    await hostPlugin.apply(second.ctx, options);
    assert.deepEqual(second.tools.map((tool) => tool.name).sort(), firstTools);
    assert.deepEqual(second.routes.map((route) => route.path).sort(), firstRoutes);
    assert.equal(second.guards.length, 3);
    const busGuard = second.guards.find((guard) => guard({
      name: "send_note",
      callId: "direct-1",
    }) !== undefined);
    assert.match(busGuard({
      name: "send_note",
      callId: "direct-1",
    }), /FUSION_AGENT_BUS_WRITES_GUARDED/);
  } finally {
    await second.cleanup();
    assert.equal(second.tools.length, 0);
    assert.equal(second.guards.length, 0);
    assert.equal(second.routes.length, 0);
  }
});

test("reload on the same host after cleanup re-registers an identical inventory with no leaks", async () => {
  const host = createHostContext();
  const config = { dshVersion: "0.2.0-rc.2" };
  const inventory = () => ({
    tools: host.tools.map((tool) => tool.name).sort(),
    routes: host.routes.map((route) => route.path).sort(),
    guards: host.guards.length,
  });

  await hostPlugin.apply(host.ctx, config);
  const first = inventory();
  assert.ok(first.tools.length > 0);
  assert.ok(first.routes.length > 0);
  assert.ok(first.guards > 0);

  await host.cleanup();
  assert.deepEqual(inventory(), { tools: [], routes: [], guards: 0 });

  // A real host reload reuses the same context object: the
  // second apply must land exactly the first inventory —
  // a leaked disposer from round one would surface as a
  // missing entry, a leaked registration as a duplicate.
  await hostPlugin.apply(host.ctx, config);
  assert.deepEqual(inventory(), first);

  // And the re-applied plugin is functional, not a shell.
  const stateRoute = host.routes.find((route) => route.path === "/plugins/dsh-fusion/state");
  assert.ok(stateRoute !== undefined);
  let routeBody;
  await stateRoute.handler({}, {
    writeHead() {},
    end(body) {
      routeBody = JSON.parse(body);
    },
  });
  assert.ok(Array.isArray(routeBody.tasks));

  await host.cleanup();
  assert.deepEqual(inventory(), { tools: [], routes: [], guards: 0 });
});
