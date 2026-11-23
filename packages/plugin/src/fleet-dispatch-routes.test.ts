import { describe, expect, it, vi } from "vitest";
import { createFleetDispatchRoutes } from "./fleet-dispatch-routes.js";
import type { FleetDispatchRequestService } from "./fleet-dispatch-requests.js";

const request = {
  id: "request-1", requestId: "req-1", taskId: "task-1", sourceToken: "a".repeat(64),
  jobId: "verify", nodeId: "worker-a", requestedBy: "Chief", source: "mcp:chief",
  status: "pending" as const, createdAt: "2026-11-22T10:00:00.000Z", updatedAt: "2026-11-22T10:00:00.000Z",
};

function service(): FleetDispatchRequestService {
  return {
    path: "/tmp/requests.json",
    create: vi.fn(),
    list: vi.fn(async () => [request]),
    approve: vi.fn(async () => ({ request: { ...request, status: "approved" as const }, attemptId: "attempt-1" })),
    reject: vi.fn(async () => ({ ...request, status: "rejected" as const, reason: "no" })),
  };
}

function harness(requests = service()) {
  let body: Record<string, unknown> = {};
  const routes = createFleetDispatchRoutes({
    service: requests,
    authenticate: () => false,
    readBody: async () => body,
  });
  const invoke = async (path: string, options: { method?: string; headers?: Record<string, string> } = {}) => {
    const result = { status: 0, body: "" };
    const route = routes.find(item => item.path === path)!;
    await route.handler({
      method: options.method ?? "GET",
      url: path,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    }, {
      writeHead: status => { result.status = status; },
      end: value => { result.body = value ?? ""; },
    });
    return { ...result, json: result.body === "" ? undefined : JSON.parse(result.body) as unknown };
  };
  return { requests, invoke, setBody(value: Record<string, unknown>) { body = value; } };
}

describe("fleet dispatch request routes", () => {
  it("lists pending requests", async () => {
    const subject = harness();
    const response = await subject.invoke("/plugins/dsh-fusion/fleet/dispatch-requests");
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ requests: [request] });
  });

  it("approves with same-origin JSON and rejects cross-site writes", async () => {
    const subject = harness();
    subject.setBody({ id: "request-1" });
    const blocked = await subject.invoke("/plugins/dsh-fusion/fleet/dispatch-requests/approve", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", host: "local" },
    });
    expect(blocked.status).toBe(403);
    expect(subject.requests.approve).not.toHaveBeenCalled();

    const accepted = await subject.invoke("/plugins/dsh-fusion/fleet/dispatch-requests/approve", {
      method: "POST", headers: { "content-type": "application/json" },
    });
    expect(accepted.status).toBe(200);
    expect(subject.requests.approve).toHaveBeenCalledWith("request-1", "panel");
  });

  it("rejects a request with an optional reason", async () => {
    const subject = harness();
    subject.setBody({ id: "request-1", reason: "no" });
    const response = await subject.invoke("/plugins/dsh-fusion/fleet/dispatch-requests/reject", {
      method: "POST", headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(subject.requests.reject).toHaveBeenCalledWith("request-1", "no", "panel");
  });
});
