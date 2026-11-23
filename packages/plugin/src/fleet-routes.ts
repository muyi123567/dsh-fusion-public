import { jsonResponse, type HttpResponse } from "./http.js";
import { FleetServiceError, type WhaleFleetServiceV1 } from "./fleet-service.js";
import { isJsonRequest, isSameOriginMutation } from "./auth.js";

interface Request {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

const BASE = "/plugins/dsh-fusion/fleet";

function routeError(response: HttpResponse, error: unknown): void {
  if (error instanceof FleetServiceError) {
    const status = error.code === "whale/host-unknown" ? 404
      : error.code === "whale/invalid-input" ? 400
      : error.code === "whale/signature-invalid" ? 409
      : 503;
    jsonResponse(response, status, { error: error.code });
    return;
  }
  jsonResponse(response, 503, { error: "whale/unavailable" });
}

export function createFleetRoutes<T extends Request>(options: {
  service: WhaleFleetServiceV1;
  authenticate: (request: T, response: HttpResponse) => boolean;
  readBody?: (request: T) => Promise<Record<string, unknown>>;
}) {
  const get = (path: string, handle: (url: URL) => Promise<unknown>) => ({
    kind: "exact" as const,
    path,
    handler: async (request: T, response: HttpResponse) => {
      if (options.authenticate(request, response)) return;
      if (request.method !== "GET") {
        jsonResponse(response, 405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        jsonResponse(response, 200, await handle(url));
      } catch (error) {
        routeError(response, error);
      }
    },
  });

  return [
    get(`${BASE}/environment`, async () => await options.service.manifest()),
    get(`${BASE}/hosts`, async () => ({ hosts: await options.service.listHosts() })),
    get(`${BASE}/diff`, async (url) => {
      const hostId = url.searchParams.get("hostId");
      if (hostId === null || hostId === "") throw new FleetServiceError("whale/invalid-input", "hostId 必填");
      return await options.service.diff(hostId, url.searchParams.get("expectedDigest") ?? undefined);
    }),
    get(`${BASE}/doctor`, async () => {
      if (options.service.doctor === undefined) throw new FleetServiceError("whale/doctor-unavailable", "诊断不可用");
      return await options.service.doctor();
    }),
    get(`${BASE}/plan`, async (url) => {
      const hostId = url.searchParams.get("hostId");
      if (hostId === null || hostId === "") throw new FleetServiceError("whale/invalid-input", "hostId 必填");
      return await options.service.plan(hostId, url.searchParams.get("expectedDigest") ?? undefined);
    }),
    {
      kind: "exact" as const,
      path: `${BASE}/expected`,
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
          const hostId = body.hostId;
          if (typeof hostId !== "string" || hostId === "") throw new FleetServiceError("whale/invalid-input", "hostId 必填");
          jsonResponse(response, 200, await options.service.saveExpected(hostId));
        } catch (error) {
          routeError(response, error);
        }
      },
    },
  ];
}
