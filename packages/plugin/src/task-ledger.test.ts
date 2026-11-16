import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function task(id: string, updatedAt: string): RuntimeTaskRecord {
  return {
    id,
    goal: `goal ${id}`,
    targetNodeIds: ["node-a"],
    transport: "ssh",
    status: "completed",
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

  it("keeps the newest tasks when the ledger exceeds its limit", async () => {
    const path = await temporaryLedgerPath();
    const tasks = Array.from({ length: 205 }, (_, index) =>
      task(`task-${index}`, `2026-10-21T00:00:${String(index % 60).padStart(2, "0")}.000Z`));

    await writeTaskLedger(path, tasks);

    const raw = JSON.parse(await readFile(path, "utf8")) as { tasks: RuntimeTaskRecord[] };
    expect(raw.tasks).toHaveLength(200);
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
