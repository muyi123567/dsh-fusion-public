import { createHash, randomBytes } from "node:crypto";
import type {
  RuntimeAgentBusLoaderResult,
  RuntimeAgentTeamsLoaderResult,
  RuntimeRoomLoaderResult,
} from "./plugin-runtime.js";

/**
 * Whole-round bridge snapshot cache (review 05 P1-1, the
 * change the read counters were installed to make safe).
 *
 * One runtime snapshot fans out to three bridge loaders and
 * four bridge HTTP calls, the panel issues state and
 * session-hub GETs back to back, and every round used to
 * refetch everything. The cacheable unit is the whole round —
 * all three sources settled together — because the Room
 * source derives from the AgentTeams result: caching sources
 * individually could mix moments inside one payload.
 *
 * Isolation is the design constraint, not an afterthought.
 * The cache key is the resolved web origin + the configured
 * room session + a salted fingerprint of the caller's
 * isolation-relevant headers (credentials and identity
 * headers only — per-request tracing headers never enter
 * the fingerprint), so two callers with different
 * credentials can never be served each other's round;
 * callers without headers (the tool surface) form their own
 * class. Header values are hashed with a per-apply random
 * salt and never stored or logged. Rounds in which any source failed are
 * shared with concurrent callers but never retained, so a
 * failure is retried on the next read instead of being
 * served for the rest of the TTL. Doctor surfaces bypass
 * the cache entirely (see createRuntime's callers).
 */
export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export interface BridgeRound {
  agentTeams: Settled<RuntimeAgentTeamsLoaderResult>;
  agentBus: Settled<RuntimeAgentBusLoaderResult>;
  room: Settled<RuntimeRoomLoaderResult>;
  /** When this round's data was actually fetched (the
   * cache's clock at settle time). A cache hit re-serves the
   * round with this stamp untouched, so consumers can report
   * the data's real age instead of the re-serve moment. */
  fetchedAt: number;
}

/** A round as produced by the fetching factory, before the
 * cache stamps its fetch time. */
export type BridgeRoundSources = Omit<BridgeRound, "fetchedAt">;

export interface BridgeRoundKeyParts {
  origin: string;
  roomSessionId: string | undefined;
  headers: Record<string, string | string[] | undefined> | undefined;
}

/**
 * The only headers allowed into the isolation fingerprint.
 * Isolation exists so one caller's credentials are never
 * served another caller's round; the headers that can carry
 * caller identity to the bridge endpoints are the credential
 * headers plus this product's own namespaced identity
 * headers. Everything else — per-request tracing headers
 * (x-request-id, traceparent, tracestate), user agents,
 * accept headers, hop-by-hop headers — does not change who
 * the upstream answers as, and including it would shard the
 * cache per request for no isolation benefit.
 */
const ISOLATION_HEADERS = new Set(["authorization", "cookie"]);
const ISOLATION_PREFIXES = ["x-dsh-", "x-fusion-"];

const MAX_ENTRIES = 32;

/** Default freshness window for one bridge round. */
export const BRIDGE_ROUND_TTL_MS = 2_000;

export class BridgeRoundCache {
  private readonly entries = new Map<string, {
    at: number;
    promise: Promise<BridgeRound>;
  }>();
  private readonly salt = randomBytes(16).toString("hex");
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number = BRIDGE_ROUND_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  key(parts: BridgeRoundKeyParts): string {
    const caller = parts.headers === undefined
      ? "tool"
      : `panel:${this.fingerprint(parts.headers)}`;
    return [
      parts.origin,
      parts.roomSessionId ?? "derived-room",
      caller,
    ].join("\n");
  }

  load(key: string, factory: () => Promise<BridgeRoundSources>): Promise<BridgeRound> {
    const existing = this.entries.get(key);
    if (existing !== undefined && this.now() - existing.at < this.ttlMs) {
      return existing.promise;
    }
    const promise = factory().then((round) => ({ ...round, fetchedAt: this.now() }));
    this.entries.set(key, { at: this.now(), promise });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    // Failure rounds are not retained: once settled, a round
    // with any failed source evicts itself so the next read
    // retries. (Successful rounds stay until the TTL lapses.)
    void promise.then((round) => {
      if (
        !round.agentTeams.ok || !round.agentBus.ok || !round.room.ok
      ) {
        if (this.entries.get(key)?.promise === promise) {
          this.entries.delete(key);
        }
      }
    }, () => {
      if (this.entries.get(key)?.promise === promise) {
        this.entries.delete(key);
      }
    });
    return promise;
  }

  private fingerprint(
    headers: Record<string, string | string[] | undefined>,
  ): string {
    const lines: string[] = [];
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      const normalized = name.toLowerCase();
      const isolationRelevant = ISOLATION_HEADERS.has(normalized)
        || ISOLATION_PREFIXES.some((prefix) => normalized.startsWith(prefix));
      if (!isolationRelevant) continue;
      lines.push(`${normalized}=${Array.isArray(value) ? value.join(", ") : value}`);
    }
    lines.sort();
    return createHash("sha256")
      .update(`${this.salt}\n${lines.join("\n")}`)
      .digest("hex");
  }
}
