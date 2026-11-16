import { describe, expect, it, vi } from "vitest";
import {
  createAgentTeamsWriteGuard,
  createAgentTeamsWriteTools,
  executeUpstreamTool,
  UpstreamToolError,
  type FusionTeamWriteToolName,
  type FusionToolExecutionContext,
  type FusionToolExecutionInput,
  type FusionToolHostContext,
} from "./upstream-tools.js";

function callerExec(includeAgent = true): FusionToolExecutionContext {
  return {
    callId: "call-1",
    rootCallId: "root-1",
    ...(includeAgent ? { agent: { id: "captain" } } : {}),
    signal: new AbortController().signal,
    token: Symbol("parent-token"),
  };
}

function toolContext(options: {
  approval?: boolean;
  outcome?: string;
  execute?: ReturnType<typeof vi.fn<NonNullable<NonNullable<FusionToolHostContext["tools"]>["execute"]>>>;
} = {}) {
  const execute = options.execute ?? vi.fn(async () => ({
    isError: false as const,
    value: { ok: true },
  }));
  const request = vi.fn(async () => options.outcome ?? "allowed-once");
  const get = vi.fn((name: string) => {
    if (name === "approval" && options.approval !== false) {
      return { request };
    }
    return undefined;
  });
  const ctx: FusionToolHostContext = {
    tools: { register: vi.fn(), execute },
    get,
  };
  return { ctx, execute, request };
}

