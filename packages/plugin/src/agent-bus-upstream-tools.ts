import type {
  FusionToolDefinition,
  FusionToolExecutionContext,
  FusionToolExecutionInput,
  FusionToolExecutionResult,
  FusionToolHostContext,
} from "./upstream-tools.js";

const FUSION_TO_UPSTREAM = {
  fusion_bus_send_note: "send_note",
  fusion_bus_create_flow: "create_flow",
  fusion_bus_create_task: "create_task",
  fusion_bus_report_task: "report_task",
  fusion_bus_settle_task: "settle_task",
  fusion_bus_cancel_task: "cancel_task",
} as const;

const UPSTREAM_TO_FUSION = {
  send_note: "fusion_bus_send_note",
  create_flow: "fusion_bus_create_flow",
  create_task: "fusion_bus_create_task",
  report_task: "fusion_bus_report_task",
  settle_task: "fusion_bus_settle_task",
  cancel_task: "fusion_bus_cancel_task",
} as const;

const MAX_MESSAGE_LENGTH = 16_000;
const MAX_TITLE_LENGTH = 80;
const MAX_ID_LENGTH = 256;
const MAX_DEPENDENCIES = 64;
const MAX_FEEDBACK_LENGTH = 4_000;
const MAX_CANCEL_REASON_LENGTH = 400;
const MAX_FLOW_DESCRIPTION_LENGTH = 400;
const MAX_ACCEPTANCE_CRITERIA_LENGTH = 2_000;
const ERROR_NAME_FALLBACK = "AgentBusUpstreamToolError";
const ERROR_CODE_FALLBACK = "UNKNOWN";

export type FusionBusWriteToolName = keyof typeof FUSION_TO_UPSTREAM;
export type AgentBusWriteToolName = typeof FUSION_TO_UPSTREAM[FusionBusWriteToolName];

// AgentBus writes have no approval step by design (the opt-in
// switch and the write guard are authoritative), so every
// action derives approvalRequired: false. Exported for the
// capability snapshot (write-capabilities.ts).
export const AGENT_BUS_WRITE_ACTIONS = (
  Object.entries(FUSION_TO_UPSTREAM) as Array<[FusionBusWriteToolName, AgentBusWriteToolName]>
).map(([action, upstream]) => ({
  action,
  upstream,
  approvalRequired: false,
}));
export type AgentBusTaskMode = "followup" | "steer";
export type AgentBusSettleOutcome = "success" | "failure";

export interface AgentBusToolGuardExecution {
  readonly name: string;
  readonly callId: string;
  readonly parent?: unknown;
}

export type AgentBusToolGuard = (
  execution: AgentBusToolGuardExecution,
) => string | undefined;

interface AgentBusToolExecutionInput {
  readonly callId: string;
  readonly rootCallId?: string;
  readonly name: AgentBusWriteToolName;
  readonly arguments: unknown;
  readonly agent?: unknown;
  readonly parent?: unknown;
  readonly signal: AbortSignal;
}

interface AgentBusToolExecutionError {
  readonly message?: string;
  readonly info?: {
    readonly name?: string;
    readonly code?: string;
  };
}

interface AgentBusToolExecutionResult extends Omit<FusionToolExecutionResult, "error"> {
  readonly error?: AgentBusToolExecutionError;
}

type AgentBusToolExecutor = (
  input: AgentBusToolExecutionInput,
) => Promise<AgentBusToolExecutionResult>;

export type AgentBusHarnessErrorFactory = (
  message: string,
  code: string,
) => Error & { code?: string };

export interface AgentBusWriteToolOptions {
  readonly errorFactory?: AgentBusHarnessErrorFactory;
}

interface AgentBusUpstreamErrorContext {
  readonly tool: FusionBusWriteToolName;
  readonly upstreamCode: string;
  readonly upstreamName: AgentBusWriteToolName;
  readonly upstreamErrorName: string;
  readonly originalMessage: string;
  readonly message: string;
}

export interface AgentBusStructuredError extends Error {
  readonly code: string;
  readonly tool: FusionBusWriteToolName;
  readonly upstreamCode: string;
  readonly upstreamName: AgentBusWriteToolName;
  readonly upstreamErrorName: string;
  readonly originalMessage: string;
}

