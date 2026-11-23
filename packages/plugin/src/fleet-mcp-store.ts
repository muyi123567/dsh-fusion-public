import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface FleetMcpClient {
  id: string;
  name: string;
  tokenSha256: string;
  scopes: FleetMcpScope[];
  createdAt: string;
}

export type FleetMcpScope = "read" | "request";

export interface FleetMcpFile {
  version: 1;
  enabled: boolean;
  port: number;
  clients: FleetMcpClient[];
}

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/u;

export class FleetMcpStore {
  readonly path: string;
  private data: FleetMcpFile;

  constructor(options: { path: string; defaultPort?: number; enabled?: boolean }) {
    this.path = options.path;
    this.data = {
      version: 1,
      enabled: options.enabled === true,
      port: options.defaultPort ?? 8797,
      clients: [],
    };
    try {
      this.refresh();
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }
  }

  get file(): FleetMcpFile {
    return this.data;
  }

  refresh(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw error;
      throw new Error("FLEET_MCP_STORE_INVALID");
    }
    this.data = validateFile(parsed);
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    renameSync(temporary, this.path);
  }

  createClient(input: { name: string; scopes?: FleetMcpScope[] }): { client: FleetMcpClient; token: string } {
    if (!NAME.test(input.name)) throw new Error("FLEET_MCP_CLIENT_NAME_INVALID");
    const scopes = normalizeScopes(input.scopes ?? ["read"]);
    const token = randomBytes(32).toString("base64url");
    const client: FleetMcpClient = {
      id: randomUUID(),
      name: input.name,
      tokenSha256: sha256(token),
      scopes,
      createdAt: new Date().toISOString(),
    };
    this.data.clients.push(client);
    this.save();
    return { client, token };
  }

  revokeClient(id: string): boolean {
    const before = this.data.clients.length;
    this.data.clients = this.data.clients.filter(client => client.id !== id);
    if (this.data.clients.length === before) return false;
    this.save();
    return true;
  }

  ensureInternalClient(): string {
    const token = randomBytes(32).toString("base64url");
    const existing = this.data.clients.find(client => client.id === "dsh-internal");
    if (existing === undefined) {
      this.data.clients.push({
        id: "dsh-internal",
        name: "DSH host",
        tokenSha256: sha256(token),
        scopes: ["read", "request"],
        createdAt: new Date().toISOString(),
      });
    } else {
      existing.tokenSha256 = sha256(token);
      existing.scopes = ["read", "request"];
    }
    this.save();
    return token;
  }

  authorize(token: string | undefined): FleetMcpClient | undefined {
    if (token === undefined || token === "") return undefined;
    // Clients are created and revoked by a local operator (or the token
    // script) while the server runs. Read the file on each request so a new
    // grant applies and a revocation fails closed without a plugin reload.
    try {
      this.refresh();
    } catch {
      return undefined;
    }
    const digest = Buffer.from(sha256(token), "hex");
    for (const client of this.data.clients) {
      const expected = Buffer.from(client.tokenSha256, "hex");
      if (expected.length === digest.length && timingSafeEqual(expected, digest) && client.scopes.includes("read")) {
        return client;
      }
    }
    return undefined;
  }
}

function validateFile(value: unknown): FleetMcpFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("FLEET_MCP_STORE_INVALID");
  const file = value as Partial<FleetMcpFile>;
  if (file.version !== 1 || typeof file.enabled !== "boolean"
    || !Number.isInteger(file.port) || file.port! < 0 || file.port! > 65_535
    || !Array.isArray(file.clients)) throw new Error("FLEET_MCP_STORE_INVALID");
  const ids = new Set<string>();
  const hashes = new Set<string>();
  const clients = file.clients.map((value): FleetMcpClient => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("FLEET_MCP_STORE_INVALID");
    const client = value as Partial<FleetMcpClient>;
    if (typeof client.id !== "string" || !ID.test(client.id)
      || typeof client.name !== "string" || !NAME.test(client.name)
      || typeof client.tokenSha256 !== "string" || !HASH.test(client.tokenSha256)
      || typeof client.createdAt !== "string"
      || !Array.isArray(client.scopes)) {
      throw new Error("FLEET_MCP_STORE_INVALID");
    }
    if (ids.has(client.id) || hashes.has(client.tokenSha256)) throw new Error("FLEET_MCP_STORE_INVALID");
    ids.add(client.id);
    hashes.add(client.tokenSha256);
    return {
      id: client.id, name: client.name, tokenSha256: client.tokenSha256,
      scopes: normalizeScopes(client.scopes as FleetMcpScope[]), createdAt: client.createdAt,
    };
  });
  return { version: 1, enabled: file.enabled, port: file.port!, clients };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeScopes(value: FleetMcpScope[]): FleetMcpScope[] {
  const scopes = [...new Set(value)];
  if (scopes.length === 0 || !scopes.includes("read")
    || scopes.some(scope => scope !== "read" && scope !== "request")) {
    throw new Error("FLEET_MCP_SCOPES_INVALID");
  }
  return scopes;
}
