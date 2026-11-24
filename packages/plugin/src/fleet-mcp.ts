import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FleetHostManifest } from "./fleet-environment.js";
import { FleetServiceError, type WhaleFleetServiceV1 } from "./fleet-service.js";
import type { FleetMcpStore } from "./fleet-mcp-store.js";
import type { FleetDispatchRequestService } from "./fleet-dispatch-requests.js";
import { DispatchRequestError } from "./fleet-dispatch-requests.js";
import type { WhaleConnectorServiceV1 } from "./cloud-connectors.js";
import type { WhaleNotificationServiceV1 } from "./fleet-notification-adapters.js";
import type { WhaleBackupServiceV1 } from "./fleet-backup.js";
import type { WhalePresetServiceV1 } from "./fleet-presets.js";
import type { WhaleAlignmentServiceV1 } from "./fleet-alignment.js";
import type { WhaleStatusServiceV1 } from "./fleet-status.js";

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
  connectors?: WhaleConnectorServiceV1;
  notifications?: WhaleNotificationServiceV1;
  presets?: WhalePresetServiceV1;
  backups?: WhaleBackupServiceV1;
  alignment?: WhaleAlignmentServiceV1;
  status?: WhaleStatusServiceV1;
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
  {
    name: "whale_environment_plan",
    description: "Turn environment drift into ordered, non-executable alignment steps with risk and restart requirements.",
    inputSchema: {
      type: "object",
      properties: { hostId: { type: "string" }, expectedDigest: { type: "string" } },
      required: ["hostId"],
    },
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

const CONNECTOR_TOOLS = [
  {
    name: "whale_connectors",
    description: "List open cloud-drive connector providers and configured instances without exposing credentials.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "whale_cloud_list",
    description: "List or search files in one configured cloud-drive connector.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        path: { type: "string" },
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 200 },
      },
      required: ["id"],
    },
  },
  {
    name: "whale_cloud_pull",
    description: "Copy one remote file into the host's private imports directory and return its sha256. Requires the request scope.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        path: { type: "string" },
        name: { type: "string" },
        maxBytes: { type: "number", minimum: 1 },
      },
      required: ["id", "path"],
    },
  },
  {
    name: "whale_cloud_upload",
    description: "Upload one local imports file to a cloud connector. Requires the operator-only approve scope; overwrite must be explicit.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        path: { type: "string" },
        sourcePath: { type: "string" },
        overwrite: { type: "boolean" },
        maxBytes: { type: "number", minimum: 1 },
      },
      required: ["id", "path", "sourcePath"],
    },
  },
] as const;

const NOTIFICATION_TOOLS = [
  {
    name: "whale_notifications",
    description: "List notification adapters and their last delivery receipts without exposing credentials.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "whale_notify_test",
    description: "Send one synthetic test notification through one adapter, or all adapters. Requires the request scope.",
    inputSchema: {
      type: "object",
      properties: { adapterId: { type: "string" } },
    },
  },
] as const;

const TRUST_TOOL = {
  name: "whale_host_trust",
  description: "Read the remote-host trust table and each cached host's verification state.",
  inputSchema: { type: "object", properties: {} },
} as const;

