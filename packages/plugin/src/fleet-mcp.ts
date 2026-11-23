import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FleetHostManifest } from "./fleet-environment.js";
import { FleetServiceError, type WhaleFleetServiceV1 } from "./fleet-service.js";
import type { FleetMcpStore } from "./fleet-mcp-store.js";
import type { FleetDispatchRequestService } from "./fleet-dispatch-requests.js";
import { DispatchRequestError } from "./fleet-dispatch-requests.js";

const PROTOCOL = "2025-06-18";
const MAX_BODY = 1 << 20;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface FleetMcpExecutionReader {
  read(taskId: string): Promise<unknown>;
}

export interface FleetMcpServer {
  readonly port: number | undefined;
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
}

export interface FleetMcpServerOptions {
  service: WhaleFleetServiceV1;
  store: FleetMcpStore;
  execution?: FleetMcpExecutionReader;
  requests?: FleetDispatchRequestService;
  autoApproveDispatch?: boolean;
  version?: string;
}

const TOOLS = [
  {
    name: "whale_list_hosts",
    description: "List known DSH hosts with their environment digest and drift state.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "whale_host_manifest",
    description: "Read one host's signed environment manifest, optionally only selected sections.",
    inputSchema: {
      type: "object",
      properties: {
        hostId: { type: "string" },
        sections: {
          type: "array",
          items: { enum: ["dsh", "bundles", "patches", "capabilities", "workspaces", "providers", "mcpServers", "secrets"] },
        },
      },
      required: ["hostId"],
    },
  },
  {
    name: "whale_environment_diff",
    description: "Compare one host against the expected environment and return blocking, warning and informational drift.",
    inputSchema: {
      type: "object",
      properties: { hostId: { type: "string" }, expectedDigest: { type: "string" } },
      required: ["hostId"],
    },
  },
  {
    name: "whale_receipt",
    description: "Read one execution attempt's receipt hashes, exit facts and review state. It never returns command text or file contents.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, attemptId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "whale_doctor",
    description: "Diagnose DSH compatibility, environment drift, MCP registration, execution readiness and installed ecosystem plugins.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

const REQUEST_TOOL = {
  name: "whale_request_dispatch",
  description: "Request one environment-gated dispatch from an allowlisted job. It stays pending until a human approves it in the Whale panel unless auto-approval is explicitly enabled.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      sourceToken: { type: "string" },
      jobId: { type: "string" },
      nodeId: { type: "string" },
      requestId: { type: "string" },
      environment: {
        type: "object",
        properties: {
          hostId: { type: "string" },
          requireDigest: { type: "string" },
          policy: { enum: ["exact", "compatible"] },
        },
      },
    },
    required: ["taskId", "sourceToken", "jobId", "nodeId"],
  },
} as const;

class ToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function createFleetMcpServer(options: FleetMcpServerOptions): FleetMcpServer {
  let server: ReturnType<typeof createServer> | undefined;
  let port: number | undefined;

  const handleCall = async (name: string, args: Record<string, unknown>, client: { id: string; name: string; scopes: readonly string[] }): Promise<unknown> => {
    switch (name) {
      case "whale_list_hosts":
        return { hosts: await options.service.listHosts() };
      case "whale_host_manifest": {
        const hostId = required(args, "hostId");
        const manifest = await options.service.host(hostId);
        if (manifest === undefined) throw new ToolError("whale/host-unknown", `未知主机：${hostId}`);
        return pickSections(manifest, args.sections);
      }
      case "whale_environment_diff": {
        const hostId = required(args, "hostId");
        const expected = optional(args, "expectedDigest");
        return await options.service.diff(hostId, expected);
      }
      case "whale_receipt": {
        if (options.execution === undefined) throw new ToolError("whale/receipt-unavailable", "执行账本未配置");
        const taskId = required(args, "taskId");
        const attemptId = optional(args, "attemptId");
        const view = await options.execution.read(taskId) as { attempts?: unknown[]; sourceRevision?: number };
        const attempts = Array.isArray(view.attempts) ? view.attempts as AttemptLike[] : [];
        const attempt = attemptId === undefined
          ? attempts[0]
          : attempts.find(candidate => candidate.id === attemptId);
        if (attempt === undefined) throw new ToolError("whale/attempt-missing", "未找到执行尝试");
        return {
          taskId,
          attemptId: attempt.id,
          jobId: attempt.jobId,
          nodeId: attempt.nodeId,
          workerTaskId: attempt.workerTaskId,
          sourceState: attempt.sourceState,
          executionState: attempt.executionState,
          receipt: attempt.receipt ?? null,
          review: attempt.review ?? null,
        };
      }
      case "whale_doctor": {
        if (options.service.doctor === undefined) throw new ToolError("whale/doctor-unavailable", "诊断不可用");
        return await options.service.doctor();
      }
      case "whale_request_dispatch": {
        if (options.requests === undefined) throw new ToolError("whale/dispatch-unavailable", "派发审批未配置");
        if (!client.scopes.includes("request")) throw new ToolError("whale/scope-required", "客户端没有 request scope");
        const requestId = optional(args, "requestId") ?? randomUUID();
        try {
          const created = await options.requests.create({
            requestId,
            taskId: required(args, "taskId"),
            sourceToken: required(args, "sourceToken"),
            jobId: required(args, "jobId"),
            nodeId: required(args, "nodeId"),
            ...(args.environment === undefined ? {} : { environment: args.environment as never }),
            requestedBy: client.name,
            source: `mcp:${client.id}`,
          });
          if (options.autoApproveDispatch !== true) {
            return { requestId: created.request.requestId, id: created.request.id, status: created.request.status, approval: "pending" };
          }
          const approved = await options.requests.approve(created.request.id, "mcp-auto");
          return { requestId: created.request.requestId, id: created.request.id, status: approved.request.status, attemptId: approved.attemptId, approval: "auto" };
        } catch (error) {
          if (error instanceof DispatchRequestError) throw new ToolError(`whale/${error.code}`, error.code);
          throw error;
        }
      }
      default:
        throw new ToolError("whale/tool-unknown", `未知工具：${name}`);
    }
  };

