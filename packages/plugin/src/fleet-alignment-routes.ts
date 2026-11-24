import { jsonResponse, type HttpResponse } from "./http.js";
import { isJsonRequest, isSameOriginMutation } from "./auth.js";
import { AlignmentError, type WhaleAlignmentServiceV1 } from "./fleet-alignment.js";

interface Request {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

const BASE = "/plugins/dsh-fusion/fleet/alignment";

function routeError(response: HttpResponse, error: unknown): void {
  if (error instanceof AlignmentError) {
    const status = error.code === "alignment/not-found" ? 404
      : error.code === "alignment/plan-changed" || error.code === "alignment/state" ? 409
      : error.code === "alignment/unavailable" ? 503
      : 400;
    jsonResponse(response, status, { error: error.code });
    return;
  }
  jsonResponse(response, 503, { error: "alignment/unavailable" });
}

export function createFleetAlignmentRoutes<T extends Request>(options: {
  service: WhaleAlignmentServiceV1;
  authenticate: (request: T, response: HttpResponse) => boolean;
  readBody?: (request: T) => Promise<Record<string, unknown>>;
}) {
  const mutate = (path: string, handle: (body: Record<string, unknown>) => unknown) => ({
    kind: "exact" as const,
    path,
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
        jsonResponse(response, 200, await handle(body));
      } catch (error) {
        routeError(response, error);
      }
    },
  });

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
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const id = url.searchParams.get("id");
        if (id !== null && id !== "") {
          const requestValue = options.service.get(id);
          if (requestValue === undefined) {
            jsonResponse(response, 404, { error: "alignment/not-found" });
            return;
          }
          jsonResponse(response, 200, requestValue);
          return;
        }
        jsonResponse(response, 200, { requests: options.service.list() });
      },
    },
    mutate(`${BASE}/plan`, async body => {
      if (typeof body.hostId !== "string" || body.hostId === "") {
        throw new AlignmentError("alignment/local-only", "hostId 必填");
      }
      return await options.service.plan(
        body.hostId,
        typeof body.expectedDigest === "string" && body.expectedDigest !== "" ? body.expectedDigest : undefined,
      );
    }),
    mutate(`${BASE}/request`, async body => {
      if (typeof body.hostId !== "string" || body.hostId === "") {
        throw new AlignmentError("alignment/local-only", "hostId 必填");
      }
      return {
        request: await options.service.create({
          hostId: body.hostId,
          ...(typeof body.expectedDigest === "string" && body.expectedDigest !== ""
            ? { expectedDigest: body.expectedDigest }
            : {}),
          requestedBy: typeof body.requestedBy === "string" && body.requestedBy !== "" ? body.requestedBy : "panel",
          source: "web",
        }),
      };
    }),
    mutate(`${BASE}/approve`, async body => {
      if (typeof body.id !== "string" || body.id === "") {
        throw new AlignmentError("alignment/not-found", "id 必填");
      }
      return { request: await options.service.approve(body.id, "panel") };
    }),
    mutate(`${BASE}/cancel`, async body => {
      if (typeof body.id !== "string" || body.id === "") {
        throw new AlignmentError("alignment/not-found", "id 必填");
      }
      return { request: await options.service.cancel(body.id) };
    }),
  ];
}
