import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudConnectorError,
  CloudConnectorRegistry,
  createCloudConnectorService,
  type CloudConnectorDefinition,
  type CloudConnectorSink,
} from "./cloud-connectors.js";
import { registerBuiltinCloudConnectors } from "./cloud-providers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-cloud-"));
  roots.push(root);
  return root;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function definition(kind: string, capabilities = { list: true, stat: true, pull: true, upload: false }): CloudConnectorDefinition {
  return {
    kind,
    displayName: kind,
    category: "test",
    description: "test connector",
    capabilities,
    fields: [],
  };
}

function sink(): CloudConnectorSink & { chunks: Buffer[] } {
  const chunks: Buffer[] = [];
  return {
    chunks,
    async write(chunk) {
      chunks.push(Buffer.from(chunk));
    },
  };
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("cloud connector registry", () => {
  it("registers built-in open drive providers and rejects reserved or duplicate kinds", () => {
    const registry = new CloudConnectorRegistry();
    registerBuiltinCloudConnectors(registry);

    expect(registry.catalog().map(entry => entry.kind)).toEqual(
      expect.arrayContaining(["gdrive", "onedrive", "webdav", "dropbox"]),
    );
    expect(codeOf(() => registry.register(definition("gdrive"), () => {
      throw new Error("unused");
    }))).toBe("connector/kind-reserved");
    expect(() => registry.register(definition("acme/drive"), () => {
      throw new Error("unused");
    })).not.toThrow();
    expect(codeOf(() => registry.register(definition("acme/drive"), () => {
      throw new Error("unused");
    }))).toBe("connector/kind-exists");
  });

  it("requires third-party kinds to be namespaced while allowing replacement explicitly", () => {
    const registry = new CloudConnectorRegistry();
    expect(codeOf(() => registry.register(definition("thirdparty"), () => {
      throw new Error("unused");
    }))).toBe("connector/kind-namespace");

    registry.register(definition("acme/box"), () => ({ async list() { return []; } }) as never);
    expect(() => registry.register(definition("acme/box"), () => ({ async list() { return []; } }) as never,
      { replace: true })).not.toThrow();
  });
});

describe("Google Drive connector", () => {
  it("lists by folder or query and exports Google-native documents", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.includes("/drive/v3/files?") && url.includes("q=")) {
        return json({
          files: [{
            id: "doc-1",
            name: "Weekly plan",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-11-23T10:00:00Z",
          }],
        });
      }
      if (url.includes("/drive/v3/files/doc-1?") && url.includes("fields=")) {
        return json({
          id: "doc-1",
          name: "Weekly plan",
          mimeType: "application/vnd.google-apps.document",
          modifiedTime: "2026-11-23T10:00:00Z",
        });
      }
      if (url.includes("/drive/v3/files/doc-1/export")) return new Response("exported", { status: 200 });
      return json({ error: "unexpected" }, 500);
    });

    const registry = new CloudConnectorRegistry();
    registerBuiltinCloudConnectors(registry);
    const connector = registry.create(
      { id: "gd", kind: "gdrive", tokenEnv: "GOOGLE_DRIVE_TOKEN", root: "root-folder" },
      { env: { GOOGLE_DRIVE_TOKEN: "token-1" }, fetch: fakeFetch as typeof fetch, now: () => 0 },
    );

    await connector.list({ path: "root-folder" });
    expect(calls[0]?.url).toContain("root-folder");
    const listed = await connector.list({ query: "Weekly" });
    expect(listed).toEqual([expect.objectContaining({ name: "Weekly plan", path: "doc-1", kind: "file" })]);
    expect(calls[1]?.url).toContain("q=name+contains+%27Weekly%27");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer token-1");

    const output = sink();
    const pulled = await connector.pull({ path: "doc-1" }, output);
    expect(pulled).toMatchObject({ name: "Weekly plan.txt", bytes: 8 });
    expect(Buffer.concat(output.chunks).toString()).toBe("exported");
    expect(calls.some(call => call.url.includes("/export") && call.url.includes("text%2Fplain"))).toBe(true);
  });

  it("refreshes an expired access token once and never returns the token in errors", async () => {
    const calls: string[] = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/token")) {
        return json({ access_token: "fresh-token", expires_in: 3600 });
      }
      if (url.includes("/drive/v3/files?")) return json({ files: [] });
      return json({ error: { message: "bad" } }, 401);
    });

    const registry = new CloudConnectorRegistry();
    registerBuiltinCloudConnectors(registry);
    const connector = registry.create(
      {
        id: "gd",
        kind: "gdrive",
        refreshTokenEnv: "GD_REFRESH",
        clientIdEnv: "GD_CLIENT_ID",
        clientSecretEnv: "GD_CLIENT_SECRET",
      },
      {
        env: { GD_REFRESH: "refresh-1", GD_CLIENT_ID: "client-1", GD_CLIENT_SECRET: "secret-1" },
        fetch: fakeFetch as typeof fetch,
        now: () => 1_000,
      },
    );

    await connector.list({ path: "root" });
    await connector.list({ path: "root" });
    expect(calls.filter(url => url.includes("/token"))).toHaveLength(1);
    expect(new Headers((fakeFetch.mock.calls[1]?.[1] as RequestInit | undefined)?.headers).get("authorization"))
      .toBe("Bearer fresh-token");
    expect(JSON.stringify(await connector.list({ path: "root" }))).not.toContain("fresh-token");
  });

  it("uploads through the multipart endpoint and refuses an existing name", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.includes("/drive/v3/files?") && url.includes("name+%3D")) {
        return json({ files: [] });
      }
      if (url.includes("/upload/drive/v3/files") && url.includes("uploadType=multipart")) {
        return json({ id: "new-1", name: "upload.txt", webViewLink: "https://drive.example/new-1" });
      }
      return json({ files: [{ id: "old", name: "upload.txt" }] });
    });
    const registry = new CloudConnectorRegistry();
    registerBuiltinCloudConnectors(registry);
    const connector = registry.create(
      { id: "gd", kind: "gdrive", tokenEnv: "GOOGLE_DRIVE_TOKEN", root: "root-1" },
      { env: { GOOGLE_DRIVE_TOKEN: "token-1" }, fetch: fakeFetch as typeof fetch, now: () => 0 },
    );
    const uploaded = await connector.upload!({ path: "upload.txt" }, Buffer.from("hi"));
    expect(uploaded).toMatchObject({ name: "upload.txt", bytes: 2, webUrl: "https://drive.example/new-1" });
    const multipart = calls.find(call => call.url.includes("uploadType=multipart"));
    expect(String(multipart?.init?.body)).toContain("\"name\":\"upload.txt\"");
  });
});

