import { isJsonRequest, isSameOriginMutation, type AuthHeaders } from "./auth.js";
import { jsonResponse, type HttpResponse } from "./http.js";
import { NativeTaskExecutionError, type createNativeTaskExecution } from "./native-task-execution.js";

interface Request {
  url?: string;
  method?: string;
  headers?: AuthHeaders;
}

const BASE = "/plugins/dsh-fusion/tasks/execution";

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value === "") throw new NativeTaskExecutionError("invalid-input");
  return value;
}

function sendError(response: HttpResponse, error: unknown) {
  if (!(error instanceof NativeTaskExecutionError)) {
    jsonResponse(response, 503, { error: "execution-unavailable" });
    return;
  }
  const status = {
    "invalid-input": 400, "task-missing": 410, "source-unavailable": 503,
    "source-stale": 409, "job-unavailable": 409, "attempt-conflict": 409,
    "attempt-missing": 410, "receipt-unavailable": 409, "review-untrusted": 403,
    "review-invalid": 422, "store-unavailable": 503,
  } satisfies Record<NativeTaskExecutionError["code"], number>;
  jsonResponse(response, status[error.code], { error: error.code });
}

export function createNativeExecutionRoutes<T extends Request>(options: {
  service: ReturnType<typeof createNativeTaskExecution> | undefined;
  authenticate: (request: T, response: HttpResponse) => boolean;
  readBody: (request: T) => Promise<Record<string, unknown>>;
}) {
  return [BASE, `${BASE}/review`].map((path) => ({
    kind: "exact" as const,
    path,
    handler: async (request: T, response: HttpResponse) => {
      if (options.authenticate(request, response)) return;
      const { service } = options;
      if (service === undefined) {
        jsonResponse(response, 404, { error: "execution-not-configured" });
        return;
      }
      if (path === BASE && request.method === "GET") {
        try {
          const taskId = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("taskId");
          jsonResponse(response, 200, await service.read(requiredString({ taskId }, "taskId")));
        } catch (error) {
          sendError(response, error);
        }
        return;
      }
      if (request.method !== "POST") {
        jsonResponse(response, 405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
      if (!isSameOriginMutation(request.headers)) {
        jsonResponse(response, 403, { error: "CROSS_SITE_MUTATION_REJECTED" });
        return;
      }
      if (!isJsonRequest(request.headers)) {
        jsonResponse(response, 415, { error: "APPLICATION_JSON_REQUIRED" });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = await options.readBody(request);
      } catch {
        jsonResponse(response, 400, { error: "invalid-input" });
        return;
      }
      try {
        const taskId = requiredString(body, "taskId");
        if (path === BASE) {
          const attempt = await service.start({
            taskId,
            sourceToken: requiredString(body, "sourceToken"),
            jobId: requiredString(body, "jobId"),
            nodeId: requiredString(body, "nodeId"),
            requestId: requiredString(body, "requestId"),
          });
          jsonResponse(response, 202, attempt);
          return;
        }
        const verdict = body.verdict;
        if (verdict !== "passed" && verdict !== "failed") throw new NativeTaskExecutionError("invalid-input");
        const attempt = await service.review({
          taskId,
          attemptId: requiredString(body, "attemptId"),
          receiptSha256: requiredString(body, "receiptSha256"),
          reviewerId: requiredString(body, "reviewerId"),
          verdict,
          summary: requiredString(body, "summary"),
          signature: requiredString(body, "signature"),
        });
        jsonResponse(response, 200, attempt);
      } catch (error) {
        sendError(response, error);
      }
    },
  }));
}
