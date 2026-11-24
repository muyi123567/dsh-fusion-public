import { jsonResponse, type HttpResponse } from "./http.js";
import type { WhaleStatusServiceV1 } from "./fleet-status.js";

interface Request {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

export function createFleetStatusRoutes<T extends Request>(options: {
  service: WhaleStatusServiceV1;
  authenticate: (request: T, response: HttpResponse) => boolean;
}) {
  return [{
    kind: "exact" as const,
    path: "/plugins/dsh-fusion/fleet/status",
    handler: async (request: T, response: HttpResponse) => {
      if (options.authenticate(request, response)) return;
      if (request.method !== "GET") {
        jsonResponse(response, 405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
      try {
        jsonResponse(response, 200, await options.service.status());
      } catch {
        jsonResponse(response, 503, { error: "status/unavailable" });
      }
    },
  }];
}