  const rpc = async (message: Record<string, unknown>, client: { id: string; name: string; scopes: readonly string[] }): Promise<unknown> => {
    const method = message.method;
    const id = message.id;
    if (typeof method !== "string") throw Object.assign(new Error("Invalid request"), { rpc: -32600 });
    switch (method) {
      case "initialize":
        return {
          protocolVersion: typeof (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion === "string"
            ? (message.params as { protocolVersion: string }).protocolVersion
            : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "whale-fleet", version: options.version ?? "0.2.0-beta.14" },
          instructions: "Read-only multi-host environment and execution receipts. Call whale_list_hosts first.",
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools: options.requests === undefined ? TOOLS : [...TOOLS, REQUEST_TOOL] };
      case "tools/call": {
        const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof params.name !== "string") throw Object.assign(new Error("Unknown tool"), { rpc: -32602 });
        try {
          const result = await handleCall(params.name, isRecord(params.arguments) ? params.arguments : {}, client);
          return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
        } catch (error) {
          const code = error instanceof ToolError ? error.code
            : error instanceof FleetServiceError ? error.code
            : typeof (error as { code?: unknown } | undefined)?.code === "string"
              ? `whale/${(error as { code: string }).code}`
            : "whale/unavailable";
          return { isError: true, content: [{ type: "text", text: code }] };
        }
      }
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { rpc: -32601, id });
    }
  };

  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const host = String(request.headers.host ?? "").replace(/:\d+$/u, "");
    if (request.headers.origin !== undefined || !LOCAL_HOSTS.has(host)) {
      send(response, 403, { error: "Forbidden" });
      return;
    }
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") {
      send(response, 404, { error: "Not found" });
      return;
    }
    const auth = String(request.headers.authorization ?? "");
    const client = auth.startsWith("Bearer ") ? options.store.authorize(auth.slice(7).trim()) : undefined;
    if (client === undefined) {
      send(response, 401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }
    if (request.method !== "POST") {
      send(response, 405, { error: "Method not allowed" }, { allow: "POST" });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(request));
    } catch (error) {
      if ((error as { status?: number }).status === 413) {
        send(response, 413, { error: "Request too large" });
      } else {
        send(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      return;
    }
    const batch = Array.isArray(body);
    const messages: unknown[] = batch ? body as unknown[] : [body];
    const replies: unknown[] = [];
    for (const message of messages) {
      if (!isRecord(message) || message.id === undefined || message.id === null) continue;
      try {
        replies.push({ jsonrpc: "2.0", id: message.id, result: await rpc(message, client) });
      } catch (error) {
        replies.push({
          jsonrpc: "2.0", id: message.id,
          error: {
            code: (error as { rpc?: number }).rpc ?? -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    if (replies.length === 0) {
      send(response, 202);
      return;
    }
    send(response, 200, batch ? replies : replies[0]);
  };

  return {
    get port() { return port; },
    async start() {
      if (server !== undefined && port !== undefined) return { port };
      const created = createServer((request, response) => {
        void serve(request, response).catch(() => {
          if (!response.headersSent) send(response, 500, { error: "Internal error" });
          else response.end();
        });
      });
      await new Promise<void>((resolve, reject) => {
        created.once("error", reject);
        created.listen(options.store.file.port, "127.0.0.1", () => {
          created.off("error", reject);
          resolve();
        });
      });
      server = created;
      port = (created.address() as AddressInfo).port;
      return { port };
    },
    async stop() {
      const current = server;
      server = undefined;
      port = undefined;
      if (current === undefined) return;
      current.closeAllConnections?.();
      await new Promise<void>(resolve => current.close(() => resolve()));
    },
  };
}

interface AttemptLike {
  id?: string;
  jobId?: string;
  nodeId?: string;
  workerTaskId?: string;
  sourceState?: string;
  executionState?: string;
  receipt?: unknown;
  review?: unknown;
}

function pickSections(manifest: FleetHostManifest, sections: unknown): unknown {
  if (sections === undefined) return manifest;
  if (!Array.isArray(sections) || !sections.every(section => typeof section === "string")) {
    throw new ToolError("whale/invalid-input", "sections 必须是字符串数组");
  }
  const selected: Record<string, unknown> = {
    contractVersion: manifest.contractVersion,
    hostId: manifest.hostId,
    displayName: manifest.displayName,
    observedAt: manifest.observedAt,
    environmentDigest: manifest.environmentDigest,
    signature: manifest.signature,
  };
  for (const section of sections) {
    if (section in manifest) selected[section] = manifest[section as keyof FleetHostManifest];
  }
  return selected;
}

function required(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") throw new ToolError("whale/invalid-input", `${name} 必填`);
  return value;
}

function optional(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw new ToolError("whale/invalid-input", `${name} 无效`);
  return value;
}

function send(response: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Request too large"), { status: 413 }));
        request.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
