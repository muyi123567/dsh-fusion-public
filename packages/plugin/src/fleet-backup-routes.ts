import { jsonResponse, type HttpResponse } from "./http.js";
import { isJsonRequest, isSameOriginMutation } from "./auth.js";
import { BackupError, type WhaleBackupServiceV1 } from "./fleet-backup.js";

interface Request {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

const BASE = "/plugins/dsh-fusion/fleet/backups";

function routeError(response: HttpResponse, error: unknown): void {
  if (error instanceof BackupError) {
    const status = error.code === "backup/not-found" ? 404
      : error.code === "backup/approval-required" || error.code === "backup/verify-failed" ? 409
      : error.code === "backup/id-invalid" ? 400
      : 500;
    jsonResponse(response, status, { error: error.code });
    return;
  }
  jsonResponse(response, 503, { error: "backup/unavailable" });
}

export function createFleetBackupRoutes<T extends Request>(options: {
  service: WhaleBackupServiceV1;
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
        jsonResponse(response, 200, { backups: options.service.list() });
      },
    },
    mutate(`${BASE}/create`, async body => ({
      manifest: await options.service.snapshot(typeof body.reason === "string" && body.reason !== "" ? body.reason : "manual"),
    })),
    mutate(`${BASE}/verify`, body => {
      if (typeof body.id !== "string" || body.id === "") throw new BackupError("backup/id-invalid", "id 必填");
      return options.service.verify(body.id);
    }),
    mutate(`${BASE}/restore`, async body => {
      if (typeof body.id !== "string" || body.id === "") throw new BackupError("backup/id-invalid", "id 必填");
      return await options.service.restore(body.id, {
        dryRun: body.dryRun !== false,
        approve: body.approve === true,
      });
    }),
  ];
}
