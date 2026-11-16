import type { FastifyInstance } from "fastify";
import type { DemoStore } from "../store/demo-store.js";

export function registerNodeRoutes(app: FastifyInstance, store: DemoStore): void {
  app.get("/api/fusion/nodes", async () => ({ nodes: store.snapshot().nodes }));
  app.get("/api/fusion/config/status", async () => ({ config: store.snapshot().config }));
  app.post("/api/fusion/config/render", async (_request, reply) => reply.code(501).send({
    ok: false,
    error: "CONFIG_RENDER_ADAPTER_NOT_CONFIGURED",
  }));
  app.post("/api/fusion/config/apply", async (_request, reply) => reply.code(501).send({
    ok: false,
    error: "CONFIG_APPLY_ADAPTER_NOT_CONFIGURED",
  }));
}
