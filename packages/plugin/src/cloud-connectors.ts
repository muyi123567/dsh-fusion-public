import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, join, resolve as resolvePath, sep } from "node:path";

export type CloudConnectorCategory = "drive" | "storage" | "generic" | string;

export interface CloudConnectorField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  env?: boolean;
  placeholder?: string;
  description?: string;
}

export interface CloudConnectorDefinition {
  kind: string;
  displayName: string;
  category: CloudConnectorCategory;
  description: string;
  docsUrl?: string;
  capabilities: {
    list: boolean;
    stat: boolean;
    pull: boolean;
    upload: boolean;
  };
  fields: CloudConnectorField[];
}

export interface CloudConnectorInstanceConfig {
  id: string;
  kind: string;
  enabled?: boolean;
  label?: string;
  root?: string;
  apiBase?: string;
  tokenEnv?: string;
  refreshTokenEnv?: string;
  clientIdEnv?: string;
  clientSecretEnv?: string;
  tokenUrl?: string;
  baseUrl?: string;
  usernameEnv?: string;
  passwordEnv?: string;
  [key: string]: unknown;
}

export interface CloudConnectorEntry {
  name: string;
  path: string;
  kind: "file" | "folder";
  size?: number;
  modifiedAt?: string;
  mimeType?: string;
  webUrl?: string;
}

export interface CloudListInput {
  path?: string;
  query?: string;
  limit?: number;
}

export interface CloudPullInput {
  path: string;
  name?: string;
  maxBytes?: number;
}

export interface CloudUploadInput {
  path: string;
  overwrite?: boolean;
  maxBytes?: number;
}

export interface CloudConnectorSink {
  write(chunk: Uint8Array): Promise<void>;
}

export interface CloudPullMeta {
  name: string;
  bytes?: number;
  mimeType?: string;
  webUrl?: string;
}

export interface CloudConnector {
  list(input: CloudListInput, signal?: AbortSignal): Promise<CloudConnectorEntry[]>;
  pull(input: CloudPullInput, sink: CloudConnectorSink, signal?: AbortSignal): Promise<CloudPullMeta>;
  stat?(path: string, signal?: AbortSignal): Promise<CloudConnectorEntry>;
  upload?(input: CloudUploadInput, body: Uint8Array, signal?: AbortSignal): Promise<{
    name: string;
    path: string;
    bytes: number;
    webUrl?: string;
  }>;
}

export interface CloudConnectorFactoryContext {
  config: CloudConnectorInstanceConfig;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  now: () => number;
}

export type CloudConnectorFactory = (context: CloudConnectorFactoryContext) => CloudConnector;

export interface CloudConnectorInstanceStatus {
  id: string;
  kind: string;
  label: string;
  enabled: boolean;
  state: "configured" | "invalid" | "disabled";
  root?: string;
  capabilities?: CloudConnectorDefinition["capabilities"];
  errorCode?: string;
}

export interface CloudPullResult {
  connectorId: string;
  kind: string;
  path: string;
  name: string;
  localPath: string;
  bytes: number;
  sha256: string;
  pulledAt: string;
}

export interface CloudUploadResult {
  connectorId: string;
  kind: string;
  path: string;
  name: string;
  localPath: string;
  bytes: number;
  sha256: string;
  uploadedAt: string;
  webUrl?: string;
}

export interface WhaleConnectorServiceV1 {
  readonly contractVersion: 1;
  catalog(): CloudConnectorDefinition[];
  instances(): CloudConnectorInstanceStatus[];
  list(id: string, input: CloudListInput): Promise<CloudConnectorEntry[]>;
  pull(id: string, input: CloudPullInput): Promise<CloudPullResult>;
  upload(id: string, input: CloudUploadInput & { sourcePath: string }): Promise<CloudUploadResult>;
  register(definition: CloudConnectorDefinition, factory: CloudConnectorFactory): () => void;
}

export class CloudConnectorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CloudConnectorError";
  }
}

const KIND = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?$/u;
const INSTANCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const HARD_MAX_BYTES = 512 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

interface Registered {
  definition: CloudConnectorDefinition;
  factory: CloudConnectorFactory;
  builtin: boolean;
}

