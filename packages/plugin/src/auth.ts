/**
 * The security boundary of the Fusion plugin.
 *
 * Everything that decides "may this request act, and on what" lives here:
 * origin checks, content-type checks, DSH authentication, the command
 * allowlist a model is confined to, and the bounds on the free text a model
 * may submit.
 *
 * These rules used to sit inside `index.ts`, where they could only be
 * exercised by booting a whole DSH host. They are separated so the
 * tradeoffs are pinned by tests, not by comments.
 */

import { jsonResponse, type HttpResponse } from "./http.js";

export interface AuthHeaders {
  [name: string]: string | string[] | undefined;
}

export interface AuthRequest {
  headers?: AuthHeaders;
}

export interface AuthConnection {
  requestRejection(request: { headers: AuthHeaders }): 401 | 403 | undefined;
}

export interface AuthContext {
  connection?: AuthConnection;
  get?: (name: string) => unknown;
}

export interface AuthWebServer {
  readonly host?: string;
  readonly port?: number;
}

/**
 * Reads one header, tolerating the array form Node allows.
 *
 * Empty and whitespace-only values are treated as absent: a header that
 * carries no information must not be mistaken for one that does.
 */
export function headerValue(
  headers: AuthHeaders | undefined,
  name: string,
): string | undefined {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  const first = Array.isArray(value) ? value[0] : value;
  const normalized = first?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}

/**
 * Whether a mutating request may be treated as same-origin.
 *
 * The rules, in order:
 *
 * - `Sec-Fetch-Site: cross-site` is always rejected. The browser sets it
 *   and a page cannot forge it.
 * - A missing `Origin` header is treated as same-origin. Non-browser
 *   clients (the DSH host itself, curl, a script) send no `Origin`, and
     DSH's own authentication layer is the gate for them. Rejecting them
     here would break the plugin's own tooling without adding a check that
     a browser could not bypass anyway.
 * - Otherwise the `Origin` host must equal the forwarded host.
 *
 * The middle rule is a deliberate tradeoff, and it is the reason this
 * function has a test: it is the kind of decision that silently regresses.
 */
export function isSameOriginMutation(headers: AuthHeaders | undefined): boolean {
  const fetchSite = headerValue(headers, "sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  const origin = headerValue(headers, "origin");
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    const host = headerValue(headers, "x-forwarded-host")?.split(",")[0]?.trim()
      ?? headerValue(headers, "host");
    return host !== undefined && parsed.host === host;
  } catch {
    return false;
  }
}

/**
 * Browser WebSocket handshakes always carry Origin. Unlike ordinary mutations,
 * a missing Origin is not accepted: an upgraded socket has no later DSH
 * response boundary to recover from.
 */
