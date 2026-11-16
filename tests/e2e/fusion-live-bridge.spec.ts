import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as hostPlugin from "../../packages/plugin/src/index.js";

type RouteHandler = (
  request: { method?: string; headers?: Record<string, string | string[] | undefined> },
  response: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (body?: string) => void;
  },
) => void | Promise<void>;

interface CapturedRequest {
  path: string;
  cookie?: string;
  roomClient?: string;
}

interface FusionStatePayload {
  demo: boolean;
  sources: Record<string, string>;
  bots: unknown[];
  groups: unknown[];
  sessions: unknown[];
  tasks: Array<{
    id: string;
    status: string;
    progress?: number;
    evidence: Array<{ label: string; value: string }>;
  }>;
  agentTeams: Array<{ phase: string }>;
  agentFlows: unknown[];
  rooms: unknown[];
  providers: Record<string, { state: string }>;
}

const requests: CapturedRequest[] = [];
let server: ReturnType<typeof createServer>;
let basePort = 0;

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function requestHandler(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  requests.push({
    path: `${url.pathname}${url.search}`,
    ...(typeof request.headers.cookie === "string" ? { cookie: request.headers.cookie } : {}),
    ...(typeof request.headers["x-agent-team-room-client"] === "string"
      ? { roomClient: request.headers["x-agent-team-room-client"] }
      : {}),
  });

  if (url.pathname === "/plugins/dsh-agent-teams/state" && url.search === "?archived=1") {
    sendJson(response, {
      teams: [{
        teamId: "archived-team",
        name: "Archived Team",
        captainSessionId: "session-old",
        phase: "archived",
        members: [{ id: "session-old", name: "Old Member", status: "removed" }],
        tasks: [],
      }],
    });
    return;
  }

  if (url.pathname === "/plugins/dsh-agent-teams/state") {
    sendJson(response, {
      teams: [{
        workspace: "AI",
        teamId: "release",
        name: "Release Team",
        captainSessionId: "session-cap",
        phase: "running",
        members: [{
          id: "session-reviewer",
          name: "Reviewer",
          role: "reviewer",
          provider: "deepseek",
          model: "v4",
          status: "working",
          activity: "working",
          progress: 100,
          done: 1,
          total: 1,
          currentTask: "review-task",
          unread: 1,
        }],
        tasks: [{
          id: "review-task",
          subject: "Audit release",
          description: "Review the release candidate",
          status: "claimed",
          state: "open",
          assignee: "Reviewer",
          model: "deepseek/v4",
          dependencies: [],
          depth: 0,
          updatedAt: 1_760_000_000_000,
        }],
        messageCount: 1,
        captainInbox: [],
      }],
    });
    return;
  }

  if (url.pathname === "/plugins/dsh-agent-bus/state") {
    sendJson(response, {
      workspaces: [{ id: "workspace-1", title: "AI", path: "/srv/projects" }],
      sessions: [{
        id: "session-bus",
        title: "Release reviewer",
        workspaceId: "workspace-1",
        live: true,
        archived: false,
      }],
      tasks: [{
        id: "bus-task-1",
        workspacePath: "/srv/projects",
        status: "completed",
        settled: true,
        content: "Verify release",
        title: null,
        contentPreview: "Verify release",
        mode: "followup",
        assignedBy: "session-lead",
        assignedTo: "session-bus",
        assignedReviewer: "session-lead",
        byTitle: "Lead",
        toTitle: "Reviewer",
        reviewerTitle: "Lead",
        retries: 0,
        reason: null,
        outcome: "success",
        feedback: "Checks passed",
        question: null,
        reportZone: "inline",
        hasReportRef: true,
        turn: 1,
        staff: [],
        executorLive: true,
        archived: false,
        dependencies: [],
        acceptanceCriteria: "All checks pass",
        flowId: "flow-1",
        auto: false,
        createdAt: "2026-10-21T00:00:00.000Z",
        updatedAt: "2026-10-21T00:01:00.000Z",
      }],
      flows: [{
        id: "flow-1",
        name: "Release flow",
        description: "Verify and release",
        workspacePath: "/srv/projects",
        taskCount: 1,
        unsettledCount: 0,
        archived: false,
      }],
      stats: { queued: 0, submitted: 0, working: 0, "input-required": 0, completed: 1, failed: 0, canceled: 0, total: 1 },
    });
    return;
  }

  if (url.pathname === "/agent-team-room/api/session/session-cap") {
    sendJson(response, {
      rooms: [{
        id: "room-1",
        name: "Release Room",
        leaderSessionId: "session-cap",
        status: "open",
        members: [{
          memberId: "member-1",
          kind: "leader",
          name: "Release lead",
          connection: { protocol: "dsh.session/v1", sessionId: "session-cap" },
          status: "leader",
        }],
      }],
    });
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
}

async function listen(): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  basePort = (server.address() as AddressInfo).port;
}

