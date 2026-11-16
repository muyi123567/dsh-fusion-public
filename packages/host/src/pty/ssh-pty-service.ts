import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export const SSH_PTY_MAX_TERMINALS = 4;
export const SSH_PTY_MAX_SNAPSHOT_BYTES = 128 * 1024;

const MAX_KNOWN_HOSTS_BYTES = 4 * 1024 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 15_000;

export type SshPtyErrorCode =
  | "PTY_DIMENSIONS_INVALID"
  | "PTY_LIMIT_REACHED"
  | "PTY_KEY_UNREADABLE"
  | "PTY_KEY_INVALID"
  | "PTY_KNOWN_HOSTS_UNREADABLE"
  | "PTY_KNOWN_HOSTS_INVALID"
  | "PTY_KNOWN_HOSTS_CERT_AUTHORITY_UNSUPPORTED"
  | "PTY_HOST_KEY_UNVERIFIED"
  | "PTY_AUTHENTICATION_FAILED"
  | "PTY_UNREACHABLE"
  | "PTY_CONNECTION_FAILED"
  | "PTY_SHELL_FAILED"
  | "PTY_NOT_CONNECTED"
  | "PTY_UNKNOWN_TERMINAL";

export class SshPtyError extends Error {
  readonly name = "SshPtyError";

  constructor(
    readonly code: SshPtyErrorCode,
    message = code,
  ) {
    super(message);
  }
}

export type SshPtyState = "connecting" | "connected" | "closed" | "error";

export interface SshPtyDimensions {
  cols: number;
  rows: number;
}

export interface SshPtySnapshot {
  sequence: number;
  data: Buffer;
  truncated: boolean;
  state: SshPtyState;
}

export type SshPtyEvent =
  | {
    type: "output";
    terminalId: string;
    sequence: number;
    data: Buffer;
  }
  | {
    type: "state";
    terminalId: string;
    sequence: number;
    state: SshPtyState;
  }
  | {
    type: "error";
    terminalId: string;
    sequence: number;
    code: SshPtyErrorCode;
    message: string;
  };

export interface SshPtyTerminal {
  readonly id: string;
  readonly state: SshPtyState;
  readonly sequence: number;
  snapshot(): SshPtySnapshot;
  subscribe(listener: (event: SshPtyEvent) => void): () => void;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  close(): void;
  terminate(): void;
}

export interface SshPtyServiceLike {
  readonly activeCount: number;
  create(dimensions: SshPtyDimensions): Promise<SshPtyTerminal>;
  get(terminalId: string): SshPtyTerminal | undefined;
  write(terminalId: string, data: Buffer): void;
  resize(terminalId: string, cols: number, rows: number): void;
  close(terminalId: string): void;
  terminate(terminalId: string): void;
  dispose(): void;
}

export interface Ssh2ReadableLike {
  on(event: "data", listener: (chunk: Buffer | Uint8Array) => void): unknown;
}

export interface Ssh2ShellChannelLike {
  readonly stdout: Ssh2ReadableLike;
  readonly stderr?: Ssh2ReadableLike;
  write(data: Buffer | string): boolean;
  setWindow(rows: number, cols: number, height: number, width: number): void;
  close(): void;
  destroy(): unknown;
  on(event: "close" | "end", listener: () => void): unknown;
}

export interface Ssh2ConnectConfigLike {
  host: string;
  username: string;
  privateKey: Buffer;
  hostHash: "sha256";
  hostVerifier: (digestHex: string) => boolean;
  readyTimeout: number;
  keepaliveInterval: number;
  keepaliveCountMax: number;
}

