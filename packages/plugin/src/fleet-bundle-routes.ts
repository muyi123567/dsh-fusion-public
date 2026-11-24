import { jsonResponse, type HttpResponse } from "./http.js";
import { isJsonRequest, isSameOriginMutation } from "./auth.js";
import { FleetBundleError, type WhaleBundleServiceV1 } from "./fleet-host-bundle.js";

interface Request {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

const BASE = "/plugins/dsh-fusion/fleet/bundle";

function routeError(response: HttpResponse, error: unknown): void {
  if (error instanceof FleetBundleError) {
    const status = error.code === "bundle/key-unavailable" ? 503
      : error.code === "bundle/digest-invalid" || error.code === "bundle/key-mismatch"
        || error.code === "bundle/signature-invalid" ? 409
      : 400;
    jsonResponse(response, status, { error: error.code });
    return;
  }
  jsonResponse(response, 503, { error: "bundle/unavailable" });
}

export function createFleetBundleRoutes<T extends Request>(options: {
  service: WhaleBundleServiceV1;
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
          jsonResponse(response, 200, await options.service.exportHost());
        } catch (error) {
          routeError(response, error);
        }
      },
    },
    {
      kind: "exact" as const,
      path: `${BASE}/import`,
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
          if (body.bundle === undefined) throw new FleetBundleError("bundle/invalid", "bundle 必填");
          jsonResponse(response, 200, await options.service.importHost(body.bundle, {
            pinTrust: body.pinTrust === true,
            saveExpected: body.saveExpected === true,
          }));
        } catch (error) {
          routeError(response, error);
        }
      },
    },
  ];
}
