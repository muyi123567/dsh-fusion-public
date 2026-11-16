import { describe, expect, it } from "vitest";
import { ReadCounts, bridgeHttpTemplate } from "./read-counts.js";

describe("bridgeHttpTemplate", () => {
  it("drops the query string so live and archived reads share a template", () => {
    expect(bridgeHttpTemplate("/plugins/dsh-agent-teams/state")).toBe("/plugins/dsh-agent-teams/state");
    expect(bridgeHttpTemplate("/plugins/dsh-agent-teams/state?archived=1")).toBe("/plugins/dsh-agent-teams/state");
  });

  it("never records a real room session id", () => {
    expect(bridgeHttpTemplate("/agent-team-room/api/session/session-cap-123"))
      .toBe("/agent-team-room/api/session/{sessionId}");
  });

  it("keeps other paths verbatim apart from the query", () => {
    expect(bridgeHttpTemplate("/plugins/dsh-agent-bus/state")).toBe("/plugins/dsh-agent-bus/state");
    expect(bridgeHttpTemplate("/somewhere/else?x=1")).toBe("/somewhere/else");
  });
});

describe("ReadCounts", () => {
  it("accumulates per layer and snapshots a detached copy", () => {
    const counts = new ReadCounts();
    counts.countRoute("state");
    counts.countRoute("state");
    counts.countRoute("history");
    counts.countLoader("agentTeams");
    counts.countBridgeHttp("/plugins/dsh-agent-teams/state");
    counts.countBridgeHttp("/plugins/dsh-agent-teams/state");
    counts.countBridgeHttp("/agent-team-room/api/session/real-id");
    counts.countController("list");
    counts.countController("page");

    const snapshot = counts.snapshot();
    expect(snapshot).toEqual({
      routes: { state: 2, sessionHub: 0, history: 1 },
      loaders: { agentTeams: 1, agentBus: 0, room: 0 },
      bridgeHttp: {
        total: 3,
        byTemplate: {
          "/plugins/dsh-agent-teams/state": 2,
          "/agent-team-room/api/session/{sessionId}": 1,
        },
      },
      controller: { list: 1, projections: 0, page: 1 },
    });

    // Mutating a snapshot must not reach back into the counters.
    snapshot.routes.state = 99;
    snapshot.bridgeHttp.byTemplate["/plugins/dsh-agent-teams/state"] = 99;
    expect(counts.snapshot().routes.state).toBe(2);
    expect(counts.snapshot().bridgeHttp.byTemplate["/plugins/dsh-agent-teams/state"]).toBe(2);
  });
});
