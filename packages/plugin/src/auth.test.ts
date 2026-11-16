import { describe, expect, it } from "vitest";
import {
  forwardedWebBaseUrl,
  headerValue,
  isJsonRequest,
  isSameOriginMutation,
  isSameOriginWebSocket,
  loopbackUrlFromHost,
  MAX_TASK_GOAL_LENGTH,
  normalizeCommandAllowlist,
  parseCommandAllowlist,
  rejectUnauthenticated,
  validateTaskGoal,
  webServerBaseUrl,
  type AuthConnection,
} from "./auth.js";

function recorder() {
  const calls: Array<{ status: number; headers: Record<string, string>; body: string }> = [];
  return {
    calls,
    response: {
      writeHead(status: number, headers: Record<string, string>) {
        calls.push({ status, headers, body: "" });
      },
      end(body?: string) {
        const last = calls[calls.length - 1];
        if (last !== undefined) last.body = body ?? "";
      },
    },
  };
}

describe("headerValue", () => {
  it("reads a plain header value", () => {
    expect(headerValue({ host: "example.test" }, "host")).toBe("example.test");
  });

  it("takes the first value of a repeated header", () => {
    expect(headerValue({ host: ["a.test", "b.test"] }, "host")).toBe("a.test");
  });

  it("treats an empty or whitespace-only value as absent", () => {
    expect(headerValue({ host: "" }, "host")).toBeUndefined();
    expect(headerValue({ host: "   " }, "host")).toBeUndefined();
  });

  it("returns undefined for a missing header", () => {
    expect(headerValue({}, "host")).toBeUndefined();
    expect(headerValue(undefined, "host")).toBeUndefined();
  });
});

describe("isSameOriginMutation", () => {
  it("rejects a cross-site request even when the origin matches", () => {
    expect(isSameOriginMutation({
      "sec-fetch-site": "cross-site",
      origin: "http://example.test",
      host: "example.test",
    })).toBe(false);
  });

  it("accepts a request whose origin matches the host", () => {
    expect(isSameOriginMutation({
      origin: "http://example.test",
      host: "example.test",
    })).toBe(true);
  });

  it("rejects a request whose origin names a different host", () => {
    expect(isSameOriginMutation({
      origin: "http://evil.test",
      host: "example.test",
    })).toBe(false);
  });

  it("compares against the forwarded host when a proxy sets one", () => {
    expect(isSameOriginMutation({
      origin: "https://panel.test",
      "x-forwarded-host": "panel.test, inner.test",
      host: "127.0.0.1:8787",
    })).toBe(true);
    expect(isSameOriginMutation({
      origin: "https://evil.test",
      "x-forwarded-host": "panel.test",
      host: "127.0.0.1:8787",
    })).toBe(false);
  });

  it("rejects an origin that cannot be parsed", () => {
    expect(isSameOriginMutation({ origin: "not a url", host: "example.test" })).toBe(false);
  });

  it("rejects an origin with no host header to compare against", () => {
    expect(isSameOriginMutation({ origin: "http://example.test" })).toBe(false);
  });

  it("treats a request without an origin header as same-origin", () => {
    // This is the deliberate tradeoff: non-browser clients send no Origin,
    // and DSH's own connection layer authenticates them. Locked by test so
    // a refactor cannot quietly narrow or widen it.
    expect(isSameOriginMutation({ host: "example.test" })).toBe(true);
    expect(isSameOriginMutation({})).toBe(true);
  });
});

describe("isSameOriginWebSocket", () => {
  it("requires Origin, matching host, and matching trusted scheme", () => {
    expect(isSameOriginWebSocket({
      origin: "https://panel.test",
      "x-forwarded-host": "panel.test",
      "x-forwarded-proto": "https",
      host: "127.0.0.1:8787",
    })).toBe(true);
    expect(isSameOriginWebSocket({
      origin: "https://panel.test",
      "x-forwarded-host": "panel.test",
      "x-forwarded-proto": "http",
      host: "127.0.0.1:8787",
    })).toBe(false);
    expect(isSameOriginWebSocket({
      origin: "https://panel.test",
      "x-forwarded-host": "panel.test",
      host: "127.0.0.1:8787",
    })).toBe(false);
    expect(isSameOriginWebSocket({
      "x-forwarded-host": "panel.test",
      host: "127.0.0.1:8787",
    })).toBe(false);
    expect(isSameOriginWebSocket({
      origin: "https://evil.test",
      host: "panel.test",
    })).toBe(false);
  });
});

describe("isJsonRequest", () => {
  it("accepts a JSON content type with parameters", () => {
    expect(isJsonRequest({ "content-type": "application/json; charset=utf-8" })).toBe(true);
  });

  it("rejects a missing or non-JSON content type", () => {
    expect(isJsonRequest({})).toBe(false);
    expect(isJsonRequest({ "content-type": "text/plain" })).toBe(false);
    expect(isJsonRequest({ "content-type": "application/x-www-form-urlencoded" })).toBe(false);
  });
});

