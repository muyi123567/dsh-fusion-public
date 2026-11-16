import { fusionBrowserUrl } from "../../routes.js";

const PTY_CREATE_PATH = "/plugins/dsh-fusion/pty/create";
const PTY_CLOSE_PATH = "/plugins/dsh-fusion/pty/close";
const PTY_WS_PATH = "/plugins/dsh-fusion/pty/ws";
const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;
const MAX_RAW_INPUT_BYTES = 46 * 1024;
const MAX_SERVER_DATA_BYTES = 128 * 1024;
const MAX_RECONNECT_ATTEMPTS = 8;
const TERMINAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface PtyCreated {
  terminalId: string;
  terminalToken: string;
  nodeId: string;
  cols: number;
  rows: number;
  state: "connecting" | "connected" | "closed" | "error";
  snapshot: {
    sequence: number;
    data: string;
    truncated: boolean;
  };
}

export class PtyApiError extends Error {
  readonly name = "PtyApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    readonly userMessage: string,
  ) {
    super(userMessage);
  }
}

type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

function encodedJsonBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function encodeBase64(data: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string, allowEmpty = false): Uint8Array {
  if (
    typeof value !== "string"
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
    || (!allowEmpty && value.length === 0)
  ) {
    throw new Error("PTY_BASE64_INVALID");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("PTY_BASE64_INVALID");
  }
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64(decoded) !== value) throw new Error("PTY_BASE64_INVALID");
  return decoded;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function userMessageForError(status: number, code: string): string {
  switch (code) {
    case "REMOTE_PTY_DISABLED":
      return "服务端未启用远程终端（FUSION_ALLOW_REMOTE_PTY）。";
    case "UNKNOWN_PTY_NODE":
      return "该节点不支持远程终端，仅配置的华为云节点可用。";
    case "REMOTE_PTY_NOT_CONFIGURED":
      return "远程终端缺少 Huawei SSH 配置，请检查主机、密钥与 known_hosts。";
    case "AUTHENTICATION_REQUIRED":
    case "TRUSTED_ORIGIN_REQUIRED":
      return "当前 DSH 会话无权建立远程终端，请重新登录后再试。";
    case "PTY_LIMIT_REACHED":
      return "远程终端已达到 4 个活动会话上限，请先关闭一个终端。";
    case "PTY_CREATE_INVALID":
      return "终端尺寸或节点参数无效。";
    case "PTY_CAPABILITY_INVALID":
      return "终端访问凭据无效，请关闭后重新创建。";
    case "PTY_UNKNOWN_TERMINAL":
      return "远程终端已不存在或已过期。";
    default:
      if (status === 401) return "当前 DSH 会话未通过认证，请重新登录。";
      if (status === 403) return "当前请求被拒绝，无法访问远程终端。";
      if (status === 404) return "远程终端或接口不存在。";
      return `远程终端请求失败（HTTP ${status}${code === "" ? "" : ` · ${code}`}）。`;
  }
}

async function readError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => ({})) as { error?: unknown };
  return typeof payload.error === "string" ? payload.error : "";
}

export async function createRemotePty(
  input: { nodeId: string; cols: number; rows: number },
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<PtyCreated> {
  const response = await fetchImpl(fusionBrowserUrl(PTY_CREATE_PATH), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const code = await readError(response);
    throw new PtyApiError(response.status, code, userMessageForError(response.status, code));
  }
  const created = await response.json() as PtyCreated;
  if (
    typeof created.terminalId !== "string"
    || !/^pty-[A-Za-z0-9-]{1,128}$/.test(created.terminalId)
    || typeof created.terminalToken !== "string"
    || !TERMINAL_TOKEN_PATTERN.test(created.terminalToken)
    || created.nodeId !== input.nodeId
    || !Number.isInteger(created.cols)
    || !Number.isInteger(created.rows)
  ) {
    throw new PtyApiError(502, "PTY_CREATE_RESPONSE_INVALID", "远程终端返回了无效的会话信息。");
  }
  return created;
}

export async function closeRemotePty(
  terminalId: string,
  terminalToken: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<void> {
  const response = await fetchImpl(fusionBrowserUrl(PTY_CLOSE_PATH), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminalId, terminalToken }),
  });
  if (!response.ok) {
    const code = await readError(response);
    throw new PtyApiError(response.status, code, userMessageForError(response.status, code));
  }
}

