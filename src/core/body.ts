/** Parse a request body into something matchers and templates can read. Never throws. */
export function parseBody(contentType: string | undefined, raw: string): unknown {
  if (!raw) return null;
  const ct = (contentType ?? "").toLowerCase();

  if (ct.includes("application/x-www-form-urlencoded")) {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(raw)) {
      const prev = out[k];
      out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    return out;
  }

  const looksJson = ct.includes("json") || /^\s*[{[]/.test(raw);
  if (looksJson) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}
