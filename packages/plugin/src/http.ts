/**
 * The minimal HTTP surface the Fusion plugin needs from a DSH web server.
 *
 * The plugin talks to DSH's own web server rather than to a framework, so
 * the response shape is small and structural. Keeping it in one module lets
 * the security helpers be tested without booting a host.
 */

export interface HttpResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: string): void;
}

/**
 * Writes a JSON response with the headers DSH's conventions require.
 *
 * `no-store` matters here: these routes answer with live operational state,
 * and a cached copy of a drift report is worse than no copy at all.
 */
export function jsonResponse(
  response: HttpResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
