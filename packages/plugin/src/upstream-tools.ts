const FUSION_TO_UPSTREAM = {
  fusion_team_approve: "agent_teams_approve",
  fusion_team_resume: "agent_teams_resume",
  fusion_team_send_message: "agent_teams_send_message",
} as const;

const UPSTREAM_TO_FUSION = {
  agent_teams_approve: "fusion_team_approve",
  agent_teams_resume: "fusion_team_resume",
  agent_teams_send_message: "fusion_team_send_message",
} as const;

const MAX_TEXT_LENGTH = 8_000;
const MAX_RECIPIENT_LENGTH = 128;
const MAX_SOURCE_ID_LENGTH = 256;

export type FusionTeamWriteToolName = keyof typeof FUSION_TO_UPSTREAM;
export type AgentTeamsWriteToolName = typeof FUSION_TO_UPSTREAM[FusionTeamWriteToolName];

// The actions whose definitions call requestFusionApproval
// before executing upstream. Kept beside the map so the
// capability snapshot (write-capabilities.ts) derives its
// per-action prerequisites from the same source.
const APPROVAL_REQUIRED_TOOLS = new Set<FusionTeamWriteToolName>([
  "fusion_team_approve",
  "fusion_team_resume",
]);

export const AGENT_TEAMS_WRITE_ACTIONS = (
  Object.entries(FUSION_TO_UPSTREAM) as Array<[FusionTeamWriteToolName, AgentTeamsWriteToolName]>
).map(([action, upstream]) => ({
  action,
  upstream,
  approvalRequired: APPROVAL_REQUIRED_TOOLS.has(action),
}));
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export interface FusionToolExecutionContext {
  readonly callId: string;
  readonly rootCallId?: string;
  readonly agent?: unknown;
  readonly signal: AbortSignal;
  readonly token: unknown;
}

export interface FusionToolExecutionInput {
  readonly callId: string;
  readonly rootCallId?: string;
  readonly name: AgentTeamsWriteToolName;
  readonly arguments: unknown;
  readonly agent?: unknown;
  readonly parent?: unknown;
  readonly signal: AbortSignal;
}

export interface FusionToolExecutionResult {
  readonly isError: boolean;
  readonly value?: unknown;
  readonly error?: {
    readonly message?: string;
    readonly info?: {
      readonly code?: string;
    };
  };
}

export interface AgentTeamsToolGuardExecution {
  readonly name: string;
  readonly callId: string;
  readonly parent?: unknown;
}

export type AgentTeamsToolGuard = (
  execution: AgentTeamsToolGuardExecution,
) => string | undefined;

export interface FusionApprovalRequest {
  readonly agent: unknown;
  readonly toolName: FusionTeamWriteToolName;
  readonly callId: string;
  readonly reason: string;
  readonly signal: AbortSignal;
}

export interface FusionApprovalService {
  request(request: FusionApprovalRequest): Promise<ApprovalOutcome>;
}

export interface FusionToolDefinition<TArgs = Record<string, never>, TResult = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (_args: TArgs, value: TResult) => Array<{ type: "text"; text: string }>;
  };
  execute: (args: TArgs, exec?: FusionToolExecutionContext) => Promise<TResult>;
}

export interface FusionToolRegistry {
  register(tool: FusionToolDefinition<any, any>): () => void;
  execute?(input: FusionToolExecutionInput): Promise<FusionToolExecutionResult>;
  guard?(guard: AgentTeamsToolGuard): () => void;
}

export interface FusionToolHostContext {
  readonly tools?: FusionToolRegistry;
  readonly get?: (name: string) => unknown;
}

let nestedCallSequence = 0;

interface ApproveArgs {
  confirmation: string;
}

interface ResumeArgs {
  reason: string;
}

interface SendMessageArgs {
  to: string;
  content: string;
  from?: string;
  source_task_id?: string;
  source_attempt_id?: string;
}

function isFusionTeamWriteTool(tool: string): tool is FusionTeamWriteToolName {
  return Object.hasOwn(FUSION_TO_UPSTREAM, tool);
}

