import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FleetMcpStore } from "./fleet-mcp-store.js";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-mcp-store-"));
  return new FleetMcpStore({ path: join(dir, "mcp.json"), defaultPort: 8797 });
}

describe("fleet MCP token store", () => {
  it("creates a client, stores only the token hash, and authorizes the token", () => {
    const tokens = store();
    const created = tokens.createClient({ name: "chief" });
    expect(created.token.length).toBeGreaterThan(30);
    expect(created.client.tokenSha256).toMatch(/^[a-f0-9]{64}$/u);
    const raw = readFileSync(tokens.path, "utf8");
    expect(raw).not.toContain(created.token);
    expect(tokens.authorize(created.token)?.id).toBe(created.client.id);
    expect(tokens.authorize("wrong-token")).toBeUndefined();
    expect(statSync(tokens.path).mode & 0o777).toBe(0o600);
  });

  it("revokes a client and rejects its token immediately", () => {
    const tokens = store();
    const created = tokens.createClient({ name: "chief" });
    expect(tokens.revokeClient(created.client.id)).toBe(true);
    expect(tokens.authorize(created.token)).toBeUndefined();
    expect(tokens.revokeClient(created.client.id)).toBe(false);
  });

  it("rotates the internal client token on every ensure call", () => {
    const tokens = store();
    const first = tokens.ensureInternalClient();
    const second = tokens.ensureInternalClient();
    expect(second).not.toBe(first);
    expect(tokens.authorize(first)).toBeUndefined();
    expect(tokens.authorize(second)?.id).toBe("dsh-internal");
    expect(tokens.authorize(second)?.scopes).toEqual(["read", "request"]);
    expect(tokens.file.clients.filter(client => client.id === "dsh-internal")).toHaveLength(1);
  });

  it("grants request scope only when explicitly asked", () => {
    const tokens = store();
    const reader = tokens.createClient({ name: "reader" });
    const chief = tokens.createClient({ name: "chief", scopes: ["read", "request"] });
    expect(reader.client.scopes).toEqual(["read"]);
    expect(chief.client.scopes).toEqual(["read", "request"]);
  });

  it("rejects a malformed file instead of guessing", () => {
    const tokens = store();
    expect(() => {
      writeFileSync(tokens.path, "{not json");
      tokens.refresh();
    }).toThrow(/FLEET_MCP_STORE_INVALID/u);
  });
});
