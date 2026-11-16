import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PTY_MESSAGE_BYTES,
  MAX_PTY_RAW_CHUNK_BYTES,
  PTY_AUTH_TIMEOUT_MS,
  PtyCapabilityRegistry,
  chunkPtyOutput,
  encodePtyServerMessage,
  parsePtyClientMessage,
  validatePtyCloseRequest,
  validatePtyCreateRequest,
} from "./pty-protocol.js";

const TOKEN = "A".repeat(43);

afterEach(() => {
  vi.useRealTimers();
});

describe("PTY protocol", () => {
  it("locks the default first-frame authentication window to five seconds", () => {
    expect(PTY_AUTH_TIMEOUT_MS).toBe(5_000);
  });

  it("accepts auth, base64 input, bounded resize, and token-bound close messages", () => {
    expect(parsePtyClientMessage(JSON.stringify({
      type: "auth",
      terminalId: "pty-1",
      terminalToken: TOKEN,
    }))).toEqual({
      type: "auth",
      terminalId: "pty-1",
      terminalToken: TOKEN,
    });
    expect(parsePtyClientMessage(JSON.stringify({
      type: "input",
      data: Buffer.from("whoami\n").toString("base64"),
    }))).toEqual({
      type: "input",
      data: Buffer.from("whoami\n"),
    });
    expect(parsePtyClientMessage(JSON.stringify({
      type: "resize",
      cols: 132,
      rows: 43,
    }))).toEqual({
      type: "resize",
      cols: 132,
      rows: 43,
    });
    expect(parsePtyClientMessage(JSON.stringify({
      type: "close",
      terminalToken: TOKEN,
    }))).toEqual({
      type: "close",
      terminalToken: TOKEN,
    });
  });

  it.each([
    ["binary", Buffer.from("{}")],
    ["invalid-json", "{"],
    ["array", "[]"],
    ["unknown", JSON.stringify({ type: "exec", data: "" })],
    ["noncanonical-base64", JSON.stringify({ type: "input", data: "***" })],
    ["too-wide", JSON.stringify({ type: "resize", cols: 501, rows: 24 })],
    ["too-tall", JSON.stringify({ type: "resize", cols: 80, rows: 201 })],
    ["close-without-token", JSON.stringify({ type: "close" })],
    ["close-extra-field", JSON.stringify({ type: "close", terminalToken: TOKEN, command: "rm" })],
    ["auth-without-token", JSON.stringify({ type: "auth", terminalId: "pty-1" })],
    ["auth-extra-field", JSON.stringify({
      type: "auth",
      terminalId: "pty-1",
      terminalToken: TOKEN,
      extra: true,
    })],
  ])("rejects %s messages", (_label, raw) => {
    expect(() => parsePtyClientMessage(raw)).toThrow(/PTY_MESSAGE_/);
  });

  it("rejects a single message over 64 KiB and input over the raw chunk limit", () => {
    const oversized = JSON.stringify({
      type: "input",
      data: Buffer.alloc(60 * 1024).toString("base64"),
    });
    const overRawChunk = JSON.stringify({
      type: "input",
      data: Buffer.alloc(MAX_PTY_RAW_CHUNK_BYTES + 1).toString("base64"),
    });
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(MAX_PTY_MESSAGE_BYTES);
    expect(() => parsePtyClientMessage(oversized)).toThrow("PTY_MESSAGE_TOO_LARGE");
    expect(() => parsePtyClientMessage(overRawChunk)).toThrow("PTY_MESSAGE_BASE64_INVALID");
  });

  it("encodes snapshots as ordered JSON chunks that stay below 64 KiB", () => {
    const raw = Buffer.alloc(MAX_PTY_RAW_CHUNK_BYTES * 2 + 7, "x");
    const messages = chunkPtyOutput("snapshot", {
      terminalId: "pty-1",
      sequence: 9,
      data: raw,
      truncated: true,
    });

    expect(messages.length).toBe(3);
    expect(messages.map((message) => message.offset)).toEqual([
      0,
      MAX_PTY_RAW_CHUNK_BYTES,
      MAX_PTY_RAW_CHUNK_BYTES * 2,
    ]);
    expect(messages.at(-1)?.final).toBe(true);
    expect(Buffer.concat(messages.map((message) => Buffer.from(message.data, "base64")))).toEqual(raw);
    for (const message of messages) {
      const encoded = encodePtyServerMessage(message);
      expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_PTY_MESSAGE_BYTES);
    }
  });

  it("serializes state and error messages without secret-bearing fields", () => {
    expect(JSON.parse(encodePtyServerMessage({
      type: "state",
      terminalId: "pty-1",
      sequence: 2,
      state: "connected",
    }))).toEqual({
      type: "state",
      terminalId: "pty-1",
      sequence: 2,
      state: "connected",
    });
    expect(JSON.parse(encodePtyServerMessage({
      type: "error",
      terminalId: "pty-1",
      sequence: 2,
      code: "PTY_CONNECTION_FAILED",
      message: "PTY_CONNECTION_FAILED",
    }))).toEqual({
      type: "error",
      terminalId: "pty-1",
      sequence: 2,
      code: "PTY_CONNECTION_FAILED",
      message: "PTY_CONNECTION_FAILED",
    });
  });

  it("validates HTTP create and close bodies before touching SSH", () => {
    expect(validatePtyCreateRequest({
      nodeId: "huawei-hs-monitor-cn",
      cols: 100,
      rows: 30,
    })).toEqual({
      nodeId: "huawei-hs-monitor-cn",
      cols: 100,
      rows: 30,
    });
    expect(() => validatePtyCreateRequest({
      nodeId: "",
      cols: 0,
      rows: 30,
    })).toThrow("PTY_CREATE_INVALID");
    expect(validatePtyCloseRequest({
      terminalId: "pty-1",
      terminalToken: TOKEN,
    })).toEqual({
      terminalId: "pty-1",
      terminalToken: TOKEN,
    });
    expect(() => validatePtyCloseRequest({ terminalId: "pty-1" }))
      .toThrow("PTY_CLOSE_INVALID");
  });

  it("stores only token hashes and requires the matching capability", () => {
    const registry = new PtyCapabilityRegistry({
      idleTtlMs: 60_000,
      onIdleExpire: vi.fn(),
    });
    const issued = registry.issue({
      terminalId: "pty-1",
      nodeId: "huawei-hs-monitor-cn",
      cols: 100,
      rows: 30,
    });

    expect(issued.terminalToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(registry.verify("pty-1", issued.terminalToken)).toBe(true);
    expect(registry.verify("pty-2", issued.terminalToken)).toBe(false);
    expect(registry.verify("pty-1", "B".repeat(43))).toBe(false);
    expect(registry.close("pty-1", "B".repeat(43))).toBe(false);
    expect(registry.verify("pty-1", issued.terminalToken)).toBe(true);
    expect(registry.close("pty-1", issued.terminalToken)).toBe(true);
    expect(registry.verify("pty-1", issued.terminalToken)).toBe(false);
  });

  it("expires unattached capabilities after the idle TTL and keeps attached ones alive", () => {
    vi.useFakeTimers();
    const onIdleExpire = vi.fn();
    const registry = new PtyCapabilityRegistry({
      idleTtlMs: 10_000,
      onIdleExpire,
    });
    const first = registry.issue({
      terminalId: "pty-idle",
      nodeId: "huawei-hs-monitor-cn",
      cols: 80,
      rows: 24,
    });
    vi.advanceTimersByTime(9_000);
    expect(registry.attach("pty-idle", first.terminalToken)).toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(onIdleExpire).not.toHaveBeenCalled();
    registry.detach("pty-idle");
    vi.advanceTimersByTime(10_000);
    expect(onIdleExpire).toHaveBeenCalledWith("pty-idle");

    const second = registry.issue({
      terminalId: "pty-expire",
      nodeId: "huawei-hs-monitor-cn",
      cols: 80,
      rows: 24,
    });
    expect(registry.verify("pty-expire", second.terminalToken)).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(onIdleExpire).toHaveBeenCalledWith("pty-expire");
    expect(registry.verify("pty-expire", second.terminalToken)).toBe(false);
  });
});
