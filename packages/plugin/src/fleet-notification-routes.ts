import { jsonResponse, type HttpResponse } from "./http.js";
import { isJsonRequest, isSameOriginMutation } from "./auth.js";
import {
  NotificationAdapterError,
  type WhaleNotificationServiceV1,
} from "./fleet-notification-adapters.js";

interface Request {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

const BASE = "/plugins/dsh-fusion/fleet/notifications";

function routeError(response: HttpResponse, error: unknown): void {
  if (error instanceof NotificationAdapterError) {
    const status = error.code === "notification/unknown" ? 404
      : error.code === "notification/config" ? 400
      : error.code === "notification/auth" ? 409
      : error.code === "notification/unavailable" ? 503
      : 502;
    jsonResponse(response, status, { error: error.code });
    return;
  }
  jsonResponse(response, 503, { error: "notification/unavailable" });
}

export function createFleetNotificationRoutes<T extends Request>(options: {
  service: WhaleNotificationServiceV1;
  authenticate: (request: T, response: HttpResponse) => boolean;
  readBody?: (request: T) => Promise<Record<string, unknown>>;
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
          jsonResponse(response, 200, {
            catalog: options.service.catalog(),
            adapters: options.service.adapters(),
            receipts: options.service.receipts().slice(-50),
          });
        } catch (error) {
          routeError(response, error);
        }
      },
    },
    {
      kind: "exact" as const,
      path: `${BASE}/test`,
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
          const body = options.readBody === undefined ? {} : await options.readBody(request);
          const adapterId = body.adapterId;
          if (adapterId !== undefined && typeof adapterId !== "string") {
            throw new NotificationAdapterError("notification/config", "adapterId 无效");
          }
          jsonResponse(response, 200, { receipts: await options.service.test(adapterId) });
        } catch (error) {
          routeError(response, error);
        }
      },
    },
  ];
}
