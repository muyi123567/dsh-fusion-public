import { describe, expect, it } from "vitest";
import { FleetServiceError, type WhaleFleetServiceV1 } from "./fleet-service.js";
import { createFleetTrustRoutes } from "./fleet-trust-routes.js";
import type { FleetHostManifest } from "./fleet-environment.js";
import type { FleetTrustEntry } from "./fleet-trust.js";

const SHA = `sha256:${"a".repeat(64)}`;

function service(): WhaleFleetServiceV1 {
  const manifest: FleetHostManifest = {
    contractVersion: 1, hostId: SHA, displayName: "host", observedAt: "2026-11-23T12:00:00.000Z",
    dsh: { version: "0.2.3-alpha.2", profile: "web", node: "24.11.1", platform: "linux", arch: "arm64" },
    bundles: [], patches: { profile: null, home: null }, capabilities: {}, workspaces: [],
    providers: [], mcpServers: [], secrets: { present: [] }, environmentDigest: SHA,
    signature: { alg: "ed25519", keyId: "host:test", value: `${"A".repeat(86)}==` },
  };
  const entry: FleetTrustEntry = {
    hostId: SHA, publicKeyPem: "-----BEGIN PUBLIC KEY-----\nAA==\n-----END PUBLIC KEY-----",
    fingerprint: `sha256:${"b".repeat(64)}`, source: "manual",
    addedAt: "2026-11-23T12:00:00.000Z", updatedAt: "2026-11-23T12:00:00.000Z",
  };
  return {
    contractVersion: 1,
    manifest: async () => manifest,
    host: async () => manifest,
    listHosts: async () => [],
    diff: async () => ({
      contractVersion: 1, hostId: SHA, expectedDigest: SHA, observedDigest: SHA,
      checkedAt: "2026-11-23T12:00:00.000Z", overall: "match", items: [],
    }),
    panelView: async () => ({
      hostId: SHA, displayName: "host", observedAt: "2026-11-23T12:00:00.000Z", digest: SHA,
      overall: "match", stale: false, signed: true, items: [], counts: { block: 0, warn: 0, info: 0 },
    }),
    plan: async () => ({
      contractVersion: 1, hostId: SHA, expectedDigest: SHA, observedDigest: SHA,
      overall: "ready", steps: [],
    }),
    saveExpected: async () => ({ hostId: SHA, digest: SHA, path: "/tmp/expected.json" }),
    trust: async (hostId, key) => {
      if (hostId !== SHA) throw new FleetServiceError("trust/key-mismatch", "mismatch");
      if (key === "bad") throw new FleetServiceError("whale/invalid-input", "bad");
      return entry;
    },
    revokeTrust: async () => true,
    trustReport: async () => ({
      mode: "manual", entries: [entry],
      hosts: [{
        hostId: SHA, displayName: "host", trust: "verified", verified: true,
        trusted: true, candidateKeyAvailable: true,
      }],
    }),
    subscribe: () => () => {},
  };
}

function exchange(routes: ReturnType<typeof createFleetTrustRoutes>, path: string, options: {
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

describe("fleet trust routes", () => {
  it("reports entries and host trust states", async () => {
    const routes = createFleetTrustRoutes({ service: service(), authenticate: () => false });
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/trust")).json).toMatchObject({
      mode: "manual",
      entries: [{ hostId: SHA }],
      hosts: [{ trust: "verified", verified: true }],
    });
  });

  it("trusts and revokes with same-origin JSON checks", async () => {
    const routes = createFleetTrustRoutes({
      service: service(),
      authenticate: () => false,
      readBody: async request => (request as unknown as { body?: Record<string, unknown> }).body ?? {},
    });
    const path = "/plugins/dsh-fusion/fleet/trust";
    expect((await exchange(routes, path, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: { hostId: SHA },
    })).status).toBe(403);
    expect((await exchange(routes, path, {
      method: "POST",
      body: { hostId: SHA },
    })).json).toMatchObject({ hostId: SHA, source: "manual" });
    expect((await exchange(routes, path, {
      method: "POST",
      body: { hostId: `sha256:${"c".repeat(64)}` },
    })).status).toBe(409);
    expect((await exchange(routes, "/plugins/dsh-fusion/fleet/trust/revoke", {
      method: "POST",
      body: { hostId: SHA },
    })).json).toEqual({ revoked: true });
  });
});
