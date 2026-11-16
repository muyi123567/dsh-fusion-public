/**
 * Read fan-out accounting (review 05 P1-1, measurement before any
 * caching). One state GET fans out to three bridge loaders,
 * several bridge HTTP calls, and session-controller reads, and
 * nothing counted any of it, so amplification was unmeasurable.
 * These counters are cumulative for the lifetime of one plugin
 * apply and are surfaced on the state payload as the `reads`
 * block; they count reads from every caller (routes and tools
 * alike), with the route layer broken out separately.
 *
 * Privacy: the HTTP layer is counted by path template only. The
 * room session id segment is replaced by a placeholder and query
 * strings are dropped, so no real session id or header value is
 * ever recorded.
 */
export interface ReadCountsSnapshot {
  routes: { state: number; sessionHub: number; history: number };
  loaders: { agentTeams: number; agentBus: number; room: number };
  bridgeHttp: { total: number; byTemplate: Record<string, number> };
  controller: { list: number; projections: number; page: number };
}

const ROOM_SESSION_PREFIX = "/agent-team-room/api/session/";

export function bridgeHttpTemplate(path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  if (withoutQuery.startsWith(ROOM_SESSION_PREFIX)) {
    return `${ROOM_SESSION_PREFIX}{sessionId}`;
  }
  return withoutQuery;
}

export class ReadCounts {
  private readonly routes = { state: 0, sessionHub: 0, history: 0 };
  private readonly loaders = { agentTeams: 0, agentBus: 0, room: 0 };
  private bridgeHttpTotal = 0;
  private readonly bridgeHttpByTemplate = new Map<string, number>();
  private readonly controller = { list: 0, projections: 0, page: 0 };

  countRoute(route: keyof ReadCountsSnapshot["routes"]): void {
    this.routes[route] += 1;
  }

  countLoader(loader: keyof ReadCountsSnapshot["loaders"]): void {
    this.loaders[loader] += 1;
  }

  countBridgeHttp(path: string): void {
    this.bridgeHttpTotal += 1;
    const template = bridgeHttpTemplate(path);
    this.bridgeHttpByTemplate.set(
      template,
      (this.bridgeHttpByTemplate.get(template) ?? 0) + 1,
    );
  }

  countController(method: keyof ReadCountsSnapshot["controller"]): void {
    this.controller[method] += 1;
  }

  snapshot(): ReadCountsSnapshot {
    return {
      routes: { ...this.routes },
      loaders: { ...this.loaders },
      bridgeHttp: {
        total: this.bridgeHttpTotal,
        byTemplate: Object.fromEntries(this.bridgeHttpByTemplate),
      },
      controller: { ...this.controller },
    };
  }
}
