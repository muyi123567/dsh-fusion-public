import { describe, expect, it } from "vitest";
import { createFusionApp } from "./standalone.js";
import { createDemoSnapshot, DemoStore } from "./store/demo-store.js";

async function readEventWindow(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 250,
  until?: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
    ]);
    if (next === null || next.done) break;
    text += decoder.decode(next.value, { stream: true });
    if (until?.(text) === true) break;
  }
  return text + decoder.decode();
}

async function openEventStream(
  app: ReturnType<typeof createFusionApp>,
  headers: Record<string, string> = {},
) {
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/fusion/events`, {
    headers,
    signal: controller.signal,
  });
  if (response.body === null) throw new Error("event stream body missing");
  return {
    response,
    reader: response.body.getReader(),
    controller,
  };
}

describe("fusion host", () => {
  it("creates a task and returns it in queued state", async () => {
    const app = createFusionApp({ demo: true });
    const response = await app.inject({
      method: "POST",
      url: "/api/fusion/tasks",
      payload: { goal: "run tests", nodeIds: ["tencent"] },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      goal: "run tests",
      status: "queued",
      targetNodeIds: ["tencent"],
    });
  });

  it("rejects a task without a goal", async () => {
    const app = createFusionApp({ demo: true });
    const response = await app.inject({
      method: "POST",
      url: "/api/fusion/tasks",
      payload: { nodeIds: ["tencent"] },
    });

    expect(response.statusCode).toBe(400);
  });

  it("defaults to an empty live snapshot without demo mode", async () => {
    const app = createFusionApp();
    const response = await app.inject({ method: "GET", url: "/api/fusion/snapshot" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      demo: false,
      nodes: [],
      bots: [],
      tasks: [],
    });
  });

  it("does not expose legacy overview, bot, session, or ssh routes", async () => {
    const app = createFusionApp({ demo: true });

    for (const url of [
      "/api/fusion/overview",
      "/api/fusion/bots",
      "/api/fusion/sessions",
      "/api/fusion/ssh/servers",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it("keeps a worker completion claim in verifying state", async () => {
    const app = createFusionApp({ demo: true });
    const response = await app.inject({
      method: "POST",
      url: "/api/fusion/tasks/T-demo-001/worker-event",
      payload: { status: "completed", progress: 100 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("verifying");
  });

  it("rejects completion without expected evidence", async () => {
    const app = createFusionApp({ demo: true });
    const response = await app.inject({
      method: "POST",
      url: "/api/fusion/tasks/T-demo-001/evidence",
      payload: { summary: "done" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      task: { status: "verifying" },
      verdict: { reason: "MISSING_EXPECTED_EVIDENCE" },
    });
  });

  it("does not report config apply success without a configured apply adapter", async () => {
    const app = createFusionApp({ demo: true });
    const response = await app.inject({
      method: "POST",
      url: "/api/fusion/config/apply",
      payload: { nodeId: "tencent" },
    });

    expect(response.statusCode).toBe(501);
  });

  it("does not replay standalone history on a first event connection", async () => {
    const store = new DemoStore(createDemoSnapshot());
    store.publish({ type: "state.updated", scope: "first" });
    store.publish({ type: "state.updated", scope: "second" });
    const app = createFusionApp({ demo: true, store });
    const stream = await openEventStream(app);

    try {
      const text = await readEventWindow(stream.reader);
      expect(text).toContain(": connected");
      expect(text).not.toMatch(/(^|\n)id: /);
    } finally {
      stream.controller.abort();
      await stream.reader.cancel().catch(() => {});
      await app.close();
    }
  });

  it("sends one fusion.gap frame for a future standalone Last-Event-ID", async () => {
    const store = new DemoStore(createDemoSnapshot());
    store.publish({ type: "state.updated", scope: "first" });
    store.publish({ type: "state.updated", scope: "second" });
    const app = createFusionApp({ demo: true, store });
    const stream = await openEventStream(app, { "last-event-id": "99" });

    try {
      const text = await readEventWindow(
        stream.reader,
        500,
        (current) => current.includes("event: fusion.gap"),
      );
      expect(text.match(/event: fusion\.gap/g)).toHaveLength(1);
      const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine === undefined) throw new Error("gap data missing");
      expect(JSON.parse(dataLine.slice("data: ".length))).toEqual({
        afterSeq: 99,
        firstAvailableSeq: 1,
        lastSeq: 2,
        missingFrom: 3,
        missingTo: 99,
        reason: "sequence-reset",
      });
      expect(text).not.toContain("\"type\":\"state.updated\"");
    } finally {
      stream.controller.abort();
      await stream.reader.cancel().catch(() => {});
      await app.close();
    }
  });

  it("replays available standalone history for a valid Last-Event-ID", async () => {
    const store = new DemoStore(createDemoSnapshot());
    store.publish({ type: "state.updated", scope: "first" });
    store.publish({ type: "state.updated", scope: "second" });
    const app = createFusionApp({ demo: true, store });
    const stream = await openEventStream(app, { "last-event-id": "0" });

    try {
      const text = await readEventWindow(
        stream.reader,
        500,
        (current) => current.includes("id: 2"),
      );
      expect(text).toContain("id: 1");
      expect(text).toContain("id: 2");
      expect(text).not.toContain("event: fusion.gap");
    } finally {
      stream.controller.abort();
      await stream.reader.cancel().catch(() => {});
      await app.close();
    }
  });
});
