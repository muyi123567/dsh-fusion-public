import { describe, expect, it } from "vitest";
import {
  buildRoomSessionPath,
  createJsonFetcher,
  decodeAgentBusSnapshot,
  decodeAgentTeamsSnapshot,
  decodeRoomSnapshot,
  emptyAgentBusBridgeResult,
  emptyAgentTeamsBridgeResult,
  emptyRoomBridgeResult,
  loadAgentBusSnapshot,
  loadAgentTeamsSnapshot,
  loadRoomSessionSnapshot,
  mapAgentBusSnapshot,
  mapAgentTeamsSnapshot,
  mapRoomSnapshot,
  type FetchLike,
} from "./domain.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fusion domain bridges", () => {
  it("maps AgentTeams members and dependency tasks into Fusion records", () => {
    const result = mapAgentTeamsSnapshot({
      teams: [{
        workspace: "AI",
        teamId: "release",
        name: "Release Team",
        captainSessionId: "captain-1",
        phase: "running",
        members: [{
          id: "reviewer",
          name: "Reviewer",
          role: "Review code",
          provider: "deepseek",
          model: "v4",
          reasoningEffort: "max",
          status: "working",
          activity: "working",
          progress: 50,
          done: 1,
          total: 2,
          currentTask: "review",
          unread: 0,
        }],
        tasks: [{
          id: "review",
          subject: "Review release",
          description: "Review the release candidate",
          status: "claimed",
          state: "open",
          assignee: "Reviewer",
          model: "v4",
          dependencies: ["implement"],
          depth: 1,
          verdict: "PENDING",
          updatedAt: 1000,
        }],
        messageCount: 2,
        captainInbox: [{ from: "Reviewer", content: "Release checks passed" }],
      }],
    });

    expect(result.agentTeams[0]).toMatchObject({
      id: "agent-teams:release",
      phase: "running",
      memberIds: ["reviewer"],
      taskIds: ["agent-teams:release:review"],
    });
    expect(result.bots.find((bot) => bot.id === "captain-1")).toMatchObject({
      id: "captain-1",
      isMain: true,
      recentMessages: [{
        from: "Reviewer",
        content: "Release checks passed",
      }],
    });
    expect(result.bots.find((bot) => bot.id === "reviewer")).toMatchObject({
      id: "reviewer",
      providerId: "agent-teams",
      reasoningEffort: "max",
      status: "working",
    });
    expect(result.tasks[0]).toMatchObject({
      id: "agent-teams:release:review",
      status: "claimed",
      transport: "dsh-fleet",
      dependsOnTaskIds: ["agent-teams:release:implement"],
      requestedByBotId: "reviewer",
      sessionId: "reviewer",
    });
    expect(result.tasks[0]?.progress).toBeUndefined();
    expect(result.tasks[0]?.evidence).toContainEqual({
      kind: "summary",
      label: "verdict",
      value: "PENDING",
    });

    const archived = mapAgentTeamsSnapshot({
      teams: [{
        teamId: "old-team",
        captainSessionId: "captain-old",
        members: [{ id: "member-old", status: "idle" }],
        tasks: [],
      }],
    }, true);
    expect(archived.agentTeams[0]?.phase).toBe("archived");
    expect(archived.bots[0]?.status).toBe("offline");
    expect(archived.sessions[0]?.status).toBe("finished");
  });

  it("preserves DSH AgentTeam task revision and write scopes", () => {
    const result = mapAgentTeamsSnapshot({
      teams: [{
        teamId: "root-session-1",
        captainSessionId: "captain-1",
        tasks: [
          {
            id: "implement",
            subject: "Implement",
            status: "pending",
            revision: 4,
            ownerId: "implementer-session",
            ownerName: "Implementer",
            blockedBy: ["design"],
            writeScopes: ["packages/plugin/src"],
            ready: false,
            writeScopeWarnings: ["packages/plugin/src overlaps design"],
          },
          { id: "design", subject: "Design", status: "completed", revision: 2 },
        ],
      }],
    });

    expect(result.tasks[0]).toMatchObject({
      id: "agent-teams:root-session-1:implement",
      dependsOnTaskIds: ["agent-teams:root-session-1:design"],
      agentTeamTask: {
        teamId: "root-session-1",
        taskId: "implement",
        revision: 4,
        ownerId: "implementer-session",
        ownerName: "Implementer",
        blockedBy: ["design"],
        writeScopes: ["packages/plugin/src"],
        ready: false,
        writeScopeWarnings: ["packages/plugin/src overlaps design"],
      },
    });
  });

  it("maps Agent Bus tasks, reports, sessions, and flows", () => {
    const result = mapAgentBusSnapshot({
      workspaces: [{ id: "w1", title: "AI", path: "F:\\AI" }],
      sessions: [{
        id: "session-1",
        title: "Reviewer Session",
        live: true,
      }],
      tasks: [{
        id: "task-1",
        title: "Audit bridge",
        content: "Audit the bridge",
        status: "completed",
        flowId: "flow-1",
        dependencies: [],
        assignedBy: "session-0",
        assignedTo: "session-1",
        assignedReviewer: "session-0",
        reportZone: "inline",
        hasReportRef: true,
        outcome: "success",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
      }],
      flows: [{
        id: "flow-1",
        name: "Release flow",
        description: "Audit and release",
        workspacePath: "F:\\AI",
        archived: false,
      }],
      stats: {},
    });

    expect(result.tasks[0]).toMatchObject({
      id: "agent-bus:task-1",
      status: "completed",
      sessionId: "agent-bus:session-1",
    });
    expect(result.tasks[0]?.progress).toBeUndefined();
    expect(result.tasks[0]?.evidence).toContainEqual({
      kind: "summary",
      label: "reportZone",
      value: "inline",
    });
    expect(result.tasks[0]?.evidence).toContainEqual({
      kind: "summary",
      label: "hasReportRef",
      value: "true",
    });
    expect(result.agentFlows[0]).toMatchObject({
      id: "agent-bus:flow-1",
      taskIds: ["agent-bus:task-1"],
      archived: false,
    });
    expect(result.sessions[0]).toMatchObject({
      id: "agent-bus:session-1",
      status: "live",
    });
  });

  it("maps the v0.6.0 Room session whitelist without inventing activity", () => {
    const result = mapRoomSnapshot({
      id: "room-1",
      name: "Release Room",
      topic: "Coordinate release",
      leaderSessionId: "leader-1",
      status: "open",
      members: [{
        memberId: "m1",
        name: "Reviewer",
        status: "active",
        connection: { sessionId: "session-r1" },
      }],
    });

    expect(result.rooms[0]).toMatchObject({
      id: "agent-room:room-1",
      status: "open",
      memberIds: ["agent-room:room-1:m1"],
      activityCount: 0,
    });
    expect(result.sessions).toContainEqual(expect.objectContaining({
      id: "session-r1",
      status: "live",
    }));
  });

  it("keeps mappings deterministic and fail-soft for malformed or empty payloads", () => {
    expect(mapAgentTeamsSnapshot(null)).toEqual(emptyAgentTeamsBridgeResult());
    expect(mapAgentBusSnapshot({ sessions: "bad", tasks: {}, flows: null })).toEqual(emptyAgentBusBridgeResult());
    expect(mapRoomSnapshot({ rooms: [] })).toEqual(emptyRoomBridgeResult());

    const teamsPayload = {
      teams: [{
        teamId: "pure",
        members: "invalid",
        tasks: [{ id: "task-1", state: "pending", updatedAt: Number.MAX_SAFE_INTEGER }],
      }],
    };
    expect(mapAgentTeamsSnapshot(teamsPayload)).toEqual(mapAgentTeamsSnapshot(teamsPayload));

    const bus = mapAgentBusSnapshot({
      sessions: [{ id: "session-1", title: "Session" }],
      tasks: [{
        id: "task-1",
        status: "input-required",
        assignedTo: "session-1",
        createdAt: "invalid",
        updatedAt: Number.POSITIVE_INFINITY,
      }],
      flows: [{ id: "flow-1", name: "Flow", description: "Line", archived: false }],
    });
    expect(bus.tasks[0]).toMatchObject({
      id: "agent-bus:task-1",
      status: "claimed",
      createdAt: "1970-01-01T00:00:00.000Z",
    });
    expect(bus.sessions[0]?.updatedAt).toBe("1970-01-01T00:00:00.000Z");

    const rooms = mapRoomSnapshot({
      rooms: [{
        id: "room-2",
        name: "Room",
        status: "open",
        updatedAt: "invalid",
        members: [{ memberId: "m1", status: "error" }],
        events: [{ id: "event-1", type: "room.created" }],
      }],
    });
    expect(rooms.sessions[0]).toMatchObject({
      status: "error",
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
  });
});

describe("Fusion bridge transport", () => {
  it("fetches same-origin plugin state and forwards request headers", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ teams: [], sessions: [], tasks: [], flows: [] });
    };
    const fetchJson = createJsonFetcher({
      baseUrl: "https://dsh.example/base/",
      fetchImpl,
      headers: {
        cookie: "session=abc",
        "x-dsh-client": "browser",
      },
    });

    await loadAgentTeamsSnapshot(fetchJson);
    await loadAgentBusSnapshot(fetchJson);

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/plugins/dsh-agent-teams/state",
      "/plugins/dsh-agent-teams/state",
      "/plugins/dsh-agent-bus/state",
    ]);
    expect(requests.map((request) => new URL(request.url).search)).toEqual([
      "",
      "?archived=1",
      "",
    ]);
    for (const request of requests) {
      const headers = new Headers(request.init?.headers);
      expect(request.init?.method).toBe("GET");
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("cookie")).toBe("session=abc");
      expect(headers.get("sec-fetch-site")).toBe("same-origin");
      expect(headers.get("x-dsh-client")).toBe("browser");
    }
  });

  it("loads a configurable Room session and forces the native client header", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({
        rooms: [{
          id: "room-1",
          name: "Release Room",
          status: "open",
          leaderSessionId: "leader-1",
          members: [{
            memberId: "m1",
            name: "Reviewer",
            status: "working",
            connection: { sessionId: "session-r1" },
            updatedAt: "2026-01-01T00:00:00.000Z",
          }],
          events: [{ id: "event-1", type: "room.created" }],
        }],
      });
    };
    const fetchJson = createJsonFetcher({
      baseUrl: "https://dsh.example",
      fetchImpl,
      headers: { cookie: "session=abc" },
    });

    const result = await loadRoomSessionSnapshot(fetchJson, "session/with space", {
      endpoint: "/custom/room/<sessionId>",
      headers: { "x-agent-team-room-client": "0" },
    });

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/custom/room/session%2Fwith%20space");
    const headers = new Headers(requests[0]!.init?.headers);
    expect(headers.get("cookie")).toBe("session=abc");
    expect(headers.get("sec-fetch-site")).toBe("same-origin");
    expect(headers.get("x-agent-team-room-client")).toBe("1");
    expect(result.rooms[0]).toMatchObject({
      id: "agent-room:room-1",
      activityCount: 1,
    });
    expect(result.sessions[0]).toMatchObject({
      id: "session-r1",
      status: "live",
    });
  });

  it("times out even when the injected fetch never settles", async () => {
    const fetchJson = createJsonFetcher({
      baseUrl: "https://dsh.example",
      fetchImpl: () => new Promise<Response>(() => {}),
      timeoutMs: 5,
    });

    await expect(fetchJson("/plugins/slow")).rejects.toMatchObject({
      name: "JsonFetchError",
      code: "TIMEOUT",
    });
  });

  it("fails soft for HTTP errors, invalid JSON, and empty Room sessions", async () => {
    const httpError = createJsonFetcher({
      baseUrl: "https://dsh.example",
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    });
    await expect(loadAgentTeamsSnapshot(httpError)).resolves.toEqual(emptyAgentTeamsBridgeResult());

    const invalidJson = createJsonFetcher({
      baseUrl: "https://dsh.example",
      fetchImpl: async () => new Response("not-json"),
    });
    await expect(loadAgentBusSnapshot(invalidJson)).resolves.toEqual(emptyAgentBusBridgeResult());

    let called = false;
    const result = await loadRoomSessionSnapshot(async () => {
      called = true;
      return {};
    }, " ");
    expect(called).toBe(false);
    expect(result).toEqual(emptyRoomBridgeResult());
  });

  it("propagates source failures when the runtime requests fail-fast status", async () => {
    const unavailable = createJsonFetcher({
      baseUrl: "https://dsh.example",
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    });

    await expect(loadAgentTeamsSnapshot(unavailable, { failFast: true })).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 503,
    });
    await expect(loadAgentBusSnapshot(unavailable, { failFast: true })).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 503,
    });
    await expect(loadRoomSessionSnapshot(unavailable, "session-1", {
      failFast: true,
    })).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 503,
    });
  });

  it("classifies bridge snapshots with the exported decoders", () => {
    expect(decodeAgentBusSnapshot({ tasks: [] }).kind).toBe("recognized");
    expect(decodeAgentBusSnapshot({ tasks: [] })).toMatchObject({ kind: "recognized" });
    expect(decodeAgentBusSnapshot({ tasks: {} })).toMatchObject({
      kind: "schema-mismatch",
      detail: "tasks",
    });
    expect(decodeAgentBusSnapshot(null)).toMatchObject({
      kind: "schema-mismatch",
      detail: "root",
    });
    expect(decodeAgentTeamsSnapshot({ teams: [] }).kind).toBe("recognized");
    expect(decodeAgentTeamsSnapshot([]).kind).toBe("recognized");
    expect(decodeAgentTeamsSnapshot({ teams: {} })).toMatchObject({
      kind: "schema-mismatch",
      detail: "teams",
    });
    // A record carrying none of the known collections extracts
    // nothing in the mappers either; recognizing it would disguise a
    // drifted payload (e.g. a renamed envelope) as a legitimately
    // empty result. Partial payloads stay recognized: a Bus snapshot
    // with only flows, or only sessions, is a legitimate subset.
    expect(decodeAgentBusSnapshot({})).toMatchObject({
      kind: "schema-mismatch",
      detail: "shape",
    });
    expect(decodeAgentBusSnapshot({ data: { tasks: [] } })).toMatchObject({
      kind: "schema-mismatch",
      detail: "shape",
    });
    expect(decodeAgentBusSnapshot({ flows: [] }).kind).toBe("recognized");
    expect(decodeAgentBusSnapshot({ sessions: [] }).kind).toBe("recognized");
    // AgentTeams records have exactly one collection, so a record
    // without it already fails on the teams field itself.
    expect(decodeAgentTeamsSnapshot({})).toMatchObject({
      kind: "schema-mismatch",
      detail: "teams",
    });
    expect(decodeAgentTeamsSnapshot({ data: [] })).toMatchObject({
      kind: "schema-mismatch",
      detail: "teams",
    });
    // Room payloads are heterogeneous by contract: an array of rooms,
    // a { rooms } envelope, a { room } envelope, or one room object.
    expect(decodeRoomSnapshot({ rooms: [] }).kind).toBe("recognized");
    expect(decodeRoomSnapshot([]).kind).toBe("recognized");
    expect(decodeRoomSnapshot({ room: { id: "room-1" } }).kind).toBe("recognized");
    expect(decodeRoomSnapshot({ id: "room-1", status: "open" }).kind).toBe("recognized");
    expect(decodeRoomSnapshot({ rooms: {} })).toMatchObject({
      kind: "schema-mismatch",
      detail: "rooms",
    });
    expect(decodeRoomSnapshot({ room: "room-1" })).toMatchObject({
      kind: "schema-mismatch",
      detail: "room",
    });
    expect(decodeRoomSnapshot(null)).toMatchObject({
      kind: "schema-mismatch",
      detail: "root",
    });
    expect(decodeRoomSnapshot("bad")).toMatchObject({
      kind: "schema-mismatch",
      detail: "root",
    });
    // A plain object with no rooms collection, no room envelope, and
    // no usable id of its own is not a single Room: recognizing it
    // would map a drifted payload (e.g. a renamed envelope) to an
    // empty result and call that success.
    expect(decodeRoomSnapshot({})).toMatchObject({
      kind: "schema-mismatch",
      detail: "shape",
    });
    expect(decodeRoomSnapshot({ data: { rooms: [] } })).toMatchObject({
      kind: "schema-mismatch",
      detail: "shape",
    });
    expect(decodeRoomSnapshot({ name: "Release Room" })).toMatchObject({
      kind: "schema-mismatch",
      detail: "shape",
    });
    expect(decodeRoomSnapshot({ room: {} })).toMatchObject({
      kind: "schema-mismatch",
      detail: "room",
    });
    expect(decodeRoomSnapshot({ room: { name: "Release Room" } })).toMatchObject({
      kind: "schema-mismatch",
      detail: "room",
    });
  });

  it("distinguishes Room schema drift from legitimate Room payload shapes", async () => {
    const fetcher = (payload: unknown) => async () => payload;

    await expect(loadRoomSessionSnapshot(fetcher({ rooms: {} }), "session-1", { failFast: true }))
      .rejects.toThrow("BRIDGE_SCHEMA_MISMATCH:room:rooms");
    await expect(loadRoomSessionSnapshot(fetcher({ rooms: {} }), "session-1"))
      .rejects.toThrow("BRIDGE_SCHEMA_MISMATCH:room:rooms");
    await expect(loadRoomSessionSnapshot(fetcher(null), "session-1", { failFast: true }))
      .rejects.toThrow("BRIDGE_SCHEMA_MISMATCH:room:root");
    await expect(loadRoomSessionSnapshot(fetcher({}), "session-1", { failFast: true }))
      .rejects.toThrow("BRIDGE_SCHEMA_MISMATCH:room:shape");
    await expect(loadRoomSessionSnapshot(fetcher({ error: "not found" }), "session-1"))
      .rejects.toThrow("BRIDGE_SCHEMA_MISMATCH:room:shape");
    await expect(loadRoomSessionSnapshot(fetcher({ data: { rooms: [] } }), "session-1", { failFast: true }))
      .rejects.toThrow("BRIDGE_SCHEMA_MISMATCH:room:shape");

    await expect(loadRoomSessionSnapshot(fetcher({ rooms: [] }), "session-1", { failFast: true }))
      .resolves.toEqual(emptyRoomBridgeResult());
    await expect(loadRoomSessionSnapshot(fetcher([]), "session-1", { failFast: true }))
      .resolves.toEqual(emptyRoomBridgeResult());
    const single = await loadRoomSessionSnapshot(
      fetcher({ id: "room-9", status: "open" }),
      "session-1",
      { failFast: true },
    );
    expect(single.rooms).toHaveLength(1);
    expect(single.rooms[0]?.id).toContain("room-9");
  });

  it("distinguishes schema drift from a legitimately empty bridge snapshot", async () => {
    const fetcher = (payload: unknown) => async () => payload;

    // Review repro: malformed collections used to resolve as an empty
    // result even with failFast, so the runtime marked the source
    // connected with zero tasks and the drift stayed invisible.
    await expect(loadAgentBusSnapshot(fetcher({ sessions: "bad", tasks: {}, flows: null }), { failFast: true }))
      .rejects.toThrow("BRIDGE_SCHEMA_MISMATCH:agent-bus");
    await expect(loadAgentBusSnapshot(fetcher({ tasks: {} }), { failFast: true }))
      .rejects.toThrow("BRIDGE_SCHEMA_MISMATCH:agent-bus:tasks");
    // A schema mismatch is an incompatibility signal, not a transport
    // failure: it surfaces even without failFast instead of silently
    // resolving to an empty "success".
    await expect(loadAgentBusSnapshot(fetcher({ tasks: {} })))
      .rejects.toThrow("BRIDGE_SCHEMA_MISMATCH:agent-bus:tasks");
    await expect(loadAgentBusSnapshot(fetcher(null), { failFast: true }))
      .rejects.toThrow("BRIDGE_SCHEMA_MISMATCH:agent-bus:root");
    await expect(loadAgentBusSnapshot(fetcher({}), { failFast: true }))
      .rejects.toThrow("BRIDGE_SCHEMA_MISMATCH:agent-bus:shape");
    await expect(loadAgentBusSnapshot(fetcher({ data: { tasks: [] } })))
      .rejects.toThrow("BRIDGE_SCHEMA_MISMATCH:agent-bus:shape");
    await expect(loadAgentTeamsSnapshot(fetcher({}), { failFast: true }))
      .rejects.toThrow("BRIDGE_SCHEMA_MISMATCH:agent-teams:teams");
    await expect(loadAgentTeamsSnapshot(fetcher({ data: [] })))
      .rejects.toThrow("BRIDGE_SCHEMA_MISMATCH:agent-teams:teams");
    await expect(loadAgentTeamsSnapshot(fetcher({ teams: {} }), { failFast: true }))
      .rejects.toThrow("BRIDGE_SCHEMA_MISMATCH:agent-teams:teams");

    // Legitimately empty payloads still resolve as empty results.
    await expect(loadAgentBusSnapshot(fetcher({ tasks: [], sessions: [], flows: [] }), { failFast: true }))
      .resolves.toEqual(emptyAgentBusBridgeResult());
    await expect(loadAgentTeamsSnapshot(fetcher({ teams: [] }), { failFast: true }))
      .resolves.toEqual(emptyAgentTeamsBridgeResult());
    await expect(loadAgentTeamsSnapshot(fetcher([]), { failFast: true }))
      .resolves.toEqual(emptyAgentTeamsBridgeResult());
  });

  it("maps optional main-branch Room activity and conversation when present", async () => {
    const requests: string[] = [];
    const fetchJson = createJsonFetcher({
      baseUrl: "https://dsh.example",
      fetchImpl: async (url) => {
        const parsed = new URL(String(url));
        requests.push(`${parsed.pathname}${parsed.search}`);
        return jsonResponse({
          rooms: [{
            id: "room-main",
            name: "Release Room",
            topic: "Release",
            leaderSessionId: "leader-1",
            status: "open",
            members: [{
              memberId: "leader-member",
              kind: "leader",
              name: "Lead",
              status: "leader",
              connection: { protocol: "dsh.session/v1", sessionId: "leader-1" },
            }],
            activity: [{
              id: "event-1",
              type: "message.direct",
              at: "2026-10-21T00:00:00.000Z",
              targetMemberId: "leader-member",
              acceptedCount: 1,
              failedCount: 0,
              label: "Message accepted for Lead",
            }],
            conversation: {
              messages: [{
                id: "message-1",
                at: 1_760_000_000_000,
                role: "leader",
                authorMemberId: "leader-member",
                authorName: "Lead",
                recipientMemberIds: ["member-1"],
                text: "Please verify the release",
                status: "accepted",
                relayId: "relay-1",
                mode: "direct",
              }],
              unavailableMemberIds: [],
              hiddenMixedReplyCount: 0,
            },
          }],
        });
      },
    });

    const result = await loadRoomSessionSnapshot(fetchJson, "leader-1");

    expect(requests).toEqual([
      "/agent-team-room/api/session/leader-1",
    ]);
    expect(result.rooms[0]).toMatchObject({
      id: "agent-room:room-main",
      activityCount: 1,
      activity: [{
        label: "Message accepted for Lead",
        acceptedCount: 1,
        targetMemberId: "agent-room:room-main:leader-member",
      }],
      conversation: {
        messages: [{
          authorMemberId: "agent-room:room-main:leader-member",
          recipientMemberIds: ["member-1"],
          text: "Please verify the release",
          role: "leader",
          mode: "direct",
        }],
      },
    });
  });

  it("builds the default Room path with an encoded session id", () => {
    expect(buildRoomSessionPath("session/with space")).toBe(
      "/agent-team-room/api/session/session%2Fwith%20space",
    );
  });
});
