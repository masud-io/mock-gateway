/**
 * Sample → mock: turn a request/response example copied from a provider's documentation
 * into an endpoint definition (path with params, JSON Schema, response template).
 * Pure functions, no framework or database imports.
 */

export interface ParsedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

// ---------- cURL ----------

/** Split a shell-ish command line into tokens, honouring '…', "…" and backslash escapes. */
function tokenize(input: string): string[] {
  const src = input.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ").trim();
  const out: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end;
      cur += src.slice(i + 1, stop);
      has = true;
      i = stop + 1;
    } else if (ch === '"') {
      i++;
      has = true;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length && /["\\$`]/.test(src[i + 1])) i++;
        cur += src[i++];
      }
      i++;
    } else if (ch === "\\" && i + 1 < src.length) {
      cur += src[i + 1];
      has = true;
      i += 2;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
      i++;
    } else {
      cur += ch;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

const DATA_FLAGS = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json"]);
const SKIP_VALUE_FLAGS = new Set(["-o", "--output", "-m", "--max-time", "--connect-timeout", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "--proxy", "-x", "--cacert", "--cert", "--key", "-w", "--write-out"]);

/** Parse a `curl …` command. Throws a readable Error if there's no URL. */
export function parseCurl(command: string): ParsedRequest {
  const tokens = tokenize(command);
  if (tokens[0]?.toLowerCase() === "curl") tokens.shift();
  let method = "";
  let url = "";
  const headers: Record<string, string> = {};
  const data: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const eq = t.startsWith("--") && t.includes("=") ? t.indexOf("=") : -1;
    const flag = eq > 0 ? t.slice(0, eq) : t;
    const inline = eq > 0 ? t.slice(eq + 1) : undefined;
    const value = () => (inline !== undefined ? inline : tokens[++i] ?? "");
    if (flag === "-X" || flag === "--request") method = value().toUpperCase();
    else if (flag === "-H" || flag === "--header") {
      const h = value();
      const at = h.indexOf(":");
      if (at > 0) headers[h.slice(0, at).trim()] = h.slice(at + 1).trim();
    } else if (flag === "-u" || flag === "--user") headers["Authorization"] = "Basic " + Buffer.from(value()).toString("base64");
    else if (flag === "--url") url = value();
    else if (DATA_FLAGS.has(flag)) {
      data.push(value());
      if (flag === "--json" && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
    } else if (SKIP_VALUE_FLAGS.has(flag)) value();
    else if (flag === "-I" || flag === "--head") method = method || "HEAD";
    else if (!t.startsWith("-") && !url) url = t;
  }
  if (!url) throw new Error("Couldn't find a URL in the cURL command.");
  const body = data.join("&");
  return { method: method || (body ? "POST" : "GET"), url, headers, body };
}

// ---------- path ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED_ID = /^([a-z]{2,8}_)([A-Za-z0-9]{8,})$/;

/** Does this path segment look like an identifier rather than a fixed word? */
function looksLikeId(seg: string): boolean {
  if (/^\d+$/.test(seg)) return true;
  if (UUID.test(seg) || PREFIXED_ID.test(seg)) return true;
  if (/^[0-9a-f]{16,}$/i.test(seg)) return true;
  // Mixed letters and digits of some length (e.g. "A1B2C3D4E5"), but not versions like "v2" or "2024-01"
  return seg.length >= 8 && /\d/.test(seg) && /[A-Za-z]/.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg) && !/^v\d/i.test(seg);
}