export class CloudConnectorRegistry {
  private readonly entries = new Map<string, Registered>();

  register(
    definition: CloudConnectorDefinition,
    factory: CloudConnectorFactory,
    options: { replace?: boolean; builtin?: boolean } = {},
  ): () => void {
    if (!KIND.test(definition.kind)) throw new CloudConnectorError("connector/kind-invalid", "连接器 kind 不合法");
    const existing = this.entries.get(definition.kind);
    if (existing !== undefined && existing.builtin && options.builtin !== true) {
      throw new CloudConnectorError("connector/kind-reserved", "不能覆盖内置连接器");
    }
    if (definition.kind.includes("/") !== true && options.builtin !== true) {
      throw new CloudConnectorError("connector/kind-namespace", "第三方连接器 kind 必须带命名空间，例如 acme/drive");
    }
    if (existing !== undefined && options.replace !== true) {
      throw new CloudConnectorError("connector/kind-exists", "连接器 kind 已存在");
    }
    validateDefinition(definition);
    this.entries.set(definition.kind, { definition: structuredClone(definition), factory, builtin: options.builtin === true });
    return () => {
      if (this.entries.get(definition.kind)?.factory === factory) this.entries.delete(definition.kind);
    };
  }

  catalog(): CloudConnectorDefinition[] {
    return [...this.entries.values()]
      .map(entry => structuredClone(entry.definition))
      .sort((left, right) => left.kind.localeCompare(right.kind));
  }

  definition(kind: string): CloudConnectorDefinition | undefined {
    const definition = this.entries.get(kind)?.definition;
    return definition === undefined ? undefined : structuredClone(definition);
  }

  create(config: CloudConnectorInstanceConfig, context: Omit<CloudConnectorFactoryContext, "config">): CloudConnector {
    const entry = this.entries.get(config.kind);
    if (entry === undefined) throw new CloudConnectorError("connector/unknown-kind", "未知连接器类型");
    return entry.factory({ ...context, config });
  }
}

function validateDefinition(definition: CloudConnectorDefinition): void {
  if (definition.displayName.trim() === "") throw new CloudConnectorError("connector/config", "连接器缺少名称");
  if (definition.description.trim() === "") throw new CloudConnectorError("connector/config", "连接器缺少说明");
  if (definition.capabilities.list !== true && definition.capabilities.pull !== true) {
    throw new CloudConnectorError("connector/config", "连接器至少需要 list 或 pull 能力");
  }
  const keys = new Set<string>();
  for (const field of definition.fields) {
    if (keys.has(field.key)) throw new CloudConnectorError("connector/config", "连接器字段重复");
    keys.add(field.key);
  }
}

export interface CloudConnectorServiceOptions {
  registry: CloudConnectorRegistry;
  connectors: CloudConnectorInstanceConfig[];
  importsDirectory: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
  maxBytes?: number;
  uploadRoots?: string[];
}

interface Instance {
  config: CloudConnectorInstanceConfig;
  status: CloudConnectorInstanceStatus;
  connector?: CloudConnector;
}