interface SendNoteArgs {
  target: string;
  content: string;
}

interface CreateFlowArgs {
  name: string;
  description?: string;
}

interface CreateTaskArgs {
  target: string;
  content: string;
  title: string;
  mode?: AgentBusTaskMode;
  reviewer?: string;
  task_id?: string;
  dependencies?: string[];
  acceptance_criteria?: string;
  flow_id?: string;
}

interface ReportTaskArgs {
  task_id: string;
  result: string;
}

interface SettleTaskArgs {
  task_id: string;
  outcome: AgentBusSettleOutcome;
  feedback?: string;
}

interface CancelTaskArgs {
  task_id: string;
  reason?: string;
}

let nestedCallSequence = 0;

function isFusionBusWriteTool(tool: string): tool is FusionBusWriteToolName {
  return Object.hasOwn(FUSION_TO_UPSTREAM, tool);
}

function nestedCallId(parentCallId: string, tool: FusionBusWriteToolName): string {
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
  // and such a context must never reach the upstream execute.
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
    throw new Error("FUSION_BUS_ARGUMENTS_INVALID");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`FUSION_BUS_UNKNOWN_ARGUMENT:${key}`);
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
    throw new Error(`FUSION_BUS_${code}_INVALID`);
  }
  if (value.trim() === "") {
    throw new Error(`FUSION_BUS_${code}_REQUIRED`);
  }
  if (value.includes("\0")) {
    throw new Error(`FUSION_BUS_INPUT_NUL:${field}`);
  }
  if (value.length > maxLength) {
    throw new Error(`FUSION_BUS_${code}_TOO_LONG`);
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
    throw new Error(`FUSION_BUS_${code}_INVALID`);
  }
  if (value.includes("\0")) {
    throw new Error(`FUSION_BUS_INPUT_NUL:${field}`);
  }
  if (value.length > maxLength) {
    throw new Error(`FUSION_BUS_${code}_TOO_LONG`);
  }
  return value;
}

function taskMode(args: Record<string, unknown>): AgentBusTaskMode | undefined {
  const value = args.mode;
  if (value === undefined) return undefined;
  if (value !== "followup" && value !== "steer") {
    throw new Error("FUSION_BUS_MODE_INVALID");
  }
  return value;
}

function settleOutcome(args: Record<string, unknown>): AgentBusSettleOutcome {
  const value = args.outcome;
  if (value !== "success" && value !== "failure") {
    throw new Error("FUSION_BUS_OUTCOME_INVALID");
  }
  return value;
}

function dependencies(
  args: Record<string, unknown>,
): string[] | undefined {
  const value = args.dependencies;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("FUSION_BUS_DEPENDENCIES_INVALID");
  }
  if (value.length > MAX_DEPENDENCIES) {
    throw new Error("FUSION_BUS_DEPENDENCIES_TOO_MANY");
  }
  const normalized: string[] = [];
  for (const dependency of value) {
    if (typeof dependency !== "string" || dependency.trim() === "") {
      throw new Error("FUSION_BUS_DEPENDENCY_INVALID");
    }
    if (dependency.includes("\0")) {
      throw new Error("FUSION_BUS_INPUT_NUL:dependencies");
    }
    if (dependency.length > MAX_ID_LENGTH) {
      throw new Error("FUSION_BUS_DEPENDENCY_TOO_LONG");
    }
    normalized.push(dependency);
  }
  return normalized;
}

function renderJson(_args: unknown, value: unknown) {
  return [{ type: "text" as const, text: JSON.stringify(value) ?? "null" }];
}

function objectOutput(properties: Record<string, unknown>, required: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

function isFusionNestedCall(callId: string, fusionName: string): boolean {
  const escapedFusionName = fusionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`:fusion:${escapedFusionName}:\\d+$`, "u").test(callId);
}

/**
 * Guards only the six AgentBus write tools proxied by Fusion. Other AgentBus
 * tools remain untouched. The guard is registered unconditionally, so the
 * disabled state is enforced on the upstream surface too.
 */
