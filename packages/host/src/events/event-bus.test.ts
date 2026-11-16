import { describe, expect, it, vi } from "vitest";
import { FusionEventBus } from "./event-bus.js";

describe("FusionEventBus", () => {
  it("assigns dense increasing sequence numbers and timestamps", () => {
    const bus = new FusionEventBus({ now: () => 1_700_000_000_000 });

    const first = bus.publish({ type: "state.updated", scope: "tasks" });
    const second = bus.publish({ type: "state.updated", scope: "nodes" });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.at).toBe("2023-11-14T22:13:20.000Z");
  });

  it("replays only events newer than the requested sequence", () => {
    const bus = new FusionEventBus();
    bus.publish({ type: "state.updated", scope: "a" });
    bus.publish({ type: "state.updated", scope: "b" });
    bus.publish({ type: "state.updated", scope: "c" });

    expect(bus.replay(1).map((event) => event.seq)).toEqual([2, 3]);
    expect(bus.replay(3)).toEqual([]);
    expect(bus.replay(Number.NaN)).toEqual([]);
  });

  it("keeps the replay buffer bounded", () => {
    const bus = new FusionEventBus({ bufferSize: 2 });
    bus.publish({ type: "state.updated", scope: "a" });
    bus.publish({ type: "state.updated", scope: "b" });
    bus.publish({ type: "state.updated", scope: "c" });

    expect(bus.replay(0).map((event) => event.seq)).toEqual([2, 3]);
  });

  it("returns replay events when no gap exists", () => {
    const bus = new FusionEventBus({ bufferSize: 2 });
    bus.publish({ type: "state.updated", scope: "a" });
    bus.publish({ type: "state.updated", scope: "b" });
    bus.publish({ type: "state.updated", scope: "c" });

    expect(bus.replayWithGap(1)).toEqual({
      events: [
        expect.objectContaining({ seq: 2 }),
        expect.objectContaining({ seq: 3 }),
      ],
      gap: null,
    });
  });

  it("reports a buffer overflow without returning partial history", () => {
    const bus = new FusionEventBus({ bufferSize: 2 });
    bus.publish({ type: "state.updated", scope: "a" });
    bus.publish({ type: "state.updated", scope: "b" });
    bus.publish({ type: "state.updated", scope: "c" });

    expect(bus.replayWithGap(0)).toEqual({
      events: [],
      gap: {
        afterSeq: 0,
        firstAvailableSeq: 2,
        lastSeq: 3,
        missingFrom: 1,
        missingTo: 1,
        reason: "buffer-overflow",
      },
    });
  });

  it("reports a sequence reset when the cursor is ahead of the bus", () => {
    const bus = new FusionEventBus({ bufferSize: 2 });
    bus.publish({ type: "state.updated", scope: "a" });
    bus.publish({ type: "state.updated", scope: "b" });
    bus.publish({ type: "state.updated", scope: "c" });

    expect(bus.replayWithGap(5)).toEqual({
      events: [],
      gap: {
        afterSeq: 5,
        firstAvailableSeq: 2,
        lastSeq: 3,
        missingFrom: 4,
        missingTo: 5,
        reason: "sequence-reset",
      },
    });
  });

  it("returns no gap for an empty bus", () => {
    const bus = new FusionEventBus();

    expect(bus.replayWithGap(0)).toEqual({ events: [], gap: null });
  });

  it("normalizes non-finite and negative replay cursors to zero", () => {
    const bus = new FusionEventBus({ bufferSize: 2 });
    bus.publish({ type: "state.updated", scope: "a" });
    bus.publish({ type: "state.updated", scope: "b" });
    bus.publish({ type: "state.updated", scope: "c" });

    for (const cursor of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.NEGATIVE_INFINITY]) {
      expect(bus.replayWithGap(cursor).gap?.afterSeq).toBe(0);
    }
  });

  it("keeps publishing when a subscriber throws and supports unsubscribe", () => {
    const bus = new FusionEventBus();
    const failing = vi.fn(() => {
      throw new Error("subscriber exploded");
    });
    const received: number[] = [];
    const unsubscribe = bus.subscribe(failing);
    bus.subscribe((event) => received.push(event.seq));

    expect(() => bus.publish({ type: "state.updated", scope: "a" })).not.toThrow();
    expect(received).toEqual([1]);
    expect(bus.subscriberCount).toBe(2);

    unsubscribe();
    bus.publish({ type: "state.updated", scope: "b" });
    expect(received).toEqual([1, 2]);
    expect(bus.subscriberCount).toBe(1);
  });
});