export function createCloudConnectorService(options: CloudConnectorServiceOptions): WhaleConnectorServiceV1 {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const defaultMaxBytes = Math.min(Math.max(options.maxBytes ?? DEFAULT_MAX_BYTES, 1), HARD_MAX_BYTES);
  const importsDirectory = options.importsDirectory;
  const uploadRoots = (options.uploadRoots ?? [importsDirectory]).map(root => resolvePath(root));
  const instances = new Map<string, Instance>();

  for (const config of options.connectors) {
    if (!INSTANCE_ID.test(config.id)) {
      throw new CloudConnectorError("connector/config", `连接器实例 id 不合法：${config.id}`);
    }
    if (instances.has(config.id)) {
      throw new CloudConnectorError("connector/config", `连接器实例 id 重复：${config.id}`);
    }
    const definition = options.registry.definition(config.kind);
    const enabled = config.enabled !== false;
    const base: CloudConnectorInstanceStatus = {
      id: config.id,
      kind: config.kind,
      label: config.label ?? config.id,
      enabled,
      state: enabled ? "configured" : "disabled",
      ...(config.root === undefined ? {} : { root: config.root }),
      ...(definition === undefined ? {} : { capabilities: definition.capabilities }),
      ...(definition === undefined ? { errorCode: "connector/unknown-kind", state: "invalid" as const } : {}),
    };
    if (!enabled || definition === undefined) {
      instances.set(config.id, { config, status: base });
      continue;
    }
    try {
      const connector = options.registry.create(config, { env, fetch: fetchImpl, now });
      instances.set(config.id, { config, status: base, connector });
    } catch (error) {
      instances.set(config.id, {
        config,
        status: { ...base, state: "invalid", errorCode: errorCodeOf(error) },
      });
    }
  }

  const resolve = (id: string): Instance => {
    const instance = instances.get(id);
    if (instance === undefined) throw new CloudConnectorError("connector/unknown", "未知连接器实例");
    if (!instance.status.enabled) throw new CloudConnectorError("connector/disabled", "连接器已禁用");
    if (instance.status.state === "invalid" || instance.connector === undefined) {
      throw new CloudConnectorError(instance.status.errorCode ?? "connector/config", "连接器配置无效");
    }
    return instance;
  };

  return {
    contractVersion: 1,
    catalog: () => options.registry.catalog(),
    instances: () => [...instances.values()].map(instance => ({ ...instance.status })),
    async list(id, input) {
      const instance = resolve(id);
      const limit = normalizeLimit(input.limit);
      const path = normalizeRemotePath(input.path);
      const query = input.query?.trim();
      try {
        return await instance.connector!.list({
          ...(path === undefined ? {} : { path }),
          ...(query === undefined || query === "" ? {} : { query }),
          limit,
        });
      } catch (error) {
        throw normalizeError(error);
      }
    },
    async pull(id, input) {
      const instance = resolve(id);
      const path = normalizeRemotePath(input.path);
      if (path === undefined) throw new CloudConnectorError("connector/path", "缺少远程路径");
      const maxBytes = Math.min(Math.max(input.maxBytes ?? defaultMaxBytes, 1), HARD_MAX_BYTES);
      mkdirSync(importsDirectory, { recursive: true, mode: 0o700 });
      const temporary = join(importsDirectory, `.part-${randomBytes(8).toString("hex")}`);
      const handle = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      let bytes = 0;
      let meta: CloudPullMeta;
      try {
        const bounded: CloudConnectorSink = {
          async write(chunk) {
            bytes += chunk.byteLength;
            if (bytes > maxBytes) throw new CloudConnectorError("connector/limit", "文件超过允许的大小");
            hash.update(chunk);
            await handle.write(chunk);
          },
        };
        meta = await instance.connector!.pull({ ...input, path, maxBytes }, bounded);
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        rmSync(temporary, { force: true });
        throw normalizeError(error);
      }
      await handle.close();
      chmodSync(temporary, 0o600);
      const name = uniqueName(importsDirectory, sanitizeFileName(input.name ?? meta.name));
      const localPath = join(importsDirectory, name);
      try {
        renameSync(temporary, localPath);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw normalizeError(error);
      }
      return {
        connectorId: id,
        kind: instance.config.kind,
        path,
        name,
        localPath,
        bytes,
        sha256: hash.digest("hex"),
        pulledAt: new Date(now()).toISOString(),
      };
    },
    async upload(id, input) {
      const instance = resolve(id);
      if (instance.connector!.upload === undefined) {
        throw new CloudConnectorError("connector/upload-unsupported", "连接器不支持上传");
      }
      const remotePath = normalizeRemotePath(input.path);
      if (remotePath === undefined) throw new CloudConnectorError("connector/path", "缺少远程路径");
      assertSafeRelativePath(remotePath);
      const sourcePath = realpathSync(resolvePath(input.sourcePath));
      const allowed = uploadRoots.some(root => {
        try {
          const realRoot = realpathSync(root);
          return sourcePath === realRoot || sourcePath.startsWith(`${realRoot}${sep}`);
        } catch {
          return false;
        }
      });
      if (!allowed) throw new CloudConnectorError("connector/path", "源文件不在允许的上传目录");
      const info = statSync(sourcePath);
      if (!info.isFile()) throw new CloudConnectorError("connector/path", "源路径不是文件");
      const maxBytes = Math.min(Math.max(input.maxBytes ?? defaultMaxBytes, 1), HARD_MAX_BYTES);
      if (info.size > maxBytes) throw new CloudConnectorError("connector/limit", "文件超过允许的大小");
      const body = readFileSync(sourcePath);
      const uploaded = await instance.connector!.upload({
        path: remotePath,
        overwrite: input.overwrite === true,
      }, body);
      return {
        connectorId: id,
        kind: instance.config.kind,
        path: remotePath,
        name: uploaded.name,
        localPath: sourcePath,
        bytes: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
        uploadedAt: new Date(now()).toISOString(),
        ...(uploaded.webUrl === undefined ? {} : { webUrl: uploaded.webUrl }),
      };
    },
    register(definition, factory) {
      return options.registry.register(definition, factory);
    },
  };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

export function normalizeRemotePath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const path = value.trim();
  return path === "" ? undefined : path;
}