export function createAgentBusWriteGuard(
  allowAgentBusWrites: boolean,
): AgentBusToolGuard {
  return (execution) => {
    if (!Object.hasOwn(UPSTREAM_TO_FUSION, execution.name)) return undefined;
    const upstreamName = execution.name as AgentBusWriteToolName;
    const fusionName = UPSTREAM_TO_FUSION[upstreamName];
    if (!allowAgentBusWrites) {
      return `FUSION_AGENT_BUS_WRITES_DISABLED: ${execution.name} is blocked until FUSION_ALLOW_AGENT_BUS_WRITES=true.`;
    }
    if (
      execution.parent === undefined
      || !isFusionNestedCall(execution.callId, fusionName)
    ) {
      return `FUSION_AGENT_BUS_WRITES_GUARDED: do not call ${execution.name} directly; use ${fusionName} through Fusion, which requires a nested parent token.`;
    }
    return undefined;
  };
}

export class AgentBusUpstreamToolError extends Error implements AgentBusStructuredError {
  readonly code: string;
  readonly tool: FusionBusWriteToolName;
  readonly upstreamCode: string;
  readonly upstreamName: AgentBusWriteToolName;
  readonly upstreamErrorName: string;
  readonly originalMessage: string;

  constructor(context: AgentBusUpstreamErrorContext) {
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
  | Promise<AgentBusHarnessErrorFactory | undefined>
  | undefined;

async function loadRuntimeHarnessErrorFactory(): Promise<
  AgentBusHarnessErrorFactory | undefined
> {
  try {
    const scope = "@deepseek-ai";
    const packageName = "dsh-llm";
    const specifier = `${scope}/${packageName}`;
    const loaded = await import(specifier) as HarnessErrorModule;
    const HarnessError = loaded.HarnessError;
    if (typeof HarnessError !== "function") return undefined;
    return (message, code) => new HarnessError(message, code);
  } catch {
    return undefined;
  }
}

function runtimeHarnessErrorFactory(): Promise<
  AgentBusHarnessErrorFactory | undefined
> {
  runtimeHarnessErrorFactoryPromise ??= loadRuntimeHarnessErrorFactory();
  return runtimeHarnessErrorFactoryPromise;
}

function structuredErrorContext(
  tool: FusionBusWriteToolName,
  result: AgentBusToolExecutionResult,
): AgentBusUpstreamErrorContext {
  const upstreamCode = result.error?.info?.code?.trim() || ERROR_CODE_FALLBACK;
  const upstreamErrorName = result.error?.info?.name?.trim() || ERROR_NAME_FALLBACK;
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
  context: AgentBusUpstreamErrorContext,
): AgentBusStructuredError {
  return Object.assign(error, {
    name: context.upstreamErrorName,
    code: context.upstreamCode,
    tool: context.tool,
    upstreamCode: context.upstreamCode,
    upstreamName: context.upstreamName,
    upstreamErrorName: context.upstreamErrorName,
    originalMessage: context.originalMessage,
  }) as AgentBusStructuredError;
}

async function createAgentBusUpstreamError(
  tool: FusionBusWriteToolName,
  result: AgentBusToolExecutionResult,
  errorFactory?: AgentBusHarnessErrorFactory,
): Promise<AgentBusStructuredError> {
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
    // The host package is optional in development; use the local fallback.
  }
  return new AgentBusUpstreamToolError(context);
}

/**
 * Creates the fixed AgentBus write proxy surface. Upstream authorization and
 * the operator opt-in gate remain authoritative; these proxies add no approval
 * workflow of their own.
 */
export function createAgentBusWriteTools(
  ctx: FusionToolHostContext,
  options: AgentBusWriteToolOptions = {},
): Array<FusionToolDefinition<any, any>> {
  return [
    {
      name: "fusion_bus_send_note",
      description: "Send a lightweight note to a live AgentBus peer through the upstream send_note tool.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: { type: "string" },
          content: { type: "string" },
        },
        required: ["target", "content"],
      },
      output: {
        schema: objectOutput({
          delivered: { type: "boolean" },
          queued: { type: "boolean" },
          messageId: { type: "string" },
        }, ["delivered", "queued", "messageId"]),
        render: renderJson,
      },
      async execute(args: SendNoteArgs, exec) {
        const params = argumentsObject(args, ["target", "content"]);
        const target = requiredString(params, "target", MAX_ID_LENGTH, "TARGET");
        const content = requiredString(
          params,
          "content",
          MAX_MESSAGE_LENGTH,
          "CONTENT",
        );
        return await executeAgentBusUpstreamTool(
          ctx,
          "fusion_bus_send_note",
          { target, content },
          exec,
          options,
        );
      },
    },
    {
      name: "fusion_bus_create_flow",
      description: "Create an AgentBus flow container through the upstream create_flow tool.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          description: { type: "string" },
        },
        required: ["name"],
      },
      output: {
        schema: objectOutput({
          flowId: { type: "string" },
          name: { type: "string" },
        }, ["flowId", "name"]),
        render: renderJson,
      },
      async execute(args: CreateFlowArgs, exec) {
        const params = argumentsObject(args, ["name", "description"]);
        const name = requiredString(params, "name", MAX_TITLE_LENGTH, "NAME");
        const description = optionalString(
          params,
          "description",
          MAX_FLOW_DESCRIPTION_LENGTH,
          "DESCRIPTION",
        );
        return await executeAgentBusUpstreamTool(
          ctx,
          "fusion_bus_create_flow",
          {
            name,
            ...(description === undefined ? {} : { description }),
          },
          exec,
          options,
        );
      },
    },
    {
      name: "fusion_bus_create_task",
      description: "Create one AgentBus task through the upstream create_task tool.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: { type: "string" },
          content: { type: "string" },
          title: { type: "string" },
          mode: { type: "string", enum: ["followup", "steer"] },
          reviewer: { type: "string" },
          task_id: { type: "string" },
          dependencies: { type: "array", items: { type: "string" }, maxItems: 64 },
          acceptance_criteria: { type: "string" },
          flow_id: { type: "string" },
        },
        required: ["target", "content", "title"],
      },
      output: {
        schema: objectOutput({
          taskId: { type: "string" },
          status: { type: "string" },
          queuePosition: { type: "number" },
          blockedBy: { type: "array", items: { type: "string" } },
        }, ["taskId", "status", "queuePosition", "blockedBy"]),
        render: renderJson,
      },
      async execute(args: CreateTaskArgs, exec) {
        const params = argumentsObject(args, [
          "target",
          "content",
          "title",
          "mode",
          "reviewer",
          "task_id",
          "dependencies",
          "acceptance_criteria",
          "flow_id",
        ]);
        const target = requiredString(params, "target", MAX_ID_LENGTH, "TARGET");
        const content = requiredString(
          params,
          "content",
          MAX_MESSAGE_LENGTH,
          "CONTENT",
        );
        const title = requiredString(params, "title", MAX_TITLE_LENGTH, "TITLE");
        const mode = taskMode(params);
        const reviewer = optionalString(
          params,
          "reviewer",
          MAX_ID_LENGTH,
          "REVIEWER",
        );
        const taskId = optionalString(
          params,
          "task_id",
          MAX_ID_LENGTH,
          "TASK_ID",
        );
        const dependencyIds = dependencies(params);
        const acceptanceCriteria = optionalString(
          params,
          "acceptance_criteria",
          MAX_ACCEPTANCE_CRITERIA_LENGTH,
          "ACCEPTANCE_CRITERIA",
        );
        const flowId = optionalString(
          params,
          "flow_id",
          MAX_ID_LENGTH,
          "FLOW_ID",
        );
        return await executeAgentBusUpstreamTool(
          ctx,
          "fusion_bus_create_task",
          {
            target,
            content,
            title,
            ...(mode === undefined ? {} : { mode }),
            ...(reviewer === undefined ? {} : { reviewer }),
            ...(taskId === undefined ? {} : { task_id: taskId }),
            ...(dependencyIds === undefined ? {} : { dependencies: dependencyIds }),
            ...(acceptanceCriteria === undefined
              ? {}
              : { acceptance_criteria: acceptanceCriteria }),
            ...(flowId === undefined ? {} : { flow_id: flowId }),
          },
          exec,
          options,
        );
      },
    },
    {
      name: "fusion_bus_report_task",
      description: "Report an AgentBus task result through the upstream report_task tool.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          result: { type: "string" },
        },
        required: ["task_id", "result"],
      },
      output: {
        schema: objectOutput({
          taskId: { type: "string" },
          status: { type: "string" },
        }, ["taskId", "status"]),
        render: renderJson,
      },
      async execute(args: ReportTaskArgs, exec) {
        const params = argumentsObject(args, ["task_id", "result"]);
        const taskId = requiredString(
          params,
          "task_id",
          MAX_ID_LENGTH,
          "TASK_ID",
        );
        const result = requiredString(
          params,
          "result",
          MAX_MESSAGE_LENGTH,
          "RESULT",
        );
        return await executeAgentBusUpstreamTool(
          ctx,
          "fusion_bus_report_task",
          { task_id: taskId, result },
          exec,
          options,
        );
      },
    },
    {
      name: "fusion_bus_settle_task",
      description: "Settle an AgentBus task through the upstream settle_task tool and its authorization rules.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          outcome: { type: "string", enum: ["success", "failure"] },
          feedback: { type: "string" },
        },
        required: ["task_id", "outcome"],
      },
      output: {
        schema: objectOutput({
          taskId: { type: "string" },
          status: { type: "string" },
          outcome: { type: "string" },
        }, ["taskId", "status", "outcome"]),
        render: renderJson,
      },
      async execute(args: SettleTaskArgs, exec) {
        const params = argumentsObject(args, ["task_id", "outcome", "feedback"]);
        const taskId = requiredString(
          params,
          "task_id",
          MAX_ID_LENGTH,
          "TASK_ID",
        );
        const outcome = settleOutcome(params);
        const feedback = optionalString(
          params,
          "feedback",
          MAX_FEEDBACK_LENGTH,
          "FEEDBACK",
        );
        return await executeAgentBusUpstreamTool(
          ctx,
          "fusion_bus_settle_task",
          {
            task_id: taskId,
            outcome,
            ...(feedback === undefined ? {} : { feedback }),
          },
          exec,
          options,
        );
      },
    },
    {
      name: "fusion_bus_cancel_task",
      description: "Cancel an AgentBus task through the upstream cancel_task tool and its authorization rules.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          reason: { type: "string", maxLength: MAX_CANCEL_REASON_LENGTH },
        },
        required: ["task_id"],
      },
      output: {
        schema: objectOutput({
          taskId: { type: "string" },
          status: { type: "string" },
        }, ["taskId", "status"]),
        render: renderJson,
      },
      async execute(args: CancelTaskArgs, exec) {
        const params = argumentsObject(args, ["task_id", "reason"]);
        const taskId = requiredString(
          params,
          "task_id",
          MAX_ID_LENGTH,
          "TASK_ID",
        );
        const reason = optionalString(
          params,
          "reason",
          MAX_CANCEL_REASON_LENGTH,
          "REASON",
        );
        return await executeAgentBusUpstreamTool(
          ctx,
          "fusion_bus_cancel_task",
          {
            task_id: taskId,
            ...(reason === undefined ? {} : { reason }),
          },
          exec,
          options,
        );
      },
    },
  ];
}

export async function executeAgentBusUpstreamTool(
  ctx: FusionToolHostContext,
  tool: FusionBusWriteToolName,
  args: Record<string, unknown>,
  exec?: FusionToolExecutionContext,
  options: AgentBusWriteToolOptions = {},
): Promise<unknown> {
  // Caller-context validation precedes registry capability,
  // matching the other write bridges: the first error per
  // action is always a versioned FUSION_TOOL_CONTEXT_* code.
  const currentExec = requireExecutionContext(exec);
  if (typeof ctx.tools?.execute !== "function") {
    throw new Error("FUSION_UPSTREAM_TOOLS_UNAVAILABLE");
  }
  if (!isFusionBusWriteTool(tool)) {
    throw new Error("FUSION_UPSTREAM_TOOL_NOT_ALLOWED");
  }

  const execute = ctx.tools.execute as unknown as AgentBusToolExecutor;
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
    throw await createAgentBusUpstreamError(tool, result, options.errorFactory);
  }
  return result.value;
}
