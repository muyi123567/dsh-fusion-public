import { isJsonRequest, isSameOriginMutation, type AuthHeaders } from "./auth.js";
import { jsonResponse, type HttpResponse } from "./http.js";
import {
  DispatchRequestError,
  type FleetDispatchRequestService,
} from "./fleet-dispatch-requests.js";

interface Request {
  url?: string;
  method?: string;
  headers?: AuthHeaders;
}

const BASE = "/plugins/dsh-fusion/fleet/dispatch-requests";

function errorResponse(response: HttpResponse, error: unknown): void {
  if (!(error instanceof DispatchRequestError)) {
    jsonResponse(response, 503, { error: "dispatch-requests-unavailable" });
    return;
  }
  const status = {
    "invalid-input": 400, "request-conflict": 409, "request-not-found": 404,
    "request-not-pending": 409, "request-expired": 410, "dispatch-failed": 409,
    "store-invalid": 503,
  }[error.code];
  jsonResponse(response, status, { error: error.code });
}

export function createFleetDispatchRoutes<T extends Request>(options: {
  service: FleetDispatchRequestService;
  authenticate: (request: T, response: HttpResponse) => boolean;
  readBody: (request: T) => Promise<Record<string, unknown>>;
}) {
  return [
    {
      kind: "exact" as const,
      path: BASE,
      handler: async (request: T, response: HttpResponse) => {
        if (options.authenticate(request, response)) return;
        if (request.method !== "GET") {
          jsonResponse(response, 405, { error: "METHOD_NOT_ALLOWED" });
          return;
        }
        try {
          jsonResponse(response, 200, { requests: await options.service.list() });
        } catch (error) {
          errorResponse(response, error);
        }
      },
    },
    {
      kind: "exact" as const,
      path: `${BASE}/approve`,
      handler: async (request: T, response: HttpResponse) => {
        if (options.authenticate(request, response)) return;
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
        try {
          const body = await options.readBody(request);
          const id = body.id;
          if (typeof id !== "string" || id === "") throw new DispatchRequestError("invalid-input");
          const approved = await options.service.approve(id, "panel");
          jsonResponse(response, 200, approved);
        } catch (error) {
          errorResponse(response, error);
        }
      },
    },
    {
      kind: "exact" as const,
      path: `${BASE}/reject`,
      handler: async (request: T, response: HttpResponse) => {
        if (options.authenticate(request, response)) return;
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
        try {
          const body = await options.readBody(request);
          const id = body.id;
          const reason = body.reason;
          if (typeof id !== "string" || id === "" || (reason !== undefined && typeof reason !== "string")) {
            throw new DispatchRequestError("invalid-input");
          }
          jsonResponse(response, 200, await options.service.reject(id, reason ?? "", "panel"));
        } catch (error) {
          errorResponse(response, error);
        }
      },
    },
  ];
}