async function stateRoute(): Promise<FusionStatePayload> {
  const routes: Array<{ path: string; handler: RouteHandler }> = [];
  const tools: string[] = [];
  const disposers: Array<() => void> = [];
  const ctx: Parameters<typeof hostPlugin.apply>[0] = {
    tools: {
      register(tool: { name: string }) {
        tools.push(tool.name);
        return () => tools.splice(tools.indexOf(tool.name), 1);
      },
      guard() {
        return () => {};
      },
    },
    get(name: string) {
      if (name === "webServer") {
        return {
          host: "127.0.0.1",
          port: basePort,
          register(route: { path: string; handler: RouteHandler }) {
            routes.push(route);
            return () => routes.splice(routes.indexOf(route), 1);
          },
        };
      }
      if (name === "connection") {
        return { requestRejection: () => undefined };
      }
      return undefined;
    },
    on() {
      return () => {};
    },
    effect(callback: () => () => void) {
      disposers.push(callback());
      return () => {};
    },
    logger: {
      info() {},
      warn() {},
    },
  };

  await hostPlugin.apply(ctx, {
    dshVersion: "0.2.0-rc.2",
    standalone: false,
    timeoutMs: 2_000,
  });

  const route = routes.find((candidate) => candidate.path === "/plugins/dsh-fusion/state");
  if (route === undefined) throw new Error("state route missing");
  let status = 0;
  let body = "";
  await route.handler(
    { method: "GET", headers: { cookie: "dsh-auth-test=session" } },
    {
      writeHead(nextStatus: number) {
        status = nextStatus;
      },
      end(nextBody?: string) {
        body = nextBody ?? "";
      },
    },
  );
  for (const dispose of disposers.reverse()) dispose();
  expect(status).toBe(200);
  return JSON.parse(body) as FusionStatePayload;
}

describe("Fusion live bridge", () => {
  beforeAll(async () => {
    server = createServer(requestHandler);
    await listen();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  });

  it("maps real AgentTeams, AgentBus, and Room payloads into the plugin state route", async () => {
    const payload = await stateRoute();

    expect(payload.demo).toBe(false);
    expect(payload.sources.agentTeams).toBe("live");
    expect(payload.sources.agentFlows).toBe("live");
    expect(payload.sources.rooms).toBe("live");
    expect(payload.providers.agentTeams.state).toBe("connected");
    expect(payload.providers.agentBus.state).toBe("connected");
    expect(payload.providers.room.state).toBe("connected");
    expect(payload.agentTeams).toHaveLength(2);
    expect(payload.agentTeams).toContainEqual(expect.objectContaining({ phase: "archived" }));
    expect(payload.agentFlows).toHaveLength(1);
    expect(payload.rooms).toHaveLength(1);

    const claimed = payload.tasks.find((task) => task.id === "agent-teams:release:review-task");
    expect(claimed).toMatchObject({ status: "claimed" });
    expect(claimed?.progress).toBeUndefined();

    const completed = payload.tasks.find((task) => task.id === "agent-bus:bus-task-1");
    expect(completed?.progress).toBeUndefined();
    expect(completed?.evidence).toContainEqual(expect.objectContaining({
      label: "reportZone",
      value: "inline",
    }));
    expect(completed?.evidence).toContainEqual(expect.objectContaining({
      label: "hasReportRef",
      value: "true",
    }));

    expect(requests.some((request) => request.path === "/plugins/dsh-agent-teams/state?archived=1")).toBe(true);
    expect(requests.filter((request) => request.path.startsWith("/plugins/dsh-agent-teams/state")))
      .toContainEqual(expect.objectContaining({ cookie: "dsh-auth-test=session" }));
    expect(requests.some((request) => request.path === "/agent-team-room/api/session/session-cap")).toBe(true);
    expect(requests.find((request) => request.path.startsWith("/agent-team-room/")))
      .toMatchObject({ roomClient: "1" });
  });
});
