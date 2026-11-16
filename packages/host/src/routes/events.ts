import type { FastifyInstance } from "fastify";
import {
  encodeSseEventFrame,
  encodeSseGapFrame,
} from "../events/event-bus.js";
import type { DemoStore } from "../store/demo-store.js";

export function registerEventRoutes(app: FastifyInstance, store: DemoStore): void {
  app.get("/api/fusion/events", async (request, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.hijack();
    reply.raw.write(": connected\n\n");

    const rawLastEventId = request.headers["last-event-id"];
    const lastEventId = Array.isArray(rawLastEventId) ? rawLastEventId[0] : rawLastEventId;
    if (lastEventId !== undefined) {
      const replay = store.replayWithGap(Number(lastEventId));
      if (replay.gap !== null) {
        reply.raw.write(encodeSseGapFrame(replay.gap));
      } else {
        for (const event of replay.events) {
          reply.raw.write(encodeSseEventFrame(event as { seq: number } & Record<string, unknown>));
        }
      }
    }

    const unsubscribe = store.subscribe((event) => {
      reply.raw.write(encodeSseEventFrame(event as { seq: number } & Record<string, unknown>));
    });
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
    heartbeat.unref?.();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);
  });
}
