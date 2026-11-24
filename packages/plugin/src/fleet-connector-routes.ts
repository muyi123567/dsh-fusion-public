import { jsonResponse, type HttpResponse } from "./http.js";
import { isJsonRequest, isSameOriginMutation } from "./auth.js";
import { CloudConnectorError, type WhaleConnectorServiceV1 } from "./cloud-connectors.js";

interface Request {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

const BASE = "/plugins/dsh-fusion/fleet/connectors";

function errorStatus(error: CloudConnectorError): number {
  switch (error.code) {
    case "connector/unknown":
    case "connector/not-found":
      return 404;
    case "connector/disabled":
    case "connector/auth":
      return 409;
    case "connector/exists":
      return 409;
    case "connector/config":
    case "connector/path":
    case "connector/limit":
      return 400;
    case "connector/timeout":
      return 504;
    default:
      return 502;
  }
}

function routeError(response: HttpResponse, error: unknown): void {
  if (error instanceof CloudConnectorError) {
    jsonResponse(response, errorStatus(error), { error: error.code });
    return;
  }
  jsonResponse(response, 503, { error: "connector/unavailable" });
}

export function createFleetConnectorRoutes<T extends Request>(options: {
  service: WhaleConnectorServiceV1;
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
    get(BASE, async () => ({ catalog: options.service.catalog(), instances: options.service.instances() })),
    get(`${BASE}/list`, async (url) => {
      const id = url.searchParams.get("id");
      if (id === null || id === "") throw new CloudConnectorError("connector/config", "id 必填");
      const limit = Number(url.searchParams.get("limit") ?? "");
      return {
        entries: await options.service.list(id, {
          ...(url.searchParams.get("path") === null ? {} : { path: url.searchParams.get("path")! }),
          ...(url.searchParams.get("query") === null ? {} : { query: url.searchParams.get("query")! }),
          ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        }),
      };
    }),
    {
      kind: "exact" as const,
      path: `${BASE}/pull`,
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
          const id = body.id;
          const path = body.path;
          if (typeof id !== "string" || id === "" || typeof path !== "string" || path === "") {
            throw new CloudConnectorError("connector/config", "id 与 path 必填");
          }
          const maxBytes = typeof body.maxBytes === "number" && Number.isFinite(body.maxBytes) ? body.maxBytes : undefined;
          jsonResponse(response, 200, await options.service.pull(id, {
            path,
            ...(typeof body.name === "string" && body.name !== "" ? { name: body.name } : {}),
            ...(maxBytes === undefined ? {} : { maxBytes }),
          }));
        } catch (error) {
          routeError(response, error);
        }
      },
    },
    {
      kind: "exact" as const,
      path: `${BASE}/upload`,
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
          const id = body.id;
          const path = body.path;
          const sourcePath = body.sourcePath;
          if (typeof id !== "string" || id === "" || typeof path !== "string" || path === ""
            || typeof sourcePath !== "string" || sourcePath === "") {
            throw new CloudConnectorError("connector/config", "id、path 与 sourcePath 必填");
          }
          const maxBytes = typeof body.maxBytes === "number" && Number.isFinite(body.maxBytes) ? body.maxBytes : undefined;
          jsonResponse(response, 200, await options.service.upload(id, {
            path,
            sourcePath,
            overwrite: body.overwrite === true,
            ...(maxBytes === undefined ? {} : { maxBytes }),
          }));
        } catch (error) {
          routeError(response, error);
        }
      },
    },
  ];
}