export interface Ssh2ClientLike {
  connect(config: Ssh2ConnectConfigLike): Ssh2ClientLike;
  shell(
    window: { term: string; cols: number; rows: number },
    callback: (error: Error | undefined | null, channel: Ssh2ShellChannelLike) => void,
  ): Ssh2ClientLike;
  end(): Ssh2ClientLike;
  destroy(): Ssh2ClientLike;
  once(event: "ready" | "close", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface Ssh2ModuleLike {
  Client: new () => Ssh2ClientLike;
}

export interface ParsedSshTarget {
  host: string;
  username: string;
}

export interface SshPtyServiceOptions {
  /**
   * The existing Huawei SSH target. A bare host uses the provider's historical
   * `root` default; `user@host` is parsed into ssh2's host/username pair.
   */
  host: string;
  keyPath: string;
  knownHostsPath: string;
  ssh2Factory: () => Promise<Ssh2ModuleLike>;
  snapshotBytes?: number;
  readyTimeoutMs?: number;
}

interface KnownHostPolicy {
  allowedFingerprints: Set<string>;
  revokedFingerprints: Set<string>;
}

interface TerminalRecord {
  id: string;
  client: Ssh2ClientLike;
  channel?: Ssh2ShellChannelLike;
  state: SshPtyState;
  sequence: number;
  chunks: Buffer[];
  snapshotLength: number;
  truncated: boolean;
  listeners: Set<(event: SshPtyEvent) => void>;
  finalized: boolean;
}

function validateDimensions(dimensions: SshPtyDimensions): void {
  if (
    !Number.isInteger(dimensions.cols)
    || dimensions.cols < 1
    || dimensions.cols > 500
    || !Number.isInteger(dimensions.rows)
    || dimensions.rows < 1
    || dimensions.rows > 200
  ) {
    throw new SshPtyError("PTY_DIMENSIONS_INVALID");
  }
}

function validTargetPart(value: string): boolean {
  return value !== ""
    && !value.startsWith("-")
    && !/[\s\0\r\n]/.test(value);
}

/**
 * Parses the Huawei provider's existing `[user@]host` configuration. No key
 * path or key material is involved.
 */
export function parseHuaweiSshTarget(value: string): ParsedSshTarget {
  const trimmed = value.trim();
  if (!validTargetPart(trimmed)) throw new SshPtyError("PTY_CONNECTION_FAILED");
  const separator = trimmed.lastIndexOf("@");
  const username = separator === -1 ? "root" : trimmed.slice(0, separator);
  const rawHost = separator === -1 ? trimmed : trimmed.slice(separator + 1);
  const host = rawHost.startsWith("[") && rawHost.endsWith("]")
    ? rawHost.slice(1, -1)
    : rawHost;
  if (!validTargetPart(username) || !validTargetPart(host)) {
    throw new SshPtyError("PTY_CONNECTION_FAILED");
  }
  return { host, username };
}

function hostPatternsFor(target: ParsedSshTarget): string[] {
  return [
    target.host,
    target.host.toLowerCase(),
    `[${target.host}]:22`,
    `[${target.host.toLowerCase()}]:22`,
  ];
}

function safeEqualBase64(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "base64");
  const expectedBuffer = Buffer.from(expected, "base64");
  return actualBuffer.length === expectedBuffer.length
    && actualBuffer.length > 0
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function hashedHostMatches(pattern: string, candidates: readonly string[]): boolean {
  const parts = pattern.split("|");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "1") return false;
  const salt = parts[2];
  const digest = parts[3];
  if (salt === undefined || digest === undefined || salt === "" || digest === "") return false;
  const saltBuffer = Buffer.from(salt, "base64");
  if (saltBuffer.length === 0) return false;
  return candidates.some((candidate) => {
    const actual = createHmac("sha1", saltBuffer).update(candidate).digest("base64");
    return safeEqualBase64(actual, digest);
  });
}

function wildcardPatternMatches(pattern: string, candidate: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const expression = escaped.replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${expression}$`, "i").test(candidate);
}

function plainHostMatches(pattern: string, candidates: readonly string[]): boolean {
  if (pattern === "") return false;
  return candidates.some((candidate) => wildcardPatternMatches(pattern, candidate));
}

function hostPatternMatches(pattern: string, candidates: readonly string[]): boolean {
  return pattern.startsWith("|1|")
    ? hashedHostMatches(pattern, candidates)
    : plainHostMatches(pattern, candidates);
}

function lineMatchesTarget(patterns: readonly string[], candidates: readonly string[]): boolean {
  const positive = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negative = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  return positive.some((pattern) => hostPatternMatches(pattern, candidates))
    && !negative.some((pattern) => hostPatternMatches(pattern, candidates));
}

/**
 * Parses OpenSSH known_hosts strictly. Wildcards and marker lines are not
 * treated as authorization; exact plain names and `|1|` hashed names are.
 */
export function parseKnownHosts(
  contents: string,
  target: ParsedSshTarget,
): KnownHostPolicy {
  const candidates = hostPatternsFor(target);
  const allowedFingerprints = new Set<string>();
  const revokedFingerprints = new Set<string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/);
    const marker = tokens[0]?.startsWith("@") ? tokens[0].toLowerCase() : undefined;
    const offset = marker === undefined ? 0 : 1;
    const hostField = tokens[offset];
    const keyType = tokens[offset + 1];
    const keyData = tokens[offset + 2];
    if (hostField === undefined || keyType === undefined || keyData === undefined) {
      throw new SshPtyError("PTY_KNOWN_HOSTS_INVALID");
    }
    const patterns = hostField.split(",");
    const matchesTarget = lineMatchesTarget(patterns, candidates);
    if (!matchesTarget) continue;
    if (marker === "@cert-authority") {
      throw new SshPtyError("PTY_KNOWN_HOSTS_CERT_AUTHORITY_UNSUPPORTED");
    }
    if (marker !== undefined && marker !== "@revoked") continue;
    if (!/^(ssh-|ecdsa-|sk-)/.test(keyType)) {
      throw new SshPtyError("PTY_KNOWN_HOSTS_INVALID");
    }
    const keyBlob = Buffer.from(keyData, "base64");
    if (keyBlob.length === 0 || keyBlob.toString("base64").replace(/=+$/, "") !== keyData.replace(/=+$/, "")) {
      throw new SshPtyError("PTY_KNOWN_HOSTS_INVALID");
    }
    const fingerprintHex = createHash("sha256").update(keyBlob).digest("hex");
    if (marker === "@revoked") {
      revokedFingerprints.add(fingerprintHex);
    } else {
      allowedFingerprints.add(fingerprintHex);
    }
  }
  return { allowedFingerprints, revokedFingerprints };
}

function buildHostVerifier(
  policy: KnownHostPolicy,
): Ssh2ConnectConfigLike["hostVerifier"] {
  return (digestHex) => {
    const fingerprint = digestHex.toLowerCase();
    return !policy.revokedFingerprints.has(fingerprint)
      && policy.allowedFingerprints.has(fingerprint);
  };
}

function mapConnectError(error: Error): SshPtyError {
  const detail = error.message.toLowerCase();
  if (
    detail.includes("host key")
    || detail.includes("host verification")
    || detail.includes("hostverifier")
  ) {
    return new SshPtyError("PTY_HOST_KEY_UNVERIFIED");
  }
  if (
    detail.includes("authentication")
    || detail.includes("permission denied")
    || detail.includes("all configured authentication methods failed")
  ) {
    return new SshPtyError("PTY_AUTHENTICATION_FAILED");
  }
  if (
    detail.includes("private key")
    || detail.includes("cannot parse")
    || detail.includes("bad passphrase")
  ) {
    return new SshPtyError("PTY_KEY_INVALID");
  }
  if (
    detail.includes("econnrefused")
    || detail.includes("enotfound")
    || detail.includes("ehostunreach")
    || detail.includes("etimedout")
    || detail.includes("timed out")
  ) {
    return new SshPtyError("PTY_UNREACHABLE");
  }
  return new SshPtyError("PTY_CONNECTION_FAILED");
}

async function readRequiredFile(
  path: string,
  unreadableCode: "PTY_KEY_UNREADABLE" | "PTY_KNOWN_HOSTS_UNREADABLE",
): Promise<Buffer> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    if (unreadableCode === "PTY_KNOWN_HOSTS_UNREADABLE" && info.size > MAX_KNOWN_HOSTS_BYTES) {
      throw new SshPtyError("PTY_KNOWN_HOSTS_INVALID");
    }
    return await readFile(path);
  } catch (error) {
    if (error instanceof SshPtyError) throw error;
    throw new SshPtyError(unreadableCode);
  }
}

export class SshPtyService {
  private readonly target: ParsedSshTarget;
  private readonly keyPath: string;
  private readonly knownHostsPath: string;
  private readonly ssh2Factory: () => Promise<Ssh2ModuleLike>;
  private readonly snapshotBytes: number;
  private readonly readyTimeoutMs: number;
  private readonly terminals = new Map<string, TerminalRecord>();
  private pendingCreates = 0;

  constructor(options: SshPtyServiceOptions) {
    this.target = parseHuaweiSshTarget(options.host);
    this.keyPath = options.keyPath;
    this.knownHostsPath = options.knownHostsPath;
    this.ssh2Factory = options.ssh2Factory;
    this.snapshotBytes = options.snapshotBytes ?? SSH_PTY_MAX_SNAPSHOT_BYTES;
    if (
      !Number.isInteger(this.snapshotBytes)
      || this.snapshotBytes < 1
      || this.snapshotBytes > SSH_PTY_MAX_SNAPSHOT_BYTES
    ) {
      throw new SshPtyError("PTY_DIMENSIONS_INVALID");
    }
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    if (!Number.isInteger(this.readyTimeoutMs) || this.readyTimeoutMs < 1_000) {
      throw new SshPtyError("PTY_CONNECTION_FAILED");
    }
  }

  get activeCount(): number {
    return this.terminals.size;
  }

  get(terminalId: string): SshPtyTerminal | undefined {
    const record = this.terminals.get(terminalId);
    return record === undefined ? undefined : this.terminalView(record);
  }

  async create(dimensions: SshPtyDimensions): Promise<SshPtyTerminal> {
    validateDimensions(dimensions);
    if (this.terminals.size + this.pendingCreates >= SSH_PTY_MAX_TERMINALS) {
      throw new SshPtyError("PTY_LIMIT_REACHED");
    }
    this.pendingCreates += 1;
    try {
      return await this.createReserved(dimensions);
    } finally {
      this.pendingCreates -= 1;
    }
  }

  private async createReserved(dimensions: SshPtyDimensions): Promise<SshPtyTerminal> {
    // Key and known_hosts material stay on the host filesystem. They are read
    // only when an operator actually opens a terminal, never at config load.
    const [privateKey, knownHostsBuffer] = await Promise.all([
      readRequiredFile(this.keyPath, "PTY_KEY_UNREADABLE"),
      readRequiredFile(this.knownHostsPath, "PTY_KNOWN_HOSTS_UNREADABLE"),
    ]);
    if (privateKey.length === 0) throw new SshPtyError("PTY_KEY_INVALID");
    let policy: KnownHostPolicy;
    try {
      policy = parseKnownHosts(knownHostsBuffer.toString("utf8"), this.target);
    } catch (error) {
      if (error instanceof SshPtyError) throw error;
      throw new SshPtyError("PTY_KNOWN_HOSTS_INVALID");
    }

    const module = await this.ssh2Factory();
    const client = new module.Client();
    const id = `pty-${randomUUID()}`;
    const record: TerminalRecord = {
      id,
      client,
      state: "connecting",
      sequence: 0,
      chunks: [],
      snapshotLength: 0,
      truncated: false,
      listeners: new Set(),
      finalized: false,
    };
    this.terminals.set(id, record);

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          client.destroy();
          reject(new SshPtyError("PTY_CONNECTION_FAILED"));
        }, this.readyTimeoutMs);
        timer.unref?.();

        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          client.destroy();
          this.dropTerminal(record);
          reject(mapConnectError(error));
        };

        client.once("error", fail);
        client.once("ready", () => {
          client.shell(
            {
              term: "xterm-256color",
              cols: dimensions.cols,
              rows: dimensions.rows,
            },
            (error, channel) => {
              if (settled) return;
              if (error !== undefined && error !== null) {
                fail(error);
                return;
              }
              settled = true;
              clearTimeout(timer);
              record.channel = channel;
              record.state = "connected";
              this.attachChannel(record);
              this.emit(record, {
                type: "state",
                terminalId: record.id,
                sequence: record.sequence,
                state: "connected",
              });
              resolve();
            },
          );
        });
        client.connect({
          host: this.target.host,
          username: this.target.username,
          privateKey,
          hostHash: "sha256",
          hostVerifier: buildHostVerifier(policy),
          readyTimeout: this.readyTimeoutMs,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
        });
      });
    } catch (error) {
      this.dropTerminal(record);
      throw error;
    }

    return this.terminalView(record);
  }

  write(terminalId: string, data: Buffer): void {
    const record = this.requireTerminal(terminalId);
    if (record.state !== "connected" || record.channel === undefined) {
      throw new SshPtyError("PTY_NOT_CONNECTED");
    }
    if (data.length > 0) record.channel.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const record = this.requireTerminal(terminalId);
    validateDimensions({ cols, rows });
    if (record.state !== "connected" || record.channel === undefined) {
      throw new SshPtyError("PTY_NOT_CONNECTED");
    }
    record.channel.setWindow(rows, cols, 0, 0);
  }

  close(terminalId: string): void {
    const record = this.requireTerminal(terminalId);
    try {
      record.channel?.close();
    } catch {
      // The peer may already have closed the channel.
    }
    try {
      record.client.end();
    } catch {
      // The transport may already be gone.
    }
    this.finalize(record, "closed");
  }

  terminate(terminalId: string): void {
    const record = this.requireTerminal(terminalId);
    try {
      record.channel?.destroy();
    } catch {
      // The peer may already have closed the channel.
    }
    try {
      record.client.destroy();
    } catch {
      // The transport may already be gone.
    }
    this.finalize(record, "closed");
  }

  dispose(): void {
    for (const record of [...this.terminals.values()]) {
      try {
        try {
          record.channel?.destroy();
        } catch {
          // Continue to the client even if the channel teardown failed.
        }
        try {
          record.client.destroy();
        } catch {
          // The terminal still has to leave the registry.
        }
      } finally {
        this.finalize(record, "closed");
      }
    }
    this.terminals.clear();
  }

  private requireTerminal(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (record === undefined) throw new SshPtyError("PTY_UNKNOWN_TERMINAL");
    return record;
  }

  private attachChannel(record: TerminalRecord): void {
    const channel = record.channel;
    if (channel === undefined) return;
    const onData = (chunk: Buffer | Uint8Array) => this.appendOutput(record, Buffer.from(chunk));
    channel.stdout.on("data", onData);
    channel.stderr?.on("data", onData);
    channel.on("close", () => this.finalize(record, "closed"));
    channel.on("end", () => this.finalize(record, "closed"));
    record.client.once("close", () => this.finalize(record, "closed"));
    record.client.once("error", (error) => {
      const mapped = mapConnectError(error);
      this.emit(record, {
        type: "error",
        terminalId: record.id,
        sequence: record.sequence,
        code: mapped.code,
        message: mapped.message,
      });
      this.finalize(record, "error");
    });
  }

  private appendOutput(record: TerminalRecord, chunk: Buffer): void {
    if (record.finalized || record.state !== "connected" || chunk.length === 0) return;
    record.sequence += 1;
    record.chunks.push(Buffer.from(chunk));
    record.snapshotLength += chunk.length;
    while (record.snapshotLength > this.snapshotBytes && record.chunks.length > 0) {
      const first = record.chunks[0];
      if (first === undefined) break;
      const excess = record.snapshotLength - this.snapshotBytes;
      if (first.length <= excess) {
        record.chunks.shift();
        record.snapshotLength -= first.length;
      } else {
        record.chunks[0] = first.subarray(excess);
        record.snapshotLength -= excess;
      }
      record.truncated = true;
    }
    this.emit(record, {
      type: "output",
      terminalId: record.id,
      sequence: record.sequence,
      data: Buffer.from(chunk),
    });
  }

  private snapshot(record: TerminalRecord): SshPtySnapshot {
    return {
      sequence: record.sequence,
      data: Buffer.concat(record.chunks, record.snapshotLength),
      truncated: record.truncated,
      state: record.state,
    };
  }

  private terminalView(record: TerminalRecord): SshPtyTerminal {
    return {
      id: record.id,
      get state() {
        return record.state;
      },
      get sequence() {
        return record.sequence;
      },
      snapshot: () => this.snapshot(record),
      subscribe: (listener) => {
        record.listeners.add(listener);
        return () => record.listeners.delete(listener);
      },
      write: (data) => this.write(record.id, data),
      resize: (cols, rows) => this.resize(record.id, cols, rows),
      close: () => this.close(record.id),
      terminate: () => this.terminate(record.id),
    };
  }

  private emit(record: TerminalRecord, event: SshPtyEvent): void {
    for (const listener of [...record.listeners]) {
      try {
        listener(event);
      } catch {
        // A failed browser writer must not break the SSH stream.
      }
    }
  }

  private finalize(record: TerminalRecord, state: "closed" | "error"): void {
    if (record.finalized) return;
    record.finalized = true;
    record.state = state;
    this.terminals.delete(record.id);
    this.emit(record, {
      type: "state",
      terminalId: record.id,
      sequence: record.sequence,
      state,
    });
    record.listeners.clear();
  }

  private dropTerminal(record: TerminalRecord): void {
    record.finalized = true;
    record.state = "closed";
    this.terminals.delete(record.id);
    record.listeners.clear();
  }
}
