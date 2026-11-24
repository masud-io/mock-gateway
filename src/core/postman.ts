/** Postman collection (v2.0 / v2.1) -> the app's own export format. Every request becomes an endpoint; its saved example
 *  responses become rules. Pure: no database, so it is easy to test. Never throws on odd input, it skips and says why. */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function isPostmanCollection(raw: unknown): boolean {
  return isObj(raw) && isObj(raw.info) && /getpostman\.com|postman/i.test(str(raw.info.schema)) && Array.isArray(raw.item);
}

/** "/orders/:id" from a Postman url (object with path[], or a raw string). {{var}} segments become :var. */
function pathOf(url: unknown, asEndpoint = true): string {
  let segments: string[];
  if (isObj(url) && Array.isArray(url.path)) {
    segments = url.path.map((s) => (isObj(s) ? str(s.value) : str(s)));
  } else {
    const raw = typeof url === "string" ? url : isObj(url) ? str(url.raw) : "";
    const noHost = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "").replace(/^\{\{[^}]+\}\}/, "");
    segments = noHost.split("?")[0].split("/");
  }
  // An endpoint path turns {{var}} into a :param; a saved request keeps it as a variable ({{vars.var}}) to be filled in when sent
  const cleaned = segments.map((s) => s.replace(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g, asEndpoint ? ":$1" : "{{vars.$1}}")).filter((s) => s !== "");
  return "/" + cleaned.join("/");
}

const headerValue = (headers: unknown, name: string): string | null => {
  if (!Array.isArray(headers)) return null;
  const h = headers.find((x) => isObj(x) && str(x.key).toLowerCase() === name);
  return isObj(h) ? str(h.value) : null;
};

/** `{{` in an example would be read as a template; escape it so the example is returned exactly as saved. */
const literal = (s: string) => s.replace(/\{\{/g, "\\{{");

const PLACEHOLDER = [{ source: "header" as const, expr: "x-edit-me", op: "exists" as const }];

export interface PostmanResult {
  file: unknown;
  warnings: string[];
}

export function postmanToExport(raw: unknown): PostmanResult {
  const warnings: string[] = [];
  const root = raw as Json;
  const info = root.info as Json;
  const name = str(info.name).trim() || "Postman import";

  type Req = { name: string; method: string; path: string; examples: Json[] };
  const requests: Req[] = [];
  // The same requests, kept as saved requests ready to send: Postman's {{var}} becomes {{vars.var}}
  const saved: { name: string; folder: string | null; method: string; path: string; headers: Record<string, string>; body: string }[] = [];
  const SAVED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
  const asVars = (s: string) => s.replace(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g, "{{vars.$1}}");
  const walk = (items: unknown[], folder: string | null) => {
    for (const it of items) {
      if (!isObj(it)) continue;
      if (Array.isArray(it.item)) {
        walk(it.item, str(it.name).trim() || folder);
        continue;
      }
      const r = it.request;
      if (!isObj(r)) continue;
      const method = (str(r.method) || "GET").toUpperCase();
      const name = str(it.name).trim() || "Request";
      requests.push({ name, method, path: pathOf(r.url), examples: Array.isArray(it.response) ? it.response.filter(isObj) : [] });
      if (SAVED_METHODS.has(method)) {
        const headers: Record<string, string> = {};
        if (Array.isArray(r.header)) {
          for (const h of r.header) {
            if (isObj(h) && h.disabled !== true && str(h.key) && !/^content-length$/i.test(str(h.key))) headers[str(h.key)] = asVars(str(h.value));
          }
        }
        const rawBody = isObj(r.body) && r.body.mode === "raw" ? str(r.body.raw) : "";
        saved.push({ name, folder, method, path: pathOf(r.url, false), headers, body: asVars(rawBody) });
      }
    }
  };
  walk(raw && Array.isArray(root.item) ? root.item : [], null);

  const seen = new Set<string>();
  const endpoints = [];
  for (const rq of requests) {
    const key = `${rq.method} ${rq.path}`;
    if (seen.has(key)) {
      warnings.push(`Skipped "${rq.name}": ${key} was already imported from another request.`);
      continue;
    }
    seen.add(key);
    const rules = rq.examples.length
      ? rq.examples.map((ex, i) => {
          const status = Number.isInteger(ex.code) && (ex.code as number) >= 100 && (ex.code as number) <= 599 ? (ex.code as number) : 200;
          const contentType = headerValue(ex.header, "content-type")?.split(";")[0].trim() || (/^\s*[{[]/.test(str(ex.body)) ? "application/json" : "text/plain");
          const headers: Record<string, string> = {};
          if (Array.isArray(ex.header)) {
            for (const h of ex.header) {
              if (!isObj(h) || !str(h.key) || /^(content-type|content-length|transfer-encoding|connection|date|server)$/i.test(str(h.key))) continue;
              headers[str(h.key)] = literal(str(h.value));
            }
          }
          return {
            scenario: null,
            name: str(ex.name).trim() || `Example ${i + 1}`,
            priority: i * 10,
            isDefault: i === 0,
            // Only the first example answers by default; the others wait for a condition so they cannot hijack every call
            conditions: i === 0 ? [] : PLACEHOLDER,
            status, headers, contentType, body: literal(str(ex.body)), delayMs: 0, faultType: null, faultRate: null,
          };
        })
      : [{ scenario: null, name: "default", priority: 0, isDefault: true, conditions: [], status: 200, headers: {}, contentType: "application/json", body: "{}", delayMs: 0, faultType: null, faultRate: null }];
    if (rq.examples.length > 1) warnings.push(`"${rq.name}": ${rq.examples.length - 1} extra example(s) were added as rules with a placeholder condition. Set their conditions.`);
    if (!rq.examples.length) warnings.push(`"${rq.name}" has no saved example response, so it answers {} until you edit it.`);
    endpoints.push({ name: rq.name, method: rq.method, path: rq.path, soapAction: null, operation: null, requestSchema: null, matchers: [], enabled: true, rules });
  }
  if (!endpoints.length) warnings.push("No requests were found in this Postman collection.");
  warnings.push("Imported from Postman: requests (also under Requests, ready to send), paths, methods and saved examples. Postman {{variables}} became {{vars.name}}: define them as variables. Authorization, scripts, variable values and tests are not imported.");

  return {
    file: {
      format: "mock-gateway/collection", version: 1,
      collection: { name, slug: name, protocol: "rest" },
      variables: [], endpoints, requests: saved, excluded: { authSchemes: 0, secretVariables: 0 },
    },
    warnings,
  };
}