describe("OneDrive connector", () => {
  it("lists folders, searches by name, and pulls through the download URL", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.includes("/me/drive/root:/Team/Plans:/children")) {
        return json({ value: [{
          id: "item-1",
          name: "plan.txt",
          size: 4,
          lastModifiedDateTime: "2026-11-23T10:00:00Z",
          file: { mimeType: "text/plain" },
          "@microsoft.graph.downloadUrl": "http://127.0.0.1:9000/download/item-1",
        }] });
      }
      if (url.includes("/me/drive/root/search")) {
        return json({ value: [{ id: "item-2", name: "found.txt", file: { mimeType: "text/plain" } }] });
      }
      if (url.includes("/me/drive/root:/Team/Plans/plan.txt")) {
        return json({
          id: "item-1",
          name: "plan.txt",
          size: 4,
          file: { mimeType: "text/plain" },
          "@microsoft.graph.downloadUrl": "http://127.0.0.1:9000/download/item-1",
        });
      }
      if (url === "http://127.0.0.1:9000/download/item-1") return new Response("data", { status: 200 });
      return json({ error: "unexpected" }, 500);
    });

    const registry = new CloudConnectorRegistry();
    registerBuiltinCloudConnectors(registry);
    const connector = registry.create(
      { id: "od", kind: "onedrive", tokenEnv: "ONEDRIVE_TOKEN" },
      { env: { ONEDRIVE_TOKEN: "token-2" }, fetch: fakeFetch as typeof fetch, now: () => 0 },
    );

    expect(await connector.list({ path: "Team/Plans" })).toEqual([
      expect.objectContaining({ name: "plan.txt", path: "Team/Plans/plan.txt", kind: "file", size: 4 }),
    ]);
    expect(await connector.list({ query: "plan" })).toEqual([
      expect.objectContaining({ name: "found.txt", path: "found.txt" }),
    ]);
    const output = sink();
    const pulled = await connector.pull({ path: "Team/Plans/plan.txt" }, output);
    expect(pulled).toMatchObject({ name: "plan.txt", bytes: 4 });
    expect(Buffer.concat(output.chunks).toString()).toBe("data");
  });
});

