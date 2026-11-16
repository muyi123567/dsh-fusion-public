import { describe, expect, it, vi } from "vitest";
import { createSnapshotCoordinator } from "./snapshot-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("snapshot coordinator", () => {
  it("serializes a burst into one in-flight request and one trailing refresh", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const snapshots: number[] = [];
    const coordinator = createSnapshotCoordinator({ load, onSnapshot: (value: number) => snapshots.push(value) });
    const initial = coordinator.refresh();
    const trailing = Array.from({ length: 20 }, () => coordinator.refresh());
    expect(load).toHaveBeenCalledTimes(1);
    expect(new Set(trailing).size).toBe(1);
    first.resolve(1);
    await initial;
    expect(load).toHaveBeenCalledTimes(2);
    let actionFinished = false;
    void trailing[0]!.then(() => { actionFinished = true; });
    await Promise.resolve();
    expect(actionFinished).toBe(false);
    second.resolve(2);
    await Promise.all(trailing);
    expect(snapshots).toEqual([1, 2]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("coalesces ordinary invalidations inside the merge window", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn().mockResolvedValue(1);
      const coordinator = createSnapshotCoordinator({
        load,
        onSnapshot: () => {},
        coalesceMs: 250,
      });
      // The cycle starts with a coalesced load; the window limits
      // consecutive stream-driven loads, not the first one.
      await coordinator.refreshCoalesced();
      expect(load).toHaveBeenCalledTimes(1);

      // Three ordinary invalidations inside the window share one
      // scheduled load at the window boundary.
      const a = coordinator.refreshCoalesced();
      const b = coordinator.refreshCoalesced();
      const c = coordinator.refreshCoalesced();
      expect(a).toBe(b);
      expect(b).toBe(c);
      await vi.advanceTimersByTimeAsync(249);
      expect(load).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(load).toHaveBeenCalledTimes(2);
      await a;

      // The next ordinary invalidation opens a fresh window.
      const d = coordinator.refreshCoalesced();
      await vi.advanceTimersByTimeAsync(250);
      expect(load).toHaveBeenCalledTimes(3);
      await d;
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets an awaited refresh supersede a scheduled coalesced load", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn().mockResolvedValue(1);
      const coordinator = createSnapshotCoordinator({
        load,
        onSnapshot: () => {},
        coalesceMs: 250,
      });
      await coordinator.refreshCoalesced();
      const coalesced = coordinator.refreshCoalesced();
      const immediate = coordinator.refresh();
      // The post-action refresh starts now, not at the window edge,
      // and the coalesced callers observe the same run.
      expect(load).toHaveBeenCalledTimes(2);
      await immediate;
      await coalesced;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(load).toHaveBeenCalledTimes(2);
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the first coalesced invalidation after an immediate load immediate", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn().mockResolvedValue(1);
      const coordinator = createSnapshotCoordinator({
        load,
        onSnapshot: () => {},
        coalesceMs: 250,
      });
      // An action-driven (or initial) load does not arm the window:
      // the stream event right after it still starts a read at once,
      // which the post-action interleavings in the app rely on.
      await coordinator.refresh();
      await coordinator.refreshCoalesced();
      expect(load).toHaveBeenCalledTimes(2);
      // But the cycle is stream-driven now: the next invalidation
      // inside the window is held to the boundary.
      const held = coordinator.refreshCoalesced();
      await vi.advanceTimersByTimeAsync(249);
      expect(load).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(load).toHaveBeenCalledTimes(3);
      await held;
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins the trailing batch for coalesced invalidations during a load", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const coordinator = createSnapshotCoordinator({
      load,
      onSnapshot: () => {},
      coalesceMs: 250,
    });
    const initial = coordinator.refresh();
    const joined = coordinator.refreshCoalesced();
    expect(load).toHaveBeenCalledTimes(1);
    first.resolve(1);
    await initial;
    expect(load).toHaveBeenCalledTimes(2);
    second.resolve(2);
    await joined;
  });

  it("treats coalesced refreshes as immediate without a merge window", async () => {
    const load = vi.fn().mockResolvedValue(1);
    const coordinator = createSnapshotCoordinator({ load, onSnapshot: () => {} });
    await coordinator.refreshCoalesced();
    await coordinator.refreshCoalesced();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps valid data on failure, rejects callers and permits recovery", async () => {
    const onSnapshot = vi.fn();
    const onError = vi.fn();
    const failure = new Error("snapshot 503");
    const coordinator = createSnapshotCoordinator({
      load: vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(failure).mockResolvedValueOnce(2),
      onSnapshot, onError,
    });
    await coordinator.refresh();
    await expect(coordinator.refresh()).rejects.toThrow("snapshot 503");
    expect(onSnapshot.mock.calls).toEqual([[1]]);
    expect(onError).toHaveBeenCalledWith(failure);
    await coordinator.refresh();
    expect(onSnapshot.mock.calls).toEqual([[1], [2]]);
  });

  it("runs a queued post-action refresh even when the earlier request fails", async () => {
    const first = deferred<number>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(2);
    const coordinator = createSnapshotCoordinator({ load, onSnapshot: vi.fn() });
    const initial = coordinator.refresh();
    const rejected = expect(initial).rejects.toThrow("old request");
    const afterAction = coordinator.refresh();
    first.reject(new Error("old request"));
    await rejected;
    await afterAction;
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("aborts and settles all callers on dispose and ignores even abort-resistant responses", async () => {
    const request = deferred<number>();
    let signal!: AbortSignal;
    const onSnapshot = vi.fn();
    const onError = vi.fn();
    const coordinator = createSnapshotCoordinator({
      load: (nextSignal) => { signal = nextSignal; return request.promise; },
      onSnapshot, onError,
    });
    const current = expect(coordinator.refresh()).rejects.toMatchObject({ name: "AbortError" });
    const trailing = expect(coordinator.refresh()).rejects.toMatchObject({ name: "AbortError" });
    coordinator.dispose();
    expect(signal.aborted).toBe(true);
    await Promise.all([current, trailing]);
    request.resolve(1);
    await Promise.resolve();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    await expect(coordinator.refresh()).rejects.toMatchObject({ name: "AbortError" });
  });
});
