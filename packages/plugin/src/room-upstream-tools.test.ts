import { describe, expect, it, vi } from "vitest";
import {
  RoomUpstreamToolError,
  createRoomWriteGuard,
  createRoomWriteTools,
  executeRoomUpstreamTool,
  type RoomHarnessErrorFactory,
} from "./room-upstream-tools.js";
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

function toolContext(options: {
  execute?: ReturnType<typeof vi.fn<NonNullable<NonNullable<FusionToolHostContext["tools"]>["execute"]>>>;
  approval?: "allowed-once" | "rejected" | "cancelled";
} = {}) {
  const nestedExecute = options.execute ?? vi.fn(async () => ({
    isError: false as const,
    value: { ok: true },
  }));
  const approval = {
    request: vi.fn(async () => options.approval ?? "allowed-once"),
  };
  const ctx: FusionToolHostContext = {
    tools: {
      register: vi.fn(),
      execute: nestedExecute,
      guard: vi.fn(),
    },
    get: vi.fn((name: string) => name === "approval" ? approval : undefined),
  };
  return { ctx, execute: nestedExecute, approval };
}

function toolsByName(ctx: FusionToolHostContext) {
  return new Map(createRoomWriteTools(ctx).map((tool) => [tool.name, tool]));
}

describe("Room upstream write tools", () => {
  it("rejects malformed execution contexts with stable codes before any upstream call", async () => {
    const { ctx, execute, approval } = toolContext();
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
      await expect(executeRoomUpstreamTool(
        ctx,
        "fusion_room_create",
        { name: "Room" },
        { ...callerExec(), ...patch } as FusionToolExecutionContext,
      )).rejects.toThrow(code);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(approval.request).not.toHaveBeenCalled();
  });

  it("never asks for approval when the caller is already aborted or the root call id is malformed", async () => {
    const { ctx, execute, approval } = toolContext();
    const tools = toolsByName(ctx);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ signal: { aborted: true } }, "FUSION_TOOL_CONTEXT_INVALID:signalAborted"],
      [{ rootCallId: "" }, "FUSION_TOOL_CONTEXT_INVALID:rootCallId"],
    ];
    for (const [patch, code] of cases) {
      await expect(tools.get("fusion_room_remove_member")!.execute(
        { room_id: "room-1", member_id: "member-1" },
        { ...callerExec(), ...patch } as FusionToolExecutionContext,
      )).rejects.toThrow(code);
    }
    expect(approval.request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports the caller context before registry capability when both are broken", async () => {
    const ctx: FusionToolHostContext = { tools: { register: vi.fn() } };
    await expect(executeRoomUpstreamTool(
      ctx,
      "fusion_room_create",
      { name: "Room" },
    )).rejects.toThrow("FUSION_TOOL_CONTEXT_UNAVAILABLE");
    await expect(executeRoomUpstreamTool(
      ctx,
      "fusion_room_create",
      { name: "Room" },
      { ...callerExec(), callId: "" } as FusionToolExecutionContext,
    )).rejects.toThrow("FUSION_TOOL_CONTEXT_INVALID:callId");
  });

  it("registers exactly the six fixed proxies", () => {
    expect(createRoomWriteTools(toolContext().ctx).map((tool) => tool.name)).toEqual([
      "fusion_room_create",
      "fusion_room_attach_session",
      "fusion_room_remove_member",
      "fusion_room_send",
      "fusion_room_broadcast",
      "fusion_room_close",
    ]);
  });

  it("maps safe defaults and caller identity to upstream Room tools", async () => {
    const { ctx, execute } = toolContext();
    const tools = toolsByName(ctx);
    const exec = callerExec();

    await tools.get("fusion_room_create")!.execute({ name: "Release" }, exec);
    await tools.get("fusion_room_attach_session")!.execute({
      room_id: "room-1",
      session_id: "session-child",
    }, exec);
    await tools.get("fusion_room_remove_member")!.execute({
      room_id: "room-1",
      member_id: "member-1",
    }, exec);
    await tools.get("fusion_room_send")!.execute({
      room_id: "room-1",
      to_member_id: "member-1",
      message: "hello",
    }, exec);
    await tools.get("fusion_room_broadcast")!.execute({
      room_id: "room-1",
      message: "all",
    }, exec);
    await tools.get("fusion_room_close")!.execute({ room_id: "room-1" }, exec);

    const calls = execute.mock.calls as unknown as Array<[FusionToolExecutionInput]>;
    expect(calls.map(([input]) => ({ name: input.name, arguments: input.arguments }))).toEqual([
      { name: "room_create", arguments: { name: "Release" } },
      {
        name: "room_attach_session",
        arguments: { room_id: "room-1", session_id: "session-child" },
      },
      {
        name: "room_remove_member",
        arguments: { room_id: "room-1", member_id: "member-1", interrupt_running: false },
      },
      {
        name: "room_send",
        arguments: { room_id: "room-1", to_member_id: "member-1", message: "hello" },
      },
      {
        name: "room_broadcast",
        arguments: { room_id: "room-1", message: "all" },
      },
      {
        name: "room_close",
        arguments: { room_id: "room-1", interrupt_running_members: false },
      },
    ]);
    expect(calls[0]?.[0]).toMatchObject({
      rootCallId: "root-1",
      agent: exec.agent,
      parent: exec.token,
      signal: exec.signal,
    });
    expect(calls[0]?.[0].callId).toMatch(/:fusion:fusion_room_create:\d+$/u);
  });

  it("requires one-time approval for broadcast/remove/close", async () => {
    const { ctx, approval, execute } = toolContext();
    const tools = toolsByName(ctx);
    const exec = callerExec();

    await tools.get("fusion_room_broadcast")!.execute({
      room_id: "room-1",
      message: "all",
    }, exec);
    await tools.get("fusion_room_remove_member")!.execute({
      room_id: "room-1",
      member_id: "member-1",
    }, exec);
    await tools.get("fusion_room_close")!.execute({ room_id: "room-1" }, exec);

    expect(approval.request).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("fails closed when approval is rejected or unavailable", async () => {
    const rejected = toolContext({ approval: "rejected" });
    await expect(
      toolsByName(rejected.ctx).get("fusion_room_broadcast")!.execute({
        room_id: "room-1",
        message: "all",
      }, callerExec()),
    ).rejects.toThrow("FUSION_ROOM_APPROVAL_REJECTED");
    expect(rejected.execute).not.toHaveBeenCalled();

    const base = toolContext().ctx;
    const unavailable: FusionToolHostContext = {
      tools: base.tools!,
      get: () => undefined,
    };
    await expect(
      toolsByName(unavailable).get("fusion_room_close")!.execute({
        room_id: "room-1",
      }, callerExec()),
    ).rejects.toThrow("FUSION_ROOM_APPROVAL_UNAVAILABLE");
  });

  it("keeps approval failures behind stable Room codes instead of leaking host errors", async () => {
    const base = toolContext();
    const close = (ctx: FusionToolHostContext, exec: FusionToolExecutionContext = callerExec()) =>
      toolsByName(ctx).get("fusion_room_close")!.execute({ room_id: "room-1" }, exec);
    const withGet = (get: NonNullable<FusionToolHostContext["get"]>): FusionToolHostContext => ({
      tools: base.ctx.tools!,
      get,
    });

    // A throwing ctx.get must not propagate the host's raw error.
    await expect(close(withGet(() => { throw new Error("host get exploded"); })))
      .rejects.toThrow("FUSION_ROOM_APPROVAL_UNAVAILABLE");
    // A null service must not leak a TypeError from property access.
    await expect(close(withGet(() => null)))
      .rejects.toThrow("FUSION_ROOM_APPROVAL_UNAVAILABLE");
    // A service whose request is not callable is unavailable.
    await expect(close(withGet(() => ({ request: "nope" }))))
      .rejects.toThrow("FUSION_ROOM_APPROVAL_UNAVAILABLE");
    // A rejecting approval request is wrapped with its message,
    // never propagated raw.
    await expect(close(withGet(() => ({
      request: async () => { throw new Error("policy engine down"); },
    })))).rejects.toThrow("FUSION_ROOM_APPROVAL_REQUEST_FAILED:policy engine down");
    // Outcomes map to a fixed code vocabulary: unknown or
    // malformed outcomes fail closed with a fixed code instead
    // of being upper-cased into the error code verbatim.
    await expect(close(withGet(() => ({ request: async () => "Denied By Policy" }))))
      .rejects.toThrow("FUSION_ROOM_APPROVAL_DENIED");
    await expect(close(withGet(() => ({ request: async () => undefined }))))
      .rejects.toThrow("FUSION_ROOM_APPROVAL_DENIED");
    await expect(close(withGet(() => ({ request: async () => "cancelled" }))))
      .rejects.toThrow("FUSION_ROOM_APPROVAL_CANCELLED");
    // The agent prerequisite is checked before the service is
    // consulted, matching the AgentTeams bridge order.
    await expect(close(withGet(() => undefined), { ...callerExec(), agent: undefined }))
      .rejects.toThrow("FUSION_ROOM_APPROVAL_AGENT_REQUIRED");
    expect(base.execute).not.toHaveBeenCalled();
  });

  it("anchors the nested guard and rejects bypass shapes", () => {
    const guard = createRoomWriteGuard(true);
    expect(guard({
      name: "room_send",
      callId: "root:fusion:fusion_room_send:1",
      parent: Symbol("parent"),
    })).toBeUndefined();
    expect(guard({
      name: "room_send",
      callId: "root:fusion:fusion_room_send:1:ptc:1",
      parent: Symbol("parent"),
    })).toContain("FUSION_ROOM_WRITES_GUARDED");
    expect(guard({ name: "room_send", callId: "root", parent: Symbol("parent") }))
      .toContain("FUSION_ROOM_WRITES_GUARDED");
    expect(createRoomWriteGuard(false)({
      name: "room_send",
      callId: "root:fusion:fusion_room_send:1",
      parent: Symbol("parent"),
    })).toContain("FUSION_ROOM_WRITES_DISABLED");
  });

  it("redacts addresses, digests and message bodies from results", async () => {
    const execute = vi.fn(async () => ({
      isError: false as const,
      value: {
        room: {
          id: "room-1",
          members: [{
            id: "m1",
            connection: { address: "secret", sessionId: "s1" },
            profile: { digest: "fingerprint" },
          }],
          events: [{ type: "delivery", body: "secret body" }],
        },
      },
    }));
    const result = await executeRoomUpstreamTool(
      toolContext({ execute }).ctx,
      "fusion_room_create",
      { name: "Room" },
      callerExec(),
    );
    expect(result).toEqual({
      room: {
        id: "room-1",
        members: [{
          id: "m1",
          connection: { address: "[redacted]", sessionId: "s1" },
          profile: { digest: "[redacted]" },
        }],
        events: [{ type: "delivery" }],
      },
    });
  });

  it("preserves upstream error name/code through the injected HarnessError factory", async () => {
    class HarnessError extends Error {
      code: string;
      constructor(message: string, code: string) {
        super(message);
        this.code = code;
      }
    }
    const errorFactory: RoomHarnessErrorFactory = (message, code) =>
      new HarnessError(message, code);
    const execute = vi.fn(async () => ({
      isError: true as const,
      error: {
        message: "room denied",
        info: { name: "RoomDenied", code: "ROOM_DENIED" },
      },
    }));
    await expect(executeRoomUpstreamTool(
      toolContext({ execute }).ctx,
      "fusion_room_send",
      { room_id: "room-1", to_member_id: "m1", message: "x" },
      callerExec(),
      { errorFactory },
    )).rejects.toMatchObject({
      name: "RoomDenied",
      code: "ROOM_DENIED",
      tool: "fusion_room_send",
    });
  });

  it("keeps a structured fallback when runtime HarnessError is unavailable", async () => {
    const execute = vi.fn(async () => ({
      isError: true as const,
      error: { message: "room denied" },
    }));
    await expect(executeRoomUpstreamTool(
      toolContext({ execute }).ctx,
      "fusion_room_close",
      { room_id: "room-1" },
      callerExec(),
      { errorFactory: () => { throw new Error("unavailable"); } },
    )).rejects.toBeInstanceOf(RoomUpstreamToolError);
  });
});
