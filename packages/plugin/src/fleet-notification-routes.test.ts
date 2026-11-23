import { describe, expect, it } from "vitest";
import { createFleetNotificationRoutes } from "./fleet-notification-routes.js";
import {
  NotificationAdapterError,
  type WhaleNotificationServiceV1,
} from "./fleet-notification-adapters.js";

function service(): WhaleNotificationServiceV1 {
  return {
    contractVersion: 1,
    catalog: () => [{
      kind: "slack", displayName: "Slack", category: "im", description: "slack", receipt: false, fields: [],
    }],
    adapters: () => [{
      id: "ops", kind: "slack", label: "Ops", enabled: true, state: "configured",
      events: ["created", "approved", "rejected", "failed", "test"], capabilities: { receipt: false },
    }],
    deliver: async () => [],
    test: async adapterId => {
      if (adapterId === "missing") throw new NotificationAdapterError("notification/unknown", "missing");
      return [{
        adapterId: adapterId ?? "ops", kind: "slack", eventType: "test", status: "delivered",
        at: "2026-11-23T12:00:00.000Z", durationMs: 1, httpStatus: 204,
      }];
    },
    receipts: () => [],
    register: () => () => {},
  };
}

function exchange(routes: ReturnType<typeof createFleetNotificationRoutes>, path: string, options: {
  method?: string; headers?: Record<string, string>; body?: unknown;
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
    url: path,
    headers: {
      ...(options.method === "POST" ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.body,
  };
  return (route.handler as unknown as (request: unknown, response: unknown) => Promise<void>)(request, response)
    .then(() => ({ ...result, json: result.body === "" ? undefined : JSON.parse(result.body) as unknown }));
}

describe("fleet notification routes", () => {
  it("lists adapters and receipts", async () => {
    const routes = createFleetNotificationRoutes({ service: service(), authenticate: () => false });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/notifications")).json).toMatchObject({
      catalog: [{ kind: "slack" }],
      adapters: [{ id: "ops" }],
    });
  });

  it("tests one adapter with same-origin JSON checks and maps errors", async () => {
    const routes = createFleetNotificationRoutes({
      service: service(),
      authenticate: () => false,
      readBody: async request => (request as unknown as { body?: Record<string, unknown> }).body ?? {},
    });
    const path = "/plugins/dsh-fusion/fleet/notifications/test";
    expect((await exchange(routes, path, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: { adapterId: "ops" },
    })).status).toBe(403);
    expect((await exchange(routes, path, {
      method: "POST",
      body: { adapterId: "ops" },
    })).json).toMatchObject({ receipts: [{ adapterId: "ops", status: "delivered" }] });
    expect((await exchange(routes, path, {
      method: "POST",
      body: { adapterId: "missing" },
    })).status).toBe(404);
  });
});
