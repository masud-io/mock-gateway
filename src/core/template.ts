import Handlebars from "handlebars";
import { randomInt, randomUUID } from "node:crypto";
import { faker } from "@faker-js/faker/locale/en";
import { escapeXml, faultXml, type SoapVersion } from "./soap";

export interface TemplateContext {
  request: {
    method: string;
    path: string;
    params: Record<string, string>;
    query: Record<string, string | string[]>;
    headers: Record<string, string>;
    body: unknown;
    rawBody: string;
  };
  vars: Record<string, string>;
  scenario: string | null;
  /** Set for SOAP requests: lets {{soapFault}} write the right Fault for the client's SOAP version */
  soapVersion?: SoapVersion;
  /** Present when rendering a validation error body */
  errors?: string[];
}

export class TemplateError extends Error {}

// Isolated environment: our helpers never leak into the global Handlebars instance.
const hbs = Handlebars.create();
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

type Opts = Handlebars.HelperOptions;
const isOpts = (v: unknown): v is Opts => typeof v === "object" && v !== null && "hash" in v && "data" in v;
/** Handlebars appends an options object as the last argument; strip it so helpers see only real args. */
const args = (a: unknown[]): unknown[] => a.filter((x) => !isOpts(x));
const opts = (a: unknown[]): Opts => a[a.length - 1] as Opts;
const num = (v: unknown) => Number(v);

hbs.registerHelper("uuid", () => randomUUID());

// {{xml value}}: XML-escaped text, for echoing request values into an XML response
hbs.registerHelper("xml", (...a: unknown[]) => escapeXml(args(a)[0]));
// {{soapFault "Client" "Insufficient balance"}}: a <soap:Fault> in the caller's SOAP version (use with status 500)
hbs.registerHelper("soapFault", (...a: unknown[]) => {
  const [code, message, detail] = args(a);
  const root = opts(a).data?.root as { soapVersion?: SoapVersion } | undefined;
  return faultXml(root?.soapVersion ?? "1.1", String(code ?? "Server"), String(message ?? "Fault"), detail === undefined ? undefined : String(detail));
});

// {{now}} -> ISO timestamp.  {{now days=1}} / {{now hours=-2}} shift it.
hbs.registerHelper("now", (...a: unknown[]) => {
  const h = opts(a).hash as Record<string, unknown>;
  const ms =
    num(h.days ?? 0) * 86_400_000 + num(h.hours ?? 0) * 3_600_000 + num(h.minutes ?? 0) * 60_000 + num(h.seconds ?? 0) * 1000;
  return new Date(Date.now() + ms).toISOString();
});
hbs.registerHelper("epoch", () => String(Date.now()));

hbs.registerHelper("randomInt", (...a: unknown[]) => {
  const [min = 0, max = 100] = args(a).map(num);
  return String(faker.number.int({ min, max }));
});

// {{randomString 24}} -> 24 random letters and digits; {{randomDigits 12}} -> 12 digits, leading zeros kept (a reference number, say).
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const randomChars = (name: string, a: unknown[], alphabet: string) => {
  const n = num(args(a)[0] ?? Number.NaN);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new TemplateError(`${name} needs a length from 1 to 1000, e.g. {{${name} 12}}`);
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
};
hbs.registerHelper("randomString", (...a: unknown[]) => randomChars("randomString", a, ALNUM));
hbs.registerHelper("randomDigits", (...a: unknown[]) => randomChars("randomDigits", a, "0123456789"));

// {{faker "person.fullName"}}, {{faker "finance.amount"}}, {{faker "string.uuid"}} ...
hbs.registerHelper("faker", (...a: unknown[]) => {
  const [path] = args(a);
  if (typeof path !== "string") throw new TemplateError('faker needs a path, e.g. {{faker "person.fullName"}}');
  let parent: unknown = null;
  let cur: unknown = faker;
  for (const part of path.split(".")) {
    if (FORBIDDEN.has(part) || cur === null || typeof cur !== "object") throw new TemplateError(`unknown faker path "${path}"`);
    parent = cur;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur !== "function") throw new TemplateError(`faker path "${path}" is not a function`);
  const v = (cur as () => unknown).call(parent); // call on its module so `this` is intact
  return v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
});

