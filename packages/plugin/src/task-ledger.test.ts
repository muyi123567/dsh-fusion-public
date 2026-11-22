import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetRouter } from "./fleet-router.js";
import {
  inspectTaskLedger,
  loadTaskLedger,
  saveTaskLedger,
  writeTaskLedger,
} from "./task-ledger.js";
import type { RuntimeTaskRecord } from "./plugin-runtime.js";

const temporaryDirectories: string[] = [];

async function temporaryLedgerPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-fusion-ledger-"));
  temporaryDirectories.push(directory);
  return join(directory, "ledger.json");
}

function task(
  id: string,
  updatedAt: string,
  status: RuntimeTaskRecord["status"] = "completed",
): RuntimeTaskRecord {
  return {
    id,
    goal: `goal ${id}`,
    targetNodeIds: ["node-a"],
    transport: "ssh",
    status,
    evidence: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("task ledger", () => {
  it("round-trips a task through disk", async () => {
    const path = await temporaryLedgerPath();
    await writeTaskLedger(path, [task("A", "2026-10-21T00:00:00.000Z")]);

    const loaded = await loadTaskLedger(path);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("A");
    expect(loaded[0]?.status).toBe("completed");
  });

  it("round-trips dispatch idempotency metadata", async () => {
    const path = await temporaryLedgerPath();
    const persisted = {
      ...task("A", "2026-10-21T00:00:00.000Z"),
      idempotencyKey: "retry-key",
      dispatchFingerprint: "fingerprint",
    };

    await writeTaskLedger(path, [persisted]);

    await expect(loadTaskLedger(path)).resolves.toEqual([persisted]);
  });

  it("keeps the newest 200 terminal tasks across mixed terminal statuses", async () => {
    const path = await temporaryLedgerPath();
    const statuses = ["completed", "failed", "cancelled"] as const;
    const tasks = Array.from({ length: 205 }, (_, index) =>
      task(`task-${index}`, new Date(1_792_540_800_000 + index).toISOString(), statuses[index % 3]));

    await writeTaskLedger(path, tasks);

    const raw = JSON.parse(await readFile(path, "utf8")) as { tasks: RuntimeTaskRecord[] };
    expect(raw.tasks).toHaveLength(200);
    expect(raw.tasks[0]?.id).toBe("task-204");
    expect(raw.tasks[199]?.id).toBe("task-5");
    expect(raw.tasks.some((record) => record.id === "task-4")).toBe(false);
  });

  it.each(["queued", "claimed", "running", "verifying"] as const)(
    "keeps an old %s task alongside the terminal history allowance",
    async (status) => {
      const path = await temporaryLedgerPath();
      const active = task("active", "2026-10-20T00:00:00.000Z", status);
      const terminal = Array.from({ length: 200 }, (_, index) =>
        task(`terminal-${index}`, "2026-10-21T00:00:00.000Z", "failed"));

      await writeTaskLedger(path, [active, ...terminal]);

      const loaded = await loadTaskLedger(path);
      expect(loaded).toHaveLength(201);
      expect(loaded).toContainEqual(active);
    },
  );

  it("keeps every active task when active tasks alone exceed the history limit", async () => {
    const path = await temporaryLedgerPath();
    const statuses = ["queued", "claimed", "running", "verifying"] as const;
    const tasks = Array.from({ length: 205 }, (_, index) =>
      task(`active-${index}`, new Date(1_792_540_800_000 + index).toISOString(), statuses[index % 4]));

    await writeTaskLedger(path, tasks);

    const loaded = await loadTaskLedger(path);
    expect(loaded).toHaveLength(205);
    expect(new Set(loaded.map((record) => record.id))).toEqual(new Set(tasks.map((record) => record.id)));
  });

  it("orders active and terminal tasks together by their latest update", async () => {
    const path = await temporaryLedgerPath();
    await writeTaskLedger(path, [
      task("old-active", "2026-10-20T00:00:00.000Z", "running"),
      task("middle-terminal", "2026-10-21T00:00:00.000Z", "failed"),
      task("new-active", "2026-10-22T00:00:00.000Z", "queued"),
    ]);

    expect((await loadTaskLedger(path)).map((record) => record.id))
      .toEqual(["new-active", "middle-terminal", "old-active"]);
  });

  it("preserves host concurrency admission after restoring a crowded ledger", async () => {
    const path = await temporaryLedgerPath();
    const active = task("active", "2026-10-20T00:00:00.000Z", "running");
    const terminal = Array.from({ length: 200 }, (_, index) =>
      task(`terminal-${index}`, "2026-10-21T00:00:00.000Z", index % 2 === 0 ? "failed" : "cancelled"));
    await writeTaskLedger(path, [active, ...terminal]);
    const dispatch = vi.fn(async () => task("unexpected", "2026-10-22T00:00:00.000Z", "running"));
    const router = new FleetRouter([{
      nodeIds: ["node-a"],
      provider: {
        id: "provider-a",
        async health() { return { state: "connected", checkedAt: 1 }; },
        async listNodes() { return []; },
        dispatch,
        async doctor() { throw new Error("unexpected doctor"); },
      },
    }], {
      initialTasks: await loadTaskLedger(path),
      hostAccess: { "node-a": { sharingMode: "shared", maxConcurrentTasks: 1 } },
    });

    await expect(router.dispatch({ goal: "next", nodeIds: ["node-a"] }))
      .rejects.toThrow("FLEET_NODE_CONCURRENCY_LIMIT:node-a:1");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reports a readable ledger with a task count", async () => {
    const path = await temporaryLedgerPath();
    await writeTaskLedger(path, [task("A", "2026-10-21T00:00:00.000Z")]);

    await expect(inspectTaskLedger(path)).resolves.toMatchObject({
      readable: true,
      taskCount: 1,
    });
  });

  it("treats a missing ledger as empty rather than failing", async () => {
    const path = await temporaryLedgerPath();

    await expect(loadTaskLedger(path)).resolves.toEqual([]);
    await expect(inspectTaskLedger(path)).resolves.toEqual({
      readable: true,
      taskCount: 0,
    });
  });

  it("does not let a failed write reject as an unhandled promise", async () => {
    const path = await temporaryLedgerPath();
    // A directory cannot be replaced by a file, so the write must fail.
    await mkdir(path);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(saveTaskLedger(path, [task("A", "2026-10-21T00:00:00.000Z")])).rejects.toBeDefined();
      // Give the microtask queue a chance to surface a missed rejection.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it("keeps the write queue usable after a failed write", async () => {
    const path = await temporaryLedgerPath();
    await mkdir(path);
    const failing = saveTaskLedger(path, [task("A", "2026-10-21T00:00:00.000Z")]);
    await expect(failing).rejects.toBeDefined();

    const recovered = await temporaryLedgerPath();
    await expect(saveTaskLedger(recovered, [task("B", "2026-10-21T00:00:00.000Z")])).resolves.toBeUndefined();
    await expect(loadTaskLedger(recovered)).resolves.toHaveLength(1);
  });
});
