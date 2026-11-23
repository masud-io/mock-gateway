import { checkAuth } from "./auth";
import { describeMatcher, testAll } from "./matchers";
import { bySpecificity, compilePath, matchPath, type CompiledPath } from "./path";
import { renderTemplate, TemplateError, type TemplateContext } from "./template";
import type {
  AuthSchemeConfig,
  CollectionConfig,
  EndpointConfig,
  EngineLog,
  EngineResponse,
  ErrorTemplate,
  MockRequest,
  ProjectContext,
  RuleConfig,
} from "./types";
import { faultEnvelope, parseEnvelope, soapContentType, wrapEnvelope, type SoapVersion } from "./soap";
import { validateJsonBody } from "./validate";

export const MAX_DELAY_MS = 60_000;

export interface EngineInput {
  req: MockRequest;
  collection: CollectionConfig;
  project: ProjectContext;
  /** Absolute URL of this collection's mock root: lets a served WSDL point at the mock instead of the real service */
  baseUrl?: string;
}

const compiledCache = new WeakMap<EndpointConfig, CompiledPath>();
function compiled(ep: EndpointConfig): CompiledPath {
  let c = compiledCache.get(ep);
  if (!c) {
    c = compilePath(ep.path);
    compiledCache.set(ep, c);
  }
  return c;
}

function json(status: number, payload: unknown, log: Partial<EngineLog> & { explanation: string }, delayMs = 0): EngineResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    delayMs,
    log: {
      endpointId: null,
      ruleId: null,
      matched: false,
      validationErrors: [],
      authResult: null,
      ...log,
    },
  };
}

const methodMatches = (ep: EndpointConfig, method: string) => {
  const m = ep.method.toUpperCase();
  return m === "*" || m === "ANY" || m === method || (method === "HEAD" && m === "GET");
};

interface Found {
  endpoint: EndpointConfig;
  params: Record<string, string>;
}

function findEndpoint(collection: CollectionConfig, req: MockRequest): Found | { reason: string } {
  const hits: (Found & { c: CompiledPath })[] = [];
  const near: string[] = [];
  const known: string[] = [];

  for (const ep of collection.endpoints) {
    if (!ep.enabled) continue;
    known.push(`${ep.method} ${ep.path}`);
    const c = compiled(ep);
    const params = matchPath(c, req.path);
    if (!params) continue;
    if (!methodMatches(ep, req.method)) {
      near.push(`${ep.method} ${ep.path}: method is ${req.method}, endpoint expects ${ep.method}`);
      continue;
    }
    const m = testAll(ep.matchers, { req, params });
    if (!m.ok) {
      near.push(`${ep.method} ${ep.path}: condition failed (${describeMatcher(m.failed)})`);
      continue;
    }
    hits.push({ endpoint: ep, params, c });
  }

  if (hits.length) {
    hits.sort((a, b) => bySpecificity(a.c, b.c));
    return { endpoint: hits[0].endpoint, params: hits[0].params };
  }
  if (near.length) return { reason: `Path matched but no endpoint accepted the request. ${near.join("; ")}` };
  const sample = known.slice(0, 10).join(", ");
  return { reason: `No endpoint path matches ${req.path}. ${known.length ? `Known: ${sample}${known.length > 10 ? ", …" : ""}` : "This collection has no endpoints yet."}` };
}

function soapFault(version: SoapVersion, status: number, code: string, message: string, log: Partial<EngineLog> & { explanation: string }, delayMs = 0): EngineResponse {
  return {
    status,
    headers: { "content-type": soapContentType(version) },
    body: faultEnvelope(version, code, message),
    delayMs,
    log: { endpointId: null, ruleId: null, matched: false, validationErrors: [], authResult: null, ...log },
  };
}

