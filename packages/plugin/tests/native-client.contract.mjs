import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const clientRequire = createRequire(new URL("../../client/package.json", import.meta.url));
const React = clientRequire("react");
const { JSDOM } = clientRequire("jsdom");
const { createRoot } = clientRequire("react-dom/client");
const dist = new URL("../dist/", import.meta.url);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function boot({ current = "fixture-session", missingNative = [] } = {}) {
  const dom = new JSDOM("<html><head></head><body><div id='root'></div></body></html>", { url: "https://dsh.invalid/" });
  const previous = {};
  for (const name of ["window", "document", "navigator", "HTMLElement", "CustomEvent", "IS_REACT_ACT_ENVIRONMENT"]) {
    previous[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name] });
  }
  let registration;
  dom.window.__ModuleLoader__ = { load: (value) => { registration = value; } };
  const source = readFileSync(new URL("client.js", dist), "utf8");
  runInNewContext(source, { window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, console });
  assert.equal(registration.id, "dsh-fusion");
  const arrivals = [];
  const require = (id) => clientRequire(id);
  require.async = (id) => {
    const arrival = deferred();
    arrivals.push({ id, ...arrival });
    return arrival.promise;
  };
  const plugin = registration.factory(require);
  const components = new Map();
  const disposers = [];
  let injected = 0, released = 0;
  let visible = false;
  const opened = [];
  let definition;
  const once = (callback) => {
    let active = true;
    return () => { if (active) { active = false; callback?.(); } };
  };
  const disposeAll = (effects) => { while (effects.length) effects.pop()(); };
  const services = new Map();
  const scopes = new Set();
  const slots = {
    inject(_slot, callback) {
      injected++;
      const dispose = callback();
      assert.equal(typeof dispose, "function", "rc3 slot injection owns the returned registration disposer");
      return once(() => { released++; dispose(); });
    },
    register(options, component) {
      const key = options.key ?? options.id;
      components.set(key, component);
      return once(() => { if (components.get(key) === component) components.delete(key); });
    },
  };
  const tabs = { register(value) {
    assert.equal(definition, undefined, "a native type must be released before registering its replacement");
    definition = value;
    return once(() => { if (definition === value) definition = undefined; });
  } };
  const right = {
    commandTarget: () => current ? { sessionId: current, paneId: "fixture-pane", host: "dock", tabId: undefined, occurrence: undefined, navigationRevision: undefined } : undefined,
    openTab(kind) { opened.push(kind); },
  };
  services.set("slots", slots);
  services.set("sessions", { list: { getSnapshot: () => ({ ids: ["catalog-session"], byId: {}, phase: "ready", projectionsBySession: {} }), subscribe: () => () => {} } });
  for (const [name, value] of [["sidebarRight", right], ["sidebarRightTabs", tabs]]) {
    if (!missingNative.includes(name)) services.set(name, value);
  }
  const contextFor = (effects) => ({
    get: (name) => services.get(name),
    effect(callback) {
      const dispose = once(callback());
      effects.push(dispose);
      return dispose;
    },
    inject(dependencies, callback) {
      const owned = [];
      let active = false;
      const sync = () => {
        const available = dependencies.every(name => services.has(name));
        if (active === available) return;
        active = available;
        if (active) callback(contextFor(owned));
        else disposeAll(owned);
      };
      scopes.add(sync);
      sync();
      const dispose = once(() => { scopes.delete(sync); disposeAll(owned); });
      effects.push(dispose);
      return { dispose };
    },
  });
  // Cordis does not run apply until every exported mandatory dependency exists.
  if (plugin.inject.every(name => services.has(name))) plugin.apply(contextFor(disposers));
  const root = createRoot(dom.window.document.getElementById("root"));
  let sessionId = "fixture-session";
  const draw = () => root.render(React.createElement(components.get("dsh-fusion"), { sessionId, useTabInfo: () => ({ sidebar: { expanded: true, fullscreen: false }, panel: { id: "fixture-pane", isFloating: false }, tab: { id: "fixture-tab", kind: "dsh-fusion.panel", visible } }) }));
  const fakeWorkspace = { FusionWorkspace: () => React.createElement("main", null, "loaded workspace") };
  return {
    dom, plugin, arrivals, components, fakeWorkspace, opened, get definition() { return definition; },
    async launcher() { await React.act(async () => root.render(React.createElement(components.get("dsh-fusion.launcher")))); },
    async mount() { await React.act(async () => { draw(); }); },
    async toggle() { await React.act(async () => { visible = !visible; draw(); }); },
    async workspaces(module, ids) { await React.act(async () => root.render(React.createElement(React.Fragment, null, ...ids.map(id => React.createElement(module.FusionWorkspace, { key: id, sessionId: id, visible: true }))))); },
    async session(value) { await React.act(async () => { sessionId = value; draw(); }); },
    async nativeServices(available) { await React.act(async () => {
      for (const [name, value] of [["sidebarRight", right], ["sidebarRightTabs", tabs]]) {
        if (available) services.set(name, value); else services.delete(name);
      }
      for (const sync of scopes) sync();
    }); },
    actualWorkspace(fetcher = async () => ({ ok: false, status: 503 })) {
      let chunk;
      const source = readFileSync(new URL("client.workspace.js", dist), "utf8");
      const original = dom.window.__ModuleLoader__;
      dom.window.__ModuleLoader__ = { load: (value) => { chunk = value; } };
      try {
        runInNewContext(source, {
          window: dom.window, self: dom.window, document: dom.window.document,
          HTMLElement: dom.window.HTMLElement, navigator: dom.window.navigator, localStorage: dom.window.localStorage,
          AbortController, DOMException, URL, TextDecoder, TextEncoder, CustomEvent: dom.window.CustomEvent, console,
          setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
          fetch: fetcher,
        });
        return chunk.factory(require);
      } finally { dom.window.__ModuleLoader__ = original; }
    },
    async unload() { await React.act(async () => { disposeAll(disposers); root.unmount(); }); assert.equal(released, injected); },
    async cleanup() {
      await React.act(async () => { disposeAll(disposers); root.unmount(); });
      dom.window.close();
      for (const [name, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

test("production launcher registers without loading or embedding the heavy workspace", async () => {
  const source = readFileSync(new URL("client.js", dist), "utf8");
  assert.match(source, /\b\w+\.async\(["']\.\/client\.workspace\.js["']\)/);
  assert.doesNotMatch(source, /xterm|fleet-radar|fusion-app|dsh-fusion-styles/);
  const h = boot();
  try {
    assert.equal(h.components.size, 2);
    await h.mount();
    assert.equal(h.arrivals.length, 0);
    assert.equal(h.dom.window.document.querySelector("style"), null);
  } finally { await h.cleanup(); }
});

test("first open uses native arrival, concurrent opens dedupe, close and reopen reuse the module", async () => {
  const h = boot();
  try {
    await h.mount();
    await h.toggle();
    assert.equal(h.arrivals.length, 1);
    assert.equal(h.arrivals[0].id, "./client.workspace.js");
    await h.toggle();
    await h.toggle();
    assert.equal(h.arrivals.length, 1);
    await React.act(async () => h.arrivals[0].resolve(h.fakeWorkspace));
    assert.match(h.dom.window.document.body.textContent, /loaded workspace/);
    await h.toggle();
    assert.doesNotMatch(h.dom.window.document.body.textContent, /loaded workspace/);
    await h.toggle();
    assert.equal(h.arrivals.length, 1);
  } finally { await h.cleanup(); }
});

test("failed native load shows an error and retries on demand", async () => {
  const h = boot();
  try {
    await h.mount();
    await h.toggle();
    await React.act(async () => h.arrivals[0].reject(new Error("chunk unavailable")));
    assert.match(h.dom.window.document.querySelector('[role="alert"]').textContent, /chunk unavailable/);
    const retry = [...h.dom.window.document.querySelectorAll("button")].find((button) => /重试/.test(button.textContent));
    await React.act(async () => retry.click());
    assert.equal(h.arrivals.length, 2);
    await React.act(async () => h.arrivals[1].resolve(h.fakeWorkspace));
    assert.match(h.dom.window.document.body.textContent, /loaded workspace/);
  } finally { await h.cleanup(); }
});

test("closing before arrival prevents a stale workspace from mounting", async () => {
  const h = boot();
  try {
    await h.mount();
    await h.toggle();
    await h.toggle();
    await React.act(async () => h.arrivals[0].resolve(h.fakeWorkspace));
    assert.doesNotMatch(h.dom.window.document.body.textContent, /loaded workspace/);
    await h.toggle();
    assert.match(h.dom.window.document.body.textContent, /loaded workspace/);
    assert.equal(h.arrivals.length, 1);
  } finally { await h.cleanup(); }
});

test("unload while native load is pending releases slots and ignores late completion", async () => {
  const h = boot();
  try {
    await h.mount();
    await h.toggle();
    await h.unload();
    await React.act(async () => h.arrivals[0].resolve(h.fakeWorkspace));
    assert.equal(h.dom.window.document.body.textContent, "");
    assert.equal(h.dom.window.document.querySelector("style"), null);
  } finally { await h.cleanup(); }
});

test("production workspace has a native chunk registration, host-shared React and no unresolved imports", () => {
  const source = readFileSync(new URL("client.workspace.js", dist), "utf8");
  let registration;
  runInNewContext(source, { window: { __ModuleLoader__: { load: (value) => { registration = value; } } } });
  assert.equal(registration.id, "dsh-fusion");
  assert.equal(registration.chunk, "client.workspace.js");
  assert.equal(typeof registration.factory, "function");
  assert.match(source, /\b\w+\(["']react["']\)/);
  assert.doesNotMatch(source, /(?<![.\w])\w+\(["']\.\//);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /createRoot/);
  assert.match(source, /\/plugins\/dsh-fusion\/state/);

  assert.doesNotMatch(source, /xterm\.js|document\.createElement\(["']canvas["']\)/);
  assert.doesNotMatch(source, /WebGLRenderer|fusion-task-workspace|鹊桥画布|卫星视图|放射树/);

  assert.equal(readdirSync(dist).some((name) => name.endsWith(".css")), false);
  assert.ok(!readdirSync(dist).some((name) => name.endsWith(".cjs")));
});

test("terminal is an independently registered native chunk with no ESM split artifacts", () => {
  const source = readFileSync(new URL("client.terminal.js", dist), "utf8");
  let registration;
  runInNewContext(source, { window: { __ModuleLoader__: { load: (value) => { registration = value; } } } });
  assert.equal(registration.id, "dsh-fusion");
  assert.equal(registration.chunk, "client.terminal.js");
  assert.equal(typeof registration.factory, "function");
  assert.match(source, /\b\w+\(["']react["']\)/);
  assert.doesNotMatch(source, /(?<![.\w])\w+\(["']\.\//);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.match(source, /xterm/);
});


test("native tab registry and runtime props follow the host contract", async () => {
  const h = boot();
  try {
    assert.equal(h.definition.id, "dsh-fusion");
    assert.equal(h.definition.kind, "dsh-fusion.panel");
    assert.equal(h.components.has("dsh-fusion.overlay"), false);
    await h.mount();
    await h.toggle();
    await React.act(async () => h.arrivals[0].resolve({ FusionWorkspace: props => {
      assert.equal(props.sessionId, "fixture-session");
      assert.equal(props.visible, true);
      return React.createElement("main", null, "native fixture");
    } }));
    assert.match(h.dom.window.document.body.textContent, /native fixture/);
    await h.toggle();
    assert.equal(h.dom.window.document.body.textContent, "");
  } finally { await h.cleanup(); }
});

test("launcher names the native tab and refuses to create a missing session", async () => {
  const h = boot({ current: null });
  try {
    await h.launcher();
    const button = h.dom.window.document.querySelector("button");
    assert.equal(button.getAttribute("aria-label"), "打开鲸面板");
    assert.equal(button.textContent, "鲸");
    await React.act(async () => button.click());
    assert.match(h.dom.window.document.querySelector('[role="status"]').textContent, /请先选择/);
    assert.deepEqual(h.opened, []);
    assert.equal(h.arrivals.length, 0);
    assert.equal(h.dom.window.document.querySelector('[role="dialog"]'), null);
  } finally { await h.cleanup(); }
});
test("launcher uses the on-screen native target even though catalog has no current or getState", async () => {
  const h = boot();
  try {
    await h.launcher();
    await React.act(async () => h.dom.window.document.querySelector("button").click());
    assert.deepEqual(h.opened, ["dsh-fusion.panel"]);
  } finally { await h.cleanup(); }
});

for (const missing of ["sidebarRight", "sidebarRightTabs"]) {
  test(`missing ${missing} keeps an explicit native-unavailable launcher without an overlay`, async () => {
    const h = boot({ missingNative: [missing] });
    try {
      assert.deepEqual(Array.from(h.plugin.inject), ["slots"]);
      assert.equal(h.components.has("dsh-fusion"), false);
      await h.launcher();
      await React.act(async () => h.dom.window.document.querySelector("button").click());
      assert.match(h.dom.window.document.querySelector('[role="status"]').textContent, /不支持原生右侧面板/);
      assert.deepEqual(h.opened, []);
      assert.equal(h.arrivals.length, 0);
      assert.equal(h.dom.window.document.querySelector('[role="dialog"]'), null);
    } finally { await h.cleanup(); }
  });
}

test("native service loss releases the body and registry and restoration owns a new loader", async () => {
  const h = boot();
  try {
    await h.mount();
    await h.toggle();
    assert.equal(h.arrivals.length, 1);
    await h.launcher();
    await h.nativeServices(false);
    assert.equal(h.components.has("dsh-fusion"), false);
    assert.equal(h.definition, undefined);
    await React.act(async () => h.dom.window.document.querySelector("button").click());
    assert.match(h.dom.window.document.querySelector('[role="status"]').textContent, /不支持原生右侧面板/);
    await React.act(async () => h.arrivals[0].resolve(h.fakeWorkspace));
    assert.doesNotMatch(h.dom.window.document.body.textContent, /loaded workspace/);
    await h.nativeServices(true);
    assert.equal(h.definition.keepMounted, false);
    assert.equal(h.components.has("dsh-fusion"), true);
    await h.mount();
    assert.equal(h.arrivals.length, 2);
    await React.act(async () => h.arrivals[1].resolve(h.fakeWorkspace));
    assert.match(h.dom.window.document.body.textContent, /loaded workspace/);
    await h.unload();
    assert.equal(h.components.size, 0);
    assert.equal(h.definition, undefined);
  } finally { await h.cleanup(); }
});

test("session changes abort the packaged workspace read and reject a late old snapshot", async () => {
  const h = boot();
  const requests = [];
  const snapshot = (goal) => ({ nodes: [], agentTeams: [], tasks: [{
    id: goal, goal, targetNodeIds: [], transport: "ssh", status: "queued",
    evidence: [], createdAt: "", updatedAt: "",
  }] });
  const response = (goal) => ({ ok: true, status: 200, json: async () => snapshot(goal) });
  try {
    const workspace = h.actualWorkspace((_url, options) => {
      const request = { ...deferred(), signal: options.signal };
      requests.push(request);
      return request.promise;
    });
    await h.mount();
    await h.toggle();
    await React.act(async () => h.arrivals[0].resolve(workspace));
    assert.equal(requests.length, 1);
    await h.session("next-session");
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests.length, 2);
    await React.act(async () => requests[1].resolve(response("new-session-task")));
    assert.match(h.dom.window.document.body.textContent, /new-session-task/);
    await React.act(async () => requests[0].resolve(response("old-session-task")));
    assert.doesNotMatch(h.dom.window.document.body.textContent, /old-session-task/);
    await h.toggle();
    assert.equal(requests[1].signal.aborted, true);
    assert.equal(h.dom.window.document.body.textContent, "");
  } finally { await h.cleanup(); }
});

const nativeTaskSnapshot = () => ({
  nodes: [{ id: "fixture-node", externalId: "fixture-node", providerId: "fixture", name: "Fixture node",
    platform: "linux", roles: ["worker"], status: "online", transports: ["ssh"], capabilities: [], configState: "current" }],
  tasks: ["running", "failed"].map(status => ({ id: status + "-task", goal: status + " collection task",
    targetNodeIds: ["fixture-node"], transport: "ssh", status, evidence: [], createdAt: "", updatedAt: "" })),
  agentTeams: [], sources: { nodes: "live", tasks: "live", agentTeams: "live" },
});
const selectNative = async (h, label, value) => {
  const select = h.dom.window.document.querySelector(`select[aria-label="${label}"]`);
  assert.ok(select, label);
  await React.act(async () => {
    select.value = value;
    select.dispatchEvent(new h.dom.window.Event("change", { bubbles: true }));
  });
};

test("native workspace peers share a generation and only the final close retires their registrations", async () => {
  const h = boot();
  const events = [];
  try {
    h.dom.window.addEventListener("dsh-fusion:task-views-ready", event => events.push(event.detail.generation));
    const workspace = h.actualWorkspace(async () => ({ ok: true, json: async () => nativeTaskSnapshot() }));
    await h.workspaces(workspace, ["left-session", "right-session"]);
    const first = h.dom.window.__DSH_FUSION_TASK_VIEWS__;
    assert.equal(first.ready, true);
    assert.equal(first.api.major, 1);
    assert.equal(first.has("register"), true);
    assert.equal(first.list().length, 0, "native entry must not install the old visualizations");
    let oldCleanup;
    await React.act(async () => { oldCleanup = first.register({ id: "fixture-view", label: "Old", Component: () => null }); });
    await h.workspaces(workspace, ["right-session"]);
    assert.equal(h.dom.window.__DSH_FUSION_TASK_VIEWS__, first);
    assert.equal(first.ready, true);
    assert.equal(events.length, 1);
    await h.workspaces(workspace, []);
    assert.equal(h.dom.window.__DSH_FUSION_TASK_VIEWS__, undefined);
    assert.equal(first.ready, false);
    assert.throws(() => first.list(), /FUSION_TASK_VIEW_REGISTRY_STALE/);
    await h.workspaces(workspace, ["next-session"]);
    const second = h.dom.window.__DSH_FUSION_TASK_VIEWS__;
    assert.ok(second.generation > first.generation);
    assert.equal(second.list().length, 0);
    let cleanup;
    await React.act(async () => { cleanup = second.register({ id: "fixture-view", label: "New", Component: () => null }); });
    oldCleanup();
    assert.equal(second.list()[0].label, "New");
    await React.act(async () => cleanup());
  } finally { await h.cleanup(); }
});

test("native task views receive the filtered collection and select the existing detail without write authority", async () => {
  const h = boot();
  let received;
  let stale = false;
  try {
    const workspace = h.actualWorkspace(async () => stale ? { ok: false, status: 503 }
      : { ok: true, json: async () => nativeTaskSnapshot() });
    await h.workspaces(workspace, ["collection-session"]);
    const facade = h.dom.window.__DSH_FUSION_TASK_VIEWS__;
    let cleanup;
    await React.act(async () => { cleanup = facade.register({
      id: "fixture-view", label: "Fixture collection", actions: ["dispatch", "cancel"],
      Component: props => {
        received = props;
        return React.createElement("button", { "aria-label": "Inspect extension task", onClick: () => props.onSelectTask(props.tasks[0].id) }, "extension collection");
      },
    }); });
    assert.equal(received, undefined, "registered extensions remain opt-in");
    await selectNative(h, "状态筛选", "running");
    await selectNative(h, "任务视图", "fixture-view");
    assert.deepEqual(Array.from(received.tasks, task => task.id), ["running-task"]);
    assert.deepEqual(Array.from(received.topology.taskIds), ["running-task"]);
    assert.deepEqual(Array.from(received.nodes, node => node.id), ["fixture-node"]);
    assert.equal(received.connectionStale, false);
    assert.equal(received.onDispatchTask, undefined);
    assert.equal(received.onCancelTask, undefined);
    await React.act(async () => h.dom.window.document.querySelector('[aria-label="Inspect extension task"]').click());
    assert.ok(h.dom.window.document.querySelector('[aria-label="任务详情"]'));
    assert.equal(facade.ready, true);
    const back = [...h.dom.window.document.querySelectorAll("button")].find(button => button.textContent === "返回任务列表");
    assert.ok(back);
    await React.act(async () => back.click());
    assert.equal(h.dom.window.document.querySelector('select[aria-label="任务视图"]').value, "fixture-view");
    stale = true;
    const refresh = [...h.dom.window.document.querySelectorAll("button")].find(button => button.textContent === "刷新");
    await React.act(async () => refresh.click());
    assert.equal(received.connectionStale, true);
    assert.equal(received.onCancelTask, undefined);
    await React.act(async () => cleanup());
    assert.equal(h.dom.window.document.querySelector('[aria-label="Inspect extension task"]'), null);
    assert.match(h.dom.window.document.body.textContent, /running collection task/);
  } finally { await h.cleanup(); }
});

test("native extension render failures stay local and return to the native list", async () => {
  const h = boot();
  try {
    const workspace = h.actualWorkspace(async () => ({ ok: true, json: async () => nativeTaskSnapshot() }));
    await h.workspaces(workspace, ["failure-session"]);
    await React.act(async () => { h.dom.window.__DSH_FUSION_TASK_VIEWS__.register({
      id: "broken-view", label: "Broken", Component: () => { throw new Error("fixture view failure"); },
    }); });
    await selectNative(h, "任务视图", "broken-view");
    assert.match(h.dom.window.document.querySelector('[role="alert"]').textContent, /扩展视图不可用/);
    assert.ok(h.dom.window.document.querySelector('[aria-label="状态筛选"]'));
    const reset = [...h.dom.window.document.querySelectorAll("button")].find(button => button.textContent === "返回任务列表");
    await React.act(async () => reset.click());
    assert.equal(h.dom.window.document.querySelector('[role="alert"]'), null);
    assert.match(h.dom.window.document.body.textContent, /running collection task/);
  } finally { await h.cleanup(); }
});
