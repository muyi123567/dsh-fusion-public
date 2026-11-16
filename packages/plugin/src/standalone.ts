import { createReadStream, existsSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { createFusionApp } from "@dsh-fusion/host/standalone";
import type { FastifyInstance } from "fastify";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export interface StandaloneOptions {
  host?: string;
  port?: number;
  clientDist?: string;
}

export interface StandaloneServer {
  app: FastifyInstance;
  url: string;
}

export async function startStandalone(options: StandaloneOptions = {}): Promise<StandaloneServer> {
  const app = createFusionApp({ demo: true });
  const clientDist = options.clientDist ?? resolve(process.cwd(), "packages/client/dist");

  app.get("/*", async (request, reply) => {
    const requestedPath = request.url.split("?")[0] ?? "/";
    const relativePath = requestedPath === "/" ? "index.html" : requestedPath.replace(/^\/+/, "");
    const candidate = resolve(clientDist, relativePath);
    const relativeCandidate = relative(clientDist, candidate);
    const safeCandidate = relativeCandidate === ""
      || (!relativeCandidate.startsWith("..") && !isAbsolute(relativeCandidate))
      ? candidate
      : resolve(clientDist, "index.html");
    const filePath = existsSync(safeCandidate) ? safeCandidate : resolve(clientDist, "index.html");
    if (!existsSync(filePath)) {
      return reply.code(503).send({ error: "CLIENT_BUILD_MISSING", clientDist });
    }
    return reply.type(contentTypes[extname(filePath)] ?? "application/octet-stream").send(createReadStream(filePath));
  });

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  await app.listen({ host, port });
  return { app, url: `http://${host}:${port}` };
}
