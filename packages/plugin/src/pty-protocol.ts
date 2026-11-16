import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const MAX_PTY_MESSAGE_BYTES = 64 * 1024;
export const MAX_PTY_BUFFERED_BYTES = 1024 * 1024;
// 46 KiB expands to less than 64 KiB after base64 and the JSON envelope.
export const MAX_PTY_RAW_CHUNK_BYTES = 46 * 1024;
export const MAX_PTY_COLS = 500;
export const MAX_PTY_ROWS = 200;
export const PTY_AUTH_TIMEOUT_MS = 5_000;
export const DEFAULT_PTY_IDLE_TTL_MS = 10 * 60 * 1_000;

const TERMINAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type PtyClientMessage =
  | { type: "auth"; terminalId: string; terminalToken: string }
  | { type: "input"; data: Buffer }
  | { type: "resize"; cols: number; rows: number }
  | { type: "close"; terminalToken: string };

export interface PtyCreateRequest {
  nodeId: string;
  cols: number;
  rows: number;
}

export interface PtyCloseRequest {
  terminalId: string;
  terminalToken: string;
}

export interface PtyChunkMessage {
  type: "snapshot" | "output";
  terminalId: string;
  sequence: number;
  data: string;
  offset: number;
  total: number;
  final: boolean;
  truncated?: boolean;
}

export type PtyServerMessage =
  | PtyChunkMessage
  | {
    type: "state";
    terminalId: string;
    sequence: number;
    state: "connecting" | "connected" | "closed" | "error";
  }
  | {
    type: "error";
    terminalId: string;
    sequence: number;
    code: string;
    message: string;
  };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

function decodeCanonicalBase64(value: unknown, maximumBytes: number): Buffer {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error("PTY_MESSAGE_BASE64_INVALID");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > maximumBytes || decoded.toString("base64") !== value) {
    throw new Error("PTY_MESSAGE_BASE64_INVALID");
  }
  return decoded;
}

function validTerminalToken(value: unknown): value is string {
  return typeof value === "string" && TERMINAL_TOKEN_PATTERN.test(value);
}

function terminalTokenHash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Validates one client text frame before any bytes reach the SSH channel.
 */
export function parsePtyClientMessage(raw: string | Buffer): PtyClientMessage {
  if (Buffer.isBuffer(raw)) throw new Error("PTY_MESSAGE_BINARY");
  if (Buffer.byteLength(raw, "utf8") > MAX_PTY_MESSAGE_BYTES) {
    throw new Error("PTY_MESSAGE_TOO_LARGE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("PTY_MESSAGE_INVALID_JSON");
  }
  if (!isPlainObject(parsed)) throw new Error("PTY_MESSAGE_INVALID");

  if (parsed.type === "auth") {
    if (
      !hasOnlyKeys(parsed, ["type", "terminalId", "terminalToken"])
      || typeof parsed.terminalId !== "string"
      || !/^pty-[A-Za-z0-9-]{1,128}$/.test(parsed.terminalId)
      || !validTerminalToken(parsed.terminalToken)
    ) {
      throw new Error("PTY_MESSAGE_INVALID");
    }
    return {
      type: "auth",
      terminalId: parsed.terminalId,
      terminalToken: parsed.terminalToken,
    };
  }
  if (parsed.type === "input") {
    if (!hasOnlyKeys(parsed, ["type", "data"])) throw new Error("PTY_MESSAGE_INVALID");
    return {
      type: "input",
      data: decodeCanonicalBase64(parsed.data, MAX_PTY_RAW_CHUNK_BYTES),
    };
  }
  if (parsed.type === "resize") {
    if (
      !hasOnlyKeys(parsed, ["type", "cols", "rows"])
      || !validInteger(parsed.cols, 1, MAX_PTY_COLS)
      || !validInteger(parsed.rows, 1, MAX_PTY_ROWS)
    ) {
      throw new Error("PTY_MESSAGE_INVALID");
    }
    return { type: "resize", cols: parsed.cols, rows: parsed.rows };
  }
  if (parsed.type === "close") {
    if (
      !hasOnlyKeys(parsed, ["type", "terminalToken"])
      || !validTerminalToken(parsed.terminalToken)
    ) {
      throw new Error("PTY_MESSAGE_INVALID");
    }
    return { type: "close", terminalToken: parsed.terminalToken };
  }
  throw new Error("PTY_MESSAGE_UNKNOWN_TYPE");
}

export function validatePtyCreateRequest(value: unknown): PtyCreateRequest {
  if (
    !isPlainObject(value)
    || !hasOnlyKeys(value, ["nodeId", "cols", "rows"])
    || typeof value.nodeId !== "string"
    || value.nodeId.length < 1
    || value.nodeId.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.nodeId)
    || !validInteger(value.cols, 1, MAX_PTY_COLS)
    || !validInteger(value.rows, 1, MAX_PTY_ROWS)
  ) {
    throw new Error("PTY_CREATE_INVALID");
  }
  return {
    nodeId: value.nodeId,
    cols: value.cols,
    rows: value.rows,
  };
}