export function assertSafeRelativePath(path: string): string[] {
  const segments = path.split("/").filter(segment => segment !== "");
  if (segments.some(segment => segment === "." || segment === ".." || /[\u0000-\u001f\\]/u.test(segment))) {
    throw new CloudConnectorError("connector/path", "远程路径不合法");
  }
  return segments;
}

export function encodePathSegments(path: string): string {
  return assertSafeRelativePath(path).map(encodeURIComponent).join("/");
}

export function joinRemotePath(...parts: Array<string | undefined>): string {
  return parts
    .flatMap(part => part === undefined ? [] : part.split("/"))
    .map(part => part.trim())
    .filter(part => part !== "" && part !== ".")
    .join("/");
}

export function sanitizeFileName(value: string): string {
  const raw = basename(String(value).replaceAll("\\", "/"));
  const cleaned = raw
    .replaceAll(/[\u0000-\u001f<>:"|?*]/gu, "_")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 180);
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "download" : cleaned;
}

function uniqueName(directory: string, name: string): string {
  if (!existsSync(join(directory, name))) return name;
  const extension = extname(name);
  const stem = extension === "" ? name : name.slice(0, -extension.length);
  for (let index = 1; index < 100; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!existsSync(join(directory, candidate))) return candidate;
  }
  return `${stem}-${randomBytes(4).toString("hex")}${extension}`;
}

export function errorCodeOf(error: unknown): string {
  if (error instanceof CloudConnectorError) return error.code;
  if (error instanceof Error && error.name === "AbortError") return "connector/timeout";
  return "connector/upstream";
}

export function normalizeError(error: unknown): CloudConnectorError {
  if (error instanceof CloudConnectorError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new CloudConnectorError("connector/timeout", "连接器请求超时");
  }
  return new CloudConnectorError("connector/upstream", "连接器请求失败");
}

export function safeHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudConnectorError("connector/config", "连接器地址不合法");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new CloudConnectorError("connector/config", "连接器地址必须使用 HTTPS（本机回环除外）");
  }
  return url;
}

export function requireEnvName(
  config: CloudConnectorInstanceConfig,
  key: keyof CloudConnectorInstanceConfig & string,
): string {
  const value = config[key];
  if (typeof value !== "string" || !ENV_NAME.test(value)) {
    throw new CloudConnectorError("connector/config", `${key} 必须是环境变量名`);
  }
  return value;
}

