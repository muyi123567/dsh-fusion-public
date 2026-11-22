import { describe, expect, it, vi } from "vitest";
import { createNativeExecutionRoutes } from "./native-execution-routes.js";
import type { createNativeTaskExecution } from "./native-task-execution.js";

type Service = ReturnType<typeof createNativeTaskExecution>;

function harness(service: Service | undefined) {
  const read = vi.fn(async () => ({
    jobs: [], attempts: [], taskAvailable: true, sourceToken: "f".repeat(64),
  }));
  const start = vi.fn(async (_input: Record<string, unknown>) => ({
    id: "attempt-1", taskId: "dsh-native-team:team:task", sourceToken: "f".repeat(64),
    jobId: "verify", nodeId: "worker", requestId: "request-1", workerTaskId: "HUAWEI-1",
    createdAt: "2026-11-20T00:00:00.000Z", sourceState: "current" as const,
    executionState: "running" as const,
  }));
  const review = vi.fn(async () => ({
    id: "attempt-1", taskId: "dsh-native-team:team:task", sourceToken: "f".repeat(64),
    jobId: "verify", nodeId: "worker", requestId: "request-1", workerTaskId: "HUAWEI-1",
    createdAt: "2026-11-20T00:00:00.000Z", sourceState: "current" as const,
    executionState: "running" as const,
  }));
  const concrete = service === undefined ? undefined : { ...service, read, start, review } as unknown as Service;
  let body: Record<string, unknown> = {};
  let authorized = true;
  const routes = createNativeExecutionRoutes({
    service: concrete,
    authenticate: (_request, response) => {
      if (authorized) return false;
      response.writeHead(401, {});
      response.end("{}");
      return true;
    },
    readBody: async () => body,
  });
  const responses: Array<{ status: number; headers: Record<string, string>; body: string }> = [];
  const invoke = async (path: string, request: Record<string, unknown> = {}) => {
    const result = { status: 0, headers: {}, body: "" };
    const route = routes.find((entry) => entry.path === path)!;
    await route.handler({ method: "GET", ...request }, {
      writeHead: (status, headers) => { result.status = status; result.headers = headers; },
      end: (value) => { result.body = value ?? ""; },
    });
    responses.push(result);
    return result;
  };
  return {
    read, start, review,
    setBody(value: Record<string, unknown>) { body = value; },
    setAuthorized(value: boolean) { authorized = value; },
    invoke,
  };
}

const PATH = "/plugins/dsh-fusion/tasks/execution";

describe("native execution HTTP boundary", () => {
  it("keeps unconfigured execution unavailable", async () => {
    const subject = harness(undefined);
    const response = await subject.invoke(PATH, { url: PATH + "?taskId=task-1" });
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: "execution-not-configured" });
  });

  it("checks DSH authentication before reading or dispatching a mutation", async () => {
    const subject = harness({} as Service);
    subject.setAuthorized(false);
    subject.setBody({ taskId: "task-1", sourceToken: "x", jobId: "j", nodeId: "n", requestId: "r" });
    const response = await subject.invoke(PATH, {
      method: "POST", headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(401);
    expect(subject.start).not.toHaveBeenCalled();
  });

  it("rejects cross-site writes before the service can start work", async () => {
    const subject = harness({} as Service);
    subject.setBody({ taskId: "task-1", sourceToken: "x", jobId: "j", nodeId: "n", requestId: "r" });
    const response = await subject.invoke(PATH, {
      method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
    });
    expect(response.status).toBe(403);
    expect(subject.start).not.toHaveBeenCalled();
  });

  it("exposes only a fresh read and selected native attempt through the route", async () => {
    const subject = harness({} as Service);
    const get = await subject.invoke(PATH, { url: PATH + "?taskId=native%3Atask" });
    expect(get.status).toBe(200);
    expect(subject.read).toHaveBeenCalledWith("native:task");

    subject.setBody({ taskId: "dsh-native-team:team:task", sourceToken: "f".repeat(64),
      jobId: "verify", nodeId: "worker", requestId: "request-1" });
    const post = await subject.invoke(PATH, {
      method: "POST", headers: { "content-type": "application/json" },
    });
    expect(post.status).toBe(202);
    expect(subject.start).toHaveBeenCalledWith({
      taskId: "dsh-native-team:team:task", sourceToken: "f".repeat(64),
      jobId: "verify", nodeId: "worker", requestId: "request-1",
    });
  });

  it("requires same-origin JSON for the independent-review mutation", async () => {
    const subject = harness({} as Service);
    subject.setBody({ taskId: "task", attemptId: "attempt", receiptSha256: "a".repeat(64),
      reviewerId: "reviewer", verdict: "passed", summary: "checked", signature: "signature" });
    const response = await subject.invoke(PATH + "/review", {
      method: "POST", headers: { "content-type": "text/plain", origin: "https://elsewhere.invalid", host: "local.invalid" },
    });
    expect(response.status).toBe(403);
    expect(subject.review).not.toHaveBeenCalled();
  });
});
