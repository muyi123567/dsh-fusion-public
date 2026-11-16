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

function boot() {
  const dom = new JSDOM("<html><head></head><body><div id='root'></div></body></html>", { url: "https://dsh.invalid/" });
  const previous = {};
  for (const name of ["window", "document", "navigator", "HTMLElement", "CustomEvent", "IS_REACT_ACT_ENVIRONMENT"]) {
    previous[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name] });
  }
  let registration;
  dom.window.__ModuleLoader__ = { load: (value) => { registration = value; } };
  const source = readFileSync(new URL("client.js", dist), "utf8");
  runInNewContext(source, { window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, console });
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
  plugin.apply({
    get: (name) => name === "slots" ? {
      inject(_slot, callback) { injected++; callback(); return () => { released++; }; },
      register(options, component) { components.set(options.id, component); },
    } : undefined,
    effect(callback) { const dispose = callback(); if (typeof dispose === "function") disposers.push(dispose); },
  });
  const root = createRoot(dom.window.document.getElementById("root"));
  const Overlay = components.get("dsh-fusion.overlay");
  const fakeWorkspace = { FusionWorkspace: () => React.createElement("main", null, "loaded workspace") };
  return {
    dom, plugin, arrivals, components, fakeWorkspace,
    async mount() { await React.act(async () => { root.render(React.createElement(Overlay)); }); },
    async toggle() { await React.act(async () => { dom.window.dispatchEvent(new dom.window.CustomEvent("dsh-fusion:toggle")); }); },
    actualWorkspace() {
      let chunk;
      const source = readFileSync(new URL("client.workspace.js", dist), "utf8");
      const original = dom.window.__ModuleLoader__;
      dom.window.__ModuleLoader__ = { load: (value) => { chunk = value; } };
      try {
        runInNewContext(source, {
          window: dom.window, self: dom.window, document: dom.window.document,
          navigator: dom.window.navigator, localStorage: dom.window.localStorage,
          AbortController, DOMException, URL, TextDecoder, TextEncoder, console,
          setTimeout, clearTimeout, queueMicrotask,
          fetch: async () => ({ ok: false, status: 503 }),
        });
        return chunk.factory(require);
      } finally { dom.window.__ModuleLoader__ = original; }
    },
    async unload() { await React.act(async () => { for (const dispose of disposers.reverse()) dispose(); root.unmount(); }); assert.equal(released, injected); },
    async cleanup() {
      await React.act(async () => root.unmount());
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

test("actual production workspace installs styles only while mounted and removes them on close/unload", async () => {
  const h = boot();
  try {
    await h.mount();
    await h.toggle();
    const module = h.actualWorkspace();
    assert.equal(h.dom.window.document.querySelector("style"), null);
    await React.act(async () => h.arrivals[0].resolve(module));
    assert.match(h.dom.window.document.body.textContent, /DSH FUSION/);
    assert.equal(h.dom.window.document.querySelectorAll('style[data-plugin="dsh-fusion"]').length, 1);
    await h.toggle();
    assert.equal(h.dom.window.document.querySelector("style"), null);
    await h.toggle();
    assert.equal(h.dom.window.document.querySelectorAll('style[data-plugin="dsh-fusion"]').length, 1);
    await h.unload();
    assert.equal(h.dom.window.document.querySelector("style"), null);
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
  assert.match(source, /\b\w+\.async\(["']\.\/client\.terminal\.js["']\)/);
  assert.doesNotMatch(source, /xterm\.js|document\.createElement\(["']canvas["']\)/);
  assert.match(source, /\.fusion-topbar/);
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
