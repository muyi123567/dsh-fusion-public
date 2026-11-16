import { describe, expect, it, vi } from "vitest";
import { FleetStateCache, fleetObservability } from "./fleet-cache.js";
import type { CachedFleetState } from "./plugin-runtime.js";

const emptyState: CachedFleetState = {
  nodes: [],
  tasks: [],
  huawei: { state: "connected", checkedAt: 1 },
  nodeProvider: { state: "connected", checkedAt: 1 },
};

describe("FleetStateCache", () => {
  it("serves a fresh entry without probing again", async () => {
    let now = 1_000;
    const read = vi.fn(async () => emptyState);
    const cache = new FleetStateCache({ read, ttlMs: 3_000, now: () => now });

    await cache.get();
    now = 2_000;
    await cache.get();

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("probes again once the entry went stale", async () => {
    let now = 1_000;
    const read = vi.fn(async () => emptyState);
    const cache = new FleetStateCache({ read, ttlMs: 3_000, now: () => now });

    await cache.get();
    now = 5_000;
    await cache.get();

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("joins an in-flight probe instead of starting another", async () => {
    let resolve: ((value: CachedFleetState) => void) | undefined;
    const read = vi.fn(() => new Promise<CachedFleetState>((r) => {
      resolve = r;
    }));
    const cache = new FleetStateCache({ read, ttlMs: 0 });

    const first = cache.get();
    const second = cache.get();
    expect(read).toHaveBeenCalledTimes(1);
    resolve?.(emptyState);
    await Promise.all([first, second]);
  });

  it("clears the pending probe when a read fails", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("ssh down"))
      .mockResolvedValueOnce(emptyState);
    const cache = new FleetStateCache({ read, ttlMs: 0 });

    await expect(cache.get()).rejects.toThrow("ssh down");
    await expect(cache.get()).resolves.toMatchObject({ nodes: [] });
  });

  it("forces the next read to probe again after invalidation", async () => {
    const read = vi.fn(async () => emptyState);
    const cache = new FleetStateCache({ read, ttlMs: 60_000 });

    await cache.get();
    cache.invalidate();
    await cache.get();

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("probes immediately on refresh even inside the freshness window", async () => {
    const read = vi.fn(async () => emptyState);
    const cache = new FleetStateCache({ read, ttlMs: 60_000 });

    await cache.get();
    await cache.refresh();

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("waits for a pre-action probe and reads fresh state after the action", async () => {
    let finishOld: ((value: CachedFleetState) => void) | undefined;
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise<CachedFleetState>((resolve) => {
        finishOld = resolve;
      }))
      .mockResolvedValueOnce({ ...emptyState, huawei: { state: "connected", checkedAt: 2 } });
    const cache = new FleetStateCache({ read, ttlMs: 60_000 });
    const oldProbe = cache.get();
    const afterAction = cache.refreshAfterCurrent();
    expect(read).toHaveBeenCalledTimes(1);
    finishOld?.(emptyState);
    await oldProbe;
    await expect(afterAction).resolves.toMatchObject({ huawei: { checkedAt: 2 } });
    expect(read).toHaveBeenCalledTimes(2);
    await expect(cache.get()).resolves.toMatchObject({ huawei: { checkedAt: 2 } });
  });

  it("serves a stale entry immediately while revalidating in the background", async () => {
    let now = 1_000;
    let finishProbe: ((state: CachedFleetState) => void) | undefined;
    const read = vi.fn()
      .mockResolvedValueOnce(emptyState)
      .mockImplementationOnce(() => new Promise<CachedFleetState>((resolve) => {
        finishProbe = resolve;
      }));
    const cache = new FleetStateCache({ read, ttlMs: 3_000, now: () => now });

    await cache.get();
    now = 10_000;
    // The revalidation probe never resolves until the test says so;
    // the stale read completing at all proves it did not wait for it.
    const served = await cache.getStaleWhileRevalidate();
    expect(served.stale).toBe(true);
    expect(served.entry).toMatchObject({ huawei: { checkedAt: 1 } });
    expect(read).toHaveBeenCalledTimes(2);

    finishProbe?.({ ...emptyState, huawei: { state: "connected", checkedAt: 2 } });
    await expect(cache.get()).resolves.toMatchObject({ huawei: { checkedAt: 2 } });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reports a fresh entry as not stale without probing again", async () => {
    let now = 1_000;
    const read = vi.fn(async () => emptyState);
    const cache = new FleetStateCache({ read, ttlMs: 3_000, now: () => now });

    await cache.get();
    now = 2_000;
    const served = await cache.getStaleWhileRevalidate();
    expect(served.stale).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("waits for the first probe on a cold cache", async () => {
    let finishProbe: ((state: CachedFleetState) => void) | undefined;
    const read = vi.fn(() => new Promise<CachedFleetState>((resolve) => {
      finishProbe = resolve;
    }));
    const cache = new FleetStateCache({ read, ttlMs: 3_000, now: () => 1_000 });

    let settled = false;
    const pending = cache.getStaleWhileRevalidate().then((served) => {
      settled = true;
      return served;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishProbe?.(emptyState);
    const served = await pending;
    expect(served.stale).toBe(false);
    expect(served.entry).toMatchObject({ huawei: { checkedAt: 1 } });
  });

  it("keeps serving the stale entry when background revalidation fails", async () => {
    let now = 1_000;
    const read = vi.fn()
      .mockResolvedValueOnce(emptyState)
      .mockRejectedValueOnce(new Error("probe failed"))
      .mockResolvedValueOnce({ ...emptyState, huawei: { state: "connected", checkedAt: 3 } });
    const cache = new FleetStateCache({ read, ttlMs: 3_000, now: () => now });

    await cache.get();
    now = 10_000;
    const served = await cache.getStaleWhileRevalidate();
    expect(served.stale).toBe(true);
    // Let the failed background probe settle; the failure belongs to
    // no caller and must neither surface as an unhandled rejection
    // nor wedge the pending slot.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(cache.get()).resolves.toMatchObject({ huawei: { checkedAt: 3 } });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("builds the state payload's fleet observability block from a read", async () => {
    let now = 1_000;
    const read = vi.fn(async () => emptyState);
    const cache = new FleetStateCache({ read, ttlMs: 3_000, now: () => now });

    const fresh = await cache.getStaleWhileRevalidate();
    expect(fleetObservability(fresh)).toEqual({ checkedAt: 1_000, stale: false });

    now = 10_000;
    const stale = await cache.getStaleWhileRevalidate();
    const inspect = {
      totals: { attempts: 4, failures: 1 },
      lastRound: {
        round: 2,
        attempts: 3,
        failures: 1,
        peakQueueDepth: 0,
        startedAt: 9_000,
        durationMs: 12,
      },
    };
    expect(fleetObservability(stale, inspect)).toEqual({
      checkedAt: 1_000,
      stale: true,
      inspect,
    });
  });

  it("recovers a post-action read even when the earlier probe rejected", async () => {
    let rejectOld: ((reason: Error) => void) | undefined;
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise<CachedFleetState>((_resolve, reject) => {
        rejectOld = reject;
      }))
      .mockResolvedValueOnce(emptyState);
    const cache = new FleetStateCache({ read });
    const oldProbe = cache.get();
    const oldFailure = expect(oldProbe).rejects.toThrow("old probe failed");
    const afterAction = cache.refreshAfterCurrent();
    rejectOld?.(new Error("old probe failed"));
    await oldFailure;
    await expect(afterAction).resolves.toMatchObject({ nodes: [] });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
