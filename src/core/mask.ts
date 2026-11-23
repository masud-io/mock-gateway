const SENSITIVE = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token"]);

/** Request headers are stored in the log; credentials must never land there in clear text. */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!SENSITIVE.has(k.toLowerCase())) {
      out[k] = v;
      continue;
    }
    // Keep the scheme ("Bearer ***") so the log still shows what kind of credential was sent
    const scheme = /^(bearer|basic|digest)\s/i.exec(v)?.[1];
    out[k] = scheme ? `${scheme} ***` : "***";
  }
  return out;
}

export function truncate(s: string | null | undefined, max = 65536): string | null {
  if (s == null) return null;
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;
}