/** Point the WSDL's <soap:address location="…"> at the mock so SDKs that read it call the mock, not the real service. */
export function pointWsdlAt(wsdl: string, baseUrl: string): string {
  return wsdl.replace(/(<(?:[\w.-]+:)?address\b[^>]*?\blocation\s*=\s*)(["'])[^"']*\2/g, (_m, pre: string, q: string) => `${pre}${q}${baseUrl}${q}`);
}

/** SOAP dispatch: the Body's first element names the operation. SOAPAction is advisory (many clients send it empty). */
function findOperation(collection: CollectionConfig, op: string, req: MockRequest, action: string | null): { endpoint: EndpointConfig; note: string | null } | { reason: string } {
  const live = collection.endpoints.filter((e) => e.enabled);
  const byName = live.filter((e) => e.operation === op);
  for (const ep of byName) {
    const m = testAll(ep.matchers, { req, params: {} });
    if (!m.ok) continue;
    const note = ep.soapAction && action !== null && ep.soapAction !== action ? `SOAPAction "${action}" differs from the documented "${ep.soapAction}"` : null;
    return { endpoint: ep, note };
  }
  const known = live.map((e) => e.operation).filter(Boolean);
  if (byName.length) return { reason: `Operation "${op}" exists but none of its endpoints' conditions matched this request` };
  const viaAction = action ? live.find((e) => !e.operation && e.soapAction === action) : undefined;
  if (viaAction) return { endpoint: viaAction, note: null };
  return { reason: `No operation "${op}". ${known.length ? `Known: ${known.slice(0, 10).join(", ")}${known.length > 10 ? ", …" : ""}` : "This collection has no operations yet."}` };
}

/** Endpoint-level scheme beats the collection-level one. */
function pickAuthScheme(collection: CollectionConfig, endpointId: string): AuthSchemeConfig | null {
  return (
    collection.authSchemes.find((s) => s.endpointId === endpointId) ??
    collection.authSchemes.find((s) => s.endpointId === null) ??
    null
  );
}

/**
 * Rule order: scenario-specific rules first, then scenario-agnostic ones, each by priority.
 * Default rules are only a fallback when nothing else matched. This makes "switch scenario" override
 * the generic behaviour without having to renumber priorities.
 */
function selectRule(
  rules: RuleConfig[],
  project: ProjectContext,
  matchCtx: { req: MockRequest; params: Record<string, string> },
): { rule: RuleConfig; why: string } | null {
  const active = rules.filter((r) => r.scenarioId === null || r.scenarioId === project.activeScenarioId);
  const order = (a: RuleConfig, b: RuleConfig) => {
    const sa = a.scenarioId === null ? 1 : 0;
    const sb = b.scenarioId === null ? 1 : 0;
    return sa - sb || a.priority - b.priority;
  };
  const conditional = active.filter((r) => !r.isDefault).sort(order);
  for (const rule of conditional) {
    if (testAll(rule.conditions, matchCtx).ok) {
      const scope = rule.scenarioId ? `scenario "${project.activeScenarioName}"` : "any scenario";
      return { rule, why: `rule "${rule.name}" matched (${scope}${rule.conditions.length ? `, ${rule.conditions.length} condition(s)` : ""})` };
    }
  }
  const fallback = active.filter((r) => r.isDefault).sort(order)[0];
  return fallback ? { rule: fallback, why: `default rule "${fallback.name}" (no conditional rule matched)` } : null;
}

function renderErrorTemplate(tpl: ErrorTemplate | null, fallback: ErrorTemplate, ctx: TemplateContext): { tpl: ErrorTemplate; body: string } {
  const use = tpl ?? fallback;
  try {
    return { tpl: use, body: renderTemplate(use.body, ctx) };
  } catch {
    // A broken custom error template must not turn a 4xx into a crash; fall back to the default body.
    return { tpl: fallback, body: renderTemplate(fallback.body, ctx) };
  }
}

export function handle({ req, collection, project, baseUrl }: EngineInput): EngineResponse {
  const base = Math.min(project.globalLatencyMs, MAX_DELAY_MS);

  if (project.outage) {
    return json(503, { error: "Service unavailable (project outage simulation is on)" }, { explanation: "project outage toggle is on" }, base);
  }
  if (collection.mode !== "mock") {
    return json(501, { error: `Collection mode "${collection.mode}" is not supported yet` }, { explanation: `mode ${collection.mode} not implemented` });
  }

  let soap: { version: SoapVersion } | null = null;
  let endpoint: EndpointConfig;
  let params: Record<string, string> = {};
  let soapNote: string | null = null;

  if (collection.protocol === "soap") {
    // A client SDK fetches the WSDL first: serve the imported one, pointing at this mock
    if ((req.method === "GET" || req.method === "HEAD") && Object.keys(req.query).some((k) => k.toLowerCase() === "wsdl")) {
      if (!collection.wsdl) return json(404, { error: "No WSDL has been imported for this API" }, { explanation: "?wsdl requested but no WSDL imported" }, base);
      const wsdl = baseUrl ? pointWsdlAt(collection.wsdl, baseUrl) : collection.wsdl;
      return { status: 200, headers: { "content-type": "text/xml; charset=utf-8" }, body: wsdl, delayMs: base, log: { endpointId: null, ruleId: null, matched: true, validationErrors: [], authResult: null, explanation: "served the imported WSDL" } };
    }
    if (req.method !== "POST") {
      return soapFault("1.1", 405, "Client", `SOAP requests must be POSTed (got ${req.method}). Add ?wsdl to fetch the service description.`, { explanation: `SOAP endpoint got ${req.method}` }, base);
    }
    const env = parseEnvelope(req.rawBody, req.headers);
    if ("error" in env) return soapFault("1.1", 400, "Client", env.error, { explanation: env.error }, base);
    soap = { version: env.version };
    const hit = findOperation(collection, env.operation, req, env.soapAction);
    if ("reason" in hit) return soapFault(env.version, 500, "Client", hit.reason, { explanation: hit.reason }, base);
    endpoint = hit.endpoint;
    soapNote = hit.note;
    // Templates and matchers read the parsed Body: request.body.GetOrder.OrderId
    req = { ...req, body: env.body };
  } else {
    const found = findEndpoint(collection, req);
    if ("reason" in found) {
      return json(404, { error: "No mock endpoint matched", method: req.method, path: req.path, hint: found.reason }, { explanation: found.reason }, base);
    }
    endpoint = found.endpoint;
    params = found.params;
  }
  const matchCtx = { req, params };

  const tctx: TemplateContext = {
    request: { method: req.method, path: req.path, params, query: req.query, headers: req.headers, body: req.body, rawBody: req.rawBody },
    vars: collection.variables,
    scenario: project.activeScenarioName,
    soapVersion: soap?.version,
  };

  // ---- auth ----
  let authResult: string | null = null;
  const scheme = pickAuthScheme(collection, endpoint.id);
  if (scheme && scheme.mode !== "off" && scheme.type !== "none") {
    const r = checkAuth(scheme, req);
    authResult = r.reason;
    if (!r.ok && scheme.mode === "strict") {
      const out = renderErrorTemplate(
        scheme.onFail,
        soap
          ? { status: 401, contentType: soapContentType(soap.version), body: faultEnvelope(soap.version, "Client", `Unauthorized: ${r.reason}`) }
          : { status: 401, contentType: "application/json", body: JSON.stringify({ error: "Unauthorized", reason: r.reason }) },
        tctx,
      );
      return {
        status: out.tpl.status,
        headers: { "content-type": out.tpl.contentType },
        body: out.body,
        delayMs: base,
        log: { endpointId: endpoint.id, ruleId: null, matched: true, validationErrors: [], authResult, explanation: `auth rejected: ${r.reason}` },
      };
    }
    if (!r.ok) authResult = `${r.reason} (warn mode: request allowed)`;
  }

  // ---- validation ----
  let validationErrors: string[] = [];
  if (!soap && collection.validationMode !== "off" && endpoint.requestSchema) {
    validationErrors = validateJsonBody(endpoint.requestSchema, req);
    if (validationErrors.length && collection.validationMode === "strict") {
      const out = renderErrorTemplate(
        collection.errorTemplate,
        { status: 400, contentType: "application/json", body: JSON.stringify({ error: "Request validation failed", details: validationErrors }) },
        { ...tctx, errors: validationErrors },
      );
      return {
        status: out.tpl.status,
        headers: { "content-type": out.tpl.contentType },
        body: out.body,
        delayMs: base,
        log: { endpointId: endpoint.id, ruleId: null, matched: true, validationErrors, authResult, explanation: "request failed schema validation (strict)" },
      };
    }
  }

  // ---- rule selection + render ----
  const picked = selectRule(endpoint.rules, project, matchCtx);
  if (!picked) {
    if (soap) return soapFault(soap.version, 500, "Server", `Operation "${endpoint.name}" has no usable response rule`, { endpointId: endpoint.id, matched: true, validationErrors, authResult, explanation: "operation matched but no response rule applies to the active scenario" }, base);
    return json(
      501,
      { error: "Endpoint matched but has no usable response rule", endpoint: endpoint.name },
      { endpointId: endpoint.id, matched: true, validationErrors, authResult, explanation: "endpoint matched but no response rule applies to the active scenario" },
      base,
    );
  }
  const { rule, why: why0 } = picked;
  const why = soapNote ? `${why0}; note: ${soapNote}` : why0;
  const logBase = { endpointId: endpoint.id, ruleId: rule.id, matched: true, validationErrors, authResult };

  try {
    const rendered = renderTemplate(rule.body, tctx);
    const body = soap ? wrapEnvelope(soap.version, rendered) : rendered;
    const headers = new Map<string, string>();
    for (const [k, v] of Object.entries({ ...collection.defaultHeaders, ...rule.headers })) {
      headers.set(k.toLowerCase(), renderTemplate(v, tctx));
    }
    headers.set("content-type", soap ? soapContentType(soap.version) : rule.contentType);
    return {
      status: rule.status,
      headers: Object.fromEntries(headers),
      body,
      delayMs: Math.min(base + rule.delayMs, MAX_DELAY_MS),
      log: { ...logBase, explanation: why },
    };
  } catch (e) {
    const message = e instanceof TemplateError ? e.message : "unexpected render error";
    if (soap) return soapFault(soap.version, 500, "Server", `Mock template failed to render: ${message}`, { ...logBase, explanation: `${why}, but its template failed: ${message}` }, base);
    return json(
      500,
      { error: "Mock template failed to render", rule: rule.name, message },
      { ...logBase, explanation: `${why}, but its template failed: ${message}` },
      base,
    );
  }
}
