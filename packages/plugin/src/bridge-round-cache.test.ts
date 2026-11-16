import { describe, expect, it } from "vitest";
import {
  BridgeRoundCache,
  type BridgeRound,
} from "./bridge-round-cache.js";

type Round = BridgeRound;
type RoundSources = Omit<BridgeRound, "fetchedAt">;

// The cache treats loader results as opaque; the marker rides
// in a field-shaped stand-in so tests can tell rounds apart.
const okRound = (marker: string): RoundSources => ({
  agentTeams: { ok: true, value: { marker } as never },
  agentBus: { ok: true, value: { marker } as never },
  room: { ok: true, value: { marker } as never },
});

const baseParts = {
  origin: "http://127.0.0.1:8080",
  roomSessionId: undefined,
  headers: { cookie: "session=alpha" },
};

describe("BridgeRoundCache keys", () => {
  it("separates origins, room sessions, caller classes, and credentials", () => {
    const cache = new BridgeRoundCache(2_000, () => 0);
    const key = cache.key(baseParts);
    expect(cache.key(baseParts)).toBe(key);
    expect(cache.key({ ...baseParts, origin: "http://127.0.0.1:9090" })).not.toBe(key);
    expect(cache.key({ ...baseParts, roomSessionId: "room-1" })).not.toBe(key);
    expect(cache.key({ ...baseParts, headers: undefined })).not.toBe(key);
    expect(cache.key({ ...baseParts, headers: { cookie: "session=beta" } })).not.toBe(key);
    expect(cache.key({ ...baseParts, headers: { authorization: "Bearer x" } })).not.toBe(key);
  });

  it("ignores hop-by-hop header differences and never embeds raw header values", () => {
    const cache = new BridgeRoundCache(2_000, () => 0);
    const key = cache.key(baseParts);
    expect(cache.key({
      ...baseParts,
      headers: { cookie: "session=alpha", host: "other.example", connection: "close" },
    })).toBe(key);
    expect(key).not.toContain("alpha");
    expect(key).not.toContain("session=");
  });

  it("keys only on isolation-relevant headers, not per-request tracing headers", () => {
    const cache = new BridgeRoundCache(2_000, () => 0);
    const key = cache.key({
      ...baseParts,
      headers: {
        cookie: "session=alpha",
        "x-request-id": "req-1",
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        tracestate: "vendor=value1",
        "user-agent": "browser-one",
        "accept-language": "zh-CN",
      },
    });
    // A new request id / trace context / user agent is the
    // SAME caller for isolation purposes: same key, cache hit.
    expect(cache.key({
      ...baseParts,
      headers: {
        cookie: "session=alpha",
        "x-request-id": "req-2",
        traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01",
        tracestate: "vendor=value2",
        "user-agent": "browser-two",
        "accept-language": "en-US",
      },
    })).toBe(key);
    // Identity-bearing differences still isolate.
    expect(cache.key({
      ...baseParts,
      headers: { cookie: "session=alpha", "x-dsh-identity": "user-b" },
    })).not.toBe(key);
    expect(cache.key({
      ...baseParts,
      headers: { authorization: "Bearer <redacted>", cookie: "session=alpha" },
    })).not.toBe(key);
  });
});

describe("BridgeRoundCache loading", () => {
  it("serves a fresh round without refetching and refetches after the TTL", async () => {
    let now = 1_000;
    const cache = new BridgeRoundCache(2_000, () => now);
    let calls = 0;
    const factory = async () => okRound(`round-${++calls}`);
    const key = cache.key(baseParts);
    expect((await cache.load(key, factory)).agentTeams).toEqual({ ok: true, value: { marker: "round-1" } });
    expect((await cache.load(key, factory)).agentTeams).toEqual({ ok: true, value: { marker: "round-1" } });
    expect(calls).toBe(1);
    now += 2_001;
    expect((await cache.load(key, factory)).agentTeams).toEqual({ ok: true, value: { marker: "round-2" } });
    expect(calls).toBe(2);
  });

  it("stamps the round with its fetch time and never refreshes it on a hit", async () => {
    let now = 5_000;
    const cache = new BridgeRoundCache(2_000, () => now);
    const key = cache.key(baseParts);
    const first = await cache.load(key, async () => okRound("round-1"));
    expect(first.fetchedAt).toBe(5_000);
    // A hit inside the TTL serves the same round: its fetch
    // time is the moment the data was actually fetched, not
    // the moment it was re-served.
    now += 1_500;
    const second = await cache.load(key, async () => okRound("round-2"));
    expect(second.fetchedAt).toBe(5_000);
    expect(second.agentTeams).toEqual({ ok: true, value: { marker: "round-1" } });
    // After the TTL the refetched round carries the new time.
    now += 1_000;
    const third = await cache.load(key, async () => okRound("round-3"));
    expect(third.fetchedAt).toBe(7_500);
  });

  it("dedupes concurrent loads of the same key into one round", async () => {
    const cache = new BridgeRoundCache(2_000, () => 0);
    let calls = 0;
    const factory = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return okRound("shared");
    };
    const key = cache.key(baseParts);
    const [first, second] = await Promise.all([
      cache.load(key, factory),
      cache.load(key, factory),
    ]);
    expect(calls).toBe(1);
    expect(first).toBe(second);
  });

  it("does not retain a round in which any source failed", async () => {
    const cache = new BridgeRoundCache(2_000, () => 0);
    let calls = 0;
    const factory = async (): Promise<RoundSources> => {
      calls += 1;
      if (calls === 1) {
        return {
          agentTeams: { ok: true, value: { marker: "teams" } as never },
          agentBus: { ok: false, error: new Error("bus down") },
          room: { ok: true, value: { marker: "room" } as never },
        };
      }
      return okRound("recovered");
    };
    const key = cache.key(baseParts);
    const first = await cache.load(key, factory);
    expect(first.agentBus).toEqual({ ok: false, error: expect.any(Error) });
    // The failed round was shared with concurrent callers but is
    // not retained: the next load retries instead of serving
    // the failure for the rest of the TTL.
    const second = await cache.load(key, factory);
    expect(calls).toBe(2);
    expect(second.agentTeams).toEqual({ ok: true, value: { marker: "recovered" } });
  });
});
