import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  formatFleetNotification,
  type FleetNotificationEvent,
  type FleetNotificationType,
} from "./fleet-notifications.js";

export interface FleetNotificationAdapterDefinition {
  kind: string;
  displayName: string;
  category: string;
  description: string;
  receipt: boolean;
  fields: Array<{
    key: string;
    label: string;
    required?: boolean;
    secret?: boolean;
    env?: boolean;
    placeholder?: string;
  }>;
}

export interface FleetNotificationAdapterConfig {
  id: string;
  kind: string;
  enabled?: boolean;
  label?: string;
  events?: FleetNotificationType[];
  url?: string;
  urlEnv?: string;
  secret?: string;
  secretEnv?: string;
  tokenEnv?: string;
  chatId?: string;
  botId?: string;
  targetId?: string;
  format?: "plain" | "markdown";
  apiBase?: string;
  timeoutMs?: number;
}

export interface FleetDeliveryReceipt {
  adapterId: string;
  kind: string;
  eventType: FleetNotificationType;
  status: "delivered" | "failed" | "unknown" | "skipped";
  at: string;
  durationMs: number;
  httpStatus?: number;
  errorCode?: string;
  receipt?: {
    version: number;
    messageId?: string;
    conversationId?: string;
  };
}

export interface FleetNotificationAdapterStatus {
  id: string;
  kind: string;
  label: string;
  enabled: boolean;
  state: "configured" | "invalid" | "disabled";
  events: FleetNotificationType[];
  capabilities: { receipt: boolean };
  errorCode?: string;
}

type DshImSend = (
  botId: string,
  targetId: string,
  text: string,
  options?: Record<string, unknown>,
) => Promise<unknown>;

export interface DshImNotifier {
  sendChecked?: DshImSend | undefined;
  send?: DshImSend | undefined;
}

export interface FleetNotificationFactoryContext {
  config: FleetNotificationAdapterConfig;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  now: () => number;
  dshIm?: DshImNotifier;
}

export interface FleetNotificationAdapter {
  deliver(event: FleetNotificationEvent, text: string): Promise<{
    status: "delivered" | "unknown";
    httpStatus?: number;
    receipt?: FleetDeliveryReceipt["receipt"];
  }>;
}

export type FleetNotificationFactory = (context: FleetNotificationFactoryContext) => FleetNotificationAdapter;

export interface WhaleNotificationServiceV1 {
  readonly contractVersion: 1;
  catalog(): FleetNotificationAdapterDefinition[];
  adapters(): FleetNotificationAdapterStatus[];
  deliver(event: FleetNotificationEvent): Promise<FleetDeliveryReceipt[]>;
  test(adapterId?: string): Promise<FleetDeliveryReceipt[]>;
  receipts(): FleetDeliveryReceipt[];
  register(definition: FleetNotificationAdapterDefinition, factory: FleetNotificationFactory): () => void;
}

export class NotificationAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: "failed" | "unknown" = "failed",
  ) {
    super(message);
    this.name = "NotificationAdapterError";
  }
}