const singular = (w: string) => (w.endsWith("ies") ? w.slice(0, -3) + "y" : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const camel = (w: string) => w.replace(/[-_]+(.)/g, (_, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, "");

export interface InferredPath {
  /** e.g. /v1/orders/:id */
  path: string;
  /** Values seen for each parameter in the sample URL, e.g. { id: "123" } */
  params: Record<string, string>;
  query: Record<string, string>;
}

export function inferPath(url: string): InferredPath {
  let pathname: string;
  let search = "";
  try {
    const u = new URL(url, "http://sample.invalid");
    pathname = u.pathname;
    search = u.search;
  } catch {
    pathname = url.split("?")[0];
  }
  const segs = pathname.split("/").filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  const idCount = segs.filter(looksLikeId).length;
  const params: Record<string, string> = {};
  const out = segs.map((seg, i) => {
    if (!looksLikeId(seg)) return seg;
    let name = "id";
    if (idCount > 1) {
      const prev = segs[i - 1] && !looksLikeId(segs[i - 1]) ? camel(singular(segs[i - 1])) : "";
      name = prev ? `${prev}Id` : `id${Object.keys(params).length + 1}`;
    }
    while (name in params) name += "2";
    params[name] = seg;
    return `:${name}`;
  });
  const query: Record<string, string> = {};
  new URLSearchParams(search).forEach((v, k) => { query[k] = v; });
  return { path: "/" + out.join("/"), params, query };
}

// ---------- JSON Schema ----------

type Schema = Record<string, unknown>;

function stringFormat(s: string): string | undefined {
  if (UUID.test(s)) return "uuid";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) return "date-time";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "date";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "email";
  if (/^https?:\/\/\S+$/.test(s)) return "uri";
  return undefined;
}

export function inferSchema(v: unknown): Schema {
  if (v === null) return { type: "null" };
  if (typeof v === "boolean") return { type: "boolean" };
  if (typeof v === "number") return { type: Number.isInteger(v) ? "integer" : "number" };
  if (typeof v === "string") {
    const format = stringFormat(v);
    return format ? { type: "string", format } : { type: "string" };
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return { type: "array" };
    return { type: "array", items: v.map(inferSchema).reduce(mergeSchemas) };
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  const s: Schema = { type: "object", properties: Object.fromEntries(keys.map((k) => [k, inferSchema(o[k])])) };
  if (keys.length) s.required = keys;
  return s;
}

function typesOf(s: Schema): string[] {
  return Array.isArray(s.type) ? (s.type as string[]) : s.type ? [s.type as string] : [];
}

/** Combine two inferred schemas so that both samples would validate. */
function mergeSchemas(a: Schema, b: Schema): Schema {
  const ta = typesOf(a);
  const tb = typesOf(b);
  // integer is a kind of number
  const norm = (t: string[]) => (t.includes("number") ? t.filter((x) => x !== "integer") : t);
  const types = norm([...new Set([...ta, ...tb])]);
  const out: Schema = { type: types.length === 1 ? types[0] : types };
  if (a.format && a.format === b.format) out.format = a.format;
  if (types.includes("object") && ta.includes("object") && tb.includes("object")) {
    const pa = (a.properties ?? {}) as Record<string, Schema>;
    const pb = (b.properties ?? {}) as Record<string, Schema>;
    const props: Record<string, Schema> = {};
    for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) props[k] = pa[k] && pb[k] ? mergeSchemas(pa[k], pb[k]) : pa[k] ?? pb[k];
    out.properties = props;
    const ra = (a.required ?? []) as string[];
    const rb = (b.required ?? []) as string[];
    const req = ra.filter((k) => rb.includes(k));
    if (req.length) out.required = req;
  } else if (types.includes("object")) {
    Object.assign(out, a.properties ? { properties: a.properties, required: a.required } : { properties: b.properties, required: b.required });
  }
  if (types.includes("array")) {
    const ia = a.items as Schema | undefined;
    const ib = b.items as Schema | undefined;
    if (ia && ib) out.items = mergeSchemas(ia, ib);
    else if (ia ?? ib) out.items = ia ?? ib;
  }
  return out;
}

// ---------- response template ----------

export interface Substitution {
  /** Where in the response, e.g. data.id */
  at: string;
  /** What the sample had */
  sample: string;
  /** The template token that replaced it */
  token: string;
  reason: string;
}

interface Leaf { key: string; path: string; value: unknown }

/** Scalar leaves of an object tree (not descending into arrays: their index paths aren't addressable in templates). */
function leaves(v: unknown, path: string[] = [], out: Leaf[] = []): Leaf[] {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, child] of Object.entries(v)) if (/^[A-Za-z_]\w*$/.test(k)) leaves(child, [...path, k], out);
  } else if (path.length && v !== null && typeof v !== "boolean" && (typeof v === "string" ? v.length > 0 : true)) {
    out.push({ key: path[path.length - 1], path: path.join("."), value: v });
  }
  return out;
}

export interface TemplateInput {
  responseBody: string;
  requestBody?: unknown;
  /** Path param values from the sample URL, e.g. { id: "123" } */
  params: Record<string, string>;
}

/**
 * Build a response template from a sample response. Values that are obviously generated
 * (IDs, timestamps) become tokens, and values echoed from the request become references to it.
 */
