import { ZodError } from "zod";
import { compilePath, matchPath, type CompiledPath } from "../../core/path";
import { invalidateRuntimeCache } from "../repository";
import { gate } from "./auth";
import { handleAuthRoute } from "./auth-routes";
import { HttpError, routes, type Route } from "./handlers";
import { csrfProblem, json } from "./http";

const PREFIX = "/api/admin";
const compiled: { route: Route; path: CompiledPath }[] = routes.map((route) => ({ route, path: compilePath(route.path) }));

export async function handleAdmin(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || "/" : url.pathname;

  if (path.startsWith("/auth/")) return handleAuthRoute(request, path);

  // Closed unless signed in (or, before any admin exists, addressed to this machine). Checked before routing so strangers learn nothing.
  const denied = await gate(request);
  if (denied) return json(denied.status, { error: denied.error, ...(denied.login ? { login: true } : {}) });

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
