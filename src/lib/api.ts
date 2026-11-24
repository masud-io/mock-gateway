import type * as S from "@/db/schema";

// Row types come straight from the DB schema (type-only import, erased at build), with Dates as ISO strings
// because that is what JSON delivers.
type J<T> = T extends Date ? string : T extends (infer U)[] ? J<U>[] : T extends object ? { [K in keyof T]: J<T[K]> } : T;

export type Rule = J<typeof S.responseRules.$inferSelect>;
export type Scenario = J<typeof S.scenarios.$inferSelect>;
export type Variable = J<typeof S.variables.$inferSelect>;
export type Matcher = { source: "header" | "query" | "body" | "path"; expr: string; op: "equals" | "not_equals" | "contains" | "regex" | "exists" | "not_exists"; value?: string };
export type ErrorTemplate = { status: number; contentType: string; body: string };

export interface TreeEndpoint { id: string; name: string; method: string; path: string; operation?: string | null; soapAction?: string | null; enabled: boolean }
export interface TreeCollection { id: string; name: string; slug: string; protocol: "rest" | "soap"; mode: string; endpoints: TreeEndpoint[] }
export interface TreeProject { id: string; name: string; slug: string; outage: boolean; collections: TreeCollection[] }
export interface TreeClient { id: string; name: string; slug: string; projects: TreeProject[] }

export interface ProjectDetail {
  project: J<typeof S.projects.$inferSelect>;
  client: J<typeof S.clients.$inferSelect>;
  scenarios: Scenario[];
  variables: Variable[];
  collections: { id: string; name: string; slug: string; protocol: "rest" | "soap"; mode: string; endpointCount: number; mockBase: string }[];
  mockBase: string;
}

export interface Credential { id: string; label: string; keyId: string | null; scopes: string[]; expiresAt: string | null; isActive: boolean }
export interface AuthScheme {
  id: string;
  type: "none" | "api_key" | "bearer" | "basic" | "oauth2" | "hmac";
  config: Record<string, unknown>;
  onFail: ErrorTemplate | null;
  mode: "strict" | "warn" | "off";
  credentials: Credential[];
}
export interface CollectionDetail {
  collection: J<typeof S.collections.$inferSelect>;
  project: J<typeof S.projects.$inferSelect>;
  client: J<typeof S.clients.$inferSelect>;
  endpoints: TreeEndpoint[];
  authScheme: AuthScheme | null;
  variables: Variable[];
  mockBase: string;
}
export interface EndpointDetail {
  endpoint: J<typeof S.endpoints.$inferSelect>;
  collection: J<typeof S.collections.$inferSelect>;
  project: J<typeof S.projects.$inferSelect>;
  client: J<typeof S.clients.$inferSelect>;
  rules: Rule[];
  scenarios: Scenario[];
  mockBase: string;
}
export interface LogRow {
  id: number; at: string; method: string; path: string; responseStatus: number; durationMs: number;
  matched: boolean; explanation: string | null; projectId: string | null;
}
export type LogDetail = J<typeof S.requestLogs.$inferSelect>;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && (data as { login?: boolean }).login && typeof window !== "undefined" && !location.pathname.startsWith("/login")) {
    // Session missing or expired: go sign in, then come back here
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload on purpose
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface AdminUser { id: string; email: string; name: string; createdAt: string }
export interface AuthStatus { authRequired: boolean; setupNeeded: boolean; canSetup: boolean; user: AdminUser | null }
