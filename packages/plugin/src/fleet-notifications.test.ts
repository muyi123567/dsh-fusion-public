import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createFleetWebhook, formatFleetNotification } from "./fleet-notifications.js";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function localReceiver() {
  const received: Array<{ body: string; signature?: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        ...(request.headers["x-dsh-fusion-signature"] === undefined
          ? {}
          : { signature: String(request.headers["x-dsh-fusion-signature"]) }),
      });
      response.writeHead(204);
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { received, url: `http://127.0.0.1:${address.port}/hook` };
}

describe("fleet notifications", () => {
  it("formats a pending approval without leaking a token", () => {
    const text = formatFleetNotification({
      type: "created", requestId: "req-1", taskId: "task-1", jobId: "verify",
      nodeId: "worker-a", requestedBy: "Chief", status: "pending",
    });
    expect(text).toContain("待审批派发");
    expect(text).toContain("Chief");
    expect(text).toContain("verify");
    expect(text).toContain("worker-a");
    expect(text).not.toMatch(/Bearer|token|sourceToken/iu);
  });

  it("formats approval and failure with the attempt/error", () => {
    expect(formatFleetNotification({
      type: "approved", requestId: "req-1", taskId: "task-1", jobId: "verify",
      nodeId: "worker-a", requestedBy: "Chief", status: "approved", attemptId: "attempt-1",
    })).toContain("attempt-1");
    expect(formatFleetNotification({
      type: "failed", requestId: "req-1", taskId: "task-1", jobId: "verify",
      nodeId: "worker-a", requestedBy: "Chief", status: "failed", error: "environment-drift",
    })).toContain("environment-drift");
  });

  it("posts a signed webhook and treats delivery as best effort", async () => {
    const receiver = await localReceiver();
    const notify = createFleetWebhook({ url: receiver.url, secret: "test-secret", timeoutMs: 2_000 });
    const event = {
      type: "created" as const, requestId: "req-1", taskId: "task-1", jobId: "verify",
      nodeId: "worker-a", requestedBy: "Chief", status: "pending",
    };
    expect(await notify(event)).toBe(true);
    expect(receiver.received).toHaveLength(1);
    const payload = JSON.parse(receiver.received[0]!.body);
    expect(payload).toMatchObject({ source: "dsh-fusion", event: { requestId: "req-1" } });
    expect(payload.text).toContain("待审批派发");
    const expected = `sha256=${createHmac("sha256", "test-secret").update(receiver.received[0]!.body).digest("hex")}`;
    expect(receiver.received[0]!.signature).toBe(expected);
  });

  it("returns false for a rejected or unreachable webhook instead of throwing", async () => {
    const notify = createFleetWebhook({ url: "http://127.0.0.1:1/hook", timeoutMs: 200 });
    await expect(notify({
      type: "failed", requestId: "req-1", taskId: "task-1", jobId: "verify",
      nodeId: "worker-a", requestedBy: "Chief", status: "failed", error: "environment-drift",
    })).resolves.toBe(false);
    expect(() => createFleetWebhook({ url: "file:///tmp/hook" })).toThrow(/FLEET_WEBHOOK_URL_INVALID/u);
  });
});