// {{json request.body.items}} -> valid JSON text (strings get quoted/escaped)
hbs.registerHelper("json", (...a: unknown[]) => JSON.stringify(args(a)[0] ?? null));
hbs.registerHelper("default", (...a: unknown[]) => {
  const [v, fallback] = args(a);
  return v === undefined || v === null || v === "" ? fallback : v;
});
hbs.registerHelper("upper", (...a: unknown[]) => String(args(a)[0] ?? "").toUpperCase());
hbs.registerHelper("lower", (...a: unknown[]) => String(args(a)[0] ?? "").toLowerCase());

hbs.registerHelper("eq", (...a: unknown[]) => args(a)[0] === args(a)[1]);
hbs.registerHelper("ne", (...a: unknown[]) => args(a)[0] !== args(a)[1]);
hbs.registerHelper("gt", (...a: unknown[]) => num(args(a)[0]) > num(args(a)[1]));
hbs.registerHelper("lt", (...a: unknown[]) => num(args(a)[0]) < num(args(a)[1]));
hbs.registerHelper("add", (...a: unknown[]) => num(args(a)[0]) + num(args(a)[1]));
hbs.registerHelper("sub", (...a: unknown[]) => num(args(a)[0]) - num(args(a)[1]));
hbs.registerHelper("mul", (...a: unknown[]) => num(args(a)[0]) * num(args(a)[1]));
// {{sum request.body.items "price"}} -> total of items[].price
hbs.registerHelper("sum", (...a: unknown[]) => {
  const [list, key] = args(a);
  if (!Array.isArray(list)) return 0;
  return list.reduce((t, x) => t + num(typeof key === "string" ? (x as Record<string, unknown>)?.[key] : x), 0);
});

// {{#repeat 3}}{"id":{{@index}}}{{#unless @last}},{{/unless}}{{/repeat}}
const MAX_REPEAT = 1000;
hbs.registerHelper("repeat", function (this: unknown, ...a: unknown[]) {
  const o = opts(a);
  const n = Math.min(Math.max(0, Math.floor(num(args(a)[0]))), MAX_REPEAT);
  let out = "";
  for (let i = 0; i < n; i++) {
    out += o.fn(this, { data: { ...o.data, index: i, first: i === 0, last: i === n - 1 } });
  }
  return out;
});

// Literal "}" for the preprocessing below.
hbs.registerHelper("__rb", () => "}");

/**
 * Handlebars lexes `}}}` as the end of a triple-stash, so JSON like {"n":{{json x}}} or
 * {"a":{"b":{{x}}}} fails to parse. Since we never escape (noEscape), `{{{x}}}` is just `{{x}}`;
 * unwrap those, then turn each run of 3+ closing braces into `}}` (closes the tag) followed by one
 * literal-brace helper per extra brace. Runs are handled whole so the output never contains a new `}}}`.
 */
function preprocess(source: string): string {
  return source
    .replace(/\{\{\{([^{}]*?)\}\}\}/g, "{{$1}}")
    .replace(/\}{3,}/g, (run) => "}}" + "{{__rb}}".repeat(run.length - 2));
}

const cache = new Map<string, HandlebarsTemplateDelegate>();
const CACHE_MAX = 500;

function compile(source: string): HandlebarsTemplateDelegate {
  let fn = cache.get(source);
  if (!fn) {
    // noEscape: bodies are JSON/XML, not HTML. Use {{json x}} when injecting a value into JSON.
    fn = hbs.compile(preprocess(source), { noEscape: true });
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(source, fn);
  }
  return fn;
}

/** Syntax-check a template without running it. Returns the error message, or null when it compiles. */
export function checkTemplate(source: string): string | null {
  if (!source.includes("{{")) return null;
  try {
    hbs.precompile(preprocess(source), { noEscape: true });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function renderTemplate(source: string, ctx: TemplateContext): string {
  if (!source.includes("{{")) return source; // fast path for static bodies
  try {
    return compile(source)(ctx);
  } catch (e) {
    throw new TemplateError(e instanceof Error ? e.message : String(e));
  }
}
