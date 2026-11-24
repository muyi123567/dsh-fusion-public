import { describe, expect, it } from "vitest";
import { createFleetConnectorRoutes } from "./fleet-connector-routes.js";
import { CloudConnectorError, type WhaleConnectorServiceV1 } from "./cloud-connectors.js";

function service(): WhaleConnectorServiceV1 {
  return {
    contractVersion: 1,
    catalog: () => [{
      kind: "gdrive",
      displayName: "Google Drive",
      category: "drive",
      description: "drive",
      capabilities: { list: true, stat: true, pull: true, upload: false },
      fields: [],
    }],
    instances: () => [{
      id: "gd", kind: "gdrive", label: "Google Drive", enabled: true, state: "configured",
    }],
    list: async (id, input) => {
      if (id === "missing") throw new CloudConnectorError("connector/unknown", "missing");
      return [{
        name: "a.txt", path: input.path ?? "root", kind: "file", size: 3,
      }];
    },
    pull: async (id, input) => {
      if (id === "disabled") throw new CloudConnectorError("connector/disabled", "disabled");
      return {
        connectorId: id, kind: "gdrive", path: input.path, name: "a.txt",
        localPath: "/tmp/imports/a.txt", bytes: 3, sha256: "a".repeat(64), pulledAt: "2026-11-23T12:00:00.000Z",
      };
    },
    upload: async (id, input) => ({
      connectorId: id, kind: "gdrive", path: input.path, name: "a.txt",
      localPath: input.sourcePath, bytes: 3, sha256: "a".repeat(64), uploadedAt: "2026-11-24T06:00:00.000Z",
    }),
    imports: () => [{ name: "a.txt", path: "/tmp/imports/a.txt", bytes: 3, modifiedAt: "2026-11-24T06:00:00.000Z" }],
    register: () => () => {},
  };
}

function exchange(routes: ReturnType<typeof createFleetConnectorRoutes>, path: string, options: {
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
    body: options.body,
    headers: {
      ...(options.method === "POST" ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  };
  return (route.handler as unknown as (request: unknown, response: unknown) => Promise<void>)(request, response).then(() => ({
    ...result,
    json: result.body === "" ? undefined : JSON.parse(result.body) as unknown,
  }));
}

describe("fleet connector routes", () => {
  it("lists providers and instances, and browses one connector", async () => {
    const routes = createFleetConnectorRoutes({
      service: service(),
      authenticate: () => false,
    });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/connectors")).json).toMatchObject({
      catalog: [{ kind: "gdrive" }],
      instances: [{ id: "gd" }],
    });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/connectors/list", {
      url: "/plugins/dsh-fusion/fleet/connectors/list?id=gd&path=root&limit=5",
    })).json).toEqual({ entries: [{ name: "a.txt", path: "root", kind: "file", size: 3 }] });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/connectors/list", {
      url: "/plugins/dsh-fusion/fleet/connectors/list?id=missing",
    })).status).toBe(404);
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/connectors/imports")).json)
      .toEqual({ imports: [{ name: "a.txt", path: "/tmp/imports/a.txt", bytes: 3, modifiedAt: "2026-11-24T06:00:00.000Z" }] });
  });

  it("pulls with same-origin JSON checks and maps connector errors", async () => {
    const routes = createFleetConnectorRoutes({
      service: service(),
      authenticate: () => false,
      readBody: async request => (request as unknown as { body?: Record<string, unknown> }).body ?? {},
    });
    const path = "/plugins/dsh-fusion/fleet/connectors/pull";
    expect((await exchange(routes, path, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: { id: "gd", path: "a.txt" },
    })).status).toBe(403);
    expect((await exchange(routes, path, {
      method: "POST",
      body: { id: "gd", path: "a.txt" },
    })).json).toMatchObject({ name: "a.txt", bytes: 3 });
    expect((await exchange(routes, path, {
      method: "POST",
      body: { id: "disabled", path: "a.txt" },
    })).status).toBe(409);
  });

  it("uploads with same-origin JSON checks", async () => {
    const routes = createFleetConnectorRoutes({
      service: service(),
      authenticate: () => false,
      readBody: async request => (request as unknown as { body?: Record<string, unknown> }).body ?? {},
    });
    const path = "/plugins/dsh-fusion/fleet/connectors/upload";
    expect((await exchange(routes, path, {
      method: "POST", headers: { origin: "https://evil.example" },
      body: { id: "gd", path: "out/a.txt", sourcePath: "/tmp/a.txt" },
    })).status).toBe(403);
    expect((await exchange(routes, path, {
      method: "POST",
      body: { id: "gd", path: "out/a.txt", sourcePath: "/tmp/a.txt" },
    })).json).toMatchObject({ connectorId: "gd", path: "out/a.txt", bytes: 3 });
  });
});
