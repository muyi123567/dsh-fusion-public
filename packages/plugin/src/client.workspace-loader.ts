import type { ComponentType } from "react";
import type { FusionWorkspaceProps } from "./client.js";

export interface WorkspaceImport {
  FusionWorkspace: ComponentType<FusionWorkspaceProps>;
}

/** Per-plugin-generation cache. Failed arrival never poisons the next open. */
export function createWorkspaceLoader(importWorkspace: () => Promise<WorkspaceImport>) {
  let disposed = false;
  let pending: Promise<WorkspaceImport | undefined> | undefined;
  return {
    load(): Promise<WorkspaceImport | undefined> {
      if (disposed) return Promise.resolve(undefined);
      pending ??= Promise.resolve().then(() => disposed ? undefined : importWorkspace()).then((module) => {
        if (disposed || module === undefined) return undefined;
        if (typeof module.FusionWorkspace !== "function") throw new Error("DSH_FUSION_WORKSPACE_INVALID");
        return module;
      }).catch((error: unknown) => {
        pending = undefined;
        if (disposed) return undefined;
        throw error;
      });
      return pending;
    },
    dispose() { disposed = true; pending = undefined; },
  };
}
