import { jsonResponse, type HttpResponse } from "./http.js";
import { isJsonRequest, isSameOriginMutation } from "./auth.js";
import { FleetServiceError, type WhaleFleetServiceV1 } from "./fleet-service.js";

interface Request {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

const BASE = "/plugins/dsh-fusion/fleet/trust";

function routeError(response: HttpResponse, error: unknown): void {
  if (error instanceof FleetServiceError) {
    const status = error.code === "whale/invalid-input" || error.code === "whale/trust-key-required" ? 400
      : error.code === "trust/key-mismatch" || error.code === "trust/key-changed" ? 409
      : error.code === "whale/trust-unavailable" ? 503
      : 502;
    jsonResponse(response, status, { error: error.code });
    return;
  }
  jsonResponse(response, 503, { error: "whale/trust-unavailable" });
}

export function createFleetTrustRoutes<T extends Request>(options: {
  service: WhaleFleetServiceV1;
  authenticate: (request: T, response: HttpResponse) => boolean;
  readBody?: (request: T) => Promise<Record<string, unknown>>;
}) {
  return [
    {
      kind: "exact" as const,
      path: BASE,
      handler: async (request: T, response: HttpResponse) => {
        if (options.authenticate(request, response)) return;
        if (request.method === "GET") {
          try {
            if (options.service.trustReport === undefined) throw new FleetServiceError("whale/trust-unavailable", "信任表未配置");
            jsonResponse(response, 200, await options.service.trustReport());
          } catch (error) {
            routeError(response, error);
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
        try {
          if (options.service.trust === undefined) throw new FleetServiceError("whale/trust-unavailable", "信任表未配置");
          const body = options.readBody === undefined ? {} : await options.readBody(request);
          if (typeof body.hostId !== "string" || body.hostId === "") {
            throw new FleetServiceError("whale/invalid-input", "hostId 必填");
          }
          const key = typeof body.publicKeyPem === "string" && body.publicKeyPem !== "" ? body.publicKeyPem : undefined;
          jsonResponse(response, 200, await options.service.trust(body.hostId, key, body.replace === true));
        } catch (error) {
          routeError(response, error);
        }
      },
    },
    {
      kind: "exact" as const,
      path: `${BASE}/revoke`,
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
          if (options.service.revokeTrust === undefined) throw new FleetServiceError("whale/trust-unavailable", "信任表未配置");
          const body = options.readBody === undefined ? {} : await options.readBody(request);
          if (typeof body.hostId !== "string" || body.hostId === "") {
            throw new FleetServiceError("whale/invalid-input", "hostId 必填");
          }
          jsonResponse(response, 200, { revoked: await options.service.revokeTrust(body.hostId) });
        } catch (error) {
          routeError(response, error);
        }
      },
    },
  ];
}
