import { describe, expect, it } from "vitest";
import { backoffDelayMs, SseParser } from "./sse-reader.js";

describe("SseParser", () => {
  it("parses an id and data frame", () => {
    const parser = new SseParser();
    const frames = parser.push("id: 7\ndata: {\"type\":\"state.updated\"}\n\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBe("7");
    expect(frames[0]?.event).toBe("message");
    expect(frames[0]?.data).toBe("{\"type\":\"state.updated\"}");
  });

  it("waits for the blank line before emitting a frame", () => {
    const parser = new SseParser();
    expect(parser.push("id: 1\n")).toHaveLength(0);
    expect(parser.push("data: partial\n")).toHaveLength(0);
    const frames = parser.push("\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toBe("partial");
  });

  it("joins multi-line data with newlines", () => {
    const parser = new SseParser();
    const frames = parser.push("data: first\ndata: second\n\n");
    expect(frames[0]?.data).toBe("first\nsecond");
  });

  it("ignores comment lines", () => {
    const parser = new SseParser();
    const frames = parser.push(": keepalive\n\n");
    expect(frames).toHaveLength(0);
  });

  it("handles carriage-return line endings", () => {
    const parser = new SseParser();
    const frames = parser.push("id: 3\r\ndata: value\r\n\r\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBe("3");
    expect(frames[0]?.data).toBe("value");
  });

  it("reads a named event and defaults the message name", () => {
    const parser = new SseParser();
    const frames = parser.push("event: node.updated\ndata: {}\n\n");
    expect(frames[0]?.event).toBe("node.updated");
  });

  it("keeps the last id across frames of one connection", () => {
    const parser = new SseParser();
    const frames = parser.push("id: 4\ndata: a\n\nid: 5\ndata: b\n\n");
    expect(frames.map((frame) => frame.id)).toEqual(["4", "5"]);
  });

  it("reads the retry field", () => {
    const parser = new SseParser();
    const frames = parser.push("retry: 2500\ndata: {}\n\n");
    expect(frames[0]?.retry).toBe(2500);
  });

  it("emits an unterminated trailing frame on flush", () => {
    const parser = new SseParser();
    expect(parser.push("id: 9\ndata: tail")).toHaveLength(0);
    const frames = parser.flush();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBe("9");
    expect(frames[0]?.data).toBe("tail");
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially and stays within the cap", () => {
    const zero = backoffDelayMs(0, () => 1);
    const one = backoffDelayMs(1, () => 1);
    const many = backoffDelayMs(20, () => 1);
    expect(one).toBeGreaterThan(zero);
    expect(many).toBeLessThanOrEqual(10_000);
  });

  it("applies jitter within the computed window", () => {
    const low = backoffDelayMs(3, () => 0);
    const high = backoffDelayMs(3, () => 1);
    expect(low).toBeLessThan(high);
  });
});