export function isSameOriginWebSocket(headers: AuthHeaders | undefined): boolean {
  const origin = headerValue(headers, "origin");
  if (origin === undefined) return false;
  const protocol = headerValue(headers, "x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase()
    ?? "http";
  if (protocol !== "http" && protocol !== "https") return false;
  try {
    return new URL(origin).protocol === `${protocol}:` && isSameOriginMutation(headers);
  } catch {
    return false;
  }
}

/**
 * Whether a request declares a JSON body.
 *
 * The write routes reject anything else: a form post or a plain text body
 * has no place in a JSON API, and accepting one would let a cross-origin
 * form reach a mutating route.
 */
export function isJsonRequest(headers: AuthHeaders | undefined): boolean {
  return headerValue(headers, "content-type")?.split(";")[0]?.trim().toLowerCase()
    === "application/json";
}

/**
 * Rejects a request that DSH will not authenticate.
 *
 * Returns true when the request was rejected and the caller must stop.
 * DSH's connection service owns the actual decision; the plugin only
 * translates the refusal into a body an operator can read.
 */
export function rejectUnauthenticated(
  context: AuthContext,
  connection: AuthConnection | undefined,
  request: AuthRequest,
  response: HttpResponse,
): boolean {
  const service = connection
    ?? context.connection
    ?? context.get?.("connection") as AuthConnection | undefined;
  if (service === undefined) {
    jsonResponse(response, 503, { error: "DSH_CONNECTION_UNAVAILABLE" });
    return true;
  }
  const rejection = service.requestRejection({ headers: request.headers ?? {} });
  if (rejection === undefined) return false;
  jsonResponse(response, rejection, {
    error: rejection === 401 ? "AUTHENTICATION_REQUIRED" : "TRUSTED_ORIGIN_REQUIRED",
  });
  return true;
}

/**
 * The public base URL of the panel, when a reverse proxy declares one.
 *
 * Only hosts the operator listed as trusted are used: the value ends up in
 * links the panel hands to the browser.
 */
export function forwardedWebBaseUrl(
  headers: AuthHeaders | undefined,
  trustedHosts: ReadonlySet<string>,
): string | undefined {
  if (trustedHosts.size === 0) return undefined;
  const host = headerValue(headers, "x-forwarded-host")?.split(",")[0]?.trim()
    ?? headerValue(headers, "host");
  const protocol = headerValue(headers, "x-forwarded-proto")?.split(",")[0]?.trim()
    ?? "http";
  if (host === undefined || (protocol !== "http" && protocol !== "https")) return undefined;
  if (!trustedHosts.has(host.toLowerCase())) return undefined;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return undefined;
  }
}

/**
 * The base URL of a locally bound web server.
 *
 * Only loopback addresses qualify: a server bound to a public interface
 * must not be advertised to the browser as if it were local.
 */
export function webServerBaseUrl(webServer: AuthWebServer | undefined): string | undefined {
  if (webServer === undefined || webServer.port === undefined) return undefined;
  if (!Number.isInteger(webServer.port) || webServer.port <= 0) return undefined;
  const configuredHost = webServer.host ?? "127.0.0.1";
  const host = configuredHost === "0.0.0.0" ? "127.0.0.1" : configuredHost;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) return undefined;
  return `http://${host.includes(":") ? `[${host}]` : host}:${webServer.port}`;
}

/**
 * The origin of a loopback `Host` header.
 *
 * Used as the last fallback when neither a trusted proxy nor the bound
 * web server says where the panel lives.
 */
export function loopbackUrlFromHost(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined) return undefined;
  try {
    const parsed = new URL(`http://${hostHeader}`);
    if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/**
 * Normalizes a command allowlist.
 *
 * Commands are trimmed and empties are dropped, so a list written by hand
 * in an environment variable behaves like a list written in JSON. A NUL
 * byte is refused: it can truncate a command on the remote host.
 */
export function normalizeCommandAllowlist(commands: readonly string[]): string[] {
  const normalized = commands.map((command) => command.trim()).filter((command) => command !== "");
  if (normalized.some((command) => command.includes("\0"))) {
    throw new Error("FUSION_MODEL_TASK_COMMANDS_INVALID");
  }
  return normalized;
}

/**
 * Parses the allowlist a model may dispatch on a remote node.
 *
 * Every failure mode reports the same code: the operator has to fix the
 * value, and the exact reason is in the thrown message only.
 */
export function parseCommandAllowlist(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("FUSION_MODEL_TASK_COMMANDS_INVALID");
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error("FUSION_MODEL_TASK_COMMANDS_INVALID");
  }
  return normalizeCommandAllowlist(parsed);
}

/** The longest task goal accepted from a model-driven dispatch. */
export const MAX_TASK_GOAL_LENGTH = 512;

/**
 * Validates the free-text goal a model submits with a dispatch.
 *
 * The goal is stored on the remote job, kept in the task ledger, and
 * rendered in the panel, so it has to be a bounded string rather than
 * whatever the model passed in.
 */
export function validateTaskGoal(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("FUSION_TASK_GOAL_INVALID");
  }
  const goal = value.trim();
  if (goal === "" || goal.length > MAX_TASK_GOAL_LENGTH) {
    throw new Error("FUSION_TASK_GOAL_INVALID");
  }
  return goal;
}
