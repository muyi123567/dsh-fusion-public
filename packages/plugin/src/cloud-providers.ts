import {
  CloudConnectorError,
  CloudConnectorRegistry,
  asBearer,
  assertSafeRelativePath,
  bearerTokenSource,
  encodePathSegments,
  joinRemotePath,
  pipeResponseBody,
  requestJson,
  requireEnvName,
  safeHttpUrl,
  stringField,
  type CloudConnector,
  type CloudConnectorDefinition,
  type CloudConnectorEntry,
  type CloudConnectorFactoryContext,
  type CloudConnectorSink,
  type CloudListInput,
  type CloudPullInput,
  type CloudPullMeta,
  type CloudUploadInput,
} from "./cloud-connectors.js";
import { randomUUID } from "node:crypto";

const DRIVE_FIELDS = "id,name,mimeType,size,modifiedTime,webViewLink,parents";
const GRAPH_FIELDS = "id,name,size,file,folder,lastModifiedDateTime,webUrl,parentReference,@microsoft.graph.downloadUrl";

const GDRIVE: CloudConnectorDefinition = {
  kind: "gdrive",
  displayName: "Google Drive",
  category: "drive",
  description: "列出、搜索并拉取 Google Drive 文件；Google 原生文档导出为文本或 CSV。",
  docsUrl: "https://developers.google.com/drive/api/guides/about-sdk",
  capabilities: { list: true, stat: true, pull: true, upload: true },
  fields: [
    { key: "tokenEnv", label: "访问令牌环境变量", env: true, secret: true, description: "短期 access token；与 refresh 三件套二选一" },
    { key: "refreshTokenEnv", label: "刷新令牌环境变量", env: true, secret: true },
    { key: "clientIdEnv", label: "OAuth Client ID 环境变量", env: true },
    { key: "clientSecretEnv", label: "OAuth Client Secret 环境变量", env: true, secret: true },
    { key: "root", label: "默认文件夹 ID", placeholder: "root" },
  ],
};

const ONEDRIVE: CloudConnectorDefinition = {
  kind: "onedrive",
  displayName: "OneDrive",
  category: "drive",
  description: "通过 Microsoft Graph 浏览、搜索并拉取 OneDrive 文件。",
  docsUrl: "https://learn.microsoft.com/graph/api/resources/onedrive",
  capabilities: { list: true, stat: true, pull: true, upload: true },
  fields: [
    { key: "tokenEnv", label: "访问令牌环境变量", env: true, secret: true },
    { key: "refreshTokenEnv", label: "刷新令牌环境变量", env: true, secret: true },
    { key: "clientIdEnv", label: "OAuth Client ID 环境变量", env: true },
    { key: "clientSecretEnv", label: "OAuth Client Secret 环境变量", env: true, secret: true },
    { key: "root", label: "默认目录", placeholder: "Documents" },
  ],
};

const WEBDAV: CloudConnectorDefinition = {
  kind: "webdav",
  displayName: "WebDAV / Nextcloud",
  category: "storage",
  description: "连接 Nextcloud、ownCloud 或任意 WebDAV 服务，浏览并拉取文件。",
  docsUrl: "https://datatracker.ietf.org/doc/html/rfc4918",
  capabilities: { list: true, stat: true, pull: true, upload: true },
  fields: [
    { key: "baseUrl", label: "WebDAV 根地址", required: true, placeholder: "https://cloud.example.com/remote.php/dav/files/me" },
    { key: "usernameEnv", label: "用户名环境变量", env: true },
    { key: "passwordEnv", label: "密码/应用密码环境变量", env: true, secret: true },
  ],
};

const DROPBOX: CloudConnectorDefinition = {
  kind: "dropbox",
  displayName: "Dropbox",
  category: "drive",
  description: "浏览、搜索并拉取 Dropbox 文件。",
  docsUrl: "https://www.dropbox.com/developers/documentation/http/documentation",
  capabilities: { list: true, stat: true, pull: true, upload: true },
  fields: [
    { key: "tokenEnv", label: "访问令牌环境变量", env: true, secret: true },
    { key: "refreshTokenEnv", label: "刷新令牌环境变量", env: true, secret: true },
    { key: "clientIdEnv", label: "App Key 环境变量", env: true },
    { key: "clientSecretEnv", label: "App Secret 环境变量", env: true, secret: true },
    { key: "root", label: "默认目录", placeholder: "/Team" },
  ],
};

