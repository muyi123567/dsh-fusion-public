import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateTaskViewRegistry,
  disposeTaskViewRegistry,
  listTaskViewDefinitions,
  registerTaskView,
  subscribeTaskViews,
  unregisterTaskView,
} from "./task-view-registry.js";

const extension = {
  id: "matrix",
  label: "矩阵视图",
  Component: () => <div>matrix</div>,
};

describe("task view registry", () => {
  beforeEach(() => {
    unregisterTaskView(extension.id);
    const current = window.__DSH_FUSION_TASK_VIEWS__;
    if (current !== undefined) disposeTaskViewRegistry(current);
    activateTaskViewRegistry();
  });

  it("exposes a versioned global extension surface", () => {
    expect(window.__DSH_FUSION_TASK_VIEWS__?.version).toBe(1);
    expect(window.__DSH_FUSION_TASK_VIEWS__?.ready).toBe(true);
    expect(window.__DSH_FUSION_TASK_VIEWS__?.api).toEqual({ major: 1, minor: 1 });
    expect(window.__DSH_FUSION_TASK_VIEWS__?.has("register")).toBe(true);
    expect(window.__DSH_FUSION_TASK_VIEWS__?.has("unknown" as never)).toBe(false);
    expect(typeof window.__DSH_FUSION_TASK_VIEWS__?.register).toBe("function");
  });

  it("announces the active generation to late-loading extensions", () => {
    const listener = vi.fn();
    window.addEventListener("dsh-fusion:task-views-ready", listener);
    try {
      const active = activateTaskViewRegistry();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0]?.[0]).toMatchObject({
        detail: {
          generation: active.generation,
          api: { major: 1, minor: 1 },
        },
      });
    } finally {
      window.removeEventListener("dsh-fusion:task-views-ready", listener);
    }
  });

  it("rejects a stale generation and lets only its owner dispose the facade", () => {
    const first = activateTaskViewRegistry();
    const second = activateTaskViewRegistry();
    expect(second.generation).toBe(first.generation + 1);
    expect(first.ready).toBe(false);
    expect(second.ready).toBe(true);
    expect(() => first.register(extension))
      .toThrowError("FUSION_TASK_VIEW_REGISTRY_STALE");
    expect(() => first.list()).toThrowError("FUSION_TASK_VIEW_REGISTRY_STALE");
    const cleanup = second.register(extension);
    disposeTaskViewRegistry(first);
    expect(window.__DSH_FUSION_TASK_VIEWS__).toBe(second);
    disposeTaskViewRegistry(second);
    expect(window.__DSH_FUSION_TASK_VIEWS__).toBeUndefined();
    expect(second.ready).toBe(false);
    cleanup();
    expect(listTaskViewDefinitions().some((view) => view.id === extension.id)).toBe(false);
  });

  it("registers and unregisters extension views", () => {
    const dispose = registerTaskView(extension);
    expect(listTaskViewDefinitions().some((view) => view.id === "matrix")).toBe(true);
    dispose();
    expect(listTaskViewDefinitions().some((view) => view.id === "matrix")).toBe(false);
  });

  it("rejects a duplicate extension id instead of replacing the live view", () => {
    const dispose = registerTaskView(extension);
    expect(() => registerTaskView({ ...extension, label: "重复视图" }))
      .toThrowError("FUSION_TASK_VIEW_ID_ALREADY_REGISTERED:matrix");
    expect(listTaskViewDefinitions().find((view) => view.id === "matrix")?.label)
      .toBe("矩阵视图");
    dispose();
    expect(listTaskViewDefinitions().some((view) => view.id === "matrix")).toBe(false);
  });

  it("keeps a replacement view when an already called cleanup runs again", () => {
    const cleanupA = registerTaskView(extension);
    cleanupA();
    const cleanupB = registerTaskView({ ...extension, label: "替代视图" });
    const snapshot = listTaskViewDefinitions();
    const listener = vi.fn();
    const unsubscribe = subscribeTaskViews(listener);
    try {
      cleanupA();
      cleanupA();
      expect(listTaskViewDefinitions().find((view) => view.id === "matrix")?.label).toBe("替代视图");
      expect(listTaskViewDefinitions()).toBe(snapshot);
      expect(listener).not.toHaveBeenCalled();
      cleanupB();
      expect(listTaskViewDefinitions().some((view) => view.id === "matrix")).toBe(false);
      const removedSnapshot = listTaskViewDefinitions();
      listener.mockClear();
      cleanupB();
      expect(listTaskViewDefinitions()).toBe(removedSnapshot);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      cleanupB();
    }
  });

  it("keeps a replacement view when cleanup runs after explicit unregister", () => {
    const cleanupA = registerTaskView(extension);
    unregisterTaskView(extension.id);
    const cleanupB = registerTaskView({ ...extension, label: "替代视图" });
    const snapshot = listTaskViewDefinitions();
    const listener = vi.fn();
    const unsubscribe = subscribeTaskViews(listener);
    try {
      cleanupA();
      cleanupA();
      expect(listTaskViewDefinitions().find((view) => view.id === "matrix")?.label).toBe("替代视图");
      expect(listTaskViewDefinitions()).toBe(snapshot);
      expect(listener).not.toHaveBeenCalled();
      cleanupB();
      expect(listTaskViewDefinitions().some((view) => view.id === "matrix")).toBe(false);
    } finally {
      unsubscribe();
      cleanupB();
    }
  });

  it("rejects malformed extensions", () => {
    expect(() => registerTaskView({ ...extension, id: "" })).toThrowError("FUSION_TASK_VIEW_ID_REQUIRED");
    expect(() => registerTaskView({ ...extension, Component: undefined as never })).toThrowError("FUSION_TASK_VIEW_COMPONENT_REQUIRED");
  });

  it("normalizes declared action capabilities", () => {
    const dispose = registerTaskView({
      ...extension,
      actions: ["cancel", "dispatch", "cancel"],
    });
    expect(listTaskViewDefinitions().find((view) => view.id === "matrix")?.actions)
      .toEqual(["cancel", "dispatch"]);
    dispose();
  });

  it("rejects unknown action capabilities", () => {
    expect(() => registerTaskView({
      ...extension,
      actions: ["remote-shell"] as never,
    })).toThrowError("FUSION_TASK_VIEW_ACTION_UNKNOWN:remote-shell");
  });
});