export function ptyWebSocketUrl(
  locationLike: Pick<Location, "protocol" | "host"> = window.location,
): string {
  const documentBase = typeof document === "undefined"
    ? `${locationLike.protocol}//${locationLike.host}/`
    : document.baseURI;
  const url = new URL(fusionBrowserUrl(PTY_WS_PATH), documentBase);
  // The document contributes the deployment prefix; the supplied location
  // remains authoritative for the connection's origin and scheme.
  url.protocol = locationLike.protocol === "https:" ? "wss:" : "ws:";
  url.host = locationLike.host;
  return url.href;
}

export type PtyRemoteState = "connecting" | "connected" | "reconnecting" | "closed" | "error";

export interface PtySocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface RemotePtyCallbacks {
  onState?: (state: PtyRemoteState) => void;
  onSnapshot?: (snapshot: {
    sequence: number;
    data: Uint8Array;
    truncated: boolean;
  }) => void;
  onOutput?: (data: Uint8Array, sequence: number) => void;
  onError?: (code: string, message: string) => void;
  onOpen?: () => void;
}

export interface RemotePtyOptions extends RemotePtyCallbacks {
  socketFactory?: (url: string) => PtySocketLike;
}

export type PtyServerMessage =
  | {
    type: "snapshot" | "output";
    terminalId: string;
    sequence: number;
    data: Uint8Array;
    offset: number;
    total: number;
    final: boolean;
    truncated: boolean;
  }
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

