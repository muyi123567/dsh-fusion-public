import { describe, expect, it, vi } from "vitest";
import { FusionEventBus } from "./event-bus.js";
import {
  diffFusionSnapshots,
  FusionStateHub,
  type FusionWatchSnapshot,
} from "./fusion-state-hub.js";

function snapshot(overrides: Partial<FusionWatchSnapshot> = {}): FusionWatchSnapshot {
  return {
    nodes: [{ id: "n1", status: "online", configState: "current" }],
    tasks: [{ id: "t1", status: "running", progress: 20 }],
    bridgeTasks: [],
    providers: { nodes: { state: "connected" }, huawei: { state: "connected" } },
    agentTeams: [{ id: "team-1" }],
    agentFlows: [],
    rooms: [],
    bots: [{ id: "bot-1" }],
    groups: [],
    sessions: [],
    ...overrides,
  };
}

describe("diffFusionSnapshots", () => {
  it("emits an initial scope event for the first snapshot", () => {
    expect(diffFusionSnapshots(undefined, snapshot())).toEqual([
      { type: "state.updated", scope: "initial" },
    ]);
  });

  it("emits nothing when nothing changed", () => {
    expect(diffFusionSnapshots(snapshot(), snapshot())).toEqual([]);
  });

  it("detects provider state changes", () => {
    const events = diffFusionSnapshots(
      snapshot({ providers: { nodes: { state: "connected" } } }),
      snapshot({ providers: { nodes: { state: "offline" } } }),
    );
    expect(events).toContainEqual({
      type: "provider.status",
      providerId: "nodes",
      state: "offline",
    });
  });

  it("detects a removed provider as not-configured", () => {
    const events = diffFusionSnapshots(
      snapshot({ providers: { nodes: { state: "connected" }, huawei: { state: "connected" } } }),
      snapshot({ providers: { nodes: { state: "connected" } } }),
    );
    expect(events).toContainEqual({
      type: "provider.status",
      providerId: "huawei",
      state: "not-configured",
    });
  });

  it("detects node status and config drift changes", () => {
    const events = diffFusionSnapshots(
      snapshot(),
      snapshot({
        nodes: [{ id: "n1", status: "degraded", configState: "drift" }],
      }),
    );
    expect(events).toContainEqual({ type: "node.updated", nodeId: "n1" });
  });

  it("emits a config event when a node's observed configuration changes", () => {
    const events = diffFusionSnapshots(
      snapshot({ config: [{ nodeId: "n1", state: "current", hash: "sha256:aaa" }] }),
      snapshot({ config: [{ nodeId: "n1", state: "drift", hash: "sha256:bbb" }] }),
    );
    expect(events).toContainEqual({ type: "config.updated", nodeId: "n1" });
  });

  it("emits a config event when a node's configuration hash changes", () => {
    const events = diffFusionSnapshots(
      snapshot({ config: [{ nodeId: "n1", state: "current", hash: "sha256:aaa" }] }),
      snapshot({ config: [{ nodeId: "n1", state: "current", hash: "sha256:bbb" }] }),
    );
    expect(events).toContainEqual({ type: "config.updated", nodeId: "n1" });
  });

  it("emits a config event when a node stops reporting a configuration", () => {
    const events = diffFusionSnapshots(
      snapshot({ config: [{ nodeId: "n1", state: "current" }] }),
      snapshot({ config: [] }),
    );
    expect(events).toContainEqual({ type: "config.updated", nodeId: "n1" });
  });

  it("emits no config event when the configuration is unchanged", () => {
    const config = [{ nodeId: "n1", state: "current" as const, hash: "sha256:aaa" }];
    expect(diffFusionSnapshots(snapshot({ config }), snapshot({ config })))
      .not.toContainEqual({ type: "config.updated", nodeId: "n1" });
  });

  it("detects task status and progress changes", () => {
    const events = diffFusionSnapshots(
      snapshot(),
      snapshot({ tasks: [{ id: "t1", status: "completed", progress: 100 }] }),
    );
    expect(events).toContainEqual({
      type: "task.updated",
      taskId: "t1",
      status: "completed",
    });
  });

  it("detects upstream bridge task status changes", () => {
    const events = diffFusionSnapshots(
      snapshot(),
      snapshot({ bridgeTasks: [{ id: "bt1", status: "completed", progress: 100 }] }),
    );
    expect(events).toContainEqual({
      type: "task.updated",
      taskId: "bt1",
      status: "completed",
    });
  });

  it("detects bridge collection membership changes", () => {
    const events = diffFusionSnapshots(
      snapshot({ rooms: [] }),
      snapshot({ rooms: [{ id: "room-1" }] }),
    );
    expect(events).toContainEqual({ type: "state.updated", scope: "rooms" });
  });

  it("detects Room status and member changes under the same id", () => {
    const events = diffFusionSnapshots(
      snapshot({
        rooms: [{ id: "room-1", status: "open", memberIds: ["b", "a"] }],
      }),
      snapshot({
        rooms: [{ id: "room-1", status: "open", memberIds: ["a", "b", "c"] }],
      }),
    );
    expect(events).toContainEqual({ type: "state.updated", scope: "rooms" });
  });

  it("names the bot whose state changed", () => {
    const events = diffFusionSnapshots(
      snapshot({ bots: [{ id: "bot-1", status: "idle" }] }),
      snapshot({ bots: [{ id: "bot-1", status: "working" }] }),
    );
    expect(events).toContainEqual({ type: "bot.updated", botId: "bot-1" });
  });

  it("names a bot that appeared or disappeared", () => {
    expect(diffFusionSnapshots(
      snapshot({ bots: [] }),
      snapshot({ bots: [{ id: "bot-1" }] }),
    )).toContainEqual({ type: "bot.updated", botId: "bot-1" });
    expect(diffFusionSnapshots(
      snapshot({ bots: [{ id: "bot-1" }] }),
      snapshot({ bots: [] }),
    )).toContainEqual({ type: "bot.updated", botId: "bot-1" });
  });

  it("emits no bot event when the bot state is unchanged", () => {
    const bots = [{ id: "bot-1", status: "working" }];
    expect(diffFusionSnapshots(snapshot({ bots }), snapshot({ bots })))
      .not.toContainEqual({ type: "bot.updated", botId: "bot-1" });
  });

  it("names the session whose state changed", () => {
    const events = diffFusionSnapshots(
      snapshot({ sessions: [{ id: "s1", status: "live" }] }),
      snapshot({ sessions: [{ id: "s1", status: "finished" }] }),
    );
    expect(events).toContainEqual({ type: "session.updated", sessionId: "s1" });
  });

  it("names a session whose activity moved without a status change", () => {
    const events = diffFusionSnapshots(
      snapshot({ sessions: [{ id: "s1", status: "live", updatedAt: "2026-10-22T00:00:00.000Z" }] }),
      snapshot({ sessions: [{ id: "s1", status: "live", updatedAt: "2026-10-22T00:01:00.000Z" }] }),
    );
    expect(events).toContainEqual({ type: "session.updated", sessionId: "s1" });
  });
});

