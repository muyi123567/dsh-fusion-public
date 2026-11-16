// Browser URL rules for the routes the Fusion panel talks to.
//
// DSH serves the web app with a `<base href="./">` element and mounts its
// own app-owned browser routes at the site root. Its own client code drops
// the leading slash from those routes so they resolve relative to the
// document: `dsh-client-connection` sends `${channel}/${endpoint}`.slice(1)
// and `dsh-client-hmr` uses `"/plugins/events".slice(1)`.
//
// That matters when DSH is deployed under a path prefix. An absolute
// `/plugins/...` URL leaves the prefix and never reaches the server, while a
// document-relative one stays under it.
//
// Routes that Fusion serves itself (the standalone host `/api/fusion/...`)
// are not DSH-owned and keep their absolute form, because that host is
// always reached at its own origin root.

const DSH_OWNED_PREFIX = "/plugins/";

export function isDshOwnedRoute(route: string): boolean {
  return route.startsWith(DSH_OWNED_PREFIX);
}

// Converts a route key into the URL the browser should request.
// DSH-owned routes become document-relative; everything else is unchanged.
export function fusionBrowserUrl(route: string): string {
  if (!isDshOwnedRoute(route)) return route;
  return route.startsWith("/") ? route.slice(1) : route;
}
