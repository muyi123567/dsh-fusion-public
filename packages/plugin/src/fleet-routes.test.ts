import { describe, expect, it, vi } from "vitest";
import { createFleetRoutes } from "./fleet-routes.js";
import { FleetServiceError, type WhaleFleetServiceV1 } from "./fleet-service.js";
import type { FleetHostManifest } from "./fleet-environment.js";

const HASH = "a".repeat(64);
const SHA = `sha256:${HASH}`;

function manifest(): FleetHostManifest {
  return {
    contractVersion: 1, hostId: SHA, displayName: "host", observedAt: "2026-11-22T10:00:00.000Z",
    dsh: { version: "0.2.3", profile: "web", node: "24.11.1", platform: "linux", arch: "x64" },
    bundles: [], patches: { profile: null, home: null }, capabilities: {}, workspaces: [],
    providers: [], mcpServers: [], secrets: { present: [] }, environmentDigest: SHA,
    signature: { alg: "ed25519", keyId: "host:test", value: `${"A".repeat(86)}==` },
  };
}

function fakeService(overrides: Partial<WhaleFleetServiceV1> = {}): WhaleFleetServiceV1 {
  return {
    contractVersion: 1,
    manifest: async () => manifest(),
    host: async () => manifest(),
    listHosts: async () => [],
    diff: async () => ({
      contractVersion: 1, hostId: SHA, expectedDigest: SHA, observedDigest: SHA,
      checkedAt: "2026-11-22T10:00:00.000Z", overall: "match", items: [],
    }),
    panelView: async () => ({
      hostId: SHA, displayName: "host", observedAt: "2026-11-22T10:00:00.000Z", digest: SHA,
      overall: "match", stale: false, signed: true, items: [], counts: { block: 0, warn: 0, info: 0 },
    }),
    doctor: async () => ({
      overall: "ok", checkedAt: "2026-11-22T10:00:00.000Z",
      checks: [{ id: "dsh.version", status: "ok", summary: "ok" }],
      integrations: [], nextActions: [],
    }),
    plan: async () => ({
      contractVersion: 1, hostId: SHA, expectedDigest: SHA, observedDigest: SHA,
      overall: "ready" as const, steps: [],
    }),
    saveExpected: async () => ({ hostId: SHA, digest: SHA, path: "/tmp/expected-manifest.json" }),
    subscribe: () => () => {},
    ...overrides,
  };
}

function exchange(routes: ReturnType<typeof createFleetRoutes>, path: string, options: {
  method?: string; url?: string;
} = {}) {
  const route = routes.find(item => item.path === path);
  if (route === undefined) throw new Error("route missing");
  const result = { status: 0, body: "" };
  const response = {
    writeHead(status: number) { result.status = status; },
    end(body?: string) { result.body = body ?? ""; },
  };
  const request = { method: options.method ?? "GET", url: options.url ?? path };
  return route.handler(request, response)
    .then(() => ({ ...result, json: result.body === "" ? undefined : JSON.parse(result.body) as unknown }));
}

describe("fleet routes", () => {
  it("serves the manifest and host list with authentication", async () => {
    const routes = createFleetRoutes({ service: fakeService(), authenticate: () => false });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/environment")).json).toMatchObject({ hostId: SHA });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/hosts")).json).toEqual({ hosts: [] });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/doctor")).json).toMatchObject({ overall: "ok" });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/plan", { url: `/plugins/dsh-fusion/fleet/plan?hostId=${SHA}` })).json).toMatchObject({ overall: "ready" });
  });

  it("requires hostId for diff and maps unknown hosts to 404", async () => {
    const routes = createFleetRoutes({ service: fakeService(), authenticate: () => false });
    const missing = await exchange(routes, "/plugins/dsh-fusion/fleet/diff");
    expect(missing.status).toBe(400);
    expect(missing.json).toEqual({ error: "whale/invalid-input" });
    const unknownRoutes = createFleetRoutes({
      service: fakeService({ diff: vi.fn(async () => { throw new FleetServiceError("whale/host-unknown", "no"); }) }),
      authenticate: () => false,
    });
    const unknown = await exchange(unknownRoutes, "/plugins/dsh-fusion/fleet/diff", { url: `/plugins/dsh-fusion/fleet/diff?hostId=${SHA}` });
    expect(unknown.status).toBe(404);
  });

  it("rejects unauthenticated and non-GET requests before the service", async () => {
    const service = fakeService({ manifest: vi.fn(async () => manifest()) });
    const routes = createFleetRoutes({ service, authenticate: (_request, response) => { response.writeHead(401, {}); response.end(); return true; } });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/environment")).status).toBe(401);
    expect(service.manifest).not.toHaveBeenCalled();
    const openRoutes = createFleetRoutes({ service, authenticate: () => false });
    const post = await exchange(openRoutes, "/plugins/dsh-fusion/fleet/environment", { method: "POST" });
    expect(post.status).toBe(405);
  });

  it("saves one host as the expected environment only for same-origin JSON", async () => {
    const saveExpected = vi.fn(async () => ({ hostId: SHA, digest: SHA, path: "/tmp/expected-manifest.json" }));
    const routes = createFleetRoutes({
      service: fakeService({ saveExpected }),
      authenticate: () => false,
      readBody: async () => ({ hostId: SHA }),
    });
    const route = routes.find(item => item.path === "/plugins/dsh-fusion/fleet/expected")!;
    const result = { status: 0, body: "" };
    await route.handler({
      method: "POST",
      url: "/plugins/dsh-fusion/fleet/expected",
      headers: { "content-type": "application/json" },
    }, {
      writeHead: status => { result.status = status; },
      end: body => { result.body = body ?? ""; },
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ digest: SHA });
    expect(saveExpected).toHaveBeenCalledWith(SHA);

    const blocked = { status: 0, body: "" };
    await route.handler({
      method: "POST",
      url: "/plugins/dsh-fusion/fleet/expected",
      headers: { "content-type": "application/json", origin: "https://evil.example", host: "local" },
    }, {
      writeHead: status => { blocked.status = status; },
      end: body => { blocked.body = body ?? ""; },
    });
    expect(blocked.status).toBe(403);
  });
});