describe("WebDAV connector", () => {
  it("parses PROPFIND listings, sends basic auth, and rejects traversal", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (init?.method === "PROPFIND") {
        return new Response(`<?xml version="1.0"?>
          <d:multistatus xmlns:d="DAV:">
            <d:response><d:href>/dav/notes/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
            <d:response><d:href>/dav/notes/a.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>3</d:getcontentlength><d:getlastmodified>Sun, 23 Nov 2026 10:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
          </d:multistatus>`, { status: 207 });
      }
      if (url === "http://127.0.0.1:9001/dav/notes/a.txt") return new Response("abc", { status: 200 });
      if (init?.method === "PUT") return new Response("", { status: 201 });
      return new Response("missing", { status: 404 });
    });

    const registry = new CloudConnectorRegistry();
    registerBuiltinCloudConnectors(registry);
    const connector = registry.create(
      {
        id: "dav",
        kind: "webdav",
        baseUrl: "http://127.0.0.1:9001/dav",
        usernameEnv: "DAV_USER",
        passwordEnv: "DAV_PASS",
      },
      { env: { DAV_USER: "alice", DAV_PASS: "secret" }, fetch: fakeFetch as typeof fetch, now: () => 0 },
    );

    expect(await connector.list({ path: "notes" })).toEqual([
      expect.objectContaining({ name: "a.txt", path: "notes/a.txt", kind: "file", size: 3 }),
    ]);
    const propfind = calls.find(call => call.init?.method === "PROPFIND");
    expect(new Headers(propfind?.init?.headers).get("depth")).toBe("1");
    expect(new Headers(propfind?.init?.headers).get("authorization")).toMatch(/^Basic /u);

    const output = sink();
    expect(await connector.pull({ path: "notes/a.txt" }, output)).toMatchObject({ name: "a.txt", bytes: 3 });
    expect(Buffer.concat(output.chunks).toString()).toBe("abc");
    await expect(connector.pull({ path: "../etc/passwd" }, sink())).rejects.toMatchObject({ code: "connector/path" });
    const uploaded = await connector.upload!({ path: "notes/out.txt", overwrite: true }, Buffer.from("xyz"));
    expect(uploaded).toMatchObject({ name: "out.txt", bytes: 3 });
  });
});

describe("Dropbox connector", () => {
  it("lists folders and downloads through the content endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith("/2/files/list_folder")) {
        return json({ entries: [
          { ".tag": "file", name: "a.txt", path_display: "/notes/a.txt", size: 2, server_modified: "2026-11-23T10:00:00Z" },
        ] });
      }
      if (url.endsWith("/2/files/download")) {
        return new Response("ok", {
          status: 200,
          headers: { "dropbox-api-result": JSON.stringify({ name: "a.txt", size: 2 }) },
        });
      }
      return json({ error_summary: "unexpected" }, 500);
    });

    const registry = new CloudConnectorRegistry();
    registerBuiltinCloudConnectors(registry);
    const connector = registry.create(
      { id: "dbx", kind: "dropbox", tokenEnv: "DROPBOX_TOKEN" },
      { env: { DROPBOX_TOKEN: "token-3" }, fetch: fakeFetch as typeof fetch, now: () => 0 },
    );

    expect(await connector.list({ path: "notes" })).toEqual([
      expect.objectContaining({ name: "a.txt", path: "/notes/a.txt", kind: "file", size: 2 }),
    ]);
    const output = sink();
    expect(await connector.pull({ path: "/notes/a.txt" }, output)).toMatchObject({ name: "a.txt", bytes: 2 });
    const download = calls.find(call => call.url.endsWith("/2/files/download"));
    expect(new Headers(download?.init?.headers).get("dropbox-api-arg")).toBe(JSON.stringify({ path: "/notes/a.txt" }));
  });
});

