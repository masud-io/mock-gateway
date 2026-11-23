import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthSchemeConfig, CredentialConfig, MockRequest } from "./types";

export interface AuthResult {
  ok: boolean;
  /** Shown in the request log, e.g. "api_key accepted (Test key)" */
  reason: string;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function usable(creds: CredentialConfig[], now: Date): CredentialConfig[] {
  return creds.filter((c) => c.isActive && (!c.expiresAt || c.expiresAt > now));
}

const str = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);

function bearerToken(req: MockRequest): string | null {
  const m = /^bearer\s+(.+)$/i.exec(req.headers["authorization"] ?? "");
  return m ? m[1].trim() : null;
}

/**
 * Check a request against a mock-side auth scheme.
 * With no credentials configured, any non-empty credential is accepted ("accept any"),
 * because most of the time you only need the provider's 401 behaviour, not real secrets.
 */
export function checkAuth(scheme: AuthSchemeConfig, req: MockRequest, now = new Date()): AuthResult {
  const creds = usable(scheme.credentials, now);
  const acceptAny = scheme.credentials.length === 0;

  switch (scheme.type) {
    case "none":
      return { ok: true, reason: "no auth required" };

    case "api_key": {
      const where = str(scheme.config.in, "header");
      const name = str(scheme.config.name, "x-api-key");
      const raw = where === "query" ? req.query[name] : req.headers[name.toLowerCase()];
      const given = Array.isArray(raw) ? raw[0] : raw;
      if (!given) return { ok: false, reason: `api_key missing (${where} "${name}")` };
      if (acceptAny) return { ok: true, reason: "api_key accepted (any value)" };
      const hit = creds.find((c) => safeEqual(c.secret, given));
      return hit ? { ok: true, reason: `api_key accepted (${hit.label})` } : { ok: false, reason: "api_key invalid or expired" };
    }

    // OAuth2 bearer tokens are checked like plain bearer tokens until the token endpoint mock exists.
    case "bearer":
    case "oauth2": {
      const token = bearerToken(req);
      if (!token) return { ok: false, reason: "bearer token missing" };
      if (acceptAny) return { ok: true, reason: `${scheme.type} accepted (any token)` };
      const hit = creds.find((c) => safeEqual(c.secret, token));
      return hit ? { ok: true, reason: `${scheme.type} accepted (${hit.label})` } : { ok: false, reason: "bearer token invalid or expired" };
    }

    case "basic": {
      const m = /^basic\s+(.+)$/i.exec(req.headers["authorization"] ?? "");
      if (!m) return { ok: false, reason: "basic credentials missing" };
      const decoded = Buffer.from(m[1], "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx < 0) return { ok: false, reason: "basic credentials malformed" };
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);
      if (acceptAny) return { ok: true, reason: "basic accepted (any user)" };
      const hit = creds.find((c) => c.keyId !== null && safeEqual(c.keyId, user) && safeEqual(c.secret, pass));
      return hit ? { ok: true, reason: `basic accepted (${hit.label})` } : { ok: false, reason: "basic credentials invalid" };
    }

    case "hmac": {
      const header = str(scheme.config.header, "x-signature").toLowerCase();
      const algorithm = str(scheme.config.algorithm, "sha256");
      const encoding = scheme.config.encoding === "base64" ? "base64" : "hex";
      const given = req.headers[header];
      if (!given) return { ok: false, reason: `hmac signature missing (header "${header}")` };
      if (acceptAny) return { ok: true, reason: "hmac accepted (not verified: no secret configured)" };
      for (const c of creds) {
        let expected: string;
        try {
          expected = createHmac(algorithm, c.secret).update(req.rawBody).digest(encoding);
        } catch {
          return { ok: false, reason: `hmac algorithm "${algorithm}" is not supported` };
        }
        // Providers often prefix the digest ("sha256=...")
        if (safeEqual(expected, given) || safeEqual(`${algorithm}=${expected}`, given)) {
          return { ok: true, reason: `hmac accepted (${c.label})` };
        }
      }
      return { ok: false, reason: "hmac signature mismatch" };
    }
  }
}