describe("upstream AgentTeams tools", () => {
  it("fails closed when the tools registry cannot execute nested calls", async () => {
    await expect(executeUpstreamTool(
      { tools: { register: vi.fn() } },
      "fusion_team_approve",
      { confirmation: "approved" },
      callerExec(),
    )).rejects.toThrow("FUSION_UPSTREAM_TOOLS_UNAVAILABLE");
  });

  it("fails closed when the caller execution context is missing", async () => {
    const execute = vi.fn();

    await expect(executeUpstreamTool(
      { tools: { register: vi.fn(), execute } },
      "fusion_team_approve",
      { confirmation: "approved" },
    )).rejects.toThrow("FUSION_TOOL_CONTEXT_UNAVAILABLE");
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports the caller context before registry capability when both are broken", async () => {
    const ctx = { tools: { register: vi.fn() } };
    await expect(executeUpstreamTool(
      ctx,
      "fusion_team_approve",
      { confirmation: "approved" },
    )).rejects.toThrow("FUSION_TOOL_CONTEXT_UNAVAILABLE");
    await expect(executeUpstreamTool(
      ctx,
      "fusion_team_approve",
      { confirmation: "approved" },
      { ...callerExec(), callId: "" } as FusionToolExecutionContext,
    )).rejects.toThrow("FUSION_TOOL_CONTEXT_INVALID:callId");
  });

  it("rejects malformed execution contexts with stable codes before any upstream call", async () => {
    const execute = vi.fn(async () => ({ isError: false as const, value: null }));
    const ctx = { tools: { register: vi.fn(), execute } };
    const malformed: Array<[Record<string, unknown>, string]> = [
      [{ callId: "" }, "FUSION_TOOL_CONTEXT_INVALID:callId"],
      [{ callId: 42 }, "FUSION_TOOL_CONTEXT_INVALID:callId"],
      [{ token: undefined }, "FUSION_TOOL_CONTEXT_INVALID:token"],
      [{ signal: undefined }, "FUSION_TOOL_CONTEXT_INVALID:signal"],
      [{ signal: { aborted: true } }, "FUSION_TOOL_CONTEXT_INVALID:signalAborted"],
      [{ rootCallId: "" }, "FUSION_TOOL_CONTEXT_INVALID:rootCallId"],
      [{ rootCallId: 42 }, "FUSION_TOOL_CONTEXT_INVALID:rootCallId"],
    ];
    for (const [patch, code] of malformed) {
      await expect(executeUpstreamTool(
        ctx,
        "fusion_team_approve",
        { confirmation: "approved" },
        { ...callerExec(), ...patch } as FusionToolExecutionContext,
      )).rejects.toThrow(code);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("never asks for approval when the caller is already aborted or the root call id is malformed", async () => {
    const { ctx, execute, request } = toolContext();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ signal: { aborted: true } }, "FUSION_TOOL_CONTEXT_INVALID:signalAborted"],
      [{ rootCallId: "" }, "FUSION_TOOL_CONTEXT_INVALID:rootCallId"],
    ];
    for (const [patch, code] of cases) {
      await expect(executeUpstreamTool(
        ctx,
        "fusion_team_approve",
        { confirmation: "approved" },
        { ...callerExec(), ...patch } as FusionToolExecutionContext,
      )).rejects.toThrow(code);
    }
    expect(request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("forwards the caller identity and returns the nested value", async () => {
    const exec = callerExec();
    const value = { status: "running", team_id: "team-1", members: 2, tasks: 3 };
    const execute = vi.fn(async () => ({ isError: false as const, value }));

    await expect(executeUpstreamTool(
      { tools: { register: vi.fn(), execute } },
      "fusion_team_approve",
      { confirmation: "approved" },
      exec,
    )).resolves.toEqual(value);

    expect(execute).toHaveBeenCalledWith({
      callId: expect.stringMatching(/^call-1:fusion:fusion_team_approve:/),
      rootCallId: "root-1",
      name: "agent_teams_approve",
      arguments: { confirmation: "approved" },
      agent: exec.agent,
      parent: exec.token,
      signal: exec.signal,
    });
  });

  it("uses a unique nested call id for every dispatch", async () => {
    const { ctx, execute } = toolContext();
    const exec = callerExec();

    await executeUpstreamTool(ctx, "fusion_team_resume", { reason: "continue" }, exec);
    await executeUpstreamTool(ctx, "fusion_team_resume", { reason: "continue" }, exec);

    const calls = execute.mock.calls as unknown as Array<[FusionToolExecutionInput]>;
    const first = calls[0]?.[0];
    const second = calls[1]?.[0];
    expect(first?.callId).toMatch(/^call-1:fusion:fusion_team_resume:/);
    expect(second?.callId).toMatch(/^call-1:fusion:fusion_team_resume:/);
    expect(first?.callId).not.toBe(second?.callId);
  });

  it("preserves upstream failure metadata without claiming a native error type", async () => {
    const execute = vi.fn(async () => ({
      isError: true as const,
      error: {
        message: "approval denied by upstream",
        info: { code: "APPROVAL_REJECTED" },
      },
    }));

    const error = await executeUpstreamTool(
      { tools: { register: vi.fn(), execute } },
      "fusion_team_approve",
      { confirmation: "approved" },
      callerExec(),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UpstreamToolError);
    expect(error).toMatchObject({
      tool: "fusion_team_approve",
      upstreamCode: "APPROVAL_REJECTED",
      upstreamName: "agent_teams_approve",
      originalMessage: "approval denied by upstream",
    });
    expect((error as Error).message).toContain("APPROVAL_REJECTED");
  });

  it("rejects names outside the fixed AgentTeams write allowlist", async () => {
    const execute = vi.fn();

    await expect(executeUpstreamTool(
      { tools: { register: vi.fn(), execute } },
      "fusion_team_delete" as FusionTeamWriteToolName,
      {},
      callerExec(),
    )).rejects.toThrow("FUSION_UPSTREAM_TOOL_NOT_ALLOWED");
    expect(execute).not.toHaveBeenCalled();
  });

  it("registers only the three supported Fusion proxies", () => {
    const tools = createAgentTeamsWriteTools(toolContext().ctx);

    expect(tools.map((tool) => tool.name)).toEqual([
      "fusion_team_approve",
      "fusion_team_resume",
      "fusion_team_send_message",
    ]);
  });

  it("maps each proxy argument to its fixed upstream tool", async () => {
    const { ctx, execute } = toolContext();
    const tools = createAgentTeamsWriteTools(ctx);
    const exec = callerExec();

    await tools[0]!.execute({ confirmation: "approved" }, exec);
    await tools[1]!.execute({ reason: "continue pending work" }, exec);
    await tools[2]!.execute({
      to: "worker-a",
      content: "Use the revised input.",
      from: "captain",
      source_task_id: "task-1",
      source_attempt_id: "attempt-1",
    }, exec);

    const calls = execute.mock.calls as unknown as Array<[FusionToolExecutionInput]>;
    expect(calls.map(([input]) => ({
      name: input.name,
      arguments: input.arguments,
    }))).toEqual([
      {
        name: "agent_teams_approve",
        arguments: { confirmation: "approved" },
      },
      {
        name: "agent_teams_resume",
        arguments: { reason: "continue pending work" },
      },
      {
        name: "agent_teams_send_message",
        arguments: {
          to: "worker-a",
          content: "Use the revised input.",
          from: "captain",
          source_task_id: "task-1",
          source_attempt_id: "attempt-1",
        },
      },
    ]);
  });

  it("asks for one-shot approval before approve and resume", async () => {
    const { ctx, request } = toolContext();
    const tools = createAgentTeamsWriteTools(ctx);
    const exec = callerExec();

    await tools[0]!.execute({ confirmation: "approved" }, exec);
    await tools[1]!.execute({ reason: "continue pending work" }, exec);

    expect(request.mock.calls).toEqual([
      [{
        agent: exec.agent,
        toolName: "fusion_team_approve",
        callId: "call-1",
        reason: "approved",
        signal: exec.signal,
      }],
      [{
        agent: exec.agent,
        toolName: "fusion_team_resume",
        callId: "call-1",
        reason: "continue pending work",
        signal: exec.signal,
      }],
    ]);
  });

  it.each(["rejected", "cancelled", "unavailable"] as const)(
    "fails closed when approval outcome is %s",
    async (outcome) => {
      const { ctx, execute } = toolContext({ outcome });
      const tools = createAgentTeamsWriteTools(ctx);

      await expect(tools[0]!.execute(
        { confirmation: "approved" },
        callerExec(),
      )).rejects.toThrow(`FUSION_APPROVAL_DENIED:outcome=${outcome}`);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("fails closed when approval or the caller agent is unavailable", async () => {
    const withoutApproval = toolContext({ approval: false });
    const withoutApprovalTools = createAgentTeamsWriteTools(withoutApproval.ctx);
    await expect(withoutApprovalTools[0]!.execute(
      { confirmation: "approved" },
      callerExec(),
    )).rejects.toThrow("FUSION_APPROVAL_UNAVAILABLE:outcome=unavailable");

    const withoutAgent = toolContext();
    const withoutAgentTools = createAgentTeamsWriteTools(withoutAgent.ctx);
    await expect(withoutAgentTools[0]!.execute(
      { confirmation: "approved" },
      callerExec(false),
    )).rejects.toThrow("FUSION_APPROVAL_AGENT_UNAVAILABLE:outcome=unavailable");
  });

  it("does not ask for extra approval before send_message", async () => {
    const { ctx, request } = toolContext({ approval: false });
    const tools = createAgentTeamsWriteTools(ctx);

    await expect(tools[2]!.execute(
      { to: "worker-a", content: "guidance" },
      callerExec(),
    )).resolves.toEqual({ ok: true });
    expect(request).not.toHaveBeenCalled();
  });

  it("enforces field boundaries and paired source ids", async () => {
    const { ctx, execute } = toolContext();
    const tools = createAgentTeamsWriteTools(ctx);
    const exec = callerExec();

    await expect(tools[0]!.execute({ confirmation: "   " }, exec))
      .rejects.toThrow("FUSION_TEAM_CONFIRMATION_REQUIRED");
    await expect(tools[1]!.execute({ reason: "x".repeat(8_001) }, exec))
      .rejects.toThrow("FUSION_TEAM_REASON_TOO_LONG");
    await expect(tools[2]!.execute({ to: "a", content: "\0hidden" }, exec))
      .rejects.toThrow("FUSION_TEAM_INPUT_NUL:content");
    await expect(tools[2]!.execute({ to: "x".repeat(129), content: "message" }, exec))
      .rejects.toThrow("FUSION_TEAM_TO_TOO_LONG");
    await expect(tools[2]!.execute({
      to: "worker-a",
      content: "message",
      from: "x".repeat(129),
    }, exec)).rejects.toThrow("FUSION_TEAM_FROM_TOO_LONG");
    await expect(tools[2]!.execute({
      to: "worker-a",
      content: "message",
      source_task_id: "x".repeat(257),
      source_attempt_id: "attempt-1",
    }, exec)).rejects.toThrow("FUSION_TEAM_SOURCE_TASK_ID_TOO_LONG");
    await expect(tools[2]!.execute({
      to: "worker-a",
      content: "message",
      source_task_id: "task-1",
      source_attempt_id: "x".repeat(257),
    }, exec)).rejects.toThrow("FUSION_TEAM_SOURCE_ATTEMPT_ID_TOO_LONG");
    await expect(tools[2]!.execute({
      to: "worker-a",
      content: "message",
      source_task_id: "task-1",
    }, exec)).rejects.toThrow("FUSION_TEAM_SOURCE_IDS_REQUIRED_TOGETHER");
    await expect(tools[2]!.execute({
      to: "worker-a",
      content: "message",
      source_attempt_id: "attempt-1",
    }, exec)).rejects.toThrow("FUSION_TEAM_SOURCE_IDS_REQUIRED_TOGETHER");
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts values exactly at the declared boundaries", async () => {
    const { ctx, execute } = toolContext();
    const tools = createAgentTeamsWriteTools(ctx);
    const exec = callerExec();

    await tools[0]!.execute({ confirmation: "x".repeat(8_000) }, exec);
    await tools[1]!.execute({ reason: "x".repeat(8_000) }, exec);
    await tools[2]!.execute({
      to: "x".repeat(128),
      content: "x".repeat(8_000),
      from: "x".repeat(128),
      source_task_id: "x".repeat(256),
      source_attempt_id: "x".repeat(256),
    }, exec);

    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("guards only the three high-privilege AgentTeams writes", () => {
    const enabled = createAgentTeamsWriteGuard(true);

    assertGuardRejectsDirect(enabled, "agent_teams_approve", "fusion_team_approve");
    assertGuardRejectsDirect(enabled, "agent_teams_resume", "fusion_team_resume");
    assertGuardRejectsDirect(enabled, "agent_teams_send_message", "fusion_team_send_message");
    expect(enabled({
      name: "agent_teams_status",
      callId: "status-1",
    })).toBeUndefined();
    expect(enabled({
      name: "agent_teams_approve",
      callId: "call-1:fusion:fusion_team_approve:1",
      parent: Symbol("parent"),
    })).toBeUndefined();
    expect(enabled({
      name: "agent_teams_approve",
      callId: "call-1:fusion:fusion_team_approve:1:ptc:1",
      parent: Symbol("parent"),
    })).toMatch(/FUSION_AGENT_TEAM_WRITES_GUARDED/);
    expect(enabled({
      name: "agent_teams_resume",
      callId: "call-1:fusion:fusion_team_resume:12:ptc:1",
      parent: Symbol("parent"),
    })).toMatch(/FUSION_AGENT_TEAM_WRITES_GUARDED/);
  });

  it("blocks all three high-privilege writes while the global switch is off", () => {
    const disabled = createAgentTeamsWriteGuard(false);

    expect(disabled({
      name: "agent_teams_approve",
      callId: "direct-1",
    })).toMatch(/FUSION_AGENT_TEAM_WRITES_DISABLED/);
    expect(disabled({
      name: "agent_teams_send_message",
      callId: "call-1:fusion:fusion_team_send_message:1",
      parent: Symbol("parent"),
    })).toMatch(/FUSION_AGENT_TEAM_WRITES_DISABLED/);
    expect(disabled({
      name: "agent_teams_status",
      callId: "status-1",
    })).toBeUndefined();
  });
});

function assertGuardRejectsDirect(
  guard: ReturnType<typeof createAgentTeamsWriteGuard>,
  upstreamName: string,
  fusionName: string,
) {
  const reason = guard({ name: upstreamName, callId: "direct-1" });
  expect(reason).toContain(fusionName);
  expect(reason).toMatch(/FUSION_AGENT_TEAM_WRITES_GUARDED/);
}
