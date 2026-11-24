import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FleetNotificationRegistry,
  createFleetNotificationService,
  registerBuiltinNotificationAdapters,
  type FleetNotificationAdapterDefinition,
} from "./fleet-notification-adapters.js";
import type { FleetNotificationEvent } from "./fleet-notifications.js";

const servers: Array<ReturnType<typeof createServer>> = [];
const roots: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const event: FleetNotificationEvent = {
  type: "created",
  requestId: "req-1",
  taskId: "task-1",
  jobId: "verify",
  nodeId: "worker-a",
  requestedBy: "Chief",
  status: "pending",
};

async function receiver() {
  const calls: Array<{ path: string; body: string; headers: Record<string, string | string[] | undefined> }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      calls.push({
        path: request.url ?? "/",
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers,
      });
      response.writeHead(204);
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { calls, base: `http://127.0.0.1:${address.port}` };
}

function definition(kind: string): FleetNotificationAdapterDefinition {
  return {
    kind,
    displayName: kind,
    category: "test",
    description: "test",
    receipt: false,
    fields: [],
  };
}

describe("notification adapter registry", () => {
  it("ships popular IM adapters and protects built-in kinds", () => {
    const registry = new FleetNotificationRegistry();
    registerBuiltinNotificationAdapters(registry);
    expect(registry.catalog().map(entry => entry.kind)).toEqual(
      expect.arrayContaining(["dsh-im", "webhook", "slack", "feishu", "dingtalk", "telegram", "discord"]),
    );
    expect(codeOf(() => registry.register(definition("slack"), () => {
      throw new Error("unused");
    }))).toBe("notification/kind-reserved");
    expect(() => registry.register(definition("acme/push"), () => {
      throw new Error("unused");
    })).not.toThrow();
    expect(codeOf(() => registry.register(definition("nonsense"), () => {
      throw new Error("unused");
    }))).toBe("notification/kind-namespace");
  });
});

