import { describe, expect, it, vi } from "vitest";
import { FleetBundleError, type WhaleBundleServiceV1 } from "./fleet-host-bundle.js";
import { createFleetBundleRoutes } from "./fleet-bundle-routes.js";

const SHA = `sha256:${"a".repeat(64)}`;

function service(): WhaleBundleServiceV1 {
  return {
    contractVersion: 1,
    exportHost: vi.fn(async () => ({
      contractVersion: 1 as const, createdAt: "2026-11-24T07:00:00.000Z",
      manifest: { hostId: SHA } as never, publicKeyPem: "-----BEGIN PUBLIC KEY-----", digest: SHA,
    })),
    importHost: vi.fn(async (bundle, options) => {
      if (bundle === "bad") throw new FleetBundleError("bundle/digest-invalid", "bad");
      return {
        hostId: SHA, digest: SHA, cachedPath: "/tmp/hosts/a.json",
        trusted: options?.pinTrust === true,
        ...(options?.saveExpected === true ? { expectedPath: "/tmp/expected-manifest.json" } : {}),
      };
    }),
  };
}

function exchange(routes: ReturnType<typeof createFleetBundleRoutes>, path: string, options: {
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

describe("fleet bundle routes", () => {
  it("exports a bundle", async () => {
    const routes = createFleetBundleRoutes({ service: service(), authenticate: () => false });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/bundle")).json).toMatchObject({ digest: SHA });
  });

  it("imports with same-origin checks and trust/expected flags", async () => {
    const routes = createFleetBundleRoutes({
      service: service(),
      authenticate: () => false,
      readBody: async request => (request as unknown as { body?: Record<string, unknown> }).body ?? {},
    });
    const path = "/plugins/dsh-fusion/fleet/bundle/import";
    expect((await exchange(routes, path, {
      method: "POST", headers: { origin: "https://evil.example" }, body: { bundle: {} },
    })).status).toBe(403);
    expect((await exchange(routes, path, {
      method: "POST", body: { bundle: {}, pinTrust: true, saveExpected: true },
    })).json).toMatchObject({ trusted: true, expectedPath: "/tmp/expected-manifest.json" });
    expect((await exchange(routes, path, {
      method: "POST", body: { bundle: "bad" },
    })).status).toBe(409);
  });
});