function nestedCallId(parentCallId: string, tool: FusionTeamWriteToolName): string {
  nestedCallSequence += 1;
  return `${parentCallId}:fusion:${tool}:${nestedCallSequence}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

function requireExecutionContext(
  exec: FusionToolExecutionContext | undefined,
): FusionToolExecutionContext {
  if (exec === undefined) {
    throw new Error("FUSION_TOOL_CONTEXT_UNAVAILABLE");
  }
  // The declared types are not a runtime guarantee: a host can hand
  // over a context whose identity fields are missing or malformed,
  // and forwarding it would mint nested calls with an unverifiable
  // parent, call id, or cancellation signal. Validate the per-action
  // prerequisites here, before approval or any upstream execute.
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
  // A caller that has already cancelled must not mint a nested
  // write: approval prompts and upstream side effects would run
  // for work whose owner has gone away.
  if (exec.signal.aborted) {
    throw new Error("FUSION_TOOL_CONTEXT_INVALID:signalAborted");
  }
  // rootCallId is optional, but when present it is forwarded as
  // the nested call's lineage; a malformed value would poison
  // that lineage, so it is validated rather than forwarded.
  if (
    exec.rootCallId !== undefined
    && (typeof exec.rootCallId !== "string" || exec.rootCallId === "")
  ) {
    throw new Error("FUSION_TOOL_CONTEXT_INVALID:rootCallId");
  }
  return exec;
}

function approvalService(ctx: FusionToolHostContext): FusionApprovalService {
  let service: unknown;
  try {
    service = ctx.get?.("approval");
  } catch {
    throw new Error("FUSION_APPROVAL_UNAVAILABLE:outcome=unavailable");
  }
  if (
    service === null
    || typeof service !== "object"
    || typeof (service as { request?: unknown }).request !== "function"
  ) {
    throw new Error("FUSION_APPROVAL_UNAVAILABLE:outcome=unavailable");
  }
  return service as FusionApprovalService;
}

async function requestFusionApproval(
  ctx: FusionToolHostContext,
  toolName: FusionTeamWriteToolName,
  reason: string,
  exec: FusionToolExecutionContext | undefined,
): Promise<void> {
  const currentExec = requireExecutionContext(exec);
  if (currentExec.agent === undefined) {
    throw new Error("FUSION_APPROVAL_AGENT_UNAVAILABLE:outcome=unavailable");
  }
  const approval = approvalService(ctx);
  let outcome: ApprovalOutcome;
  try {
    outcome = await approval.request({
      agent: currentExec.agent,
      toolName,
      callId: currentExec.callId,
      reason,
      signal: currentExec.signal,
    });
  } catch (error) {
    throw new Error(
      `FUSION_APPROVAL_REQUEST_FAILED:outcome=unavailable:${errorMessage(error)}`,
    );
  }
  if (outcome !== "allowed-once") {
    throw new Error(`FUSION_APPROVAL_DENIED:outcome=${String(outcome)}`);
  }
}

function requiredText(
  args: Record<string, unknown>,
  field: string,
  maxLength: number,
  code: string,
): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`FUSION_TEAM_${code}_REQUIRED`);
  }
  if (value.includes("\0")) {
    throw new Error(`FUSION_TEAM_INPUT_NUL:${field}`);
  }
  if (value.length > maxLength) {
    throw new Error(`FUSION_TEAM_${code}_TOO_LONG`);
  }
  return value;
}

function optionalText(
  args: Record<string, unknown>,
  field: string,
  maxLength: number | undefined,
  code: string,
): string | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`FUSION_TEAM_${code}_INVALID`);
  }
  if (value.includes("\0")) {
    throw new Error(`FUSION_TEAM_INPUT_NUL:${field}`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new Error(`FUSION_TEAM_${code}_TOO_LONG`);
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

/**
 * Guards only the three high-privilege AgentTeams write tools proxied by
 * Fusion. The other upstream AgentTeams tools are intentionally outside this
 * guard's scope.
 */
export function createAgentTeamsWriteGuard(
  allowAgentTeamWrites: boolean,
): AgentTeamsToolGuard {
  return (execution) => {
    if (!Object.hasOwn(UPSTREAM_TO_FUSION, execution.name)) return undefined;
    const upstreamName = execution.name as AgentTeamsWriteToolName;
    const fusionName = UPSTREAM_TO_FUSION[upstreamName];
    if (!allowAgentTeamWrites) {
      return `FUSION_AGENT_TEAM_WRITES_DISABLED: ${execution.name} is blocked until FUSION_ALLOW_AGENT_TEAM_WRITES=true; this guard covers only fusion_team_approve, fusion_team_resume, and fusion_team_send_message.`;
    }
    if (
      execution.parent === undefined
      || !isFusionNestedCall(execution.callId, fusionName)
    ) {
      return `FUSION_AGENT_TEAM_WRITES_GUARDED: do not call ${execution.name} directly; use ${fusionName} through Fusion, which requires a nested parent token.`;
    }
    return undefined;
  };
}

export class UpstreamToolError extends Error {
  readonly tool: FusionTeamWriteToolName;
  readonly upstreamCode: string;
  readonly upstreamName: AgentTeamsWriteToolName;
  readonly originalMessage: string;

  constructor(
    tool: FusionTeamWriteToolName,
    result: FusionToolExecutionResult,
  ) {
    const upstreamName = FUSION_TO_UPSTREAM[tool];
    const upstreamCode = result.error?.info?.code?.trim() || "UNKNOWN";
    const originalMessage = result.error?.message ?? "UNKNOWN_UPSTREAM_ERROR";
    super(`UPSTREAM_TOOL_FAILED:${tool}:${upstreamCode}:${originalMessage}`);
    this.name = "UpstreamToolError";
    this.tool = tool;
    this.upstreamCode = upstreamCode;
    this.upstreamName = upstreamName;
    this.originalMessage = originalMessage;
  }
}

/**
 * Creates the only three high-privilege AgentTeams write proxies exposed by
 * Fusion. They call the public tools registry and never read or write
 * `.agent-teams` state directly.
 */
export function createAgentTeamsWriteTools(
  ctx: FusionToolHostContext,
): Array<FusionToolDefinition<any, any>> {
  return [
    {
      name: "fusion_team_approve",
      description: "Approve and start a staged AgentTeams plan only after explicit user approval; each call requires a DSH one-shot approval decision.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          confirmation: { type: "string" },
        },
        required: ["confirmation"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string" },
            team_id: { type: "string" },
            members: { type: "number" },
            tasks: { type: "number" },
          },
          required: ["status", "team_id", "members", "tasks"],
        },
        render: renderJson,
      },
      async execute(args: ApproveArgs, exec) {
        const params = args as unknown as Record<string, unknown>;
        const confirmation = requiredText(
          params,
          "confirmation",
          MAX_TEXT_LENGTH,
          "CONFIRMATION",
        );
        await requestFusionApproval(
          ctx,
          "fusion_team_approve",
          confirmation,
          exec,
        );
        return await executeUpstreamTool(
          ctx,
          "fusion_team_approve",
          { confirmation },
          exec,
        );
      },
    },
    {
      name: "fusion_team_resume",
      description: "Resume a halted AgentTeams team with a non-empty reason after a DSH one-shot approval; only still-pending work is scheduled.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          reason: { type: "string" },
        },
        required: ["reason"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string" },
            team_id: { type: "string" },
            reason: { type: "string" },
          },
          required: ["status", "team_id", "reason"],
        },
        render: renderJson,
      },
      async execute(args: ResumeArgs, exec) {
        const params = args as unknown as Record<string, unknown>;
        const reason = requiredText(params, "reason", MAX_TEXT_LENGTH, "REASON");
        await requestFusionApproval(
          ctx,
          "fusion_team_resume",
          reason,
          exec,
        );
        return await executeUpstreamTool(
          ctx,
          "fusion_team_resume",
          { reason },
          exec,
        );
      },
    },
    {
      name: "fusion_team_send_message",
      description: "Send coordination or current-task guidance to an AgentTeams captain or member; this does not replace creating or reassigning a task for a new unit of work.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          to: { type: "string" },
          content: { type: "string" },
          from: { type: "string" },
          source_task_id: { type: "string" },
          source_attempt_id: { type: "string" },
        },
        required: ["to", "content"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            message_id: { type: "string" },
            from: { type: "string" },
            to: { type: "string" },
            delivered: { type: "string" },
          },
          required: ["message_id", "from", "to", "delivered"],
        },
        render: renderJson,
      },
      async execute(args: SendMessageArgs, exec) {
        const params = args as unknown as Record<string, unknown>;
        const to = requiredText(params, "to", MAX_RECIPIENT_LENGTH, "TO");
        const content = requiredText(params, "content", MAX_TEXT_LENGTH, "CONTENT");
        const from = optionalText(
          params,
          "from",
          MAX_RECIPIENT_LENGTH,
          "FROM",
        );
        const sourceTaskId = optionalText(
          params,
          "source_task_id",
          MAX_SOURCE_ID_LENGTH,
          "SOURCE_TASK_ID",
        );
        const sourceAttemptId = optionalText(
          params,
          "source_attempt_id",
          MAX_SOURCE_ID_LENGTH,
          "SOURCE_ATTEMPT_ID",
        );
        if ((sourceTaskId === undefined) !== (sourceAttemptId === undefined)) {
          throw new Error("FUSION_TEAM_SOURCE_IDS_REQUIRED_TOGETHER");
        }
        return await executeUpstreamTool(
          ctx,
          "fusion_team_send_message",
          {
            to,
            content,
            ...(from === undefined ? {} : { from }),
            ...(sourceTaskId === undefined ? {} : { source_task_id: sourceTaskId }),
            ...(sourceAttemptId === undefined ? {} : { source_attempt_id: sourceAttemptId }),
          },
          exec,
        );
      },
    },
  ];
}

export async function executeUpstreamTool(
  ctx: FusionToolHostContext,
  tool: FusionTeamWriteToolName,
  args: Record<string, unknown>,
  exec?: FusionToolExecutionContext,
): Promise<unknown> {
  // The caller-context contract is validated before registry
  // capability, uniformly across the write bridges: when both
  // are broken the caller hears about their own context first,
  // so the first error per action is always a versioned
  // FUSION_TOOL_CONTEXT_* code.
  const currentExec = requireExecutionContext(exec);
  if (typeof ctx.tools?.execute !== "function") {
    throw new Error("FUSION_UPSTREAM_TOOLS_UNAVAILABLE");
  }
  if (!isFusionTeamWriteTool(tool)) {
    throw new Error("FUSION_UPSTREAM_TOOL_NOT_ALLOWED");
  }

  const upstreamName = FUSION_TO_UPSTREAM[tool];
  const result = await ctx.tools.execute({
    callId: nestedCallId(currentExec.callId, tool),
    ...(currentExec.rootCallId === undefined ? {} : { rootCallId: currentExec.rootCallId }),
    name: upstreamName,
    arguments: args,
    ...(currentExec.agent === undefined ? {} : { agent: currentExec.agent }),
    parent: currentExec.token,
    signal: currentExec.signal,
  });

  if (result.isError) {
    throw new UpstreamToolError(tool, result);
  }
  return result.value;
}