export function readSecret(
  env: Record<string, string | undefined>,
  config: CloudConnectorInstanceConfig,
  key: keyof CloudConnectorInstanceConfig & string,
): string | undefined {
  const name = config[key];
  if (name === undefined) return undefined;
  if (typeof name !== "string" || !ENV_NAME.test(name)) {
    throw new CloudConnectorError("connector/config", `${key} 必须是环境变量名`);
  }
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function requiredSecret(
  env: Record<string, string | undefined>,
  config: CloudConnectorInstanceConfig,
  key: keyof CloudConnectorInstanceConfig & string,
): string {
  const value = readSecret(env, config, key);
  if (value === undefined) throw new CloudConnectorError("connector/auth", `缺少 ${key} 指向的凭据`);
  return value;
}

export function bearerTokenSource(options: {
  env: Record<string, string | undefined>;
  config: CloudConnectorInstanceConfig;
  fetch: typeof fetch;
  now: () => number;
  tokenUrl: string;
  scope?: string;
}): () => Promise<string> {
  const tokenEnv = options.config.tokenEnv;
  if (tokenEnv !== undefined) {
    if (typeof tokenEnv !== "string" || !ENV_NAME.test(tokenEnv)) {
      throw new CloudConnectorError("connector/config", "tokenEnv 必须是环境变量名");
    }
    const value = options.env[tokenEnv];
    if (value === undefined || value.trim() === "") {
      throw new CloudConnectorError("connector/auth", "缺少 tokenEnv 指向的凭据");
    }
    return async () => options.env[tokenEnv] ?? value;
  }

  const refreshName = requireEnvName(options.config, "refreshTokenEnv");
  const clientIdName = requireEnvName(options.config, "clientIdEnv");
  const clientSecretName = requireEnvName(options.config, "clientSecretEnv");
  const tokenUrl = safeHttpUrl(
    typeof options.config.tokenUrl === "string" && options.config.tokenUrl !== "" ? options.config.tokenUrl : options.tokenUrl,
  );
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  const refresh = async (): Promise<string> => {
    const refreshToken = options.env[refreshName];
    const clientId = options.env[clientIdName];
    const clientSecret = options.env[clientSecretName];
    if (refreshToken === undefined || clientId === undefined || clientSecret === undefined) {
      throw new CloudConnectorError("connector/auth", "OAuth 刷新凭据不完整");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    });
    let response: Response;
    try {
      response = await options.fetch(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: timeoutSignal(),
      });
    } catch {
      throw new CloudConnectorError("connector/auth", "OAuth 刷新请求失败");
    }
    if (!response.ok) throw new CloudConnectorError("connector/auth", "OAuth 刷新被拒绝");
    const value = await response.json().catch(() => undefined) as { access_token?: unknown; expires_in?: unknown } | undefined;
    if (value === undefined || typeof value.access_token !== "string" || value.access_token === "") {
      throw new CloudConnectorError("connector/auth", "OAuth 刷新未返回令牌");
    }
    const expiresIn = typeof value.expires_in === "number" && Number.isFinite(value.expires_in)
      ? Math.min(Math.max(value.expires_in, 60), 86_400)
      : 3_600;
    cached = { token: value.access_token, expiresAt: options.now() + expiresIn * 1_000 };
    return value.access_token;
  };

  return async () => {
    if (cached !== undefined && cached.expiresAt - 60_000 > options.now()) return cached.token;
    if (pending === undefined) {
      pending = refresh().finally(() => { pending = undefined; });
    }
    return await pending;
  };
}

export async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: URL | string,
  init: RequestInit,
  code = "connector/upstream",
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: mergeSignals(init.signal) });
  } catch (error) {
    throw normalizeError(error);
  }
  if (!response.ok) {
    throw new CloudConnectorError(
      response.status === 401 || response.status === 403 ? "connector/auth" : code,
      `上游返回 ${response.status}`,
    );
  }
  try {
    return await response.json() as T;
  } catch {
    throw new CloudConnectorError(code, "上游返回的不是 JSON");
  }
}

export async function pipeResponseBody(
  response: Response,
  sink: CloudConnectorSink,
  signal?: AbortSignal,
): Promise<number> {
  if (!response.ok) {
    throw new CloudConnectorError(
      response.status === 401 || response.status === 403 ? "connector/auth"
        : response.status === 404 ? "connector/not-found" : "connector/upstream",
      `上游返回 ${response.status}`,
    );
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 0) await sink.write(bytes);
    return bytes.byteLength;
  }
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted === true) throw new DOMException("aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined && value.byteLength > 0) {
        total += value.byteLength;
        await sink.write(value);
      }
    }
    return total;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function mergeSignals(signal?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal === undefined || signal === null ? timeout : AbortSignal.any([signal, timeout]);
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

export function asBearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export function stringField(config: CloudConnectorInstanceConfig, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
