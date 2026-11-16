/**
 * Client mirror of the state payload's fleet observability block
 * (server: fleetObservability in the plugin's fleet-cache). The
 * block exists only when the deployment has a fleet cache, and
 * its inspect section only when a fleet router is configured;
 * every consumer must tolerate each layer's absence.
 */
export interface FleetInspectRoundStats {
  round: number;
  attempts: number;
  failures: number;
  peakQueueDepth: number;
  startedAt: number;
  durationMs: number | undefined;
}

export interface FleetInspectStats {
  totals: { attempts: number; failures: number };
  lastRound: FleetInspectRoundStats | undefined;
}

export interface FleetObservability {
  checkedAt: number;
  stale: boolean;
  inspect?: FleetInspectStats;
}

/**
 * Flattened view of the block for presentation. Absent sections
 * stay absent (never zero-filled): no inspect section means no
 * router was configured, no round means none has run yet, and a
 * round without durationMs is still running, not zero-length.
 */
export interface FleetObservabilityView {
  checkedAt: number;
  stale: boolean;
  inspectAttempts?: number;
  inspectFailures?: number;
  lastRoundAttempts?: number;
  lastRoundFailures?: number;
  peakQueueDepth?: number;
  lastRoundDurationMs?: number;
  lastRoundRunning: boolean;
}

export function fleetObservabilityView(
  fleet: FleetObservability | undefined,
): FleetObservabilityView | undefined {
  if (fleet === undefined) return undefined;
  const inspect = fleet.inspect;
  const lastRound = inspect?.lastRound;
  return {
    checkedAt: fleet.checkedAt,
    stale: fleet.stale,
    ...(inspect === undefined ? {} : {
      inspectAttempts: inspect.totals.attempts,
      inspectFailures: inspect.totals.failures,
    }),
    ...(lastRound === undefined ? {} : {
      lastRoundAttempts: lastRound.attempts,
      lastRoundFailures: lastRound.failures,
      peakQueueDepth: lastRound.peakQueueDepth,
      ...(lastRound.durationMs === undefined ? {} : {
        lastRoundDurationMs: lastRound.durationMs,
      }),
    }),
    lastRoundRunning: lastRound !== undefined && lastRound.durationMs === undefined,
  };
}