describe("rejectUnauthenticated", () => {
  const connection = (rejection: 401 | 403 | undefined): AuthConnection => ({
    requestRejection: () => rejection,
  });

  it("reports that the DSH connection service is unavailable", () => {
    const { calls, response } = recorder();
    expect(rejectUnauthenticated({}, undefined, { headers: {} }, response)).toBe(true);
    expect(calls[0]?.status).toBe(503);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      error: "DSH_CONNECTION_UNAVAILABLE",
    });
  });

  it("reports an authentication failure", () => {
    const { calls, response } = recorder();
    expect(rejectUnauthenticated(
      {},
      connection(401),
      { headers: {} },
      response,
    )).toBe(true);
    expect(calls[0]?.status).toBe(401);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      error: "AUTHENTICATION_REQUIRED",
    });
  });

  it("reports a rejected origin", () => {
    const { calls, response } = recorder();
    expect(rejectUnauthenticated(
      {},
      connection(403),
      { headers: {} },
      response,
    )).toBe(true);
    expect(calls[0]?.status).toBe(403);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      error: "TRUSTED_ORIGIN_REQUIRED",
    });
  });

  it("lets an accepted request through", () => {
    const { calls, response } = recorder();
    expect(rejectUnauthenticated(
      {},
      connection(undefined),
      { headers: {} },
      response,
    )).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("falls back to the connection service on the context", () => {
    const { calls, response } = recorder();
    expect(rejectUnauthenticated(
      { connection: connection(401) },
      undefined,
      { headers: {} },
      response,
    )).toBe(true);
    expect(calls[0]?.status).toBe(401);
  });
});

describe("forwardedWebBaseUrl", () => {
  it("uses a trusted forwarded host and protocol", () => {
    expect(forwardedWebBaseUrl(
      { "x-forwarded-host": "panel.test", "x-forwarded-proto": "https" },
      new Set(["panel.test"]),
    )).toBe("https://panel.test");
  });

  it("refuses a host the operator did not trust", () => {
    expect(forwardedWebBaseUrl(
      { "x-forwarded-host": "evil.test" },
      new Set(["panel.test"]),
    )).toBeUndefined();
  });

  it("refuses an unknown protocol", () => {
    expect(forwardedWebBaseUrl(
      { "x-forwarded-host": "panel.test", "x-forwarded-proto": "file" },
      new Set(["panel.test"]),
    )).toBeUndefined();
  });

  it("returns nothing when no host is trusted", () => {
    expect(forwardedWebBaseUrl({ "x-forwarded-host": "panel.test" }, new Set())).toBeUndefined();
  });
});

describe("webServerBaseUrl", () => {
  it("uses the loopback address of a bound server", () => {
    expect(webServerBaseUrl({ host: "127.0.0.1", port: 8787 })).toBe("http://127.0.0.1:8787");
  });

  it("maps a wildcard bind onto loopback", () => {
    expect(webServerBaseUrl({ host: "0.0.0.0", port: 8787 })).toBe("http://127.0.0.1:8787");
  });

  it("refuses a server bound to a public interface", () => {
    expect(webServerBaseUrl({ host: "10.0.0.5", port: 8787 })).toBeUndefined();
  });

  it("refuses a server without a usable port", () => {
    expect(webServerBaseUrl({ host: "127.0.0.1" })).toBeUndefined();
    expect(webServerBaseUrl({ host: "127.0.0.1", port: 0 })).toBeUndefined();
  });
});

describe("loopbackUrlFromHost", () => {
  it("accepts a loopback host header", () => {
    expect(loopbackUrlFromHost("127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(loopbackUrlFromHost("localhost:8787")).toBe("http://localhost:8787");
  });

  it("refuses a non-loopback or malformed host", () => {
    expect(loopbackUrlFromHost("example.test")).toBeUndefined();
    expect(loopbackUrlFromHost("not a host")).toBeUndefined();
    expect(loopbackUrlFromHost(undefined)).toBeUndefined();
  });
});

describe("command allowlist", () => {
  it("trims entries and drops empty ones", () => {
    expect(normalizeCommandAllowlist(["  uname -r ", "", "   "])).toEqual(["uname -r"]);
  });

  it("refuses a command carrying a NUL byte", () => {
    expect(() => normalizeCommandAllowlist(["uname\0 -r"]))
      .toThrow("FUSION_MODEL_TASK_COMMANDS_INVALID");
  });

  it("parses a JSON array of strings", () => {
    expect(parseCommandAllowlist('["uname -r", "uptime"]')).toEqual(["uname -r", "uptime"]);
  });

  it("refuses malformed JSON, a non-array, and a non-string entry", () => {
    expect(() => parseCommandAllowlist("not json"))
      .toThrow("FUSION_MODEL_TASK_COMMANDS_INVALID");
    expect(() => parseCommandAllowlist('{"uname":true}'))
      .toThrow("FUSION_MODEL_TASK_COMMANDS_INVALID");
    expect(() => parseCommandAllowlist('["uname", 7]'))
      .toThrow("FUSION_MODEL_TASK_COMMANDS_INVALID");
  });
});

describe("validateTaskGoal", () => {
  it("accepts a bounded string and trims it", () => {
    expect(validateTaskGoal("  check the kernel  ")).toBe("check the kernel");
  });

  it("refuses a value that is not a string", () => {
    expect(() => validateTaskGoal(7)).toThrow("FUSION_TASK_GOAL_INVALID");
    expect(() => validateTaskGoal(undefined)).toThrow("FUSION_TASK_GOAL_INVALID");
  });

  it("refuses an empty goal", () => {
    expect(() => validateTaskGoal("   ")).toThrow("FUSION_TASK_GOAL_INVALID");
  });

  it("refuses a goal longer than the bound", () => {
    expect(() => validateTaskGoal("x".repeat(MAX_TASK_GOAL_LENGTH + 1)))
      .toThrow("FUSION_TASK_GOAL_INVALID");
    expect(validateTaskGoal("x".repeat(MAX_TASK_GOAL_LENGTH))).toHaveLength(MAX_TASK_GOAL_LENGTH);
  });
});
