import type { FastifyInstance } from "fastify";
import type { DemoStore } from "../store/demo-store.js";
import { parseCreateTaskInput } from "../store/task-store.js";
import type { EvidenceSubmission, WorkerTaskEvent } from "../tasks/evidence.js";

export function registerTaskRoutes(app: FastifyInstance, store: DemoStore): void {
  app.get("/api/fusion/tasks", async () => ({ tasks: store.snapshot().tasks }));

  app.post("/api/fusion/tasks", async (request, reply) => {
    try {
      return reply.code(201).send(store.createTask(parseCreateTaskInput(request.body)));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/fusion/tasks/:id/cancel", async (request, reply) => {
    const task = store.cancelTask(request.params.id);
    if (task === undefined) return reply.code(404).send({ error: "task not found" });
    return task;
  });

  app.post<{ Params: { id: string }; Body: WorkerTaskEvent }>(
    "/api/fusion/tasks/:id/worker-event",
    async (request, reply) => {
      const task = store.applyWorkerEvent(request.params.id, request.body);
      if (task === undefined) return reply.code(404).send({ error: "task not found" });
      return task;
    },
  );

  app.post<{ Params: { id: string }; Body: EvidenceSubmission }>(
    "/api/fusion/tasks/:id/evidence",
    async (request, reply) => {
      const result = store.completeTaskWithEvidence(request.params.id, request.body);
      if (result === undefined) return reply.code(404).send({ error: "task not found" });
      return reply.code(result.verdict.ok ? 200 : 409).send(result);
    },
  );
}
