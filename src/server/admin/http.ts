export const json = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

/**
 * A malicious web page must not be able to drive the admin API from a signed-in browser. Writes therefore need
 * (a) a same-origin Origin header when one is sent and (b) a JSON content type, which a cross-site form or
 * simple fetch cannot send without a CORS preflight (and we never answer preflights).
 */
export function csrfProblem(request: Request): string | null {
  if (request.method === "GET") return null;
  const origin = request.headers.get("origin");
  if (origin) {
    let sameHost = false;
    try {
      sameHost = new URL(origin).host === request.headers.get("host");
    } catch {
      /* malformed origin stays rejected */
    }
    if (!sameHost) return "Cross-origin requests to the admin API are not allowed";
  }
  const hasBody = Number(request.headers.get("content-length") ?? 0) > 0;
  if (hasBody && !(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return "Admin API writes must use Content-Type: application/json";
  }
  return null;
}
