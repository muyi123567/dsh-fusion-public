import { mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFleetMcpServer, type FleetMcpServer } from "./fleet-mcp.js";
import { FleetMcpStore } from "./fleet-mcp-store.js";
import type { WhaleFleetServiceV1 } from "./fleet-service.js";

const HASH = "a".repeat(64);
const SHA = `sha256:${HASH}`;

function service(overrides: Partial<WhaleFleetServiceV1> = {}): WhaleFleetServiceV1 {
  return {
    contractVersion: 1,
    manifest: async () => ({
      contractVersion: 1 as const, hostId: SHA, displayName: "host", observedAt: "2026-11-22T10:00:00.000Z",
      dsh: { version: "0.2.3", profile: "web", node: "24.11.1", platform: "linux", arch: "x64" },
      bundles: [], patches: { profile: null, home: null }, capabilities: {}, workspaces: [],
      providers: [], mcpServers: [], secrets: { present: [] }, environmentDigest: SHA,
      signature: { alg: "ed25519" as const, keyId: "host:test", value: `${"A".repeat(86)}==` },
    }),
    host: vi.fn(async () => ({
      contractVersion: 1 as const, hostId: SHA, displayName: "host", observedAt: "2026-11-22T10:00:00.000Z",
      dsh: { version: "0.2.3", profile: "web", node: "24.11.1", platform: "linux", arch: "x64" },
      bundles: [], patches: { profile: null, home: null }, capabilities: { ssh: true }, workspaces: [],
      providers: [], mcpServers: [], secrets: { present: ["DEEPSEEK_API_KEY"] }, environmentDigest: SHA,
      signature: { alg: "ed25519" as const, keyId: "host:test", value: `${"A".repeat(86)}==` },
    })),
    listHosts: vi.fn(async () => [{ hostId: SHA, displayName: "host", observedAt: "2026-11-22T10:00:00.000Z", digest: SHA, overall: "match" as const, stale: false, signed: true }]),
    diff: vi.fn(async () => ({
      contractVersion: 1 as const, hostId: SHA, expectedDigest: SHA, observedDigest: SHA,
      checkedAt: "2026-11-22T10:00:00.000Z", overall: "match" as const, items: [],
    })),
    panelView: vi.fn(),
    subscribe: () => () => {},
    ...overrides,
  };
}

let running: FleetMcpServer | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function start(options: { service?: WhaleFleetServiceV1; execution?: { read: (taskId: string) => Promise<unknown> } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-mcp-"));
  const store = new FleetMcpStore({ path: join(dir, "mcp.json"), defaultPort: 0 });
  const token = store.createClient({ name: "test" }).token;
  running = createFleetMcpServer({
    service: options.service ?? service(),
    store,
    ...(options.execution === undefined ? {} : { execution: options.execution as never }),
  });
  const { port } = await running.start();
  return { port, token, store, url: `http://127.0.0.1:${port}/mcp` };
}

function rpc(id: number, method: string, params?: unknown) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

async function post(url: string, token: string | undefined, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function postRaw(url: string, token: string, body: unknown, headers: Record<string, string>): Promise<{ status: number }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...headers,
      },
    }, response => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

describe("fleet MCP server", () => {
  it("initializes and lists only the read-only tools", async () => {
    const { url, token } = await start();
    const init = await post(url, token, rpc(1, "initialize", { protocolVersion: "2025-06-18" }));
    expect(init.status).toBe(200);
    expect(await init.json()).toMatchObject({ result: { serverInfo: { name: "whale-fleet" } } });
    const listed = await post(url, token, rpc(2, "tools/list"));
    expect(listed.status).toBe(200);
    const body = await listed.json() as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map(tool => tool.name)).toEqual([
      "whale_list_hosts", "whale_host_manifest", "whale_environment_diff", "whale_receipt",
    ]);
  });

  it("rejects browser Origins, non-loopback Hosts, wrong tokens and GET", async () => {
    const { url, token } = await start();
    expect((await post(url, token, rpc(1, "ping"), { origin: "https://evil.example" })).status).toBe(403);
    expect((await postRaw(url, token, rpc(1, "ping"), { host: "evil.example" })).status).toBe(403);
    expect((await post(url, undefined, rpc(1, "ping"))).status).toBe(401);
    expect((await post(url, "wrong", rpc(1, "ping"))).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  });

  it("applies newly created and revoked client tokens without a restart", async () => {
    const { url, store } = await start();
    const created = store.createClient({ name: "late-client" });
    expect((await post(url, created.token, rpc(1, "ping"))).status).toBe(200);
    store.revokeClient(created.client.id);
    expect((await post(url, created.token, rpc(2, "ping"))).status).toBe(401);
  });

  it("calls list_hosts, manifest, diff and receipt with structured results", async () => {
    const execution = {
      read: vi.fn(async () => ({
        jobs: [], taskAvailable: true, sourceToken: HASH, sourceRevision: 1,
        attempts: [{
          id: "attempt-1", taskId: "task-1", sourceToken: HASH, jobId: "verify", nodeId: "worker",
          requestId: "req", workerTaskId: "worker-1", createdAt: "2026-11-22T10:00:00.000Z",
          sourceState: "current", executionState: "exited",
          receipt: {
            sha256: HASH, taskId: "task-1", sourceToken: HASH, attemptId: "attempt-1",
            jobId: "verify", nodeId: "worker", workerTaskId: "worker-1", commandSha256: HASH,
            dispatchFingerprint: HASH, startedAt: "2026-11-22T10:00:00.000Z",
            finishedAt: "2026-11-22T10:00:01.000Z", exitCode: 0,
            stdout: { sha256: HASH, bytes: 1 }, stderr: { sha256: HASH, bytes: 0 },
          },
        }],
      })),
    };
    const { url, token } = await start({ execution });
    const call = async (name: string, args: unknown = {}) => {
      const response = await post(url, token, rpc(3, "tools/call", { name, arguments: args }));
      expect(response.status).toBe(200);
      const body = await response.json() as { result: { structuredContent: unknown; isError?: boolean } };
      return body.result;
    };
    expect((await call("whale_list_hosts")).isError).toBeUndefined();
    expect((await call("whale_host_manifest", { hostId: SHA })).isError).toBeUndefined();
    expect((await call("whale_environment_diff", { hostId: SHA })).isError).toBeUndefined();
    const receipt = await call("whale_receipt", { taskId: "task-1", attemptId: "attempt-1" });
    expect(receipt.structuredContent).toMatchObject({ taskId: "task-1", attemptId: "attempt-1", executionState: "exited" });
  });

  it("returns tool errors without leaking internal exceptions", async () => {
    const { url, token } = await start({ service: service({ host: async () => undefined }) });
    const response = await post(url, token, rpc(4, "tools/call", {
      name: "whale_host_manifest", arguments: { hostId: SHA },
    }));
    const body = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("whale/host-unknown");
  });
});
