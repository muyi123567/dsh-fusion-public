interface SnapshotCoordinatorOptions<T> {
  load: (signal: AbortSignal) => Promise<T>;
  onSnapshot: (snapshot: T) => void;
  onError?: (error: unknown) => void;
  /**
   * Merge window for ordinary invalidations (see refreshCoalesced):
   * consecutive coalesced loads are spaced at least this many
   * milliseconds apart (settlement to start), so a sustained stream
   * of events costs at most one load per window instead of one per
   * event. Defaults to 0 (coalesced refreshes behave like refresh()).
   */
  coalesceMs?: number;
  now?: () => number;
}

interface RefreshBatch {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  /** True when this batch came from refreshCoalesced(). */
  coalesced: boolean;
}

/** Serializes reads; invalidations during a read wait for the next read. */
export function createSnapshotCoordinator<T>(options: SnapshotCoordinatorOptions<T>) {
  let disposed = false;
  let running = false;
  let controller: AbortController | undefined;
  let active: RefreshBatch | undefined;
  let pending: RefreshBatch | undefined;
  let scheduled: RefreshBatch | undefined;
  let scheduledTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCompletedAt: number | undefined;
  let lastLoadCoalesced = false;
  const coalesceMs = Math.max(0, Math.trunc(options.coalesceMs ?? 0));
  const now = options.now ?? (() => Date.now());
  const abortError = () => new DOMException("Snapshot coordinator disposed", "AbortError");

  const createBatch = (coalesced: boolean): RefreshBatch => {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject, coalesced };
  };

  const run = async (batch: RefreshBatch) => {
    running = true;
    active = batch;
    controller = new AbortController();
    try {
      const snapshot = await options.load(controller.signal);
      if (disposed) return;
      options.onSnapshot(snapshot);
      batch.resolve();
    } catch (error) {
      if (disposed) return;
      options.onError?.(error);
      batch.reject(error);
    } finally {
      active = undefined;
      lastCompletedAt = now();
      lastLoadCoalesced = batch.coalesced;
      if (!disposed && pending !== undefined) {
        const next = pending;
        pending = undefined;
        void run(next);
      } else {
        running = false;
      }
    }
  };

  return {
    /** Awaiting this observes a request started after this invalidation. */
    refresh(): Promise<void> {
      if (disposed) return Promise.reject(abortError());
      if (running) {
        pending ??= createBatch(false);
        return pending.promise;
      }
      // An awaited (post-action) refresh supersedes a coalesced load
      // still waiting out its merge window: run that batch now so
      // both sets of callers observe the same post-invalidation read.
      if (scheduled !== undefined) {
        const batch = scheduled;
        scheduled = undefined;
        if (scheduledTimer !== undefined) clearTimeout(scheduledTimer);
        scheduledTimer = undefined;
        void run(batch);
        return batch.promise;
      }
      const batch = createBatch(false);
      void run(batch);
      return batch.promise;
    },
    /**
     * Ordinary invalidation (stream events): like refresh(), except
     * that a stream-driven load cycle is rate-limited — when the
     * previous load was itself coalesced and settled inside the
     * merge window, the next load is scheduled at the window
     * boundary and all invalidations in between share it. The first
     * invalidation after an action-driven or initial load stays
     * immediate, as do gap recovery and post-action refreshes
     * (refresh()).
     */
    refreshCoalesced(): Promise<void> {
      if (disposed) return Promise.reject(abortError());
      if (running) {
        pending ??= createBatch(true);
        return pending.promise;
      }
      if (scheduled !== undefined) return scheduled.promise;
      const elapsed = lastCompletedAt === undefined
        ? Number.POSITIVE_INFINITY
        : now() - lastCompletedAt;
      if (coalesceMs <= 0 || !lastLoadCoalesced || elapsed >= coalesceMs) {
        const batch = createBatch(true);
        void run(batch);
        return batch.promise;
      }
      const batch = createBatch(true);
      scheduled = batch;
      scheduledTimer = setTimeout(() => {
        scheduledTimer = undefined;
        if (scheduled !== batch) return;
        scheduled = undefined;
        if (disposed) return;
        void run(batch);
      }, coalesceMs - elapsed);
      return batch.promise;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (scheduledTimer !== undefined) clearTimeout(scheduledTimer);
      scheduledTimer = undefined;
      controller?.abort();
      active?.reject(abortError());
      pending?.reject(abortError());
      scheduled?.reject(abortError());
      active = undefined;
      pending = undefined;
      scheduled = undefined;
    },
  };
}