export function parsePtyServerMessage(
  raw: string,
  expectedTerminalId?: string,
): PtyServerMessage {
  if (encodedJsonBytes(raw) > MAX_CLIENT_MESSAGE_BYTES) {
    throw new Error("PTY_SERVER_MESSAGE_TOO_LARGE");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("PTY_SERVER_MESSAGE_INVALID");
  }
  if (
    !isRecord(value)
    || typeof value.terminalId !== "string"
    || (expectedTerminalId !== undefined && value.terminalId !== expectedTerminalId)
    || !isIntegerInRange(value.sequence, 0, Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("PTY_SERVER_MESSAGE_INVALID");
  }
  if (value.type === "state") {
    if (!["connecting", "connected", "closed", "error"].includes(String(value.state))) {
      throw new Error("PTY_SERVER_MESSAGE_INVALID");
    }
    return {
      type: "state",
      terminalId: value.terminalId,
      sequence: value.sequence,
      state: value.state as "connecting" | "connected" | "closed" | "error",
    };
  }
  if (value.type === "error") {
    if (
      typeof value.code !== "string"
      || value.code.length === 0
      || value.code.length > 128
      || typeof value.message !== "string"
      || value.message.length > 512
      || /[\r\n]/.test(value.code + value.message)
    ) {
      throw new Error("PTY_SERVER_MESSAGE_INVALID");
    }
    return {
      type: "error",
      terminalId: value.terminalId,
      sequence: value.sequence,
      code: value.code,
      message: value.message,
    };
  }
  if (value.type !== "snapshot" && value.type !== "output") {
    throw new Error("PTY_SERVER_MESSAGE_INVALID");
  }
  if (
    !isIntegerInRange(value.offset, 0, MAX_SERVER_DATA_BYTES)
    || !isIntegerInRange(value.total, 0, MAX_SERVER_DATA_BYTES)
    || typeof value.final !== "boolean"
  ) {
    throw new Error("PTY_SERVER_MESSAGE_INVALID");
  }
  const data = decodeBase64(String(value.data ?? ""), true);
  if (
    data.length > MAX_RAW_INPUT_BYTES
    || value.offset + data.length > value.total
    || (value.final && value.offset + data.length !== value.total)
  ) {
    throw new Error("PTY_SERVER_MESSAGE_INVALID");
  }
  if (value.type === "snapshot" && typeof value.truncated !== "boolean") {
    throw new Error("PTY_SERVER_MESSAGE_INVALID");
  }
  return {
    type: value.type,
    terminalId: value.terminalId,
    sequence: value.sequence,
    data,
    offset: value.offset,
    total: value.total,
    final: value.final,
    truncated: value.truncated === true,
  };
}

export class RemotePtySocket {
  private readonly terminalId: string;
  private readonly terminalToken: string;
  private readonly options: RemotePtyOptions;
  private socket: PtySocketLike | undefined = undefined;
  private state: PtyRemoteState = "closed";
  private intentionalClose = false;
  private fatal = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  private snapshotSequence = 0;
  private snapshotOffset = 0;
  private snapshotTotal = 0;
  private snapshotTruncated = false;
  private snapshotChunks: Uint8Array[] = [];
  private outputSequence = 0;
  private outputOffset = 0;
  private outputTotal = 0;
  private outputChunks: Uint8Array[] = [];

  constructor(
    terminalId: string,
    terminalToken: string,
    options: RemotePtyOptions = {},
  ) {
    this.terminalId = terminalId;
    this.terminalToken = terminalToken;
    this.options = options;
  }

  connect(): void {
    this.intentionalClose = false;
    this.fatal = false;
    this.openSocket("connecting");
  }

  reconnect(): void {
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.intentionalClose = false;
    this.fatal = false;
    this.socket?.close(1000, "PTY_CLIENT_RECONNECT");
    this.openSocket("reconnecting");
  }

  sendInput(data: Uint8Array): void {
    if (data.length === 0 || data.length > MAX_RAW_INPUT_BYTES) {
      throw new Error("PTY_INPUT_INVALID");
    }
    this.send({ type: "input", data: encodeBase64(data) });
  }

  sendResize(cols: number, rows: number): void {
    if (
      !Number.isInteger(cols)
      || cols < 1
      || cols > 500
      || !Number.isInteger(rows)
      || rows < 1
      || rows > 200
    ) {
      throw new Error("PTY_RESIZE_INVALID");
    }
    this.send({ type: "resize", cols, rows });
  }

  sendClose(): void {
    this.intentionalClose = true;
    try {
      this.send({ type: "close", terminalToken: this.terminalToken });
    } finally {
      this.socket?.close(1000, "PTY_CLIENT_CLOSED");
      this.setState("closed");
    }
  }

  dispose(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.socket?.close(1000, "PTY_CLIENT_DISPOSED");
    this.socket = undefined;
    this.setState("closed");
  }

  private openSocket(nextState: PtyRemoteState): void {
    this.clearReconnectTimer();
    this.setState(nextState);
    const factory = this.options.socketFactory
      ?? ((url: string) => new WebSocket(url) as PtySocketLike);
    let socket: PtySocketLike;
    try {
      socket = factory(ptyWebSocketUrl());
    } catch (error) {
      this.options.onError?.(
        "PTY_WEBSOCKET_CONNECT_FAILED",
        error instanceof Error ? error.message : String(error),
      );
      this.setState("error");
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      try {
        this.send({
          type: "auth",
          terminalId: this.terminalId,
          terminalToken: this.terminalToken,
        });
      } catch {
        this.protocolFailure();
        return;
      }
      this.setState("connected");
      this.options.onOpen?.();
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || !isRecord(event) || typeof event.data !== "string") {
        this.protocolFailure();
        return;
      }
      try {
        this.handleMessage(parsePtyServerMessage(event.data, this.terminalId));
      } catch {
        this.protocolFailure();
      }
    });
    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.options.onError?.("PTY_WEBSOCKET_ERROR", "远程终端 WebSocket 连接异常。");
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.intentionalClose || this.fatal) {
        this.setState(this.fatal ? "error" : "closed");
        return;
      }
      const closeCode = isRecord(event) && typeof event.code === "number"
        ? event.code
        : 1006;
      const closeReason = isRecord(event) && typeof event.reason === "string"
        ? event.reason
        : "";
      if (closeCode === 1008 && closeReason.includes("PTY_AUTH")) {
        this.fatal = true;
        this.options.onError?.("AUTHENTICATION_REQUIRED", "远程终端认证帧无效或超时。");
        this.setState("error");
        return;
      }
      if (closeCode === 4401 || closeCode === 4403 || closeCode === 4404) {
        this.fatal = true;
        const code = closeCode === 4401
          ? "AUTHENTICATION_REQUIRED"
          : closeCode === 4403
            ? "PTY_CAPABILITY_INVALID"
            : "PTY_UNKNOWN_TERMINAL";
        this.options.onError?.(code, userMessageForError(closeCode === 4401 ? 401 : closeCode === 4403 ? 403 : 404, code));
        this.setState("error");
        return;
      }
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        this.fatal = true;
        this.options.onError?.("PTY_RECONNECT_EXHAUSTED", "远程终端重连次数已用尽。");
        this.setState("error");
        return;
      }
      this.setState("reconnecting");
      const delay = Math.min(500 * (2 ** this.reconnectAttempts), 8_000);
      this.reconnectAttempts += 1;
      this.reconnectTimer = setTimeout(() => this.openSocket("reconnecting"), delay);
    });
  }

  private handleMessage(message: PtyServerMessage): void {
    if (message.type === "state") {
      if (message.state === "closed") {
        this.intentionalClose = true;
        this.setState("closed");
      } else if (message.state === "error") {
        this.fatal = true;
        this.setState("error");
      } else {
        this.setState(message.state === "connected" ? "connected" : "connecting");
        if (message.state === "connected") this.reconnectAttempts = 0;
      }
      return;
    }
    if (message.type === "error") {
      this.fatal = true;
      this.options.onError?.(message.code, message.message);
      this.setState("error");
      return;
    }
    if (message.type === "output") {
      if (message.offset === 0) {
        this.outputSequence = message.sequence;
        this.outputOffset = 0;
        this.outputTotal = message.total;
        this.outputChunks = [];
      }
      if (
        message.sequence !== this.outputSequence
        || message.offset !== this.outputOffset
        || message.total !== this.outputTotal
      ) {
        this.options.onError?.("PTY_OUTPUT_CHUNK_INVALID", "远程终端输出分片无效。");
        return;
      }
      this.outputChunks.push(message.data);
      this.outputOffset += message.data.length;
      if (message.final) {
        if (this.outputOffset !== this.outputTotal) {
          this.options.onError?.("PTY_OUTPUT_CHUNK_INVALID", "远程终端输出不完整。");
          return;
        }
        const data = new Uint8Array(this.outputOffset);
        let offset = 0;
        for (const chunk of this.outputChunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        this.options.onOutput?.(data, this.outputSequence);
        this.outputChunks = [];
      }
      return;
    }
    if (message.offset === 0) {
      this.snapshotSequence = message.sequence;
      this.snapshotOffset = 0;
      this.snapshotTotal = message.total;
      this.snapshotTruncated = message.truncated;
      this.snapshotChunks = [];
    }
    if (
      message.sequence !== this.snapshotSequence
      || message.offset !== this.snapshotOffset
      || message.total !== this.snapshotTotal
    ) {
      this.options.onError?.("PTY_SNAPSHOT_CHUNK_INVALID", "远程终端快照分片顺序无效。");
      return;
    }
    this.snapshotChunks.push(message.data);
    this.snapshotOffset += message.data.length;
    if (message.final) {
      if (this.snapshotOffset !== this.snapshotTotal) {
        this.options.onError?.("PTY_SNAPSHOT_CHUNK_INVALID", "远程终端快照不完整。");
        return;
      }
      const data = new Uint8Array(this.snapshotOffset);
      let offset = 0;
      for (const chunk of this.snapshotChunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      this.options.onSnapshot?.({
        sequence: this.snapshotSequence,
        data,
        truncated: this.snapshotTruncated,
      });
      this.snapshotChunks = [];
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState !== 1) throw new Error("PTY_SOCKET_NOT_OPEN");
    const encoded = JSON.stringify(message);
    if (encodedJsonBytes(encoded) > MAX_CLIENT_MESSAGE_BYTES) {
      throw new Error("PTY_CLIENT_MESSAGE_TOO_LARGE");
    }
    this.socket.send(encoded);
  }

  private protocolFailure(): void {
    this.fatal = true;
    this.options.onError?.("PTY_PROTOCOL_INVALID", "远程终端返回了无效协议消息。");
    this.setState("error");
    this.socket?.close(1008, "PTY_PROTOCOL_INVALID");
  }

  private setState(state: PtyRemoteState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onState?.(state);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