const PRESET_BACKUP_TOOLS = [
  {
    name: "whale_presets",
    description: "List bundled DSH Skill, plugin and configuration presets with install status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "whale_backups",
    description: "List config snapshots, or verify one snapshot when id is provided.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  },
] as const;

const ALIGNMENT_TOOLS = [
  {
    name: "whale_alignment",
    description: "List alignment requests, or read one request when id is provided.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  },
  {
    name: "whale_alignment_plan",
    description: "Build a local-host alignment plan with auto/manual execution classification.",
    inputSchema: {
      type: "object",
      properties: { hostId: { type: "string" }, expectedDigest: { type: "string" } },
      required: ["hostId"],
    },
  },
  {
    name: "whale_request_alignment",
    description: "Create a pending local alignment request. A human must approve it in the Whale panel.",
    inputSchema: {
      type: "object",
      properties: { hostId: { type: "string" }, expectedDigest: { type: "string" } },
      required: ["hostId"],
    },
  },
  {
    name: "whale_approve_alignment",
    description: "Approve and execute one pending alignment request. Requires the approve scope and an operator-issued token.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
] as const;

const STATUS_TOOL = {
  name: "whale_status",
  description: "One-call fleet summary: local environment, drift, trust, pending approvals, connectors, notifications, presets, backups and alignment.",
  inputSchema: { type: "object", properties: {} },
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
      case "whale_environment_plan": {
        const hostId = required(args, "hostId");
        return await options.service.plan(hostId, optional(args, "expectedDigest"));
      }
      case "whale_connectors": {
        if (options.connectors === undefined) throw new ToolError("whale/connectors-unavailable", "云盘连接器未配置");
        return { catalog: options.connectors.catalog(), instances: options.connectors.instances() };
      }
      case "whale_cloud_list": {
        if (options.connectors === undefined) throw new ToolError("whale/connectors-unavailable", "云盘连接器未配置");
        const limit = optionalNumber(args, "limit");
        const path = optional(args, "path");
        const query = optional(args, "query");
        return {
          entries: await options.connectors.list(required(args, "id"), {
            ...(path === undefined ? {} : { path }),
            ...(query === undefined ? {} : { query }),
            ...(limit === undefined ? {} : { limit }),
          }),
        };
      }
      case "whale_cloud_pull": {
        if (options.connectors === undefined) throw new ToolError("whale/connectors-unavailable", "云盘连接器未配置");
        if (!client.scopes.includes("request")) throw new ToolError("whale/scope-required", "客户端没有 request scope");
        const maxBytes = optionalNumber(args, "maxBytes");
        const name = optional(args, "name");
        return await options.connectors.pull(required(args, "id"), {
          path: required(args, "path"),
          ...(name === undefined ? {} : { name }),
          ...(maxBytes === undefined ? {} : { maxBytes }),
        });
      }
      case "whale_cloud_upload": {
        if (options.connectors === undefined) throw new ToolError("whale/connectors-unavailable", "云盘连接器未配置");
        if (!client.scopes.includes("approve")) throw new ToolError("whale/scope-required", "客户端没有 approve scope");
        const maxBytes = optionalNumber(args, "maxBytes");
        return await options.connectors.upload(required(args, "id"), {
          path: required(args, "path"),
          sourcePath: required(args, "sourcePath"),
          overwrite: args.overwrite === true,
          ...(maxBytes === undefined ? {} : { maxBytes }),
        });
      }
      case "whale_notifications": {
        if (options.notifications === undefined) throw new ToolError("whale/notifications-unavailable", "通知适配器未配置");
        return {
          catalog: options.notifications.catalog(),
          adapters: options.notifications.adapters(),
          receipts: options.notifications.receipts().slice(-20),
        };
      }
      case "whale_notify_test": {
        if (options.notifications === undefined) throw new ToolError("whale/notifications-unavailable", "通知适配器未配置");
        if (!client.scopes.includes("request")) throw new ToolError("whale/scope-required", "客户端没有 request scope");
        return { receipts: await options.notifications.test(optional(args, "adapterId")) };
      }
      case "whale_host_trust": {
        if (options.service.trustReport === undefined) throw new ToolError("whale/trust-unavailable", "信任表未配置");
        return await options.service.trustReport();
      }
      case "whale_presets": {
        if (options.presets === undefined) throw new ToolError("whale/presets-unavailable", "预设服务未配置");
        return { presets: options.presets.list() };
      }
      case "whale_backups": {
        if (options.backups === undefined) throw new ToolError("whale/backups-unavailable", "备份服务未配置");
        const id = optional(args, "id");
        return id === undefined ? { backups: options.backups.list() } : options.backups.verify(id);
      }
      case "whale_alignment": {
        if (options.alignment === undefined) throw new ToolError("whale/alignment-unavailable", "对齐服务未配置");
        const id = optional(args, "id");
        if (id === undefined) return { requests: options.alignment.list() };
        const request = options.alignment.get(id);
        if (request === undefined) throw new ToolError("whale/alignment-not-found", "对齐请求不存在");
        return request;
      }
      case "whale_alignment_plan": {
        if (options.alignment === undefined) throw new ToolError("whale/alignment-unavailable", "对齐服务未配置");
        return await options.alignment.plan(required(args, "hostId"), optional(args, "expectedDigest"));
      }
      case "whale_request_alignment": {
        if (options.alignment === undefined) throw new ToolError("whale/alignment-unavailable", "对齐服务未配置");
        if (!client.scopes.includes("request")) throw new ToolError("whale/scope-required", "客户端没有 request scope");
        const expectedDigest = optional(args, "expectedDigest");
        return {
          request: await options.alignment.create({
            hostId: required(args, "hostId"),
            ...(expectedDigest === undefined ? {} : { expectedDigest }),
            requestedBy: client.name,
            source: `mcp:${client.id}`,
          }),
        };
      }
      case "whale_approve_alignment": {
        if (options.alignment === undefined) throw new ToolError("whale/alignment-unavailable", "对齐服务未配置");
        if (!client.scopes.includes("approve")) throw new ToolError("whale/scope-required", "客户端没有 approve scope");
        return { request: await options.alignment.approve(required(args, "id"), `mcp:${client.name}`) };
      }
      case "whale_status": {
        if (options.status === undefined) throw new ToolError("whale/status-unavailable", "状态汇总未配置");
        return await options.status.status();
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
          instructions: "Whale fleet MCP. Start with whale_status, then whale_list_hosts and whale_environment_diff. Read tools cover trust, cloud materials, notifications, presets, backups and alignment. request_* tools create pending requests (request scope); alignment approval and cloud upload require the operator-only approve scope. Never claim approval or success without reading a receipt.",
        };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: [
            ...TOOLS,
            ...(options.connectors === undefined ? [] : CONNECTOR_TOOLS),
            ...(options.notifications === undefined ? [] : NOTIFICATION_TOOLS),
            ...(options.service.trustReport === undefined ? [] : [TRUST_TOOL]),
            ...(options.presets === undefined && options.backups === undefined ? [] : PRESET_BACKUP_TOOLS),
            ...(options.alignment === undefined ? [] : ALIGNMENT_TOOLS),
            ...(options.status === undefined ? [] : [STATUS_TOOL]),
            ...(options.requests === undefined ? [] : [REQUEST_TOOL]),
          ],
        };
      case "tools/call": {
        const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof params.name !== "string") throw Object.assign(new Error("Unknown tool"), { rpc: -32602 });
        try {
          const result = await handleCall(params.name, isRecord(params.arguments) ? params.arguments : {}, client);
          return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: toolErrorCode(error) }] };
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

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolError("whale/invalid-input", `${name} 无效`);
  }
  return value;
}

function toolErrorCode(error: unknown): string {
  if (error instanceof ToolError) return error.code;
  if (error instanceof FleetServiceError) return error.code;
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code !== "string") return "whale/unavailable";
  if (code.startsWith("connector/") || code.startsWith("notification/") || code === "send-result-unknown") return code;
  return `whale/${code}`;
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
