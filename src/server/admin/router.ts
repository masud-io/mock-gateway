import { ZodError } from "zod";
import { compilePath, matchPath, type CompiledPath } from "../../core/path";
import { invalidateRuntimeCache } from "../repository";
import { HttpError, routes, type Route } from "./handlers";

const PREFIX = "/api/admin";
const compiled: { route: Route; path: CompiledPath }[] = routes.map((route) => ({ route, path: compilePath(route.path) }));

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * The admin API has no login (solo local tool), so a malicious web page must not be able to drive it
 * from the user's browser. Writes therefore need (a) a same-origin Origin header when one is sent and
 * (b) a JSON content type, which a cross-site form or simple fetch cannot send without a CORS preflight
 * (and we never answer preflights).
 */
function csrfProblem(request: Request): string | null {
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

export async function handleAdmin(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || "/" : url.pathname;

  let hit: { route: Route; params: Record<string, string> } | null = null;
  let pathKnown = false;
  for (const c of compiled) {
    const params = matchPath(c.path, path);
    if (!params) continue;
    pathKnown = true;
    if (c.route.method === request.method) {
      hit = { route: c.route, params };
      break;
    }
  }
  if (!hit) return json(pathKnown ? 405 : 404, { error: pathKnown ? "Method not allowed" : `No admin route for ${request.method} ${path}` });

  const blocked = csrfProblem(request);
  if (blocked) return json(403, { error: blocked });

  try {
    let body: unknown = undefined;
    if (request.method !== "GET" && request.method !== "DELETE") {
      const text = await request.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new HttpError(400, "Request body is not valid JSON");
        }
      }
    }
    const result = await hit.route.run({ params: hit.params, query: url.searchParams, body });
    // One place guarantees the mock engine never serves stale config after an admin write.
    if (request.method !== "GET" && !hit.route.readonly) invalidateRuntimeCache();
    return json(hit.route.status ?? 200, result ?? { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    if (e instanceof ZodError) {
      const issues = e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
      return json(400, { error: `Invalid input: ${issues.join("; ")}`, issues });
    }
    console.error("[mockgw] admin API error:", e);
    return json(500, { error: "Internal error" });
  }
}
