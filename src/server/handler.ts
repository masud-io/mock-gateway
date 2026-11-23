import { parseBody } from "../core/body";
import { handle } from "../core/engine";
import type { EngineLog, MockRequest } from "../core/types";
import { writeLog } from "./logger";
import { getRuntime } from "./repository";

const PREFIX_SEGMENTS = 4; // "", "mock", client, project, collection -> rest starts at index 5
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noLog = (explanation: string): EngineLog => ({
  endpointId: null, ruleId: null, matched: false, validationErrors: [], authResult: null, explanation,
});

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/**
 * Mock URL shape: /mock/{client}/{project}/{collection}/<anything the third-party API would serve>
 * Takes a standard Web Request so it can be exercised in tests without Next.js.
 */
export async function handleMockRequest(request: Request): Promise<Response> {
  const started = Date.now();
  const url = new URL(request.url);

  // Use the raw pathname (not decoded route params) so %2F inside a segment isn't split twice.
  const parts = url.pathname.split("/");
  const [client, project, collectionSlug] = [parts[2], parts[3], parts[4]];
  const rest = "/" + parts.slice(PREFIX_SEGMENTS + 1).join("/");

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return jsonResponse(413, { error: `Request body exceeds ${MAX_BODY_BYTES} bytes` });
  const rawBody = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return jsonResponse(413, { error: `Request body exceeds ${MAX_BODY_BYTES} bytes` });

  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => (headers[k] = v));
  const query: Record<string, string | string[]> = {};
  for (const [k, v] of url.searchParams) {
    const prev = query[k];
    query[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }

  const req: MockRequest = {
    method: request.method.toUpperCase(),
    path: rest,
    query,
    headers,
    rawBody,
    body: parseBody(headers["content-type"], rawBody),
  };

  const snapshot = client && project && collectionSlug ? await getRuntime(client, project) : null;
  const collection = snapshot?.collections.get(collectionSlug ?? "");

  let status: number;
  let body: string;
  let outHeaders: Record<string, string>;
  let log: EngineLog;
  let delayMs = 0;

  if (!snapshot || !collection) {
    const why = !snapshot
      ? `No project "${client}/${project}". URL format: /mock/{client}/{project}/{collection}/…`
      : `Project has no collection "${collectionSlug}". Collections: ${[...snapshot.collections.keys()].join(", ") || "(none)"}`;
    status = 404;
    body = JSON.stringify({ error: "Unknown mock route", hint: why });
    outHeaders = { "content-type": "application/json" };
    log = noLog(why);
  } else {
    const res = handle({ req, collection, project: snapshot.project, baseUrl: `${url.origin}/mock/${client}/${project}/${collectionSlug}` });
    ({ status, body, headers: outHeaders, log, delayMs } = res);
  }

  if (delayMs > 0) await sleep(delayMs);

  // Fire-and-forget: a logging failure must never break a mock response
  writeLog({
    projectId: snapshot?.project.id ?? null,
    collectionId: collection?.id ?? null,
    method: req.method,
    path: url.pathname + url.search,
    requestHeaders: headers,
    requestBody: rawBody,
    responseStatus: status,
    responseBody: body,
    durationMs: Date.now() - started,
    engine: log,
  }).catch((e) => console.error("[mockgw] failed to write request log:", e));

  if (log.endpointId) outHeaders["x-mockgw-endpoint"] = log.endpointId;
  if (log.ruleId) outHeaders["x-mockgw-rule"] = log.ruleId;

  // 1xx/204/205/304 must not carry a body; HEAD never does
  const bodyless = req.method === "HEAD" || [204, 205, 304].includes(status);
  return new Response(bodyless ? null : body, { status, headers: outHeaders });
}
