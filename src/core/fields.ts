/** Reads a pasted sample request (SOAP XML, JSON, form data or a cURL command) and lists every field a condition can look at,
 *  with the exact expression the mock would match it by. Pure: no database. */
import { parseBody } from "./body";
import { parseCurl } from "./infer";
import { parseEnvelope, wrapEnvelope } from "./soap";

export interface RequestField {
  source: "body" | "header" | "query";
  /** What goes in the condition: a JSONPath for the body, a name for a header or query parameter */
  expr: string;
  value: string;
}

export interface ReadFields {
  fields: RequestField[];
  /** What the sample was understood as, e.g. "SOAP request: GetTokenRequest" */
  summary: string;
}

const MAX_FIELDS = 300;
// Plain identifiers use dot notation; anything else (attributes like "@_Response", names with dashes or dots) goes in brackets
const seg = (k: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? `.${k}` : `['${k.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`);
const SKIP_HEADERS = new Set(["host", "content-length", "connection", "accept", "accept-encoding", "accept-language", "user-agent", "cache-control", "pragma"]);

function flatten(v: unknown, path: string, out: RequestField[]): void {
  if (out.length >= MAX_FIELDS) return;
  if (Array.isArray(v)) {
    v.forEach((x, i) => flatten(x, `${path}[${i}]`, out));
  } else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) flatten(x, path + seg(k), out);
  } else if (v !== undefined && v !== null) {
    out.push({ source: "body", expr: path, value: String(v) });
  }
}

/** Throws an Error with a readable message when the sample cannot be understood. */
export function readRequestFields(text: string, protocol: "rest" | "soap"): ReadFields {
  const input = text.trim();
  if (!input) throw new Error("Paste a sample request first.");

  let body = input;
  let contentType: string | undefined;
  let headers: Record<string, string> = {};
  let url = "";
  let method = "";
  if (/^curl\s/i.test(input)) {
    const c = parseCurl(input);
    body = c.body;
    headers = Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k.toLowerCase(), v]));
    contentType = headers["content-type"];
    url = c.url;
    method = c.method;
  }

  const fields: RequestField[] = [];
  let summary: string;
  if (protocol === "soap") {
    const env = parseEnvelope(wrapEnvelope("1.1", body), headers);
    if ("error" in env) throw new Error(env.error);
    flatten(env.body, "$", fields);
    summary = `SOAP request: ${env.operation}`;
  } else {
    const parsed = parseBody(contentType, body);
    if (parsed === null && body.trim()) {
      if (!url) throw new Error("The body is not JSON or form data. Paste JSON, or a cURL command.");
    }
    flatten(parsed, "$", fields);
    summary = `${method ? `${method} ` : ""}${parsed === null ? "request without a body" : "JSON/form body"}`;
  }

  if (url) {
    try {
      for (const [k, v] of new URL(url, "http://sample.invalid").searchParams) fields.push({ source: "query", expr: k, value: v });
    } catch { /* an unparsable URL just contributes no query fields */ }
  }
  for (const [k, v] of Object.entries(headers)) {
    if (!SKIP_HEADERS.has(k)) fields.push({ source: "header", expr: k, value: v });
  }
  if (!fields.length) throw new Error("No fields found in that request: it needs a body with at least one value.");
  return { fields: fields.slice(0, MAX_FIELDS), summary };
}