export function buildTemplate({ responseBody, requestBody, params }: TemplateInput): { template: string; substitutions: Substitution[]; isJson: boolean } {
  const subs: Substitution[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return plainTemplate(responseBody);
  }
  if (parsed === null || typeof parsed !== "object") return { template: responseBody.trim(), substitutions: subs, isJson: true };

  const reqLeaves = requestBody !== undefined ? leaves(requestBody) : [];
  const raw: string[] = []; // raw tokens that replace a whole JSON value
  const marker = (n: number) => `__MOCKGW_TOKEN_${n}__`;
  const place = (at: string, sample: unknown, token: string, reason: string) => {
    subs.push({ at, sample: typeof sample === "string" ? sample : JSON.stringify(sample), token, reason });
    raw.push(token);
    return marker(raw.length - 1);
  };

  const walk = (v: unknown, path: string[]): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...path, `[${i}]`]));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, [...path, k])]));
    const at = path.join(".").replace(/\.\[/g, "[");
    const key = path[path.length - 1] ?? "";
    if (v === null || typeof v === "boolean") return v;

    for (const [name, pv] of Object.entries(params)) {
      if (String(v) === pv) {
        const token = typeof v === "number" ? `{{request.params.${name}}}` : `{{json request.params.${name}}}`;
        return place(at, v, token, `same as the :${name} in the URL`);
      }
    }
    const echo = reqLeaves.find((l) => l.key === key && l.value === v);
    if (echo) return place(at, v, `{{json request.body.${echo.path}}}`, "echoes a field of the request body");

    if (typeof v === "string") {
      if (UUID.test(v)) return place(at, v, "{{json (uuid)}}", "looks like a generated UUID");
      const fmt = stringFormat(v);
      if (fmt === "date-time") return place(at, v, "{{json (now)}}", "timestamp: becomes the current time");
      const m = PREFIXED_ID.exec(v);
      if (m && (key === "id" || /id$/i.test(key))) return place(at, v, `"${m[1]}{{uuid}}"`, "looks like a generated ID");
    }
    if (typeof v === "number" && Number.isInteger(v) && v >= 100 && (key === "id" || /_?id$/i.test(key))) {
      return place(at, v, "{{randomInt 1000 999999}}", "numeric ID: becomes a random number");
    }
    return v;
  };

  const tree = walk(parsed, []);
  let template = JSON.stringify(tree, null, 2);
  template = template.replace(/"__MOCKGW_TOKEN_(\d+)__"/g, (_, n: string) => raw[Number(n)]);
  return { template, substitutions: subs, isJson: true };
}

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * XML flavour of buildTemplate for SOAP: element text that is a UUID or timestamp becomes a token, and text equal to
 * a same-named element of the request becomes a reference to it. Works on the text so the sample's layout survives.
 */
export function buildXmlTemplate(xml: string, requestBody: unknown): { template: string; substitutions: Substitution[] } {
  const subs: Substitution[] = [];
  let out = xml.trim();
  const elementAt = (m: string) => /<(?:[\w.-]+:)?([\w.-]+)/.exec(m)?.[1] ?? "text";

  // Echoes first, so a value taken from the request isn't also treated as a generated one
  for (const leaf of requestBody !== undefined ? leaves(requestBody) : []) {
    if (typeof leaf.value !== "string") continue;
    const re = new RegExp(`(<(?:[\\w.-]+:)?${reEsc(leaf.key)}(?:\\s[^>]*)?>)(${reEsc(xmlText(leaf.value))})(</(?:[\\w.-]+:)?${reEsc(leaf.key)}>)`, "g");
    out = out.replace(re, (_m, open: string, val: string, close: string) => {
      const token = `{{xml request.body.${leaf.path}}}`;
      subs.push({ at: elementAt(open), sample: leaf.value as string, token, reason: "echoes a field of the request" });
      return open + token + close;
    });
  }
  out = out.replace(/>(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)</g, (_m, ts: string, offset: number) => {
    const open = out.lastIndexOf("<", offset);
    subs.push({ at: elementAt(out.slice(open, offset + 1)), sample: ts, token: "{{now}}", reason: "timestamp: becomes the current time" });
    return ">{{now}}<";
  });
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m, offset: number) => {
    const open = out.lastIndexOf("<", offset);
    subs.push({ at: open >= 0 ? elementAt(out.slice(open, offset + 1)) : "text", sample: m, token: "{{uuid}}", reason: "looks like a generated UUID" });
    return "{{uuid}}";
  });
  return { template: out, substitutions: subs };
}

function plainTemplate(text: string): { template: string; substitutions: Substitution[]; isJson: boolean } {
  const subs: Substitution[] = [];
  const template = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => {
    subs.push({ at: "text", sample: m, token: "{{uuid}}", reason: "looks like a generated UUID" });
    return "{{uuid}}";
  });
  return { template, substitutions: subs, isJson: false };
}
