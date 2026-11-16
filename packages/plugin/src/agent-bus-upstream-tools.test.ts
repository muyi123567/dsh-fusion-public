import { describe, expect, it, vi } from "vitest";
import {
  AgentBusUpstreamToolError,
  createAgentBusWriteGuard,
  createAgentBusWriteTools,
  executeAgentBusUpstreamTool,
  type AgentBusHarnessErrorFactory,
  type FusionBusWriteToolName,
} from "./agent-bus-upstream-tools.js";
import type {
  FusionToolExecutionContext,
  FusionToolExecutionInput,
  FusionToolHostContext,
} from "./upstream-tools.js";

function callerExec(): FusionToolExecutionContext {
  return {
    callId: "call-1",
    rootCallId: "root-1",
    agent: { id: "captain" },
    signal: new AbortController().signal,
    token: Symbol("parent-token"),
  };
}

function toolContext(execute?: ReturnType<typeof vi.fn<NonNullable<NonNullable<FusionToolHostContext["tools"]>["execute"]>>>) {
  const nestedExecute = execute ?? vi.fn(async () => ({
    isError: false as const,
    value: { ok: true },
  }));
  const ctx: FusionToolHostContext = {
    tools: {
      register: vi.fn(),
      execute: nestedExecute,
      guard: vi.fn(),
    },
  };
  return { ctx, execute: nestedExecute };
}

function toolsByName(ctx: FusionToolHostContext) {
  return new Map(createAgentBusWriteTools(ctx).map((tool) => [tool.name, tool]));
}