describe("notification adapter service", () => {
  it("delivers one event through webhook, Slack, Feishu, DingTalk, Telegram and Discord with receipts", async () => {
    const http = await receiver();
    const root = mkdtempSync(join(tmpdir(), "fusion-notify-"));
    roots.push(root);
    const service = createFleetNotificationService({
      directory: join(root, "notifications.json"),
      adapters: [
        { id: "hook", kind: "webhook", url: `${http.base}/webhook`, secret: "hook-secret" },
        { id: "slack", kind: "slack", url: `${http.base}/slack` },
        { id: "feishu", kind: "feishu", url: `${http.base}/feishu` },
        { id: "ding", kind: "dingtalk", url: `${http.base}/dingtalk`, secret: "ding-secret" },
        { id: "tg", kind: "telegram", apiBase: http.base, tokenEnv: "TG_TOKEN", chatId: "42" },
        { id: "discord", kind: "discord", url: `${http.base}/discord` },
      ],
      env: { TG_TOKEN: "123:secret-token" },
      now: () => Date.parse("2026-11-23T12:00:00Z"),
    });

    const receipts = await service.deliver(event);
    expect(receipts.map(receipt => receipt.status)).toEqual(Array(6).fill("delivered"));
    expect(receipts.every(receipt => receipt.eventType === "created")).toBe(true);
    expect(JSON.stringify(receipts)).not.toContain("secret-token");

    const paths = http.calls.map(call => call.path);
    expect(paths).toEqual(expect.arrayContaining([
      "/webhook", "/slack", "/feishu", expect.stringMatching(/^\/dingtalk\?/u), "/discord",
      expect.stringMatching(/^\/bot123:secret-token\/sendMessage$/u),
    ]));

    const bodyOf = (path: string) => JSON.parse(http.calls.find(call => call.path.startsWith(path))!.body);
    expect(bodyOf("/webhook")).toMatchObject({ source: "dsh-fusion", event: { requestId: "req-1" } });
    expect(http.calls.find(call => call.path === "/webhook")!.headers["x-dsh-fusion-signature"])
      .toMatch(/^sha256=[a-f0-9]{64}$/u);
    expect(bodyOf("/slack")).toEqual({ text: expect.stringContaining("待审批派发") });
    expect(bodyOf("/feishu")).toMatchObject({ msg_type: "text", content: { text: expect.stringContaining("待审批派发") } });
    expect(bodyOf("/dingtalk")).toMatchObject({ msgtype: "text", text: { content: expect.stringContaining("待审批派发") } });
    expect(bodyOf("/discord")).toEqual({ content: expect.stringContaining("待审批派发") });
    const telegram = http.calls.find(call => call.path.includes("/sendMessage"))!;
    expect(JSON.parse(telegram.body)).toMatchObject({ chat_id: "42", text: expect.stringContaining("待审批派发") });

    const dingUrl = new URL(`http://x${http.calls.find(call => call.path.startsWith("/dingtalk"))!.path}`);
    const timestamp = dingUrl.searchParams.get("timestamp")!;
    const sign = dingUrl.searchParams.get("sign")!;
    const expected = createHmac("sha256", "ding-secret").update(`${timestamp}\nding-secret`).digest("base64");
    expect(sign).toBe(expected);
  });

  it("uses dsh-im sendChecked receipts and preserves an unknown outcome without retrying", async () => {
    const sendChecked = vi.fn(async () => ({
      sent: true,
      receipt: { version: 1, messageId: "om_1", conversationId: "oc_1" },
    }));
    const service = createFleetNotificationService({
      adapters: [{ id: "im", kind: "dsh-im", botId: "bot-1", targetId: "group-1" }],
      dshIm: { sendChecked, send: vi.fn() },
      env: {},
      now: () => Date.parse("2026-11-23T12:00:00Z"),
    });
    const [delivered] = await service.deliver(event);
    expect(delivered).toMatchObject({
      adapterId: "im",
      status: "delivered",
      receipt: { version: 1, messageId: "om_1", conversationId: "oc_1" },
    });
    expect(sendChecked).toHaveBeenCalledWith(
      "bot-1", "group-1", expect.stringContaining("待审批派发"), { format: "plain", receipt: true },
    );

    const unknownSender = vi.fn(async () => {
      const error = new Error("unknown") as Error & { code: string };
      error.code = "send-result-unknown";
      throw error;
    });
    const unknownService = createFleetNotificationService({
      adapters: [{ id: "im", kind: "dsh-im", botId: "bot-1", targetId: "group-1" }],
      dshIm: { sendChecked: unknownSender, send: vi.fn() },
      env: {},
    });
    const [unknown] = await unknownService.deliver(event);
    expect(unknown).toMatchObject({ status: "unknown", errorCode: "send-result-unknown" });
    expect(unknownSender).toHaveBeenCalledTimes(1);
  });

  it("isolates failures, filters events, and persists receipt metadata", async () => {
    const http = await receiver();
    const root = mkdtempSync(join(tmpdir(), "fusion-notify-"));
    roots.push(root);
    const path = join(root, "notifications.json");
    const service = createFleetNotificationService({
      directory: path,
      adapters: [
        { id: "good", kind: "slack", url: `${http.base}/good` },
        { id: "bad", kind: "slack", url: "http://127.0.0.1:1/nope", timeoutMs: 200 },
        { id: "failed-only", kind: "slack", url: `${http.base}/failed-only`, events: ["failed"] },
      ],
      env: {},
      now: () => Date.parse("2026-11-23T12:00:00Z"),
    });
    const receipts = await service.deliver(event);
    expect(receipts).toMatchObject([
      { adapterId: "good", status: "delivered" },
      { adapterId: "bad", status: "failed" },
      { adapterId: "failed-only", status: "skipped" },
    ]);
    expect(service.receipts()).toHaveLength(3);

    const restarted = createFleetNotificationService({
      directory: path,
      adapters: [],
      env: {},
    });
    expect(restarted.receipts()).toHaveLength(3);
    expect(restarted.receipts()[0]).toMatchObject({ adapterId: "good" });
  });

  it("marks an adapter invalid when its required secret or URL is missing", async () => {
    const service = createFleetNotificationService({
      adapters: [
        { id: "tg", kind: "telegram", tokenEnv: "MISSING", chatId: "1" },
        { id: "bad-url", kind: "slack", url: "file:///tmp/x" },
      ],
      env: {},
    });
    expect(service.adapters()).toMatchObject([
      { id: "tg", state: "invalid", errorCode: "notification/auth" },
      { id: "bad-url", state: "invalid", errorCode: "notification/config" },
    ]);
    const receipts = await service.deliver(event);
    expect(receipts.every(receipt => receipt.status === "failed")).toBe(true);
  });

  it("does not follow redirects for notification HTTP adapters", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const service = createFleetNotificationService({
      adapters: [{ id: "slack", kind: "slack", url: "https://example.com/hook" }],
      env: {},
      fetch: fetcher as typeof fetch,
    });
    await service.deliver(event);
    expect(fetcher).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: "error" }),
    );
  });
});

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
