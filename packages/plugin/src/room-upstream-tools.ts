import type {
  FusionToolDefinition,
  FusionToolExecutionContext,
  FusionToolExecutionResult,
  FusionToolHostContext,
} from "./upstream-tools.js";

const FUSION_TO_UPSTREAM = {
  fusion_room_create: "room_create",
  fusion_room_attach_session: "room_attach_session",
  fusion_room_remove_member: "room_remove_member",
  fusion_room_send: "room_send",
  fusion_room_broadcast: "room_broadcast",
  fusion_room_close: "room_close",
} as const;

const UPSTREAM_TO_FUSION = {
  room_create: "fusion_room_create",
  room_attach_session: "fusion_room_attach_session",
  room_remove_member: "fusion_room_remove_member",
  room_send: "fusion_room_send",
  room_broadcast: "fusion_room_broadcast",
  room_close: "fusion_room_close",
} as const;

const MAX_NAME_LENGTH = 120;
const MAX_TOPIC_LENGTH = 800;
const MAX_ID_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 16_000;
const MAX_SUMMARY_LENGTH = 4_000;
const APPROVAL_REQUIRED_TOOLS = new Set<FusionRoomWriteToolName>([
  "fusion_room_remove_member",
  "fusion_room_broadcast",
  "fusion_room_close",
]);
const REDACTED_KEYS = new Set([
  "address",
  "digest",
  "privateKey",
  "private_key",
  "secret",
  "token",
  "credential",
  "credentials",
]);
const DROPPED_CONTENT_KEYS = new Set([
  "body",
  "content",
  "message",
  "messages",
  "text",
  "prompt",
  "raw",
]);

export type FusionRoomWriteToolName = keyof typeof FUSION_TO_UPSTREAM;
export type RoomWriteToolName = typeof FUSION_TO_UPSTREAM[FusionRoomWriteToolName];

// Derived from the same APPROVAL_REQUIRED_TOOLS set the
// executor consults, for the capability snapshot
// (write-capabilities.ts).
export const ROOM_WRITE_ACTIONS = (
  Object.entries(FUSION_TO_UPSTREAM) as Array<[FusionRoomWriteToolName, RoomWriteToolName]>
).map(([action, upstream]) => ({
  action,
  upstream,
  approvalRequired: APPROVAL_REQUIRED_TOOLS.has(action),
}));

export interface RoomToolGuardExecution {
  readonly name: string;
  readonly callId: string;
  readonly parent?: unknown;
}

export type RoomToolGuard = (
  execution: RoomToolGuardExecution,
) => string | undefined;

interface RoomToolExecutionInput {
  readonly callId: string;
  readonly rootCallId?: string;
  readonly name: RoomWriteToolName;
  readonly arguments: unknown;
  readonly agent?: unknown;
  readonly parent?: unknown;
  readonly signal: AbortSignal;
}

interface RoomToolExecutionError {
  readonly message?: string;
  readonly info?: {
    readonly name?: string;
    readonly code?: string;
  };
}

interface RoomToolExecutionResult extends Omit<FusionToolExecutionResult, "error"> {
  readonly error?: RoomToolExecutionError;
}

type RoomToolExecutor = (
  input: RoomToolExecutionInput,
) => Promise<RoomToolExecutionResult>;

interface RoomApprovalRequest {
  readonly agent: unknown;
  readonly toolName: FusionRoomWriteToolName;
  readonly callId: string;
  readonly reason: string;
  readonly signal: AbortSignal;
}

interface RoomApprovalService {
  request(request: RoomApprovalRequest): Promise<string>;
}

export type RoomHarnessErrorFactory = (
  message: string,
  code: string,
) => Error & { code?: string };

export interface RoomWriteToolOptions {
  readonly errorFactory?: RoomHarnessErrorFactory;
}

interface RoomUpstreamErrorContext {
  readonly tool: FusionRoomWriteToolName;
  readonly upstreamCode: string;
  readonly upstreamName: RoomWriteToolName;
  readonly upstreamErrorName: string;
  readonly originalMessage: string;
  readonly message: string;
}

export interface RoomStructuredError extends Error {
  readonly code: string;
  readonly tool: FusionRoomWriteToolName;
  readonly upstreamCode: string;
  readonly upstreamName: RoomWriteToolName;
  readonly upstreamErrorName: string;
  readonly originalMessage: string;
}

let nestedCallSequence = 0;