export function validatePtyCloseRequest(value: unknown): PtyCloseRequest {
  if (
    !isPlainObject(value)
    || !hasOnlyKeys(value, ["terminalId", "terminalToken"])
    || typeof value.terminalId !== "string"
    || !/^pty-[A-Za-z0-9-]{1,128}$/.test(value.terminalId)
    || !validTerminalToken(value.terminalToken)
  ) {
    throw new Error("PTY_CLOSE_INVALID");
  }
  return {
    terminalId: value.terminalId,
    terminalToken: value.terminalToken,
  };
}

interface PtyCapabilityGrant {
  terminalId: string;
  nodeId: string;
  cols: number;
  rows: number;
  tokenHash: Buffer;
  attachments: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface PtyCapabilityRegistryOptions {
  idleTtlMs: number;
  onIdleExpire: (terminalId: string) => void;
}

/**
 * Keeps only token digests. A terminal id alone never grants close or attach
 * access, and the plaintext creator token is returned once by issue().
 */
export class PtyCapabilityRegistry {
  private readonly grants = new Map<string, PtyCapabilityGrant>();
  private readonly idleTtlMs: number;
  private readonly onIdleExpire: (terminalId: string) => void;

  constructor(options: PtyCapabilityRegistryOptions) {
    if (!Number.isInteger(options.idleTtlMs) || options.idleTtlMs < 1) {
      throw new Error("PTY_IDLE_TTL_INVALID");
    }
    this.idleTtlMs = options.idleTtlMs;
    this.onIdleExpire = options.onIdleExpire;
  }

  issue(input: {
    terminalId: string;
    nodeId: string;
    cols: number;
    rows: number;
  }): { terminalToken: string } {
    if (this.grants.has(input.terminalId)) throw new Error("PTY_CAPABILITY_EXISTS");
    const terminalToken = randomBytes(32).toString("base64url");
    const grant: PtyCapabilityGrant = {
      ...input,
      tokenHash: terminalTokenHash(terminalToken),
      attachments: 0,
      idleTimer: undefined,
    };
    this.grants.set(input.terminalId, grant);
    this.scheduleIdle(grant);
    return { terminalToken };
  }

  verify(terminalId: string, terminalToken: string): boolean {
    const grant = this.grants.get(terminalId);
    if (grant === undefined || !validTerminalToken(terminalToken)) return false;
    const actual = terminalTokenHash(terminalToken);
    return actual.length === grant.tokenHash.length
      && timingSafeEqual(actual, grant.tokenHash);
  }

  attach(terminalId: string, terminalToken: string): boolean {
    if (!this.verify(terminalId, terminalToken)) return false;
    const grant = this.grants.get(terminalId)!;
    grant.attachments += 1;
    this.clearIdle(grant);
    return true;
  }

  detach(terminalId: string): void {
    const grant = this.grants.get(terminalId);
    if (grant === undefined) return;
    grant.attachments = Math.max(0, grant.attachments - 1);
    if (grant.attachments === 0) this.scheduleIdle(grant);
  }

  close(terminalId: string, terminalToken: string): boolean {
    if (!this.verify(terminalId, terminalToken)) return false;
    this.delete(terminalId);
    return true;
  }

  delete(terminalId: string): void {
    const grant = this.grants.get(terminalId);
    if (grant !== undefined) this.clearIdle(grant);
    this.grants.delete(terminalId);
  }

  clear(): void {
    for (const grant of this.grants.values()) this.clearIdle(grant);
    this.grants.clear();
  }

  private scheduleIdle(grant: PtyCapabilityGrant): void {
    this.clearIdle(grant);
    grant.idleTimer = setTimeout(() => {
      const current = this.grants.get(grant.terminalId);
      if (current !== grant || grant.attachments !== 0) return;
      this.grants.delete(grant.terminalId);
      grant.idleTimer = undefined;
      this.onIdleExpire(grant.terminalId);
    }, this.idleTtlMs);
    grant.idleTimer.unref?.();
  }

  private clearIdle(grant: PtyCapabilityGrant): void {
    if (grant.idleTimer === undefined) return;
    clearTimeout(grant.idleTimer);
    grant.idleTimer = undefined;
  }
}

export function chunkPtyOutput(
  type: "snapshot" | "output",
  input: {
    terminalId: string;
    sequence: number;
    data: Buffer;
    truncated?: boolean;
  },
): PtyChunkMessage[] {
  const chunks: PtyChunkMessage[] = [];
  const total = input.data.length;
  if (total === 0) {
    return [{
      type,
      terminalId: input.terminalId,
      sequence: input.sequence,
      data: "",
      offset: 0,
      total: 0,
      final: true,
      ...(type === "snapshot" ? { truncated: input.truncated === true } : {}),
    }];
  }
  for (let offset = 0; offset < total; offset += MAX_PTY_RAW_CHUNK_BYTES) {
    const end = Math.min(offset + MAX_PTY_RAW_CHUNK_BYTES, total);
    chunks.push({
      type,
      terminalId: input.terminalId,
      sequence: input.sequence,
      data: input.data.subarray(offset, end).toString("base64"),
      offset,
      total,
      final: end === total,
      ...(type === "snapshot" ? { truncated: input.truncated === true } : {}),
    });
  }
  return chunks;
}

export function encodePtyServerMessage(message: PtyServerMessage): string {
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded, "utf8") > MAX_PTY_MESSAGE_BYTES) {
    throw new Error("PTY_SERVER_MESSAGE_TOO_LARGE");
  }
  return encoded;
}
