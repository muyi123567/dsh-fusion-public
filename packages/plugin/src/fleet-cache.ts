import type { FleetInspectStats } from "./fleet-router.js";
import type {
  CachedFleetState,
  RuntimeNodeRecord,
  RuntimeProviderStatus,
  RuntimeTaskRecord,
} from "./plugin-runtime.js";

export interface FleetCacheEntry extends CachedFleetState {
  at: number;
}

export interface FleetCacheRead {
  entry: FleetCacheEntry;
  /** True when the entry was past its freshness window when served. */
  stale: boolean;
}

/** The fleet observability block served on the state payload. */
export interface FleetObservability {
  /** When the served fleet snapshot was checked (entry time, ms). */
  checkedAt: number;
  /** True when the served snapshot was past its freshness window. */
  stale: boolean;
  /** Inspect effort from the fleet router, when one is configured. */
  inspect?: FleetInspectStats;
}

export function fleetObservability(
  read: FleetCacheRead,
  inspect?: FleetInspectStats,
): FleetObservability {
  return {
    checkedAt: read.entry.at,
    stale: read.stale,
    ...(inspect === undefined ? {} : { inspect }),
  };
}

export interface FleetCacheOptions {
  /** Performs the actual remote probes. */
  read: () => Promise<CachedFleetState>;
  /** How long a cached entry stays fresh enough to serve a request. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * Single source of truth for remote fleet probes.
 *
 * Every client request, background poll, and event push reads through this
 * cache, so N clients never cause N rounds of SSH commands. A read that
 * arrives while a probe is in flight joins that probe instead of starting
 * another one.
 */
export class FleetStateCache {
  private readonly read: () => Promise<CachedFleetState>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private entry: FleetCacheEntry | undefined;
  private pending: Promise<FleetCacheEntry> | undefined;

  constructor(options: FleetCacheOptions) {
    this.read = options.read;
    this.ttlMs = Math.max(0, Math.trunc(options.ttlMs ?? 3_000));
    this.now = options.now ?? (() => Date.now());
  }

  get fresh(): boolean {
    return this.entry !== undefined && this.now() - this.entry.at < this.ttlMs;
  }

  /** Returns the cached entry, refreshing it when it went stale. */
  async get(): Promise<FleetCacheEntry> {
    if (this.fresh && this.entry !== undefined) return this.entry;
    return await this.startProbe();
  }

  /**
   * Stale-while-revalidate read for paths that must not block on a slow
   * probe round (panel state reads): a stale entry is served
   * immediately, explicitly marked stale, while one background probe
   * revalidates it. A cold cache has nothing to serve, so the first
   * probe is still awaited. A failed background probe belongs to no
   * caller: it is swallowed here, the pending slot clears itself, and
   * the next read retries.
   */
  async getStaleWhileRevalidate(): Promise<FleetCacheRead> {
    if (this.entry !== undefined) {
      if (this.fresh) return { entry: this.entry, stale: false };
      void this.startProbe().catch(() => undefined);
      return { entry: this.entry, stale: true };
    }
    return { entry: await this.get(), stale: false };
  }

  private startProbe(): Promise<FleetCacheEntry> {
    if (this.pending !== undefined) return this.pending;
    const pending = this.read().then((state) => {
      const entry: FleetCacheEntry = { ...state, at: this.now() };
      this.entry = entry;
      this.pending = undefined;
      return entry;
    }).catch((error: unknown) => {
      this.pending = undefined;
      throw error;
    });
    this.pending = pending;
    return pending;
  }

  /** Forces the next read to probe the remote fleet again. */
  invalidate(): void {
    this.entry = undefined;
  }

  /** Probes the remote fleet now, bypassing the freshness window. */
  async refresh(): Promise<FleetCacheEntry> {
    this.invalidate();
    return await this.get();
  }

  /** A mutation must not reuse a probe which started before it completed. */
  async refreshAfterCurrent(): Promise<FleetCacheEntry> {
    const earlierProbe = this.pending;
    if (earlierProbe !== undefined) {
      // Its failure belongs to its original callers; the action still needs
      // a fresh observation rather than inheriting that earlier outcome.
      await earlierProbe.catch(() => undefined);
    }
    return await this.refresh();
  }
}