const KIND = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?$/u;
const INSTANCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const EVENTS: FleetNotificationType[] = ["created", "approved", "rejected", "failed", "test"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MAX_RECEIPTS = 100;

const DEFINITIONS: FleetNotificationAdapterDefinition[] = [
  {
    kind: "dsh-im",
    displayName: "dsh-im",
    category: "im",
    description: "通过已安装的 dsh-im 发送；支持 sendChecked 回执。",
    receipt: true,
    fields: [
      { key: "botId", label: "Bot ID", required: true },
      { key: "targetId", label: "目标会话", required: true },
      { key: "format", label: "格式", placeholder: "plain / markdown" },
    ],
  },
  {
    kind: "webhook",
    displayName: "通用 Webhook",
    category: "webhook",
    description: "POST 事件 JSON，可用 HMAC 签名。",
    receipt: false,
    fields: [
      { key: "url", label: "回调地址", required: true },
      { key: "secretEnv", label: "签名密钥环境变量", env: true, secret: true },
    ],
  },
  {
    kind: "slack",
    displayName: "Slack",
    category: "im",
    description: "Slack Incoming Webhook，发送 text 消息。",
    receipt: false,
    fields: [{ key: "urlEnv", label: "Webhook URL 环境变量", env: true, secret: true, required: true }],
  },
  {
    kind: "feishu",
    displayName: "飞书 / Lark",
    category: "im",
    description: "飞书自定义机器人，发送文本消息。",
    receipt: false,
    fields: [{ key: "urlEnv", label: "Webhook URL 环境变量", env: true, secret: true, required: true }],
  },
  {
    kind: "dingtalk",
    displayName: "钉钉",
    category: "im",
    description: "钉钉自定义机器人，支持加签。",
    receipt: false,
    fields: [
      { key: "urlEnv", label: "Webhook URL 环境变量", env: true, secret: true, required: true },
      { key: "secretEnv", label: "加签密钥环境变量", env: true, secret: true },
    ],
  },
  {
    kind: "telegram",
    displayName: "Telegram",
    category: "im",
    description: "Telegram Bot API sendMessage。",
    receipt: false,
    fields: [
      { key: "tokenEnv", label: "Bot Token 环境变量", env: true, secret: true, required: true },
      { key: "chatId", label: "Chat ID", required: true },
    ],
  },
  {
    kind: "discord",
    displayName: "Discord",
    category: "im",
    description: "Discord Incoming Webhook，发送 content 消息。",
    receipt: false,
    fields: [{ key: "urlEnv", label: "Webhook URL 环境变量", env: true, secret: true, required: true }],
  },
];

interface Registered {
  definition: FleetNotificationAdapterDefinition;
  factory: FleetNotificationFactory;
  builtin: boolean;
}

export class FleetNotificationRegistry {
  private readonly entries = new Map<string, Registered>();

  register(
    definition: FleetNotificationAdapterDefinition,
    factory: FleetNotificationFactory,
    options: { replace?: boolean; builtin?: boolean } = {},
  ): () => void {
    if (!KIND.test(definition.kind)) throw new NotificationAdapterError("notification/kind-invalid", "适配器 kind 不合法");
    const existing = this.entries.get(definition.kind);
    if (existing?.builtin === true && options.builtin !== true) {
      throw new NotificationAdapterError("notification/kind-reserved", "不能覆盖内置适配器");
    }
    if (!definition.kind.includes("/") && options.builtin !== true) {
      throw new NotificationAdapterError("notification/kind-namespace", "第三方适配器 kind 必须带命名空间");
    }
    if (existing !== undefined && options.replace !== true) {
      throw new NotificationAdapterError("notification/kind-exists", "适配器 kind 已存在");
    }
    this.entries.set(definition.kind, {
      definition: structuredClone(definition),
      factory,
      builtin: options.builtin === true,
    });
    return () => {
      if (this.entries.get(definition.kind)?.factory === factory) this.entries.delete(definition.kind);
    };
  }

  catalog(): FleetNotificationAdapterDefinition[] {
    return [...this.entries.values()]
      .map(entry => structuredClone(entry.definition))
      .sort((left, right) => left.kind.localeCompare(right.kind));
  }

  definition(kind: string): FleetNotificationAdapterDefinition | undefined {
    const definition = this.entries.get(kind)?.definition;
    return definition === undefined ? undefined : structuredClone(definition);
  }

  create(config: FleetNotificationAdapterConfig, context: Omit<FleetNotificationFactoryContext, "config">): FleetNotificationAdapter {
    const entry = this.entries.get(config.kind);
    if (entry === undefined) throw new NotificationAdapterError("notification/unknown-kind", "未知适配器类型");
    return entry.factory({ ...context, config });
  }
}

export function registerBuiltinNotificationAdapters(registry: FleetNotificationRegistry): void {
  for (const definition of DEFINITIONS) {
    const factory = FACTORIES[definition.kind];
    if (factory !== undefined) registry.register(definition, factory, { builtin: true });
  }
}

const FACTORIES: Record<string, FleetNotificationFactory> = {
  "dsh-im": createDshImAdapter,
  webhook: createWebhookAdapter,
  slack: createSlackAdapter,
  feishu: createFeishuAdapter,
  dingtalk: createDingTalkAdapter,
  telegram: createTelegramAdapter,
  discord: createDiscordAdapter,
};

export interface FleetNotificationServiceOptions {
  adapters: FleetNotificationAdapterConfig[];
  dshIm?: DshImNotifier;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
  directory?: string;
  limit?: number;
}

interface Instance {
  config: FleetNotificationAdapterConfig;
  status: FleetNotificationAdapterStatus;
  adapter?: FleetNotificationAdapter;
}

export function createFleetNotificationService(options: FleetNotificationServiceOptions): WhaleNotificationServiceV1 {
  const registry = new FleetNotificationRegistry();
  registerBuiltinNotificationAdapters(registry);
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const limit = Math.min(Math.max(options.limit ?? MAX_RECEIPTS, 1), MAX_RECEIPTS);
  const receiptsPath = options.directory;
  let history = loadReceipts(receiptsPath);
  const instances = new Map<string, Instance>();

  for (const config of options.adapters) {
    if (!INSTANCE_ID.test(config.id)) {
      throw new NotificationAdapterError("notification/config", `适配器实例 id 不合法：${config.id}`);
    }
    if (instances.has(config.id)) {
      throw new NotificationAdapterError("notification/config", `适配器实例 id 重复：${config.id}`);
    }
    const definition = registry.definition(config.kind);
    const events = normalizeEvents(config.events);
    const enabled = config.enabled !== false;
    const base: FleetNotificationAdapterStatus = {
      id: config.id,
      kind: config.kind,
      label: config.label ?? config.id,
      enabled,
      state: enabled ? "configured" : "disabled",
      events,
      capabilities: { receipt: definition?.receipt === true },
      ...(definition === undefined ? { state: "invalid" as const, errorCode: "notification/unknown-kind" } : {}),
    };
    if (!enabled || definition === undefined) {
      instances.set(config.id, { config, status: base });
      continue;
    }
    try {
      const adapter = registry.create(config, {
        env, fetch: fetchImpl, now,
        ...(options.dshIm === undefined ? {} : { dshIm: options.dshIm }),
      });
      instances.set(config.id, { config, status: base, adapter });
    } catch (error) {
      instances.set(config.id, {
        config,
        status: { ...base, state: "invalid", errorCode: errorCodeOf(error) },
      });
    }
  }

  const save = (): void => {
    history = history.slice(-limit);
    if (receiptsPath === undefined) return;
    try {
      mkdirSync(dirname(receiptsPath), { recursive: true, mode: 0o700 });
      const temporary = `${receiptsPath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ version: 1, receipts: history }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, receiptsPath);
    } catch {
      // Persistence is best effort; delivery must not fail because the disk is full.
    }
  };

  const deliverOne = async (
    instance: Instance,
    event: FleetNotificationEvent,
    text: string,
  ): Promise<FleetDeliveryReceipt> => {
    const started = now();
    const at = new Date(started).toISOString();
    const base = {
      adapterId: instance.config.id,
      kind: instance.config.kind,
      eventType: event.type,
      at,
    };
    if (!instance.status.enabled) return { ...base, status: "skipped", durationMs: 0 };
    if (!instance.status.events.includes(event.type)) return { ...base, status: "skipped", durationMs: 0 };
    if (instance.status.state === "invalid" || instance.adapter === undefined) {
      return {
        ...base,
        status: "failed",
        durationMs: 0,
        errorCode: instance.status.errorCode ?? "notification/config",
      };
    }
    try {
      const result = await instance.adapter.deliver(event, text);
      return {
        ...base,
        status: result.status,
        durationMs: Math.max(0, now() - started),
        ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
        ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
      };
    } catch (error) {
      const adapterError = normalizeError(error);
      return {
        ...base,
        status: adapterError.outcome,
        durationMs: Math.max(0, now() - started),
        errorCode: adapterError.code,
      };
    }
  };

  const run = async (event: FleetNotificationEvent, only?: string): Promise<FleetDeliveryReceipt[]> => {
    const text = formatFleetNotification(event);
    const selected = [...instances.values()].filter(instance => only === undefined || instance.config.id === only);
    if (only !== undefined && selected.length === 0) {
      throw new NotificationAdapterError("notification/unknown", "未知适配器实例");
    }
    const receipts = await Promise.all(selected.map(instance => deliverOne(instance, event, text)));
    history.push(...receipts);
    save();
    return receipts;
  };

  return {
    contractVersion: 1,
    catalog: () => registry.catalog(),
    adapters: () => [...instances.values()].map(instance => ({ ...instance.status, events: [...instance.status.events] })),
    deliver: async event => await run(event),
    test: async adapterId => await run({
      type: "test",
      requestId: "test",
      taskId: "connector-test",
      jobId: "connector-test",
      nodeId: "local",
      requestedBy: "鲸群",
      status: "test",
    }, adapterId),
    receipts: () => history.map(receipt => structuredClone(receipt)),
    register: (definition, factory) => registry.register(definition, factory),
  };
}

function normalizeEvents(events: FleetNotificationType[] | undefined): FleetNotificationType[] {
  if (events === undefined) return [...EVENTS];
  const selected = [...new Set(events)].filter(event => EVENTS.includes(event));
  if (selected.length === 0) throw new NotificationAdapterError("notification/config", "events 不能为空");
  return selected;
}

function createDshImAdapter(context: FleetNotificationFactoryContext): FleetNotificationAdapter {
  const botId = requiredString(context.config.botId, "botId");
  const targetId = requiredString(context.config.targetId, "targetId");
  const format = context.config.format ?? "plain";
  if (format !== "plain" && format !== "markdown") {
    throw new NotificationAdapterError("notification/config", "format 必须是 plain 或 markdown");
  }
  const sender = context.dshIm;
  return {
    async deliver(_event, text) {
      if (sender === undefined || (sender.sendChecked === undefined && sender.send === undefined)) {
        throw new NotificationAdapterError("notification/unavailable", "dsh-im 未安装或未提供发送服务");
      }
      try {
        const result = sender.sendChecked === undefined
          ? await sender.send!(botId, targetId, text, { format })
          : await sender.sendChecked(botId, targetId, text, { format, receipt: true });
        const parsed = asRecord(result);
        if (parsed === undefined || parsed.sent !== true) {
          throw new NotificationAdapterError("notification/dsh-im-rejected", "dsh-im 未确认发送");
        }
        const receipt = asRecord(parsed.receipt);
        return {
          status: "delivered",
          ...(receipt === undefined ? {} : {
            receipt: {
              version: typeof receipt.version === "number" ? receipt.version : 1,
              ...(typeof receipt.messageId === "string" ? { messageId: receipt.messageId } : {}),
              ...(typeof receipt.conversationId === "string" ? { conversationId: receipt.conversationId } : {}),
            },
          }),
        };
      } catch (error) {
        if (error instanceof NotificationAdapterError) throw error;
        const code = typeof (error as { code?: unknown } | undefined)?.code === "string"
          ? (error as { code: string }).code
          : "notification/dsh-im-failed";
        if (code === "send-result-unknown") {
          throw new NotificationAdapterError("send-result-unknown", "dsh-im 发送结果未知", "unknown");
        }
        throw new NotificationAdapterError(code.startsWith("notification/") ? code : `notification/${code}`, "dsh-im 发送失败");
      }
    },
  };
}

function createWebhookAdapter(context: FleetNotificationFactoryContext): FleetNotificationAdapter {
  const url = resolveUrl(context, true);
  const secret = resolveSecret(context, "secretEnv", "secret");
  const timeoutMs = timeoutOf(context.config);
  return {
    async deliver(event, text) {
      const body = JSON.stringify({ source: "dsh-fusion", version: 1, event, text });
      const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "dsh-fusion-webhook/1" };
      if (secret !== undefined) {
        headers["x-dsh-fusion-signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      }
      const status = await post(context.fetch, url, body, headers, timeoutMs);
      return { status: "delivered", httpStatus: status };
    },
  };
}

function createSlackAdapter(context: FleetNotificationFactoryContext): FleetNotificationAdapter {
  const url = resolveUrl(context, true);
  const timeoutMs = timeoutOf(context.config);
  return {
    async deliver(_event, text) {
      const status = await post(context.fetch, url, JSON.stringify({ text: clip(text, 3_000) }),
        { "content-type": "application/json" }, timeoutMs);
      return { status: "delivered", httpStatus: status };
    },
  };
}

function createFeishuAdapter(context: FleetNotificationFactoryContext): FleetNotificationAdapter {
  const url = resolveUrl(context, true);
  const timeoutMs = timeoutOf(context.config);
  return {
    async deliver(_event, text) {
      const status = await post(context.fetch, url, JSON.stringify({
        msg_type: "text",
        content: { text: clip(text, 3_000) },
      }), { "content-type": "application/json" }, timeoutMs);
      return { status: "delivered", httpStatus: status };
    },
  };
}

function createDingTalkAdapter(context: FleetNotificationFactoryContext): FleetNotificationAdapter {
  const configured = resolveUrl(context, true);
  const secret = resolveSecret(context, "secretEnv", "secret");
  const timeoutMs = timeoutOf(context.config);
  return {
    async deliver(_event, text) {
      const url = new URL(configured);
      if (secret !== undefined) {
        const timestamp = String(context.now());
        const sign = createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
        url.searchParams.set("timestamp", timestamp);
        url.searchParams.set("sign", sign);
      }
      const status = await post(context.fetch, url, JSON.stringify({
        msgtype: "text",
        text: { content: clip(text, 3_000) },
      }), { "content-type": "application/json" }, timeoutMs);
      return { status: "delivered", httpStatus: status };
    },
  };
}

function createTelegramAdapter(context: FleetNotificationFactoryContext): FleetNotificationAdapter {
  const token = requiredSecret(context.env, context.config.tokenEnv, "tokenEnv");
  const chatId = requiredString(context.config.chatId, "chatId");
  const base = safeUrl(context.config.apiBase ?? "https://api.telegram.org");
  const timeoutMs = timeoutOf(context.config);
  return {
    async deliver(_event, text) {
      const url = new URL(`/bot${token}/sendMessage`, base);
      const status = await post(context.fetch, url, JSON.stringify({
        chat_id: chatId,
        text: clip(text, 4_000),
        disable_web_page_preview: true,
      }), { "content-type": "application/json" }, timeoutMs);
      return { status: "delivered", httpStatus: status };
    },
  };
}

function createDiscordAdapter(context: FleetNotificationFactoryContext): FleetNotificationAdapter {
  const url = resolveUrl(context, true);
  const timeoutMs = timeoutOf(context.config);
  return {
    async deliver(_event, text) {
      const status = await post(context.fetch, url, JSON.stringify({ content: clip(text, 1_900) }),
        { "content-type": "application/json" }, timeoutMs);
      return { status: "delivered", httpStatus: status };
    },
  };
}

function resolveUrl(context: FleetNotificationFactoryContext, required: boolean): URL {
  const fromEnv = context.config.urlEnv === undefined
    ? undefined
    : context.env[requiredEnvName(context.config.urlEnv, "urlEnv")];
  const value = fromEnv ?? context.config.url;
  if (value === undefined || value.trim() === "") {
    if (required) throw new NotificationAdapterError("notification/config", "缺少 URL");
    throw new NotificationAdapterError("notification/config", "URL 为空");
  }
  return safeUrl(value);
}

function resolveSecret(
  context: FleetNotificationFactoryContext,
  envKey: "secretEnv",
  literalKey: "secret",
): string | undefined {
  const name = context.config[envKey];
  if (name !== undefined) {
    const value = context.env[requiredEnvName(name, envKey)];
    if (value === undefined || value.trim() === "") {
      throw new NotificationAdapterError("notification/auth", `${envKey} 指向的密钥缺失`);
    }
    return value;
  }
  const value = context.config[literalKey];
  return value === undefined || value.trim() === "" ? undefined : value;
}

function requiredSecret(
  env: Record<string, string | undefined>,
  envName: string | undefined,
  field: string,
): string {
  if (envName === undefined) throw new NotificationAdapterError("notification/config", `缺少 ${field}`);
  const value = env[requiredEnvName(envName, field)];
  if (value === undefined || value.trim() === "") {
    throw new NotificationAdapterError("notification/auth", `${field} 指向的凭据缺失`);
  }
  return value;
}

function requiredEnvName(value: string, field: string): string {
  if (!ENV_NAME.test(value)) throw new NotificationAdapterError("notification/config", `${field} 必须是环境变量名`);
  return value;
}

function requiredString(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === "") {
    throw new NotificationAdapterError("notification/config", `缺少 ${field}`);
  }
  return value;
}

function safeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NotificationAdapterError("notification/config", "URL 不合法");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new NotificationAdapterError("notification/config", "URL 必须使用 HTTPS（本机回环除外）");
  }
  if (value.length > 2_048) throw new NotificationAdapterError("notification/config", "URL 过长");
  return url;
}

function timeoutOf(config: FleetNotificationAdapterConfig): number {
  return Math.min(Math.max(config.timeoutMs ?? 5_000, 100), 10_000);
}

async function post(
  fetchImpl: typeof fetch,
  url: URL | string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<number> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new NotificationAdapterError("notification/network", "适配器请求失败");
  }
  if (!response.ok) {
    throw new NotificationAdapterError("notification/http", `适配器返回 ${response.status}`);
  }
  return response.status;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function errorCodeOf(error: unknown): string {
  return error instanceof NotificationAdapterError ? error.code : "notification/unavailable";
}

function normalizeError(error: unknown): NotificationAdapterError {
  if (error instanceof NotificationAdapterError) return error;
  return new NotificationAdapterError("notification/unavailable", "适配器发送失败");
}

function loadReceipts(path: string | undefined): FleetDeliveryReceipt[] {
  if (path === undefined) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { receipts?: unknown };
    if (!Array.isArray(parsed.receipts)) return [];
    return parsed.receipts.flatMap(value => {
      const receipt = asRecord(value);
      if (receipt === null || receipt === undefined) return [];
      if (typeof receipt.adapterId !== "string" || typeof receipt.kind !== "string") return [];
      if (typeof receipt.eventType !== "string" || typeof receipt.status !== "string") return [];
      if (!EVENTS.includes(receipt.eventType as FleetNotificationType)) return [];
      if (!["delivered", "failed", "unknown", "skipped"].includes(receipt.status)) return [];
      const meta = asRecord(receipt.receipt);
      return [{
        adapterId: receipt.adapterId,
        kind: receipt.kind,
        eventType: receipt.eventType as FleetNotificationType,
        status: receipt.status as FleetDeliveryReceipt["status"],
        at: typeof receipt.at === "string" ? receipt.at : new Date(0).toISOString(),
        durationMs: typeof receipt.durationMs === "number" ? receipt.durationMs : 0,
        ...(typeof receipt.httpStatus === "number" ? { httpStatus: receipt.httpStatus } : {}),
        ...(typeof receipt.errorCode === "string" ? { errorCode: receipt.errorCode } : {}),
        ...(meta === undefined ? {} : {
          receipt: {
            version: typeof meta.version === "number" ? meta.version : 1,
            ...(typeof meta.messageId === "string" ? { messageId: meta.messageId } : {}),
            ...(typeof meta.conversationId === "string" ? { conversationId: meta.conversationId } : {}),
          },
        }),
      }];
    }).slice(-MAX_RECEIPTS);
  } catch {
    return [];
  }
}
