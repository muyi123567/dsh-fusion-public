import Fastify, { type FastifyInstance } from "fastify";
import { registerEventRoutes } from "./routes/events.js";
import { registerNodeRoutes } from "./routes/nodes.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { createDemoSnapshot, createEmptySnapshot, DemoStore } from "./store/demo-store.js";

export interface FusionAppOptions {
  demo?: boolean;
  store?: DemoStore;
}

export function createFusionApp(options: FusionAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const demo = options.demo === true;
  const store = options.store ?? new DemoStore(demo ? createDemoSnapshot() : createEmptySnapshot());

  app.get("/api/fusion/health", async () => ({ ok: true, demo }));
  app.get("/api/fusion/snapshot", async () => ({ demo, ...store.snapshot() }));
  registerNodeRoutes(app, store);
  registerTaskRoutes(app, store);
  registerEventRoutes(app, store);
  return app;
}
