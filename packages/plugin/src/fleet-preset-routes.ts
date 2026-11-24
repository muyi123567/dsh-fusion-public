import { jsonResponse, type HttpResponse } from "./http.js";
import { isJsonRequest, isSameOriginMutation } from "./auth.js";
import { PresetError, type WhalePresetServiceV1 } from "./fleet-presets.js";

interface Request {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

const BASE = "/plugins/dsh-fusion/fleet/presets";

function routeError(response: HttpResponse, error: unknown): void {
  if (error instanceof PresetError) {
    const status = error.code === "preset/not-skill" ? 404
      : error.code === "preset/exists" || error.code === "preset/modified" || error.code === "preset/foreign" ? 409
      : error.code === "preset/too-large" ? 413
      : 400;
    jsonResponse(response, status, { error: error.code });
    return;
  }
  jsonResponse(response, 503, { error: "preset/unavailable" });
}

export function createFleetPresetRoutes<T extends Request>(options: {
  service: WhalePresetServiceV1;
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
        jsonResponse(response, 200, handle(body));
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
        jsonResponse(response, 200, { presets: options.service.list() });
      },
    },
    mutate(`${BASE}/skills/install`, body => {
      if (typeof body.id !== "string" || body.id === "") throw new PresetError("preset/id-invalid", "id 必填");
      return { installed: options.service.installSkill(body.id, { overwrite: body.overwrite === true }) };
    }),
    mutate(`${BASE}/skills/uninstall`, body => {
      if (typeof body.id !== "string" || body.id === "") throw new PresetError("preset/id-invalid", "id 必填");
      return { removed: options.service.uninstallSkill(body.id, { force: body.force === true }) };
    }),
  ];
}