export function registerBuiltinCloudConnectors(registry: CloudConnectorRegistry): void {
  registry.register(GDRIVE, createGdrive, { builtin: true });
  registry.register(ONEDRIVE, createOnedrive, { builtin: true });
  registry.register(WEBDAV, createWebdav, { builtin: true });
  registry.register(DROPBOX, createDropbox, { builtin: true });
}

function createGdrive(context: CloudConnectorFactoryContext): CloudConnector {
  const api = safeHttpUrl(stringField(context.config, "apiBase") ?? "https://www.googleapis.com");
  const token = bearerTokenSource({
    env: context.env,
    config: context.config,
    fetch: context.fetch,
    now: context.now,
    tokenUrl: "https://oauth2.googleapis.com/token",
  });
  const rootId = stringField(context.config, "root") ?? "root";

  const fileUrl = (id: string, suffix = ""): string =>
    new URL(`/drive/v3/files/${encodeURIComponent(id)}${suffix}`, api).toString();

  const stat = async (id: string): Promise<CloudConnectorEntry> => {
    const url = new URL(fileUrl(id));
    url.searchParams.set("fields", DRIVE_FIELDS);
    url.searchParams.set("supportsAllDrives", "true");
    const file = await requestJson<DriveFile>(context.fetch, url, { headers: asBearer(await token()) });
    if (file.id === undefined) throw new CloudConnectorError("connector/not-found", "Drive 文件不存在");
    return driveEntry(file);
  };

  return {
    async list(input: CloudListInput) {
      const url = new URL("/drive/v3/files", api);
      const query = input.query?.trim();
      const folder = input.path?.trim() ?? rootId;
      if (query !== undefined && query !== "") {
        url.searchParams.set("q", `name contains '${escapeDriveQuery(query)}' and trashed = false`);
        url.searchParams.set("orderBy", "folder,name");
      } else {
        url.searchParams.set("q", `'${escapeDriveQuery(folder)}' in parents and trashed = false`);
        url.searchParams.set("orderBy", "folder,name");
      }
      url.searchParams.set("pageSize", String(input.limit ?? 50));
      url.searchParams.set("fields", `files(${DRIVE_FIELDS}),nextPageToken`);
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      const data = await requestJson<{ files?: DriveFile[] }>(context.fetch, url, { headers: asBearer(await token()) });
      return (data.files ?? []).flatMap(file => file.id === undefined ? [] : [driveEntry(file)]);
    },
    stat,
    async pull(input: CloudPullInput, sink: CloudConnectorSink): Promise<CloudPullMeta> {
      const entry = await stat(input.path);
      const native = entry.mimeType?.startsWith("application/vnd.google-apps.") === true;
      let url: string;
      let name = entry.name;
      if (native) {
        const exported = exportMime(entry.mimeType);
        url = fileUrl(input.path, `/export?mimeType=${encodeURIComponent(exported.mime)}`);
        if (!name.toLowerCase().endsWith(`.${exported.extension}`)) name = `${name}.${exported.extension}`;
      } else {
        url = fileUrl(input.path, "?alt=media&supportsAllDrives=true");
      }
      const response = await context.fetch(url, { headers: asBearer(await token()), signal: AbortSignal.timeout(30_000) });
      const bytes = await pipeResponseBody(response, sink);
      return {
        name,
        bytes,
        ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
        ...(entry.webUrl === undefined ? {} : { webUrl: entry.webUrl }),
      };
    },
    async upload(input: CloudUploadInput, body: Uint8Array) {
      const name = input.path.split("/").pop();
      if (name === undefined || name.trim() === "") throw new CloudConnectorError("connector/path", "上传路径不合法");
      const existing = await requestJson<{ files?: DriveFile[] }>(context.fetch, (() => {
        const url = new URL("/drive/v3/files", api);
        url.searchParams.set("q", `name = '${escapeDriveQuery(name)}' and '${escapeDriveQuery(rootId)}' in parents and trashed = false`);
        url.searchParams.set("fields", "files(id,name,webViewLink)");
        url.searchParams.set("supportsAllDrives", "true");
        return url;
      })(), { headers: asBearer(await token()) });
      const found = existing.files?.[0];
      if (found?.id !== undefined && input.overwrite !== true) {
        throw new CloudConnectorError("connector/exists", "目标文件已存在");
      }
      if (found?.id !== undefined) {
        const url = new URL(`/upload/drive/v3/files/${encodeURIComponent(found.id)}`, api);
        url.searchParams.set("uploadType", "media");
        url.searchParams.set("supportsAllDrives", "true");
        const response = await context.fetch(url, {
          method: "PATCH",
          headers: { ...asBearer(await token()), "content-type": "application/octet-stream" },
          body: Buffer.from(body),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new CloudConnectorError("connector/upstream", `Drive 返回 ${response.status}`);
        return { name, path: input.path, bytes: body.byteLength, ...(found.webViewLink === undefined ? {} : { webUrl: found.webViewLink }) };
      }
      const boundary = `fusion-${randomUUID()}`;
      const metadata = JSON.stringify({ name, parents: [rootId] });
      const prefix = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
        + `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
      const payload = Buffer.concat([prefix, Buffer.from(body), suffix]);
      const url = new URL("/upload/drive/v3/files", api);
      url.searchParams.set("uploadType", "multipart");
      url.searchParams.set("supportsAllDrives", "true");
      const response = await context.fetch(url, {
        method: "POST",
        headers: {
          ...asBearer(await token()),
          "content-type": `multipart/related; boundary=${boundary}`,
        },
        body: payload,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new CloudConnectorError(response.status === 401 ? "connector/auth" : "connector/upstream", `Drive 返回 ${response.status}`);
      }
      const uploaded = await response.json() as DriveFile;
      return {
        name,
        path: input.path,
        bytes: body.byteLength,
        ...(uploaded.webViewLink === undefined ? {} : { webUrl: uploaded.webViewLink }),
      };
    },
  };
}

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string | number;
  modifiedTime?: string;
  webViewLink?: string;
}

function driveEntry(file: DriveFile): CloudConnectorEntry {
  const folder = file.mimeType === "application/vnd.google-apps.folder";
  const size = typeof file.size === "number" ? file.size : typeof file.size === "string" ? Number(file.size) : undefined;
  return {
    name: file.name ?? file.id ?? "untitled",
    path: file.id ?? file.name ?? "untitled",
    kind: folder ? "folder" : "file",
    ...(size === undefined || !Number.isFinite(size) ? {} : { size }),
    ...(file.modifiedTime === undefined ? {} : { modifiedAt: file.modifiedTime }),
    ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
    ...(file.webViewLink === undefined ? {} : { webUrl: file.webViewLink }),
  };
}

function escapeDriveQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function exportMime(mimeType: string | undefined): { mime: string; extension: string } {
  if (mimeType === "application/vnd.google-apps.spreadsheet") return { mime: "text/csv", extension: "csv" };
  return { mime: "text/plain", extension: "txt" };
}

function createOnedrive(context: CloudConnectorFactoryContext): CloudConnector {
  const api = safeHttpUrl(stringField(context.config, "apiBase") ?? "https://graph.microsoft.com/v1.0");
  const token = bearerTokenSource({
    env: context.env,
    config: context.config,
    fetch: context.fetch,
    now: context.now,
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "https://graph.microsoft.com/.default offline_access",
  });
  const root = stringField(context.config, "root");

  const itemUrl = (path: string): URL => {
    const trimmed = path.trim();
    if (trimmed.startsWith("id:")) return new URL(`/me/drive/items/${encodeURIComponent(trimmed.slice(3))}`, api);
    if (trimmed === "" || trimmed === "root") return new URL("/me/drive/root", api);
    return new URL(`/me/drive/root:/${encodePathSegments(trimmed)}:`, api);
  };

  const remotePath = (parent: string | undefined, name: string): string => joinRemotePath(parent, name);

  const stat = async (path: string): Promise<CloudConnectorEntry> => {
    const url = itemUrl(path);
    url.searchParams.set("$select", GRAPH_FIELDS);
    const item = await requestJson<GraphItem>(context.fetch, url, { headers: asBearer(await token()) });
    return graphEntry(item, path);
  };

  return {
    async list(input: CloudListInput) {
      const query = input.query?.trim();
      const parent = input.path?.trim() ?? root;
      let url: URL;
      if (query !== undefined && query !== "") {
        url = new URL(`/me/drive/root/search(q='${encodeURIComponent(query)}')`, api);
      } else if (parent === undefined || parent === "" || parent === "root") {
        url = new URL("/me/drive/root/children", api);
      } else if (parent.startsWith("id:")) {
        url = new URL(`/me/drive/items/${encodeURIComponent(parent.slice(3))}/children`, api);
      } else {
        url = new URL(`/me/drive/root:/${encodePathSegments(parent)}:/children`, api);
      }
      url.searchParams.set("$top", String(input.limit ?? 50));
      url.searchParams.set("$select", GRAPH_FIELDS);
      const data = await requestJson<{ value?: GraphItem[] }>(context.fetch, url, { headers: asBearer(await token()) });
      return (data.value ?? []).flatMap(item => {
        if (item.name === undefined) return [];
        return [graphEntry(item, remotePath(query === undefined ? parent : undefined, item.name))];
      });
    },
    stat,
    async pull(input: CloudPullInput, sink: CloudConnectorSink): Promise<CloudPullMeta> {
      const entry = await stat(input.path);
      const meta = await requestJson<GraphItem>(context.fetch, (() => {
        const url = itemUrl(input.path);
        url.searchParams.set("$select", GRAPH_FIELDS);
        return url;
      })(), { headers: asBearer(await token()) });
      const downloadUrl = meta["@microsoft.graph.downloadUrl"];
      const response = typeof downloadUrl === "string" && downloadUrl !== ""
        ? await context.fetch(safeHttpUrl(downloadUrl), { signal: AbortSignal.timeout(30_000) })
        : await context.fetch(new URL(`${itemUrl(input.path).toString()}/content`), {
          headers: asBearer(await token()),
          signal: AbortSignal.timeout(30_000),
        });
      const bytes = await pipeResponseBody(response, sink);
      return {
        name: entry.name,
        bytes,
        ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
        ...(entry.webUrl === undefined ? {} : { webUrl: entry.webUrl }),
      };
    },
    async upload(input: CloudUploadInput, body: Uint8Array) {
      let exists = true;
      try {
        await stat(input.path);
      } catch (error) {
        if (error instanceof CloudConnectorError && error.code === "connector/not-found") exists = false;
        else throw error;
      }
      if (exists && input.overwrite !== true) throw new CloudConnectorError("connector/exists", "目标文件已存在");
      const url = new URL(`${itemUrl(input.path).toString()}/content`);
      const response = await context.fetch(url, {
        method: "PUT",
        headers: { ...asBearer(await token()), "content-type": "application/octet-stream" },
        body: Buffer.from(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new CloudConnectorError("connector/upstream", `Graph 返回 ${response.status}`);
      const item = await response.json().catch(() => undefined) as GraphItem | undefined;
      return {
        name: input.path.split("/").pop() ?? item?.name ?? "upload",
        path: input.path,
        bytes: body.byteLength,
        ...(item?.webUrl === undefined ? {} : { webUrl: item.webUrl }),
      };
    },
  };
}

interface GraphItem {
  id?: string;
  name?: string;
  size?: number;
  file?: { mimeType?: string };
  folder?: unknown;
  lastModifiedDateTime?: string;
  webUrl?: string;
  "@microsoft.graph.downloadUrl"?: string;
}

function graphEntry(item: GraphItem, path: string): CloudConnectorEntry {
  return {
    name: item.name ?? item.id ?? "untitled",
    path,
    kind: item.folder === undefined ? "file" : "folder",
    ...(typeof item.size === "number" ? { size: item.size } : {}),
    ...(item.lastModifiedDateTime === undefined ? {} : { modifiedAt: item.lastModifiedDateTime }),
    ...(item.file?.mimeType === undefined ? {} : { mimeType: item.file.mimeType }),
    ...(item.webUrl === undefined ? {} : { webUrl: item.webUrl }),
  };
}

function createWebdav(context: CloudConnectorFactoryContext): CloudConnector {
  const configured = stringField(context.config, "baseUrl")
    ?? (typeof context.config.baseUrlEnv === "string" ? context.env[context.config.baseUrlEnv] : undefined);
  if (configured === undefined || configured.trim() === "") {
    throw new CloudConnectorError("connector/config", "WebDAV 缺少 baseUrl");
  }
  const base = safeHttpUrl(configured);
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const username = context.config.usernameEnv === undefined
    ? undefined : context.env[requireEnvName(context.config, "usernameEnv")];
  const password = context.config.passwordEnv === undefined
    ? undefined : context.env[requireEnvName(context.config, "passwordEnv")];
  const headers = (): Record<string, string> => {
    if (username === undefined || password === undefined) return {};
    return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
  };
  const davUrl = (path: string | undefined): URL => {
    const encoded = path === undefined || path.trim() === "" ? "" : encodePathSegments(path);
    return new URL(encoded, base.toString().endsWith("/") ? base.toString() : `${base.toString()}/`);
  };
  const propfind = async (path: string | undefined, depth: "0" | "1"): Promise<DavEntry[]> => {
    let response: Response;
    try {
      response = await context.fetch(davUrl(path), {
        method: "PROPFIND",
        headers: { ...headers(), depth, "content-type": "application/xml; charset=utf-8" },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new CloudConnectorError("connector/upstream", error instanceof Error ? error.message : "WebDAV 请求失败");
    }
    if (response.status === 401 || response.status === 403) throw new CloudConnectorError("connector/auth", "WebDAV 认证失败");
    if (response.status === 404) throw new CloudConnectorError("connector/not-found", "WebDAV 路径不存在");
    if (!response.ok && response.status !== 207) throw new CloudConnectorError("connector/upstream", `WebDAV 返回 ${response.status}`);
    const xml = await response.text();
    return parseDav(xml, basePath);
  };

  return {
    async list(input: CloudListInput) {
      const entries = await propfind(input.path, "1");
      const self = normalizeDavPath(input.path);
      return entries
        .filter(entry => entry.path !== self)
        .slice(0, input.limit ?? 50);
    },
    async stat(path: string) {
      const entries = await propfind(path, "0");
      const entry = entries[0];
      if (entry === undefined) throw new CloudConnectorError("connector/not-found", "WebDAV 路径不存在");
      return entry;
    },
    async pull(input: CloudPullInput, sink: CloudConnectorSink): Promise<CloudPullMeta> {
      assertSafeRelativePath(input.path);
      let response: Response;
      try {
        response = await context.fetch(davUrl(input.path), { headers: headers(), signal: AbortSignal.timeout(30_000) });
      } catch (error) {
        throw new CloudConnectorError("connector/upstream", error instanceof Error ? error.message : "WebDAV 下载失败");
      }
      const bytes = await pipeResponseBody(response, sink);
      return { name: input.path.split("/").pop() ?? "download", bytes };
    },
    async upload(input: CloudUploadInput, body: Uint8Array) {
      let exists = true;
      try {
        await propfind(input.path, "0");
      } catch (error) {
        if (error instanceof CloudConnectorError && error.code === "connector/not-found") exists = false;
        else throw error;
      }
      if (exists && input.overwrite !== true) throw new CloudConnectorError("connector/exists", "目标文件已存在");
      let response: Response;
      try {
        response = await context.fetch(davUrl(input.path), {
          method: "PUT",
          headers: { ...headers(), "content-type": "application/octet-stream" },
          body: Buffer.from(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new CloudConnectorError("connector/upstream", "WebDAV 上传失败");
      }
      if (!response.ok) throw new CloudConnectorError("connector/upstream", `WebDAV 返回 ${response.status}`);
      return { name: input.path.split("/").pop() ?? "upload", path: input.path, bytes: body.byteLength };
    },
  };
}

interface DavEntry extends CloudConnectorEntry {
  href: string;
}

function parseDav(xml: string, basePath: string): DavEntry[] {
  const blocks = xml.match(/<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/giu) ?? [];
  const entries: DavEntry[] = [];
  for (const block of blocks) {
    const href = tag(block, "href");
    if (href === undefined) continue;
    let path: string;
    try {
      const url = new URL(href, "http://dav.invalid");
      const decoded = decodeURIComponent(url.pathname);
      path = decoded.startsWith(basePath) ? decoded.slice(basePath.length) : decoded.replace(/^\/+/u, "");
    } catch {
      path = decodeURIComponent(href).replace(/^\/+/u, "");
    }
    path = path.replace(/\/+$/u, "");
    const folder = /<(?:[A-Za-z0-9_-]+:)?collection\b/iu.test(block);
    const size = Number(tag(block, "getcontentlength") ?? "");
    const modified = tag(block, "getlastmodified");
    entries.push({
      href,
      name: path.split("/").pop() ?? href,
      path,
      kind: folder ? "folder" : "file",
      ...(Number.isFinite(size) && size >= 0 && tag(block, "getcontentlength") !== undefined ? { size } : {}),
      ...(modified === undefined || Number.isNaN(Date.parse(modified)) ? {} : { modifiedAt: new Date(modified).toISOString() }),
    });
  }
  return entries;
}

function tag(block: string, name: string): string | undefined {
  const match = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${name}>`, "iu").exec(block);
  return match?.[1]?.trim();
}

function normalizeDavPath(path: string | undefined): string {
  return (path ?? "").trim().replace(/^\/+|\/+$/gu, "");
}

function createDropbox(context: CloudConnectorFactoryContext): CloudConnector {
  const api = safeHttpUrl(stringField(context.config, "apiBase") ?? "https://api.dropboxapi.com");
  const content = safeHttpUrl(stringField(context.config, "contentBase") ?? api.toString());
  const token = bearerTokenSource({
    env: context.env,
    config: context.config,
    fetch: context.fetch,
    now: context.now,
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
  });
  const root = stringField(context.config, "root");

  const dropboxPath = (path: string | undefined): string => {
    const value = joinRemotePath(root, path);
    return value === "" ? "" : `/${value.replace(/^\/+/u, "")}`;
  };

  const post = async <T>(url: string, body: unknown): Promise<T> => requestJson<T>(context.fetch, url, {
    method: "POST",
    headers: { ...asBearer(await token()), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    async list(input: CloudListInput) {
      const query = input.query?.trim();
      if (query !== undefined && query !== "") {
        const data = await post<{ matches?: Array<{ metadata?: { metadata?: DropboxEntry } }> }>(
          `${api.toString().replace(/\/$/u, "")}/2/files/search_v2`,
          { query, options: { max_results: input.limit ?? 50, ...(root === undefined ? {} : { path: dropboxPath(root) }) } },
        );
        return (data.matches ?? []).flatMap(match => match.metadata?.metadata === undefined
          ? [] : [dropboxEntry(match.metadata.metadata)]);
      }
      const data = await post<{ entries?: DropboxEntry[] }>(
        `${api.toString().replace(/\/$/u, "")}/2/files/list_folder`,
        { path: dropboxPath(input.path), limit: input.limit ?? 50, recursive: false },
      );
      return (data.entries ?? []).flatMap(entry => [dropboxEntry(entry)]);
    },
    async stat(path: string) {
      const entry = await post<DropboxEntry>(
        `${api.toString().replace(/\/$/u, "")}/2/files/get_metadata`,
        { path: dropboxPath(path) },
      );
      return dropboxEntry(entry);
    },
    async pull(input: CloudPullInput, sink: CloudConnectorSink): Promise<CloudPullMeta> {
      const url = `${content.toString().replace(/\/$/u, "")}/2/files/download`;
      const response = await context.fetch(url, {
        method: "POST",
        headers: {
          ...asBearer(await token()),
          "dropbox-api-arg": JSON.stringify({ path: dropboxPath(input.path) }),
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new CloudConnectorError(
          response.status === 401 ? "connector/auth" : response.status === 409 ? "connector/not-found" : "connector/upstream",
          `Dropbox 返回 ${response.status}`,
        );
      }
      const header = response.headers.get("dropbox-api-result");
      const meta = header === null ? undefined : safeJson<{ name?: string; size?: number }>(header);
      const bytes = await pipeResponseBody(response, sink);
      return {
        name: meta?.name ?? input.path.split("/").pop() ?? "download",
        bytes,
      };
    },
    async upload(input: CloudUploadInput, body: Uint8Array) {
      const url = `${content.toString().replace(/\/$/u, "")}/2/files/upload`;
      const response = await context.fetch(url, {
        method: "POST",
        headers: {
          ...asBearer(await token()),
          "content-type": "application/octet-stream",
          "dropbox-api-arg": JSON.stringify({
            path: dropboxPath(input.path),
            mode: input.overwrite === true ? "overwrite" : "add",
            autorename: false,
            mute: true,
          }),
        },
        body: Buffer.from(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new CloudConnectorError(
          response.status === 401 ? "connector/auth"
            : response.status === 409 ? "connector/exists"
            : "connector/upstream",
          `Dropbox 返回 ${response.status}`,
        );
      }
      const meta = await response.json().catch(() => undefined) as DropboxEntry | undefined;
      return {
        name: meta?.name ?? input.path.split("/").pop() ?? "upload",
        path: input.path,
        bytes: body.byteLength,
      };
    },
  };
}

interface DropboxEntry {
  ".tag"?: string;
  name?: string;
  path_display?: string;
  path_lower?: string;
  size?: number;
  server_modified?: string;
}

function dropboxEntry(entry: DropboxEntry): CloudConnectorEntry {
  const path = entry.path_display ?? entry.path_lower ?? entry.name ?? "";
  return {
    name: entry.name ?? path.split("/").pop() ?? "untitled",
    path,
    kind: entry[".tag"] === "folder" ? "folder" : "file",
    ...(typeof entry.size === "number" ? { size: entry.size } : {}),
    ...(entry.server_modified === undefined ? {} : { modifiedAt: entry.server_modified }),
  };
}

function safeJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
