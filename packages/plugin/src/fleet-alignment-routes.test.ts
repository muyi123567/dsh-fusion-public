import { describe, expect, it, vi } from "vitest";
import { AlignmentError, type WhaleAlignmentServiceV1 } from "./fleet-alignment.js";
import { createFleetAlignmentRoutes } from "./fleet-alignment-routes.js";
import type { FleetPlanReport } from "./fleet-plan.js";

const SHA = `sha256:${"a".repeat(64)}`;

function service(): WhaleAlignmentServiceV1 {
  const plan: FleetPlanReport = {
    contractVersion: 1, hostId: SHA, expectedDigest: SHA, observedDigest: SHA,
    overall: "ready", steps: [],
  };
  const request = {
    contractVersion: 1 as const, id: "align-1", hostId: SHA, requestedBy: "panel", source: "web",
    createdAt: "2026-11-24T06:00:00.000Z", updatedAt: "2026-11-24T06:00:00.000Z",
    status: "pending" as const, planDigest: `sha256:${"b".repeat(64)}`, plan, steps: [],
  };
  return {
    contractVersion: 1,
    plan: vi.fn(async () => ({
      contractVersion: 1 as const, hostId: SHA, planDigest: `sha256:${"c".repeat(64)}`, plan, steps: [],
    })),
    create: vi.fn(async () => request),
    approve: vi.fn(async () => ({ ...request, status: "succeeded" as const })),
    cancel: vi.fn(async () => ({ ...request, status: "cancelled" as const })),
    list: () => [request],
    get: id => (id === "align-1" ? request : undefined),
  };
}

function exchange(routes: ReturnType<typeof createFleetAlignmentRoutes>, path: string, options: {
  method?: string; url?: string; headers?: Record<string, string>; body?: unknown;
} = {}) {
  const route = routes.find(item => item.path === path);
  if (route === undefined) throw new Error("route missing");
  const result = { status: 0, body: "" };
  const response = {
    writeHead(status: number) { result.status = status; },
    end(body?: string) { result.body = body ?? ""; },
  };
  const request = {
    method: options.method ?? "GET",
    url: options.url ?? path,
    headers: {
      ...(options.method === "POST" ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.body,
  };
  return (route.handler as unknown as (request: unknown, response: unknown) => Promise<void>)(request, response)
    .then(() => ({ ...result, json: result.body === "" ? undefined : JSON.parse(result.body) as unknown }));
}

describe("fleet alignment routes", () => {
  it("lists requests and returns one by id", async () => {
    const routes = createFleetAlignmentRoutes({ service: service(), authenticate: () => false });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/alignment")).json).toMatchObject({
      requests: [{ id: "align-1" }],
    });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/alignment", {
      url: "/plugins/dsh-fusion/fleet/alignment?id=align-1",
    })).json).toMatchObject({ id: "align-1" });
  });

  it("plans, requests, approves and cancels with same-origin checks", async () => {
    const svc = service();
    const routes = createFleetAlignmentRoutes({
      service: svc,
      authenticate: () => false,
      readBody: async request => (request as unknown as { body?: Record<string, unknown> }).body ?? {},
    });
    const planPath = "/plugins/dsh-fusion/fleet/alignment/plan";
    expect((await exchange(routes, planPath, {
      method: "POST", headers: { origin: "https://evil.example" }, body: { hostId: SHA },
    })).status).toBe(403);
    expect((await exchange(routes, planPath, { method: "POST", body: { hostId: SHA } })).json)
      .toMatchObject({ planDigest: expect.stringMatching(/^sha256:/u) });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/alignment/request", {
      method: "POST", body: { hostId: SHA },
    })).json).toMatchObject({ request: { id: "align-1" } });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/alignment/approve", {
      method: "POST", body: { id: "align-1" },
    })).json).toMatchObject({ request: { status: "succeeded" } });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/alignment/cancel", {
      method: "POST", body: { id: "align-1" },
    })).json).toMatchObject({ request: { status: "cancelled" } });
  });

  it("maps unknown requests and invalid plans", async () => {
    const svc = service();
    svc.plan = vi.fn(async () => {
      throw new AlignmentError("alignment/local-only", "local only");
    });
    const routes = createFleetAlignmentRoutes({
      service: svc,
      authenticate: () => false,
      readBody: async request => (request as unknown as { body?: Record<string, unknown> }).body ?? {},
    });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/alignment/plan", {
      method: "POST", body: { hostId: SHA },
    })).status).toBe(400);
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/alignment", {
      url: "/plugins/dsh-fusion/fleet/alignment?id=missing",
    })).status).toBe(404);
  });
});
