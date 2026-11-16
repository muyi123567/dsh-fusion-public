import { describe, expect, it, vi } from "vitest";
import { createWorkspaceLoader, type WorkspaceImport } from "./client.workspace-loader.js";

const workspace: WorkspaceImport = { FusionWorkspace: () => null };

describe("native workspace lifecycle", () => {
  it("does not begin queued arrival after disposal", async () => {
    const load = vi.fn(async () => workspace);
    const loader = createWorkspaceLoader(load);
    const pending = loader.load();
    loader.dispose();
    await expect(pending).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });
  it("defers load and shares pending and successful arrival", async () => {
    const load = vi.fn(async () => workspace);
    const loader = createWorkspaceLoader(load);
    expect(load).not.toHaveBeenCalled();
    const first = loader.load();
    expect(loader.load()).toBe(first);
    await expect(first).resolves.toBe(workspace);
    await expect(loader.load()).resolves.toBe(workspace);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retries rejected or invalid arrivals without retaining a failed promise", async () => {
    const load = vi.fn<() => Promise<WorkspaceImport>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({} as WorkspaceImport)
      .mockResolvedValue(workspace);
    const loader = createWorkspaceLoader(load);
    await expect(loader.load()).rejects.toThrow("offline");
    await expect(loader.load()).rejects.toThrow("DSH_FUSION_WORKSPACE_INVALID");
    await expect(loader.load()).resolves.toBe(workspace);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("ignores completion after disposal and never starts another arrival", async () => {
    let complete!: (value: WorkspaceImport) => void;
    const load = vi.fn(() => new Promise<WorkspaceImport>((resolve) => { complete = resolve; }));
    const loader = createWorkspaceLoader(load);
    const pending = loader.load();
    await Promise.resolve();
    loader.dispose();
    complete(workspace);
    await expect(pending).resolves.toBeUndefined();
    await expect(loader.load()).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
