import { describe, expect, it } from "vitest";
import type { AgentTeamRecord } from "@dsh-fusion/core";
import {
  orderedProviderStatuses,
  resolveBridgeSources,
} from "./bridge-sources-model.js";

const liveTeam: AgentTeamRecord = {
  id: "agent-teams:release",
  providerId: "agent-teams",
  name: "Release Team",
  workspace: "F:\\AI\\release",
  phase: "running",
  captainSessionId: "agent-teams:release:captain",
  memberIds: ["agent-teams:release:reviewer"],
  taskIds: ["agent-teams:release:review"],
};

describe("resolveBridgeSources", () => {
  it("uses demo data only when no provider status is available", () => {
    const bridge = resolveBridgeSources({
      agentTeams: [liveTeam],
      agentFlows: undefined,
      rooms: [],
    });

    expect(bridge.agentTeams).toEqual({
      items: [liveTeam],
      mode: "live",
    });
    expect(bridge.agentFlows.mode).toBe("demo");
    expect(bridge.agentFlows.fallbackReason).toBe("missing");
    expect(bridge.rooms.mode).toBe("demo");
    expect(bridge.rooms.fallbackReason).toBe("empty");
  });

  it("does not substitute demo records when live providers are empty or unavailable", () => {
    const bridge = resolveBridgeSources({
      agentTeams: [],
      agentFlows: [],
      rooms: [],
      providers: {
        agentTeams: { state: "connected", checkedAt: 1 },
        agentBus: { state: "offline", checkedAt: 2, message: "HTTP 503" },
        room: { state: "not-configured", checkedAt: 3 },
      },
    });

    expect(bridge.agentTeams).toEqual({ items: [], mode: "live" });
    expect(bridge.agentFlows).toEqual({
      items: [],
      mode: "unavailable",
      fallbackReason: "unavailable",
    });
    expect(bridge.rooms).toEqual({
      items: [],
      mode: "unavailable",
      fallbackReason: "unavailable",
    });
  });

  it("does not label cached records as live when the provider is offline", () => {
    const bridge = resolveBridgeSources({
      agentTeams: [liveTeam],
      providers: {
        agentTeams: { state: "offline", checkedAt: 1, message: "refresh failed" },
      },
    });

    expect(bridge.agentTeams).toEqual({
      items: [],
      mode: "unavailable",
      fallbackReason: "unavailable",
    });
  });

  it("keeps provider statuses optional and orders known sources", () => {
    const bridge = resolveBridgeSources({
      providers: {
        huawei: { state: "offline", checkedAt: 1 },
        agentBus: { state: "connected", checkedAt: 2, version: "0.2.0" },
        nodes: { state: "degraded", checkedAt: 3 },
      },
    });

    expect(bridge.providers.agentBus?.state).toBe("connected");
    expect(orderedProviderStatuses(bridge.providers).map(([providerId]) => providerId))
      .toEqual(["nodes", "agentBus", "huawei"]);
  });
});
