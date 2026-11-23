import { JSONPath } from "jsonpath-plus";
import type { Matcher, MockRequest } from "./types";

export interface MatchContext {
  req: MockRequest;
  /** Path params extracted by the endpoint's path pattern */
  params: Record<string, string>;
}

function asString(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** All candidate values a matcher can see. Empty array = the source has no value. */
function readValues(m: Matcher, { req, params }: MatchContext): string[] {
  switch (m.source) {
    case "header": {
      const v = req.headers[m.expr.toLowerCase()];
      return v === undefined ? [] : [v];
    }
    case "query": {
      const v = req.query[m.expr];
      return v === undefined ? [] : Array.isArray(v) ? v : [v];
    }
    case "path": {
      const v = params[m.expr];
      return v === undefined ? [] : [v];
    }
    case "body": {
      if (req.body === null || typeof req.body !== "object") return [];
      const expr = m.expr.startsWith("$") ? m.expr : `$.${m.expr}`;
      try {
        const found = JSONPath({ path: expr, json: req.body as object, wrap: true, eval: "safe" }) as unknown[];
        return found.filter((x) => x !== undefined).map(asString);
      } catch {
        return []; // invalid JSONPath never matches
      }
    }
  }
}

export function testMatcher(m: Matcher, ctx: MatchContext): boolean {
  const values = readValues(m, ctx);
  if (m.op === "exists") return values.length > 0;
  if (values.length === 0) return false;
  const expected = m.value ?? "";
  switch (m.op) {
    case "equals":
      return values.some((v) => v === expected);
    case "contains":
      return values.some((v) => v.includes(expected));
    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(expected);
      } catch {
        return false;
      }
      return values.some((v) => re.test(v));
    }
  }
}

export function describeMatcher(m: Matcher): string {
  return m.op === "exists" ? `${m.source} ${m.expr} exists` : `${m.source} ${m.expr} ${m.op} "${m.value ?? ""}"`;
}

/** Every matcher must pass. Returns the first failing one for diagnostics. */
export function testAll(matchers: Matcher[], ctx: MatchContext): { ok: true } | { ok: false; failed: Matcher } {
  for (const m of matchers) {
    if (!testMatcher(m, ctx)) return { ok: false, failed: m };
  }
  return { ok: true };
}
