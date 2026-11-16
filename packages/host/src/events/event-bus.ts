import type { FusionEvent, FusionEventInput } from "@dsh-fusion/core";

export interface FusionEventBusOptions {
  /** How many events stay replayable for Last-Event-ID reconnects. */
  bufferSize?: number;
  now?: () => number;
}

export type FusionReplayGapReason = "buffer-overflow" | "sequence-reset";

export interface FusionReplayGap {
  afterSeq: number;
  firstAvailableSeq: number;
  lastSeq: number;
  missingFrom: number;
  missingTo: number;
  reason: FusionReplayGapReason;
}

export interface FusionReplayResult {
  events: FusionEvent[];
  gap: FusionReplayGap | null;
}

export function replayEventsWithGap(
  events: readonly FusionEvent[],
  lastSeq: number,
  afterSeq: number,
): FusionReplayResult {
  const cursor = Number.isFinite(afterSeq) && afterSeq >= 0 ? afterSeq : 0;
  const latestSeq = Number.isFinite(lastSeq) && lastSeq >= 0 ? lastSeq : 0;
  const firstAvailableSeq = events[0]?.seq ?? latestSeq + 1;

  if (cursor > latestSeq) {
    return {
      events: [],
      gap: {
        afterSeq: cursor,
        firstAvailableSeq,
        lastSeq: latestSeq,
        missingFrom: latestSeq + 1,
        missingTo: cursor,
        reason: "sequence-reset",
      },
    };
  }

  if (cursor < firstAvailableSeq - 1) {
    return {
      events: [],
      gap: {
        afterSeq: cursor,
        firstAvailableSeq,
        lastSeq: latestSeq,
        missingFrom: cursor + 1,
        missingTo: firstAvailableSeq - 1,
        reason: "buffer-overflow",
      },
    };
  }

  return {
    events: events.filter((event) => event.seq > cursor),
    gap: null,
  };
}

export function encodeSseEventFrame(event: { seq: number } & Record<string, unknown>): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function encodeSseGapFrame(gap: FusionReplayGap): string {
  return `event: fusion.gap\nid: ${gap.lastSeq}\ndata: ${JSON.stringify(gap)}\n\n`;
}

/**
 * Monotonic, replayable event bus. Sequence numbers are dense and strictly
 * increasing so a client can resume with Last-Event-ID after a dropped
 * connection without gaps.
 */
export class FusionEventBus {
  private readonly bufferSize: number;
  private readonly now: () => number;
  private readonly buffer: FusionEvent[] = [];
  private readonly listeners = new Set<(event: FusionEvent) => void>();
  private sequence = 0;

  constructor(options: FusionEventBusOptions = {}) {
    this.bufferSize = Math.max(1, Math.trunc(options.bufferSize ?? 256));
    this.now = options.now ?? (() => Date.now());
  }

  get lastSeq(): number {
    return this.sequence;
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  publish(input: FusionEventInput): FusionEvent {
    const event = {
      ...input,
      seq: ++this.sequence,
      at: new Date(this.now()).toISOString(),
    } as FusionEvent;
    this.buffer.push(event);
    while (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A failing subscriber must never break the producer or other subscribers.
      }
    }
    return event;
  }

  subscribe(listener: (event: FusionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Events strictly newer than the given sequence, oldest first. */
  replay(afterSeq: number): FusionEvent[] {
    if (!Number.isFinite(afterSeq)) return [];
    return this.buffer.filter((event) => event.seq > afterSeq);
  }

  /**
   * Events newer than the cursor, or a gap descriptor when the requested
   * history is no longer available or the cursor belongs to another sequence.
   */
  replayWithGap(afterSeq: number): FusionReplayResult {
    return replayEventsWithGap(this.buffer, this.lastSeq, afterSeq);
  }
}
