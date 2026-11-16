import { describe, expect, it } from "vitest";
import {
  fleetObservabilityView,
  type FleetObservability,
} from "./fleet-observability.js";

const base: FleetObservability = { checkedAt: 1_760_000_000_000, stale: false };

describe("fleetObservabilityView", () => {
  it("returns undefined when the payload carries no fleet block", () => {
    expect(fleetObservabilityView(undefined)).toBeUndefined();
  });

  it("keeps inspect fields absent when no router is configured", () => {
    expect(fleetObservabilityView({ ...base, stale: true })).toEqual({
      checkedAt: base.checkedAt,
      stale: true,
      lastRoundRunning: false,
    });
  });

  it("keeps round fields absent when no round has run yet", () => {
    expect(fleetObservabilityView({
      ...base,
      inspect: { totals: { attempts: 4, failures: 1 }, lastRound: undefined },
    })).toEqual({
      checkedAt: base.checkedAt,
      stale: false,
      inspectAttempts: 4,
      inspectFailures: 1,
      lastRoundRunning: false,
    });
  });

  it("marks a round with no duration as running instead of zero-length", () => {
    expect(fleetObservabilityView({
      ...base,
      inspect: {
        totals: { attempts: 9, failures: 2 },
        lastRound: {
          round: 3,
          attempts: 5,
          failures: 2,
          peakQueueDepth: 3,
          startedAt: base.checkedAt - 100,
          durationMs: undefined,
        },
      },
    })).toEqual({
      checkedAt: base.checkedAt,
      stale: false,
      inspectAttempts: 9,
      inspectFailures: 2,
      lastRoundAttempts: 5,
      lastRoundFailures: 2,
      peakQueueDepth: 3,
      lastRoundRunning: true,
    });
  });

  it("carries the settled round duration through", () => {
    const view = fleetObservabilityView({
      ...base,
      inspect: {
        totals: { attempts: 9, failures: 0 },
        lastRound: {
          round: 3,
          attempts: 5,
          failures: 0,
          peakQueueDepth: 1,
          startedAt: base.checkedAt - 100,
          durationMs: 45,
        },
      },
    });
    expect(view).toMatchObject({ lastRoundDurationMs: 45, lastRoundRunning: false });
  });
});
