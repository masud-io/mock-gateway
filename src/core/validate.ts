import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { MockRequest } from "./types";

// strict:false so provider-doc schemas with unknown keywords still compile; allErrors for a full report.
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const cache = new Map<string, ValidateFunction | Error>();
const CACHE_MAX = 200;

function getValidator(schema: unknown): ValidateFunction | Error {
  const key = JSON.stringify(schema);
  let v = cache.get(key);
  if (!v) {
    try {
      v = ajv.compile(schema as object);
    } catch (e) {
      v = e instanceof Error ? e : new Error(String(e));
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, v);
  }
  return v;
}

/** Check that a JSON Schema compiles. Returns the error message, or null when it's usable. */
export function checkSchema(schema: unknown): string | null {
  if (schema === null || schema === undefined) return null;
  if (typeof schema !== "object" || Array.isArray(schema)) return "schema must be a JSON object";
  const v = getValidator(schema);
  return v instanceof Error ? v.message : null;
}

/** Validate the request body against a JSON Schema. Returns error messages ([] = valid). */
export function validateJsonBody(schema: unknown, req: MockRequest): string[] {
  if (schema === null || schema === undefined || typeof schema !== "object") return [];

  const validator = getValidator(schema);
  if (validator instanceof Error) return [`endpoint schema is invalid: ${validator.message}`];

  if (req.body === null) {
    return req.rawBody ? ["body is not valid JSON"] : ["body is required"];
  }
  if (validator(req.body)) return [];
  return (validator.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`.trim());
}