function isFusionRoomWriteTool(tool: string): tool is FusionRoomWriteToolName {
  return Object.hasOwn(FUSION_TO_UPSTREAM, tool);
}

function nestedCallId(parentCallId: string, tool: FusionRoomWriteToolName): string {
  nestedCallSequence += 1;
  return `${parentCallId}:fusion:${tool}:${nestedCallSequence}`;
}

function requireExecutionContext(
  exec: FusionToolExecutionContext | undefined,
): FusionToolExecutionContext {
  if (exec === undefined) {
    throw new Error("FUSION_TOOL_CONTEXT_UNAVAILABLE");
  }
  // Same runtime prerequisite contract as the other write bridges:
  // declared types do not stop a host from handing over a context
  // with a missing call id, parent token, or cancellation signal,
  // and such a context must fail before approval or upstream
  // execute are ever reached.
  if (typeof exec.callId !== "string" || exec.callId === "") {
    throw new Error("FUSION_TOOL_CONTEXT_INVALID:callId");
  }
  if (exec.token === undefined || exec.token === null) {
    throw new Error("FUSION_TOOL_CONTEXT_INVALID:token");
  }
  if (
    exec.signal === undefined
    || exec.signal === null
    || typeof exec.signal.aborted !== "boolean"
  ) {
    throw new Error("FUSION_TOOL_CONTEXT_INVALID:signal");
  }
  // Same identity tightening as the other write bridges: an
  // already-aborted caller mints nothing, and a present
  // rootCallId must be a usable lineage string.
  if (exec.signal.aborted) {
    throw new Error("FUSION_TOOL_CONTEXT_INVALID:signalAborted");
  }
  if (
    exec.rootCallId !== undefined
    && (typeof exec.rootCallId !== "string" || exec.rootCallId === "")
  ) {
    throw new Error("FUSION_TOOL_CONTEXT_INVALID:rootCallId");
  }
  return exec;
}

function argumentsObject(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("FUSION_ROOM_ARGUMENTS_INVALID");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`FUSION_ROOM_UNKNOWN_ARGUMENT:${key}`);
    }
  }
  return record;
}

function requiredString(
  args: Record<string, unknown>,
  field: string,
  maxLength: number,
  code: string,
): string {
  const value = args[field];
  if (typeof value !== "string") {
    throw new Error(`FUSION_ROOM_${code}_INVALID`);
  }
  if (value.trim() === "") {
    throw new Error(`FUSION_ROOM_${code}_REQUIRED`);
  }
  if (value.includes("\0")) {
    throw new Error(`FUSION_ROOM_INPUT_NUL:${field}`);
  }
  if (value.length > maxLength) {
    throw new Error(`FUSION_ROOM_${code}_TOO_LONG`);
  }
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  field: string,
  maxLength: number,
  code: string,
): string | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`FUSION_ROOM_${code}_INVALID`);
  }
  if (value.includes("\0")) {
    throw new Error(`FUSION_ROOM_INPUT_NUL:${field}`);
  }
  if (value.length > maxLength) {
    throw new Error(`FUSION_ROOM_${code}_TOO_LONG`);
  }
  return value;
}