describe("cloud connector service", () => {
  function serviceWith(connector: {
    list?: () => Promise<unknown[]>;
    pull?: (input: unknown, sink: CloudConnectorSink) => Promise<{ name: string }>;
  }) {
    const registry = new CloudConnectorRegistry();
    registry.register(definition("acme/memory"), () => ({
      async list() { return (connector.list ?? (async () => []))() as never; },
      async pull(_input: unknown, output: CloudConnectorSink) {
        const value = await (connector.pull ?? (async () => ({ name: "file.bin" })))(_input, output);
        return value;
      },
    }) as never);
    const directory = tempRoot();
    const service = createCloudConnectorService({
      registry,
      connectors: [{ id: "mem", kind: "acme/memory" }, { id: "off", kind: "acme/memory", enabled: false }],
      importsDirectory: join(directory, "imports"),
      env: {},
      now: () => Date.parse("2026-11-23T12:00:00Z"),
    });
    return { service, directory };
  }

  it("pulls into a private imports directory with a sha256 receipt", async () => {
    const { service, directory } = serviceWith({
      async pull(_input, output) {
        await output.write(Buffer.from("abc"));
        return { name: "report.txt" };
      },
    });

    const result = await service.pull("mem", { path: "remote/report.txt", maxBytes: 10 });
    expect(result).toMatchObject({
      connectorId: "mem",
      name: "report.txt",
      bytes: 3,
      sha256: createHash("sha256").update("abc").digest("hex"),
    });
    expect(result.localPath.startsWith(join(directory, "imports"))).toBe(true);
    expect(readFileSync(result.localPath, "utf8")).toBe("abc");
    expect(statSync(result.localPath).mode & 0o777).toBe(0o600);
  });

  it("enforces the byte cap, filename sanitation, disabled instances, and unique names", async () => {
    const { service, directory } = serviceWith({
      async pull(_input, output) {
        await output.write(Buffer.from("abcdef"));
        return { name: "../../unsafe name.txt" };
      },
    });

    await expect(service.pull("mem", { path: "x", maxBytes: 3 })).rejects.toMatchObject({ code: "connector/limit" });
    await expect(service.pull("off", { path: "x" })).rejects.toMatchObject({ code: "connector/disabled" });
    await expect(service.pull("missing", { path: "x" })).rejects.toMatchObject({ code: "connector/unknown" });

    const first = await service.pull("mem", { path: "x" });
    const second = await service.pull("mem", { path: "x" });
    expect(first.name).toBe("unsafe name.txt");
    expect(first.localPath).not.toBe(second.localPath);
    expect(first.localPath.startsWith(join(directory, "imports"))).toBe(true);
  });

  it("reports invalid configuration without leaking secrets", async () => {
    const registry = new CloudConnectorRegistry();
    registerBuiltinCloudConnectors(registry);
    const service = createCloudConnectorService({
      registry,
      connectors: [{ id: "gd", kind: "gdrive", tokenEnv: "MISSING_TOKEN" }],
      importsDirectory: join(tempRoot(), "imports"),
      env: {},
    });

    await expect(service.list("gd", { path: "root" })).rejects.toBeInstanceOf(CloudConnectorError);
    await expect(service.list("gd", { path: "root" })).rejects.toMatchObject({ code: "connector/auth" });
    expect(service.instances()).toEqual([
      expect.objectContaining({ id: "gd", kind: "gdrive", enabled: true, state: "invalid", errorCode: "connector/auth" }),
    ]);
  });

  it("uploads only from allowlisted roots, enforces the cap, and returns a sha256 receipt", async () => {
    const root = tempRoot();
    const imports = join(root, "imports");
    mkdirSync(imports, { recursive: true });
    const inside = join(imports, "artifact.txt");
    const outside = join(root, "outside.txt");
    writeFileSync(inside, "abc");
    writeFileSync(outside, "secret");
    const upload = vi.fn(async (input: { path: string; overwrite?: boolean }, body: Uint8Array) => ({
      name: input.path.split("/").pop() ?? "upload",
      path: input.path,
      bytes: body.byteLength,
    }));
    const registry = new CloudConnectorRegistry();
    registry.register(definition("acme/memory"), () => ({
      async list() { return []; },
      async pull() { return { name: "x" }; },
      upload,
    }) as never);
    const service = createCloudConnectorService({
      registry,
      connectors: [{ id: "mem", kind: "acme/memory" }],
      importsDirectory: imports,
      env: {},
      now: () => Date.parse("2026-11-24T06:00:00Z"),
    });

    const result = await service.upload("mem", { path: "out/artifact.txt", sourcePath: inside });
    expect(result).toMatchObject({
      connectorId: "mem", path: "out/artifact.txt", name: "artifact.txt", bytes: 3,
      sha256: createHash("sha256").update("abc").digest("hex"),
    });
    expect(upload).toHaveBeenCalledWith({ path: "out/artifact.txt", overwrite: false }, Buffer.from("abc"));
    await expect(service.upload("mem", { path: "out/x", sourcePath: outside })).rejects.toMatchObject({ code: "connector/path" });
    await expect(service.upload("mem", { path: "out/x", sourcePath: inside, maxBytes: 2 })).rejects.toMatchObject({ code: "connector/limit" });
  });

  it("lists only regular files in the imports directory", () => {
    const root = tempRoot();
    const imports = join(root, "imports");
    mkdirSync(imports, { recursive: true });
    writeFileSync(join(imports, "a.txt"), "abc");
    mkdirSync(join(imports, "nested"));
    writeFileSync(join(imports, ".hidden"), "x");
    const registry = new CloudConnectorRegistry();
    registry.register(definition("acme/memory"), () => ({
      async list() { return []; },
      async pull() { return { name: "x" }; },
      upload: async () => ({ name: "x", path: "x", bytes: 0 }),
    }) as never);
    const service = createCloudConnectorService({
      registry,
      connectors: [],
      importsDirectory: imports,
      env: {},
    });
    expect(service.imports()).toEqual([
      expect.objectContaining({ name: "a.txt", bytes: 3, path: join(imports, "a.txt") }),
    ]);
  });
});
