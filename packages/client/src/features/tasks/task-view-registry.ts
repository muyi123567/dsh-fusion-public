import { useSyncExternalStore, type ComponentType } from "react";
import type {
  FusionTaskViewAction,
  FusionTaskViewDefinition as CoreFusionTaskViewDefinition,
  FusionTaskViewProps,
} from "@dsh-fusion/core";

export type { FusionTaskViewAction, FusionTaskViewProps };

export type FusionTaskViewDefinition = CoreFusionTaskViewDefinition<
  ComponentType<FusionTaskViewProps>,
  ComponentType<any>
>;

const knownActions = new Set<string>(["dispatch", "cancel"]);

const builtinIds = new Set<string>();
const definitions = new Map<string, FusionTaskViewDefinition>();
const listeners = new Set<() => void>();
let cachedDefinitions: readonly FusionTaskViewDefinition[] = [];
let nextGeneration = 0;

function publish(): void {
  cachedDefinitions = [...definitions.values()].sort(compareDefinitions);
  for (const listener of listeners) listener();
}

function compareDefinitions(
  left: FusionTaskViewDefinition,
  right: FusionTaskViewDefinition,
): number {
  const priority = (right.priority ?? 0) - (left.priority ?? 0);
  return priority !== 0 ? priority : left.id.localeCompare(right.id);
}

export function registerTaskView(definition: FusionTaskViewDefinition): () => void {
  if (typeof definition?.id !== "string" || definition.id.trim() === "") {
    throw new Error("FUSION_TASK_VIEW_ID_REQUIRED");
  }
  if (builtinIds.has(definition.id)) {
    throw new Error(`FUSION_TASK_VIEW_ID_RESERVED:${definition.id}`);
  }
  if (definitions.has(definition.id)) {
    throw new Error(`FUSION_TASK_VIEW_ID_ALREADY_REGISTERED:${definition.id}`);
  }
  const actions = definition.actions === undefined
    ? undefined
    : [...new Set(definition.actions)];
  for (const action of actions ?? []) {
    if (!knownActions.has(action)) {
      throw new Error(`FUSION_TASK_VIEW_ACTION_UNKNOWN:${action}`);
    }
  }
  if (typeof definition?.label !== "string" || definition.label.trim() === "") {
    throw new Error("FUSION_TASK_VIEW_LABEL_REQUIRED");
  }
  if (typeof definition?.Component !== "function") {
    throw new Error("FUSION_TASK_VIEW_COMPONENT_REQUIRED");
  }
  const normalized: FusionTaskViewDefinition = {
    id: definition.id,
    label: definition.label,
    group: definition.group ?? "extension",
    priority: definition.priority ?? 0,
    ...(actions === undefined ? {} : { actions }),
    Component: definition.Component,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(definition.Icon === undefined ? {} : { Icon: definition.Icon }),
  };
  definitions.set(normalized.id, Object.freeze(normalized));
  publish();
  return () => {
    if (definitions.get(normalized.id) !== normalized) return;
    unregisterTaskView(normalized.id);
  };
}

export function unregisterTaskView(id: string): void {
  if (builtinIds.has(id)) throw new Error(`FUSION_TASK_VIEW_ID_RESERVED:${id}`);
  if (!definitions.delete(id)) return;
  publish();
}

export function listTaskViewDefinitions(): readonly FusionTaskViewDefinition[] {
  return cachedDefinitions;
}

export function subscribeTaskViews(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTaskViewDefinitions(): readonly FusionTaskViewDefinition[] {
  return useSyncExternalStore(subscribeTaskViews, listTaskViewDefinitions, listTaskViewDefinitions);
}

export type FusionTaskViewMethod = "register" | "unregister" | "list";

export interface FusionTaskViewApi {
  major: 1;
  minor: 1;
}

export interface FusionTaskViewGlobal {
  version: 1;
  generation: number;
  readonly ready: boolean;
  api: FusionTaskViewApi;
  has(method: string): boolean;
  register: typeof registerTaskView;
  unregister: typeof unregisterTaskView;
  list: typeof listTaskViewDefinitions;
}

declare global {
  interface Window {
    __DSH_FUSION_TASK_VIEWS__?: FusionTaskViewGlobal;
  }
}

function assertCurrentRegistry(global: FusionTaskViewGlobal): void {
  if (window.__DSH_FUSION_TASK_VIEWS__ !== global) {
    throw new Error("FUSION_TASK_VIEW_REGISTRY_STALE");
  }
}

export function activateTaskViewRegistry(): FusionTaskViewGlobal {
  const generation = ++nextGeneration;
  const global: FusionTaskViewGlobal = {
    version: 1,
    generation,
    get ready() {
      return window.__DSH_FUSION_TASK_VIEWS__ === global;
    },
    api: { major: 1, minor: 1 },
    has: (method) =>
      window.__DSH_FUSION_TASK_VIEWS__ === global
      && (method === "register" || method === "unregister" || method === "list"),
    register: (definition) => {
      assertCurrentRegistry(global);
      return registerTaskView(definition);
    },
    unregister: (id) => {
      assertCurrentRegistry(global);
      unregisterTaskView(id);
    },
    list: () => {
      assertCurrentRegistry(global);
      return listTaskViewDefinitions();
    },
  };
  window.__DSH_FUSION_TASK_VIEWS__ = global;
  window.dispatchEvent(new CustomEvent("dsh-fusion:task-views-ready", {
    detail: { generation, api: global.api },
  }));
  return global;
}

export function disposeTaskViewRegistry(global: FusionTaskViewGlobal): void {
  if (window.__DSH_FUSION_TASK_VIEWS__ === global) {
    delete window.__DSH_FUSION_TASK_VIEWS__;
  }
}

export function resetTaskViewsForTest(): void {
  definitions.clear();
  publish();
}

export function installBuiltinTaskViews(views: readonly FusionTaskViewDefinition[]): void {
  for (const view of views) {
    if (definitions.has(view.id)) continue;
    definitions.set(view.id, Object.freeze({ ...view, group: "core" }));
    builtinIds.add(view.id);
  }
  publish();
}