function optionalBoolean(
  args: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`FUSION_ROOM_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

function renderJson(_args: unknown, value: unknown) {
  return [{ type: "text" as const, text: JSON.stringify(value) ?? "null" }];
}

function isFusionNestedCall(callId: string, fusionName: string): boolean {
  const escapedFusionName = fusionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`:fusion:${escapedFusionName}:\\d+$`, "u").test(callId);
}

export function createRoomWriteGuard(allowRoomWrites: boolean): RoomToolGuard {
  return (execution) => {
    if (!Object.hasOwn(UPSTREAM_TO_FUSION, execution.name)) return undefined;
    const upstreamName = execution.name as RoomWriteToolName;
    const fusionName = UPSTREAM_TO_FUSION[upstreamName];
    if (!allowRoomWrites) {
      return `FUSION_ROOM_WRITES_DISABLED: ${execution.name} is blocked until FUSION_ALLOW_ROOM_WRITES=true.`;
    }
    if (
      execution.parent === undefined
      || !isFusionNestedCall(execution.callId, fusionName)
    ) {
      return `FUSION_ROOM_WRITES_GUARDED: do not call ${execution.name} directly; use ${fusionName} through Fusion.`;
    }
    return undefined;
  };
}

export class RoomUpstreamToolError extends Error implements RoomStructuredError {
  readonly code: string;
  readonly tool: FusionRoomWriteToolName;
  readonly upstreamCode: string;
  readonly upstreamName: RoomWriteToolName;
  readonly upstreamErrorName: string;
  readonly originalMessage: string;

  constructor(context: RoomUpstreamErrorContext) {
    super(context.message);
    this.name = context.upstreamErrorName;
    this.code = context.upstreamCode;
    this.tool = context.tool;
    this.upstreamCode = context.upstreamCode;
    this.upstreamName = context.upstreamName;
    this.upstreamErrorName = context.upstreamErrorName;
    this.originalMessage = context.originalMessage;
  }
}

interface HarnessErrorModule {
  readonly HarnessError?: new (
    message: string,
    code: string,
    options?: ErrorOptions,
  ) => Error & { code: string };
}

let runtimeHarnessErrorFactoryPromise:
  | Promise<RoomHarnessErrorFactory | undefined>
  | undefined;

async function loadRuntimeHarnessErrorFactory(): Promise<
  RoomHarnessErrorFactory | undefined
> {
  try {
    const scope = "@deepseek-ai";
    const packageName = "dsh-llm";
    const loaded = await import(`${scope}/${packageName}`) as HarnessErrorModule;
    if (typeof loaded.HarnessError !== "function") return undefined;
    const HarnessError = loaded.HarnessError;
    return (message, code) => new HarnessError(message, code);
  } catch {
    return undefined;
  }
}

function runtimeHarnessErrorFactory(): Promise<
  RoomHarnessErrorFactory | undefined
> {
  runtimeHarnessErrorFactoryPromise ??= loadRuntimeHarnessErrorFactory();
  return runtimeHarnessErrorFactoryPromise;
}

function structuredErrorContext(
  tool: FusionRoomWriteToolName,
  result: RoomToolExecutionResult,
): RoomUpstreamErrorContext {
  const upstreamCode = result.error?.info?.code?.trim() || "UNKNOWN";
  const upstreamErrorName = result.error?.info?.name?.trim() || "RoomUpstreamToolError";
  const originalMessage = result.error?.message ?? "UNKNOWN_UPSTREAM_ERROR";
  return {
    tool,
    upstreamCode,
    upstreamName: FUSION_TO_UPSTREAM[tool],
    upstreamErrorName,
    originalMessage,
    message: `UPSTREAM_TOOL_FAILED:${tool}:${upstreamCode}:${originalMessage}`,
  };
}

function decorateStructuredError(
  error: Error,
  context: RoomUpstreamErrorContext,
): RoomStructuredError {
  return Object.assign(error, {
    name: context.upstreamErrorName,
    code: context.upstreamCode,
    tool: context.tool,
    upstreamCode: context.upstreamCode,
    upstreamName: context.upstreamName,
    upstreamErrorName: context.upstreamErrorName,
    originalMessage: context.originalMessage,
  }) as RoomStructuredError;
}

async function createRoomUpstreamError(
  tool: FusionRoomWriteToolName,
  result: RoomToolExecutionResult,
  errorFactory?: RoomHarnessErrorFactory,
): Promise<RoomStructuredError> {
  const context = structuredErrorContext(tool, result);
  try {
    const factory = errorFactory ?? await runtimeHarnessErrorFactory();
    if (factory !== undefined) {
      const error = factory(context.message, context.upstreamCode);
      if (error instanceof Error) {
        return decorateStructuredError(error, context);
      }
    }
  } catch {
    // The DSH module remains optional for standalone tests.
  }
  return new RoomUpstreamToolError(context);
}

function sanitizeRoomResult(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-limit]";
  if (typeof value === "string") {
    return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitizeRoomResult(entry, depth + 1));
  }
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (REDACTED_KEYS.has(key)) {
      result[key] = "[redacted]";
      continue;
    }
    if (DROPPED_CONTENT_KEYS.has(key)) continue;
    result[key] = sanitizeRoomResult(entry, depth + 1);
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

function roomApprovalService(ctx: FusionToolHostContext): RoomApprovalService {
  // Mirrors the AgentTeams bridge: resolving the service must
  // never leak a host error or a TypeError. A throwing ctx.get,
  // a null/non-object service, or a non-callable request all
  // mean the same thing to the caller: approval is unavailable.
  let service: unknown;
  try {
    service = ctx.get?.("approval");
  } catch {
    throw new Error("FUSION_ROOM_APPROVAL_UNAVAILABLE");
  }
  if (
    service === null
    || typeof service !== "object"
    || typeof (service as { request?: unknown }).request !== "function"
  ) {
    throw new Error("FUSION_ROOM_APPROVAL_UNAVAILABLE");
  }
  return service as RoomApprovalService;
}

async function requestRoomApproval(
  ctx: FusionToolHostContext,
  tool: FusionRoomWriteToolName,
  exec: FusionToolExecutionContext,
): Promise<void> {
  // Identity prerequisites precede service resolution, matching
  // the AgentTeams bridge's check order.
  if (exec.agent === undefined) {
    throw new Error("FUSION_ROOM_APPROVAL_AGENT_REQUIRED");
  }
  const approval = roomApprovalService(ctx);
  let outcome: string;
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: tool,
      callId: exec.callId,
      reason: `DSH Fusion requests one-time approval for upstream ${FUSION_TO_UPSTREAM[tool]}.`,
      signal: exec.signal,
    });
  } catch (error) {
    throw new Error(`FUSION_ROOM_APPROVAL_REQUEST_FAILED:${errorMessage(error)}`);
  }
  // Outcomes map to a fixed code vocabulary. The previous
  // upper-casing interpolated arbitrary host strings (spaces,
  // casing, non-strings) into the error code; an unrecognised
  // or malformed outcome now fails closed with the fixed
  // denial code.
  switch (outcome) {
    case "allowed-once":
      return;
    case "rejected":
      throw new Error("FUSION_ROOM_APPROVAL_REJECTED");
    case "cancelled":
      throw new Error("FUSION_ROOM_APPROVAL_CANCELLED");
    case "unavailable":
      throw new Error("FUSION_ROOM_APPROVAL_UNAVAILABLE");
    default:
      throw new Error("FUSION_ROOM_APPROVAL_DENIED");
  }
}

export async function executeRoomUpstreamTool(
  ctx: FusionToolHostContext,
  tool: FusionRoomWriteToolName,
  args: Record<string, unknown>,
  exec?: FusionToolExecutionContext,
  options: RoomWriteToolOptions = {},
): Promise<unknown> {
  // Caller-context validation precedes registry capability,
  // matching the other write bridges: the first error per
  // action is always a versioned FUSION_TOOL_CONTEXT_* code.
  const currentExec = requireExecutionContext(exec);
  if (typeof ctx.tools?.execute !== "function") {
    throw new Error("FUSION_UPSTREAM_TOOLS_UNAVAILABLE");
  }
  if (!isFusionRoomWriteTool(tool)) {
    throw new Error("FUSION_UPSTREAM_TOOL_NOT_ALLOWED");
  }
  if (APPROVAL_REQUIRED_TOOLS.has(tool)) {
    await requestRoomApproval(ctx, tool, currentExec);
  }

  const execute = ctx.tools.execute as unknown as RoomToolExecutor;
  const result = await execute({
    callId: nestedCallId(currentExec.callId, tool),
    ...(currentExec.rootCallId === undefined ? {} : { rootCallId: currentExec.rootCallId }),
    name: FUSION_TO_UPSTREAM[tool],
    arguments: args,
    ...(currentExec.agent === undefined ? {} : { agent: currentExec.agent }),
    parent: currentExec.token,
    signal: currentExec.signal,
  });
  if (result.isError) {
    throw await createRoomUpstreamError(tool, result, options.errorFactory);
  }
  return sanitizeRoomResult(result.value);
}

const genericRoomOutput = {
  schema: { type: "object", additionalProperties: true },
  render: renderJson,
};

export function createRoomWriteTools(
  ctx: FusionToolHostContext,
  options: RoomWriteToolOptions = {},
): Array<FusionToolDefinition<any, any>> {
  return [
    {
      name: "fusion_room_create",
      description: "Create a persistent Agent Team Room owned by the calling Session.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          topic: { type: "string" },
        },
        required: ["name"],
      },
      output: genericRoomOutput,
      async execute(args: unknown, exec) {
        const params = argumentsObject(args, ["name", "topic"]);
        const name = requiredString(params, "name", MAX_NAME_LENGTH, "NAME");
        const topic = optionalString(params, "topic", MAX_TOPIC_LENGTH, "TOPIC");
        return await executeRoomUpstreamTool(
          ctx,
          "fusion_room_create",
          { name, ...(topic === undefined ? {} : { topic }) },
          exec,
          options,
        );
      },
    },
    {
      name: "fusion_room_attach_session",
      description: "Attach an existing continuable direct-child Session to an owned Room.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          room_id: { type: "string" },
          session_id: { type: "string" },
          name: { type: "string" },
        },
        required: ["room_id", "session_id"],
      },
      output: genericRoomOutput,
      async execute(args: unknown, exec) {
        const params = argumentsObject(args, ["room_id", "session_id", "name"]);
        const roomId = requiredString(params, "room_id", MAX_ID_LENGTH, "ROOM_ID");
        const sessionId = requiredString(params, "session_id", MAX_ID_LENGTH, "SESSION_ID");
        const name = optionalString(params, "name", MAX_NAME_LENGTH, "NAME");
        return await executeRoomUpstreamTool(
          ctx,
          "fusion_room_attach_session",
          {
            room_id: roomId,
            session_id: sessionId,
            ...(name === undefined ? {} : { name }),
          },
          exec,
          options,
        );
      },
    },
    {
      name: "fusion_room_remove_member",
      description: "Detach one Room member without deleting its backing Session.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          room_id: { type: "string" },
          member_id: { type: "string" },
          interrupt_running: { type: "boolean" },
        },
        required: ["room_id", "member_id"],
      },
      output: genericRoomOutput,
      async execute(args: unknown, exec) {
        const params = argumentsObject(args, ["room_id", "member_id", "interrupt_running"]);
        const roomId = requiredString(params, "room_id", MAX_ID_LENGTH, "ROOM_ID");
        const memberId = requiredString(params, "member_id", MAX_ID_LENGTH, "MEMBER_ID");
        const interrupt = optionalBoolean(params, "interrupt_running") ?? false;
        return await executeRoomUpstreamTool(
          ctx,
          "fusion_room_remove_member",
          { room_id: roomId, member_id: memberId, interrupt_running: interrupt },
          exec,
          options,
        );
      },
    },
    {
      name: "fusion_room_send",
      description: "Send one direct message through an attached Room member provider.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          room_id: { type: "string" },
          to_member_id: { type: "string" },
          message: { type: "string" },
        },
        required: ["room_id", "to_member_id", "message"],
      },
      output: genericRoomOutput,
      async execute(args: unknown, exec) {
        const params = argumentsObject(args, ["room_id", "to_member_id", "message"]);
        const roomId = requiredString(params, "room_id", MAX_ID_LENGTH, "ROOM_ID");
        const memberId = requiredString(params, "to_member_id", MAX_ID_LENGTH, "MEMBER_ID");
        const message = requiredString(params, "message", MAX_MESSAGE_LENGTH, "MESSAGE");
        return await executeRoomUpstreamTool(
          ctx,
          "fusion_room_send",
          { room_id: roomId, to_member_id: memberId, message },
          exec,
          options,
        );
      },
    },
    {
      name: "fusion_room_broadcast",
      description: "Broadcast one message to every active member through one-time user approval.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          room_id: { type: "string" },
          message: { type: "string" },
        },
        required: ["room_id", "message"],
      },
      output: genericRoomOutput,
      async execute(args: unknown, exec) {
        const params = argumentsObject(args, ["room_id", "message"]);
        const roomId = requiredString(params, "room_id", MAX_ID_LENGTH, "ROOM_ID");
        const message = requiredString(params, "message", MAX_MESSAGE_LENGTH, "MESSAGE");
        return await executeRoomUpstreamTool(
          ctx,
          "fusion_room_broadcast",
          { room_id: roomId, message },
          exec,
          options,
        );
      },
    },
    {
      name: "fusion_room_close",
      description: "Close one owned Room without deleting its backing Sessions.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          room_id: { type: "string" },
          summary: { type: "string" },
          interrupt_running_members: { type: "boolean" },
        },
        required: ["room_id"],
      },
      output: genericRoomOutput,
      async execute(args: unknown, exec) {
        const params = argumentsObject(args, [
          "room_id",
          "summary",
          "interrupt_running_members",
        ]);
        const roomId = requiredString(params, "room_id", MAX_ID_LENGTH, "ROOM_ID");
        const summary = optionalString(params, "summary", MAX_SUMMARY_LENGTH, "SUMMARY");
        const interrupt = optionalBoolean(params, "interrupt_running_members") ?? false;
        return await executeRoomUpstreamTool(
          ctx,
          "fusion_room_close",
          {
            room_id: roomId,
            ...(summary === undefined ? {} : { summary }),
            interrupt_running_members: interrupt,
          },
          exec,
          options,
        );
      },
    },
  ];
}