describe("FusionStateHub", () => {
  it("publishes the merged diff when a slice arrives", () => {
    const bus = new FusionEventBus();
    const hub = new FusionStateHub({ bus });
    const seen: string[] = [];
    bus.subscribe((event) => seen.push(event.type));

    hub.mergeFleetSnapshot({ nodes: [{ id: "n1", status: "online", configState: "current" }] });
    hub.mergeBridgeSnapshot({ agentTeams: [{ id: "team-1" }] });

    expect(seen).toEqual(["state.updated", "state.updated"]);
    expect(bus.lastSeq).toBe(2);
  });

  it("does not emit fleet events when only the bridge slice changes", () => {
    const bus = new FusionEventBus();
    const hub = new FusionStateHub({ bus });
    hub.mergeFleetSnapshot({
      nodes: [{ id: "n1", status: "online", configState: "current" }],
      tasks: [{ id: "t1", status: "running", progress: 20 }],
    });
    const events = hub.mergeBridgeSnapshot({ rooms: [{ id: "room-1" }] });

    expect(events).toEqual([{ type: "state.updated", scope: "rooms" }]);
  });

  it("keeps the observed configuration in the fleet slice", () => {
    const bus = new FusionEventBus();
    const hub = new FusionStateHub({ bus });
    hub.mergeFleetSnapshot({
      nodes: [{ id: "n1", status: "online", configState: "current" }],
      config: [{ nodeId: "n1", state: "current", hash: "sha256:aaa" }],
    });
    const events = hub.mergeBridgeSnapshot({ rooms: [{ id: "room-1" }] });

    // A bridge refresh must not look like a configuration change.
    expect(events).not.toContainEqual({ type: "config.updated", nodeId: "n1" });
  });

  it("emits a config event when the fleet slice observes drift", () => {
    const bus = new FusionEventBus();
    const hub = new FusionStateHub({ bus });
    hub.mergeFleetSnapshot({
      nodes: [{ id: "n1", status: "online", configState: "current" }],
      config: [{ nodeId: "n1", state: "current", hash: "sha256:aaa" }],
    });
    const events = hub.mergeFleetSnapshot({
      nodes: [{ id: "n1", status: "online", configState: "drift" }],
      config: [{ nodeId: "n1", state: "drift", hash: "sha256:bbb" }],
    });

    expect(events).toContainEqual({ type: "config.updated", nodeId: "n1" });
  });

  it("keeps provider states from both slices", () => {
    const bus = new FusionEventBus();
    const hub = new FusionStateHub({ bus });
    hub.mergeFleetSnapshot({
      nodes: [{ id: "n1", status: "online", configState: "current" }],
      providers: { nodes: { state: "connected" }, huawei: { state: "connected" } },
    });
    const events = hub.mergeBridgeSnapshot({
      agentTeams: [{ id: "team-1" }],
      providers: { agentTeams: { state: "connected" } },
    });

    expect(events).toContainEqual({
      type: "provider.status",
      providerId: "agentTeams",
      state: "connected",
    });
    expect(events).not.toContainEqual({
      type: "provider.status",
      providerId: "huawei",
      state: "not-configured",
    });
  });

  it("splits a live snapshot into fleet and bridge ownership", () => {
    const bus = new FusionEventBus();
    const hub = new FusionStateHub({ bus });
    hub.mergeLiveSnapshot({
      nodes: [{ id: "n1", status: "online", configState: "current" }],
      tasks: [{ id: "t1", status: "running", progress: 20 }],
      rooms: [{ id: "room-1" }],
      providers: {
        nodes: { state: "connected" },
        huawei: { state: "connected" },
        agentTeams: { state: "connected" },
        room: { state: "offline" },
      },
    });

    const events = hub.mergeFleetSnapshot({
      nodes: [{ id: "n1", status: "degraded", configState: "current" }],
    });

    expect(events).toContainEqual({ type: "node.updated", nodeId: "n1" });
    expect(events).not.toContainEqual({
      type: "provider.status",
      providerId: "room",
      state: "not-configured",
    });
  });

  it("refreshes the fleet slice on its own timer", async () => {
    const bus = new FusionEventBus();
    const read = vi.fn()
      .mockResolvedValueOnce({ tasks: [{ id: "t1", status: "running", progress: 20 }] })
      .mockResolvedValue({ tasks: [{ id: "t1", status: "completed", progress: 100 }] });
    const hub = new FusionStateHub({ bus, intervalMs: 250 });
    hub.onFleetRefresh(read);

    await hub.refreshFleet();
    await hub.refreshFleet();

    expect(read).toHaveBeenCalledTimes(2);
    expect(bus.lastSeq).toBe(2);
  });

  it("does not overlap concurrent fleet refreshes", async () => {
    const bus = new FusionEventBus();
    let resolve: ((value: Partial<FusionWatchSnapshot>) => void) | undefined;
    const read = vi.fn(() => new Promise<Partial<FusionWatchSnapshot>>((r) => {
      resolve = r;
    }));
    const hub = new FusionStateHub({ bus });
    hub.onFleetRefresh(read);

    const first = hub.refreshFleet();
    const second = hub.refreshFleet();
    expect(read).toHaveBeenCalledTimes(1);
    resolve?.({});
    await Promise.all([first, second]);
  });

  it("reports fleet read failures without throwing", async () => {
    const bus = new FusionEventBus();
    const onError = vi.fn();
    const hub = new FusionStateHub({ bus, onError });
    hub.onFleetRefresh(async () => {
      throw new Error("provider exploded");
    });

    await expect(hub.refreshFleet()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("starts and stops its interval", () => {
    const bus = new FusionEventBus();
    const setIntervalFn = vi.fn(() => "handle");
    const clearIntervalFn = vi.fn();
    const hub = new FusionStateHub({
      bus,
      intervalMs: 1000,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    });

    hub.start();
    expect(hub.running).toBe(true);
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 1000);
    hub.start();
    expect(setIntervalFn).toHaveBeenCalledTimes(1);

    hub.stop();
    expect(hub.running).toBe(false);
    expect(clearIntervalFn).toHaveBeenCalledWith("handle");
  });
});
