// Framework-free types for the mock engine. Nothing in src/core may import Next.js or the database,
// so the engine can later move into a separate Fastify runtime unchanged.

export type Protocol = "rest" | "soap";
export type ValidationMode = "strict" | "warn" | "off";
export type CollectionMode = "mock" | "pass_through" | "record";
export type AuthType = "none" | "api_key" | "bearer" | "basic" | "oauth2" | "hmac";

export type Matcher = {
  source: "header" | "query" | "body" | "path";
  /** header/query/path-param name, or a JSONPath expression for `body` */
  expr: string;
  op: "equals" | "not_equals" | "contains" | "regex" | "exists" | "not_exists";
  value?: string;
};

export interface MockRequest {
  method: string;
  /** Path relative to the collection root, always starting with "/" */
  path: string;
  query: Record<string, string | string[]>;
  /** Header names are lower-cased */
  headers: Record<string, string>;
  rawBody: string;
  /** Parsed JSON / form body, or null when the body is empty or not parseable */
  body: unknown;
}

export interface ErrorTemplate {
  status: number;
  contentType: string;
  body: string;
}

export interface RuleConfig {
  id: string;
  name: string;
  scenarioId: string | null;
  priority: number;
  isDefault: boolean;
  conditions: Matcher[];
  status: number;
  headers: Record<string, string>;
  contentType: string;
  body: string;
  delayMs: number;
}

export interface CredentialConfig {
  label: string;
  keyId: string | null;
  /** Decrypted secret / key / password */
  secret: string;
  scopes: string[];
  expiresAt: Date | null;
  isActive: boolean;
}

export interface AuthSchemeConfig {
  id: string;
  /** null = applies to the whole collection */
  endpointId: string | null;
  type: AuthType;
  config: Record<string, unknown>;
  onFail: ErrorTemplate | null;
  mode: ValidationMode;
  credentials: CredentialConfig[];
}

export interface EndpointConfig {
  id: string;
  name: string;
  method: string;
  path: string;
  requestSchema: unknown;
  /** SOAP: the Body element this endpoint answers, and the SOAPAction it was documented with */
  operation?: string | null;
  soapAction?: string | null;
  matchers: Matcher[];
  enabled: boolean;
  rules: RuleConfig[];
}

export interface CollectionConfig {
  id: string;
  name: string;
  slug: string;
  protocol: Protocol;
  mode: CollectionMode;
  validationMode: ValidationMode;
  errorTemplate: ErrorTemplate | null;
  defaultHeaders: Record<string, string>;
  /** Client + project + collection variables, already merged (collection wins) */
  variables: Record<string, string>;
  /** SOAP: the imported WSDL, served on GET ?wsdl */
  wsdl?: string | null;
  endpoints: EndpointConfig[];
  authSchemes: AuthSchemeConfig[];
}

export interface ProjectContext {
  id: string;
  activeScenarioId: string | null;
  activeScenarioName: string | null;
  globalLatencyMs: number;
  outage: boolean;
}

export interface EngineLog {
  endpointId: string | null;
  ruleId: string | null;
  matched: boolean;
  validationErrors: string[];
  authResult: string | null;
  /** Human-readable "why this rule" / "why no match" */
  explanation: string;
}

export interface EngineResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** The caller sleeps this long before sending; the engine itself never waits */
  delayMs: number;
  log: EngineLog;
}