describe("AgentBus upstream write tools", () => {
  it("registers exactly the six supported Fusion proxies", () => {
    const tools = createAgentBusWriteTools(toolContext().ctx);

    expect(tools.map((tool) => tool.name)).toEqual([
      "fusion_bus_send_note",
      "fusion_bus_create_flow",
      "fusion_bus_create_task",
      "fusion_bus_report_task",
      "fusion_bus_settle_task",
      "fusion_bus_cancel_task",
    ]);
  });

  it("maps every proxy argument to its fixed upstream tool", async () => {
    const { ctx, execute } = toolContext();
    const tools = toolsByName(ctx);
    const exec = callerExec();

    await tools.get("fusion_bus_send_note")!.execute({
      target: "peer-a",
      content: "Please check the release.",
    }, exec);
    await tools.get("fusion_bus_create_flow")!.execute({
      name: "Release flow",
      description: "Ship the release safely.",
    }, exec);
    await tools.get("fusion_bus_create_task")!.execute({
      target: "peer-b",
      content: "Verify the package.",
      title: "Verify package",
      mode: "steer",
      reviewer: "peer-c",
      task_id: "task-answer",
      dependencies: ["task-1", "task-2"],
      acceptance_criteria: "Checks pass.",
      flow_id: "flow-1",
    }, exec);
    await tools.get("fusion_bus_report_task")!.execute({
      task_id: "task-1",
      result: "Package verified.",
    }, exec);
    await tools.get("fusion_bus_settle_task")!.execute({
      task_id: "task-1",
      outcome: "failure",
      feedback: "Add the missing checksum.",
    }, exec);
    await tools.get("fusion_bus_cancel_task")!.execute({
      task_id: "task-2",
      reason: "Superseded by task-1.",
    }, exec);

    const calls = execute.mock.calls as unknown as Array<[FusionToolExecutionInput]>;
    expect(calls.map(([input]) => ({
      name: input.name,
      arguments: input.arguments,
    }))).toEqual([
      {
        name: "send_note",
        arguments: {
          target: "peer-a",
          content: "Please check the release.",
        },
      },
      {
        name: "create_flow",
        arguments: {
          name: "Release flow",
          description: "Ship the release safely.",
        },
      },
      {
        name: "create_task",
        arguments: {
          target: "peer-b",
          content: "Verify the package.",
          title: "Verify package",
          mode: "steer",
          reviewer: "peer-c",
          task_id: "task-answer",
          dependencies: ["task-1", "task-2"],
          acceptance_criteria: "Checks pass.",
          flow_id: "flow-1",
        },
      },
      {
        name: "report_task",
        arguments: {
          task_id: "task-1",
          result: "Package verified.",
        },
      },
      {
        name: "settle_task",
        arguments: {
          task_id: "task-1",
          outcome: "failure",
          feedback: "Add the missing checksum.",
        },
      },
      {
        name: "cancel_task",
        arguments: {
          task_id: "task-2",
          reason: "Superseded by task-1.",
        },
      },
    ]);
  });

  it("forwards caller identity and mints unique nested call ids", async () => {
    const { ctx, execute } = toolContext();
    const exec = callerExec();

    await executeAgentBusUpstreamTool(
      ctx,
      "fusion_bus_report_task",
      { task_id: "task-1", result: "first" },
      exec,
    );
    await executeAgentBusUpstreamTool(
      ctx,
      "fusion_bus_report_task",
      { task_id: "task-1", result: "second" },
      exec,
    );

    const calls = execute.mock.calls as unknown as Array<[FusionToolExecutionInput]>;
    expect(calls[0]?.[0]).toMatchObject({
      rootCallId: "root-1",
      name: "report_task",
      arguments: { task_id: "task-1", result: "first" },
      agent: exec.agent,
      parent: exec.token,
      signal: exec.signal,
    });
    expect(calls[1]?.[0]).toMatchObject({
      rootCallId: "root-1",
      name: "report_task",
      arguments: { task_id: "task-1", result: "second" },
      agent: exec.agent,
      parent: exec.token,
      signal: exec.signal,
    });
    expect(calls[0]?.[0].callId).toMatch(
      /^call-1:fusion:fusion_bus_report_task:/,
    );
    expect(calls[1]?.[0].callId).toMatch(
      /^call-1:fusion:fusion_bus_report_task:/,
    );
    expect(calls[0]?.[0].callId).not.toBe(calls[1]?.[0].callId);
  });

  it("normalizes upstream errors through an injectable HarnessError factory", async () => {
    const execute = vi.fn(async () => ({
      isError: true as const,
      error: {
        message: "caller is not the reviewer",
        info: {
          name: "AuthorizationError",
          code: "NOT_REVIEWER",
        },
      },
    }));
    const { ctx } = toolContext(execute);
    class InjectedHarnessError extends Error {
      readonly code: string;

      constructor(message: string, code: string) {
        super(message);
        this.name = "HarnessError";
        this.code = code;
      }
    }
    const errorFactory: AgentBusHarnessErrorFactory = vi.fn(
      (message, code) => new InjectedHarnessError(message, code),
    );

    const error = await executeAgentBusUpstreamTool(
      ctx,
      "fusion_bus_settle_task",
      { task_id: "task-1", outcome: "success" },
      callerExec(),
      { errorFactory },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InjectedHarnessError);
    expect(error).toMatchObject({
      name: "AuthorizationError",
      code: "NOT_REVIEWER",
      tool: "fusion_bus_settle_task",
      upstreamCode: "NOT_REVIEWER",
      upstreamName: "settle_task",
      upstreamErrorName: "AuthorizationError",
      originalMessage: "caller is not the reviewer",
    });
    expect((error as Error).message).toContain("NOT_REVIEWER");
    expect(errorFactory).toHaveBeenCalledWith(
      expect.stringContaining("NOT_REVIEWER"),
      "NOT_REVIEWER",
    );
  });

  it("falls back to the custom structured error when the runtime factory is unavailable", async () => {
    const execute = vi.fn(async () => ({
      isError: true as const,
      error: {
        message: "caller is not the reviewer",
        info: {
          name: "AuthorizationError",
          code: "NOT_REVIEWER",
        },
      },
    }));
    const { ctx } = toolContext(execute);
    const errorFactory: AgentBusHarnessErrorFactory = vi.fn(() => {
      throw new Error("runtime module unavailable");
    });

    const error = await executeAgentBusUpstreamTool(
      ctx,
      "fusion_bus_settle_task",
      { task_id: "task-1", outcome: "success" },
      callerExec(),
      { errorFactory },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgentBusUpstreamToolError);
    expect(error).toMatchObject({
      name: "AuthorizationError",
      code: "NOT_REVIEWER",
      tool: "fusion_bus_settle_task",
      upstreamCode: "NOT_REVIEWER",
      upstreamName: "settle_task",
      upstreamErrorName: "AuthorizationError",
      originalMessage: "caller is not the reviewer",
    });
  });

  it("uses stable error name and code fallbacks when upstream omits them", async () => {
    const execute = vi.fn(async () => ({
      isError: true as const,
      error: {
        message: "upstream failed without metadata",
      },
    }));
    const { ctx } = toolContext(execute);
    const errorFactory: AgentBusHarnessErrorFactory = (message, code) => {
      const error = new Error(message);
      return Object.assign(error, { code });
    };

    const error = await executeAgentBusUpstreamTool(
      ctx,
      "fusion_bus_report_task",
      { task_id: "task-1", result: "result" },
      callerExec(),
      { errorFactory },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "AgentBusUpstreamToolError",
      code: "UNKNOWN",
      upstreamCode: "UNKNOWN",
      upstreamErrorName: "AgentBusUpstreamToolError",
      originalMessage: "upstream failed without metadata",
    });
  });

  it("fails closed without an executable registry or caller context", async () => {
    await expect(executeAgentBusUpstreamTool(
      { tools: { register: vi.fn() } },
      "fusion_bus_send_note",
      { target: "peer-a", content: "hello" },
      callerExec(),
    )).rejects.toThrow("FUSION_UPSTREAM_TOOLS_UNAVAILABLE");

    const execute = vi.fn();
    await expect(executeAgentBusUpstreamTool(
      { tools: { register: vi.fn(), execute } },
      "fusion_bus_send_note",
      { target: "peer-a", content: "hello" },
    )).rejects.toThrow("FUSION_TOOL_CONTEXT_UNAVAILABLE");
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports the caller context before registry capability when both are broken", async () => {
    const ctx = { tools: { register: vi.fn() } };
    await expect(executeAgentBusUpstreamTool(
      ctx,
      "fusion_bus_send_note",
      { target: "peer-a", content: "hello" },
    )).rejects.toThrow("FUSION_TOOL_CONTEXT_UNAVAILABLE");
    await expect(executeAgentBusUpstreamTool(
      ctx,
      "fusion_bus_send_note",
      { target: "peer-a", content: "hello" },
      { ...callerExec(), callId: "" } as FusionToolExecutionContext,
    )).rejects.toThrow("FUSION_TOOL_CONTEXT_INVALID:callId");
  });

  it("rejects malformed execution contexts with stable codes before any upstream call", async () => {
    const { ctx, execute } = toolContext();
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
      await expect(executeAgentBusUpstreamTool(
        ctx,
        "fusion_bus_send_note",
        { target: "peer-a", content: "hello" },
        { ...callerExec(), ...patch } as FusionToolExecutionContext,
      )).rejects.toThrow(code);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects names outside the fixed AgentBus allowlist", async () => {
    const execute = vi.fn();

    await expect(executeAgentBusUpstreamTool(
      { tools: { register: vi.fn(), execute } },
      "fusion_bus_delete_task" as FusionBusWriteToolName,
      {},
      callerExec(),
    )).rejects.toThrow("FUSION_UPSTREAM_TOOL_NOT_ALLOWED");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unknown arguments before calling upstream", async () => {
    const { ctx, execute } = toolContext();
    const tools = toolsByName(ctx);
    const exec = callerExec();

    await expect(tools.get("fusion_bus_send_note")!.execute({
      target: "peer-a",
      content: "hello",
      name: "create_task",
    }, exec)).rejects.toThrow("FUSION_BUS_UNKNOWN_ARGUMENT:name");
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces text, identifier, collection, enum, and NUL boundaries", async () => {
    const { ctx, execute } = toolContext();
    const tools = toolsByName(ctx);
    const exec = callerExec();

    await expect(tools.get("fusion_bus_send_note")!.execute({
      target: "peer-a",
      content: "x".repeat(16_001),
    }, exec)).rejects.toThrow("FUSION_BUS_CONTENT_TOO_LONG");
    await expect(tools.get("fusion_bus_report_task")!.execute({
      task_id: "task-1",
      result: "x".repeat(16_001),
    }, exec)).rejects.toThrow("FUSION_BUS_RESULT_TOO_LONG");
    await expect(tools.get("fusion_bus_create_flow")!.execute({
      name: "x".repeat(81),
    }, exec)).rejects.toThrow("FUSION_BUS_NAME_TOO_LONG");
    await expect(tools.get("fusion_bus_create_task")!.execute({
      target: "peer-b",
      content: "work",
      title: "x".repeat(81),
    }, exec)).rejects.toThrow("FUSION_BUS_TITLE_TOO_LONG");
    await expect(tools.get("fusion_bus_create_task")!.execute({
      target: "x".repeat(257),
      content: "work",
      title: "work",
    }, exec)).rejects.toThrow("FUSION_BUS_TARGET_TOO_LONG");
    await expect(tools.get("fusion_bus_create_task")!.execute({
      target: "peer-b",
      content: "work",
      title: "work",
      reviewer: "x".repeat(257),
    }, exec)).rejects.toThrow("FUSION_BUS_REVIEWER_TOO_LONG");
    await expect(tools.get("fusion_bus_create_task")!.execute({
      target: "peer-b",
      content: "work",
      title: "work",
      task_id: "x".repeat(257),
    }, exec)).rejects.toThrow("FUSION_BUS_TASK_ID_TOO_LONG");
    await expect(tools.get("fusion_bus_create_task")!.execute({
      target: "peer-b",
      content: "work",
      title: "work",
      flow_id: "x".repeat(257),
    }, exec)).rejects.toThrow("FUSION_BUS_FLOW_ID_TOO_LONG");
    await expect(tools.get("fusion_bus_create_task")!.execute({
      target: "peer-b",
      content: "work",
      title: "work",
      dependencies: Array.from({ length: 65 }, (_, index) => `task-${index}`),
    }, exec)).rejects.toThrow("FUSION_BUS_DEPENDENCIES_TOO_MANY");
    await expect(tools.get("fusion_bus_create_task")!.execute({
      target: "peer-b",
      content: "work",
      title: "work",
      dependencies: [`task-${"x".repeat(252)}`],
    }, exec)).rejects.toThrow("FUSION_BUS_DEPENDENCY_TOO_LONG");
    await expect(tools.get("fusion_bus_create_task")!.execute({
      target: "peer-b",
      content: "work",
      title: "work",
      mode: "invalid",
    }, exec)).rejects.toThrow("FUSION_BUS_MODE_INVALID");
    await expect(tools.get("fusion_bus_settle_task")!.execute({
      task_id: "task-1",
      outcome: "passed",
    }, exec)).rejects.toThrow("FUSION_BUS_OUTCOME_INVALID");
    await expect(tools.get("fusion_bus_settle_task")!.execute({
      task_id: "task-1",
      outcome: "failure",
      feedback: "x".repeat(4_001),
    }, exec)).rejects.toThrow("FUSION_BUS_FEEDBACK_TOO_LONG");
    await expect(tools.get("fusion_bus_cancel_task")!.execute({
      task_id: "task-1",
      reason: "x".repeat(401),
    }, exec)).rejects.toThrow("FUSION_BUS_REASON_TOO_LONG");
    await expect(tools.get("fusion_bus_send_note")!.execute({
      target: "peer-a",
      content: "\0hidden",
    }, exec)).rejects.toThrow("FUSION_BUS_INPUT_NUL:content");
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts values exactly at the declared boundaries", async () => {
    const { ctx, execute } = toolContext();
    const tools = toolsByName(ctx);
    const exec = callerExec();

    await tools.get("fusion_bus_send_note")!.execute({
      target: "x".repeat(256),
      content: "x".repeat(16_000),
    }, exec);
    await tools.get("fusion_bus_create_flow")!.execute({
      name: "x".repeat(80),
    }, exec);
    await tools.get("fusion_bus_create_task")!.execute({
      target: "peer-b",
      content: "x".repeat(16_000),
      title: "x".repeat(80),
      reviewer: "x".repeat(256),
      task_id: "x".repeat(256),
      dependencies: Array.from({ length: 64 }, (_, index) => `task-${index}`),
      flow_id: "x".repeat(256),
    }, exec);
    await tools.get("fusion_bus_report_task")!.execute({
      task_id: "x".repeat(256),
      result: "x".repeat(16_000),
    }, exec);
    await tools.get("fusion_bus_settle_task")!.execute({
      task_id: "x".repeat(256),
      outcome: "success",
      feedback: "x".repeat(4_000),
    }, exec);
    await tools.get("fusion_bus_cancel_task")!.execute({
      task_id: "x".repeat(256),
      reason: "x".repeat(400),
    }, exec);

    expect(execute).toHaveBeenCalledTimes(6);
  });

  it("guards only direct calls to the six AgentBus writes", () => {
    const guard = createAgentBusWriteGuard(true);

    const mappings = [
      ["send_note", "fusion_bus_send_note"],
      ["create_flow", "fusion_bus_create_flow"],
      ["create_task", "fusion_bus_create_task"],
      ["report_task", "fusion_bus_report_task"],
      ["settle_task", "fusion_bus_settle_task"],
      ["cancel_task", "fusion_bus_cancel_task"],
    ] as const;
    for (const [upstreamName, fusionName] of mappings) {
      expect(guard({
        name: upstreamName,
        callId: "direct-1",
      })).toContain(fusionName);
      expect(guard({
        name: upstreamName,
        callId: `call-1:fusion:${fusionName}:1`,
        parent: Symbol("parent"),
      })).toBeUndefined();
      expect(guard({
        name: upstreamName,
        callId: `call-1:fusion:${fusionName}:1:ptc:1`,
        parent: Symbol("parent"),
      })).toMatch(/FUSION_AGENT_BUS_WRITES_GUARDED/);
    }

    expect(guard({
      name: "list_peers",
      callId: "read-1",
    })).toBeUndefined();
    expect(guard({
      name: "send_note",
      callId: "nested-without-marker",
      parent: Symbol("parent"),
    })).toMatch(/FUSION_AGENT_BUS_WRITES_GUARDED/);
  });

  it("blocks AgentBus writes when its guard is disabled", () => {
    const guard = createAgentBusWriteGuard(false);

    expect(guard({
      name: "create_task",
      callId: "call-1:fusion:fusion_bus_create_task:1",
      parent: Symbol("parent"),
    })).toMatch(/FUSION_AGENT_BUS_WRITES_DISABLED/);
    expect(guard({
      name: "list_tasks",
      callId: "read-1",
    })).toBeUndefined();
  });
});
