import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { checkAuth } from "./auth";
import { parseBody } from "./body";
import { handle } from "./engine";
import { maskHeaders } from "./mask";
import { testAll, testMatcher } from "./matchers";
import { bySpecificity, compilePath, matchPath } from "./path";
import { renderTemplate, TemplateError, type TemplateContext } from "./template";
import type { AuthSchemeConfig, CollectionConfig, EndpointConfig, MockRequest, ProjectContext, RuleConfig } from "./types";
import { validateJsonBody } from "./validate";

const req = (over: Partial<MockRequest> = {}): MockRequest => ({
  method: "GET",
  path: "/",
  query: {},
  headers: {},
  rawBody: "",
  body: null,
  ...over,
});

describe("path", () => {
  it("extracts params and decodes them", () => {
    expect(matchPath(compilePath("/orders/:id"), "/orders/a%20b")).toEqual({ id: "a b" });
  });
  it("ignores trailing slash and rejects wrong length", () => {
    const c = compilePath("/orders/:id");
    expect(matchPath(c, "/orders/1/")).toEqual({ id: "1" });
    expect(matchPath(c, "/orders")).toBeNull();
    expect(matchPath(c, "/orders/1/items")).toBeNull();
  });
  it("wildcard captures the rest", () => {
    expect(matchPath(compilePath("/files/*"), "/files/a/b/c.txt")).toEqual({ "*": "a/b/c.txt" });
  });
  it("is case-sensitive on literals", () => {
    expect(matchPath(compilePath("/Orders"), "/orders")).toBeNull();
  });
  it("survives a malformed escape", () => {
    expect(matchPath(compilePath("/x/:v"), "/x/%E0%A4%A")).toEqual({ v: "%E0%A4%A" });
  });
  it("orders literals before params before wildcards", () => {
    const list = ["/orders/*", "/orders/:id", "/orders/recent"].map(compilePath).sort(bySpecificity);
    expect(list.map((c) => c.segments.map((s) => s.t).join(","))).toEqual(["lit,lit", "lit,param", "lit,wild"]);
  });
});

describe("body", () => {
  it("parses json, form, and ignores garbage", () => {
    expect(parseBody("application/json", '{"a":1}')).toEqual({ a: 1 });
    expect(parseBody("application/x-www-form-urlencoded", "a=1&a=2&b=3")).toEqual({ a: ["1", "2"], b: "3" });
    expect(parseBody("application/json", "{bad")).toBeNull();
    expect(parseBody("text/plain", "hello")).toBeNull();
    expect(parseBody(undefined, "")).toBeNull();
  });
});

describe("matchers", () => {
  const r = req({
    headers: { "x-tenant": "acme" },
    query: { page: "2", tag: ["a", "b"] },
    body: { user: { id: 7, name: "Ann" }, items: [{ sku: "A" }, { sku: "B" }] },
  });
  const ctx = { req: r, params: { id: "42" } };
  it("reads header (case-insensitive), query, path, body", () => {
    expect(testMatcher({ source: "header", expr: "X-Tenant", op: "equals", value: "acme" }, ctx)).toBe(true);
    expect(testMatcher({ source: "query", expr: "tag", op: "equals", value: "b" }, ctx)).toBe(true);
    expect(testMatcher({ source: "path", expr: "id", op: "equals", value: "42" }, ctx)).toBe(true);
    expect(testMatcher({ source: "body", expr: "$.user.id", op: "equals", value: "7" }, ctx)).toBe(true);
    expect(testMatcher({ source: "body", expr: "user.name", op: "contains", value: "nn" }, ctx)).toBe(true);
    expect(testMatcher({ source: "body", expr: "$.items[*].sku", op: "equals", value: "B" }, ctx)).toBe(true);
  });
  it("exists / regex / missing / invalid input never throws", () => {
    expect(testMatcher({ source: "header", expr: "x-none", op: "exists" }, ctx)).toBe(false);
    expect(testMatcher({ source: "query", expr: "page", op: "regex", value: "^\\d+$" }, ctx)).toBe(true);
    expect(testMatcher({ source: "query", expr: "page", op: "regex", value: "(" }, ctx)).toBe(false);
    expect(testMatcher({ source: "body", expr: "$[?(", op: "exists" }, ctx)).toBe(false);
    expect(testMatcher({ source: "body", expr: "$.x", op: "exists" }, { req: req(), params: {} })).toBe(false);
  });
  it("not_equals / not_exists treat a missing field as a match", () => {
    expect(testMatcher({ source: "path", expr: "id", op: "not_equals", value: "42" }, ctx)).toBe(false);
    expect(testMatcher({ source: "path", expr: "id", op: "not_equals", value: "43" }, ctx)).toBe(true);
    expect(testMatcher({ source: "query", expr: "tag", op: "not_equals", value: "b" }, ctx)).toBe(false); // one of the values equals it
    expect(testMatcher({ source: "body", expr: "$.user.key", op: "not_equals", value: "x" }, ctx)).toBe(true); // missing
    expect(testMatcher({ source: "header", expr: "x-none", op: "not_exists" }, ctx)).toBe(true);
    expect(testMatcher({ source: "header", expr: "x-tenant", op: "not_exists" }, ctx)).toBe(false);
    expect(testMatcher({ source: "body", expr: "$.x", op: "not_equals", value: "1" }, { req: req(), params: {} })).toBe(true);
  });
  it("testAll reports the first failing matcher", () => {
    const res = testAll(
      [
        { source: "path", expr: "id", op: "equals", value: "42" },
        { source: "header", expr: "x-tenant", op: "equals", value: "other" },
      ],
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failed.expr).toBe("x-tenant");
  });
});

const tctx = (over: Partial<TemplateContext["request"]> = {}): TemplateContext => ({
  request: { method: "POST", path: "/x", params: { id: "9" }, query: {}, headers: {}, body: null, rawBody: "", ...over },
  vars: { region: "eu" },
  scenario: null,
});

describe("template", () => {
  it("renders request, vars and does not HTML-escape", () => {
    expect(renderTemplate('{"id":"{{request.params.id}}","r":"{{vars.region}}","q":"{{request.body.t}}"}', tctx({ body: { t: "<b>&" } }))).toBe(
      '{"id":"9","r":"eu","q":"<b>&"}',
    );
  });
  it("returns static text untouched", () => {
    expect(renderTemplate("plain", tctx())).toBe("plain");
  });
  it("uuid / now / randomInt / faker helpers", () => {
    expect(renderTemplate("{{uuid}}", tctx())).toMatch(/^[0-9a-f-]{36}$/);
    const t = Date.now();
    const d = new Date(renderTemplate("{{now days=1}}", tctx())).getTime();
    expect(d - t).toBeGreaterThan(86_400_000 - 5000);
    expect(d - t).toBeLessThan(86_400_000 + 5000);
    const n = Number(renderTemplate("{{randomInt 5 6}}", tctx()));
    expect([5, 6]).toContain(n);
    expect(renderTemplate('{{faker "person.fullName"}}', tctx()).length).toBeGreaterThan(2);
  });
  it("randomString / randomDigits give the requested length and alphabet", () => {
    expect(renderTemplate("{{randomString 24}}", tctx())).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(renderTemplate("{{randomDigits 12}}", tctx())).toMatch(/^\d{12}$/);
    // Leading zeros survive, unlike randomInt
    const many = Array.from({ length: 200 }, () => renderTemplate("{{randomDigits 6}}", tctx()));
    expect(many.some((s) => s.startsWith("0"))).toBe(true);
    expect(new Set(many).size).toBeGreaterThan(150);
    for (const bad of ["{{randomString}}", "{{randomString 0}}", "{{randomDigits 1001}}", "{{randomDigits 2.5}}", '{{randomString "x"}}']) {
      expect(() => renderTemplate(bad, tctx())).toThrow(TemplateError);
    }
  });
  it("rejects bad or unsafe faker paths", () => {
    expect(() => renderTemplate('{{faker "nope.x"}}', tctx())).toThrow(TemplateError);
    expect(() => renderTemplate('{{faker "constructor"}}', tctx())).toThrow(TemplateError);
    expect(() => renderTemplate("{{faker}}", tctx())).toThrow(TemplateError);
  });
  it("json helper escapes, sum and repeat build nested bodies", () => {
    expect(renderTemplate('{"n":{{json request.body.n}}}', tctx({ body: { n: 'a"b' } }))).toBe('{"n":"a\\"b"}');
    const items = [{ price: 2 }, { price: 3.5 }];
    expect(renderTemplate('{{sum request.body.items "price"}}', tctx({ body: { items } }))).toBe("5.5");
    expect(renderTemplate("[{{#repeat 3}}{{@index}}{{#unless @last}},{{/unless}}{{/repeat}}]", tctx())).toBe("[0,1,2]");
  });
  it("handles }}} sequences that JSON bodies produce (not a triple-stash)", () => {
    const c = tctx({ params: { id: "9" } });
    expect(renderTemplate('{"a":{"b":{{request.params.id}}}}', c)).toBe('{"a":{"b":9}}');
    expect(renderTemplate('{"a":{"b":"{{request.params.id}}"}}', c)).toBe('{"a":{"b":"9"}}');
    expect(renderTemplate("{{{request.params.id}}}", c)).toBe("9");
    expect(renderTemplate('{"x":{}} {{request.params.id}}', c)).toBe('{"x":{}} 9');
  });
  it("caps repeat and reports syntax errors", () => {
    expect(renderTemplate("{{#repeat 999999}}x{{/repeat}}", tctx()).length).toBe(1000);
    expect(() => renderTemplate("{{#if}}", tctx())).toThrow(TemplateError);
  });
  it("default and comparison helpers", () => {
    expect(renderTemplate('{{default request.query.page "1"}}', tctx())).toBe("1");
    expect(renderTemplate('{{#if (eq request.params.id "9")}}yes{{else}}no{{/if}}', tctx())).toBe("yes");
  });
});

describe("validate", () => {
  const schema = {
    type: "object",
    required: ["amount", "currency"],
    properties: { amount: { type: "number", minimum: 1 }, currency: { enum: ["USD", "EUR"] }, email: { type: "string", format: "email" } },
  };
  it("accepts a valid body", () => {
    expect(validateJsonBody(schema, req({ body: { amount: 5, currency: "USD" }, rawBody: "x" }))).toEqual([]);
  });
  it("reports every violation", () => {
    const errs = validateJsonBody(schema, req({ body: { amount: 0, currency: "GBP", email: "no" }, rawBody: "x" }));
    expect(errs.length).toBe(3);
    expect(errs.join(" ")).toContain("/amount");
  });
  it("distinguishes missing from non-JSON body, and bad schemas", () => {
    expect(validateJsonBody(schema, req())).toEqual(["body is required"]);
    expect(validateJsonBody(schema, req({ rawBody: "<x/>" }))).toEqual(["body is not valid JSON"]);
    expect(validateJsonBody({ type: "nonsense" }, req({ body: {}, rawBody: "{}" }))[0]).toContain("schema is invalid");
    expect(validateJsonBody(null, req())).toEqual([]);
  });
});

const scheme = (type: AuthSchemeConfig["type"], config = {}, credentials: AuthSchemeConfig["credentials"] = []): AuthSchemeConfig => ({
  id: "s",
  endpointId: null,
  type,
  config,
  onFail: null,
  mode: "strict",
  credentials,
});
const cred = (secret: string, over = {}) => ({ label: "k", keyId: null, secret, scopes: [], expiresAt: null, isActive: true, ...over });

describe("auth", () => {
  it("api_key: missing, wrong, right, accept-any, expired, inactive", () => {
    const s = scheme("api_key", {}, [cred("secret1")]);
    expect(checkAuth(s, req()).ok).toBe(false);
    expect(checkAuth(s, req({ headers: { "x-api-key": "nope" } })).ok).toBe(false);
    expect(checkAuth(s, req({ headers: { "x-api-key": "secret1" } })).ok).toBe(true);
    expect(checkAuth(scheme("api_key"), req({ headers: { "x-api-key": "anything" } })).ok).toBe(true);
    const past = new Date(Date.now() - 1000);
    expect(checkAuth(scheme("api_key", {}, [cred("s", { expiresAt: past })]), req({ headers: { "x-api-key": "s" } })).ok).toBe(false);
    expect(checkAuth(scheme("api_key", {}, [cred("s", { isActive: false })]), req({ headers: { "x-api-key": "s" } })).ok).toBe(false);
  });
  it("api_key can come from the query string", () => {
    const s = scheme("api_key", { in: "query", name: "key" }, [cred("q1")]);
    expect(checkAuth(s, req({ query: { key: "q1" } })).ok).toBe(true);
  });
  it("bearer and basic", () => {
    expect(checkAuth(scheme("bearer", {}, [cred("tok")]), req({ headers: { authorization: "Bearer tok" } })).ok).toBe(true);
    expect(checkAuth(scheme("bearer", {}, [cred("tok")]), req({ headers: { authorization: "Bearer bad" } })).ok).toBe(false);
    expect(checkAuth(scheme("bearer"), req({ headers: { authorization: "Basic abc" } })).ok).toBe(false);
    const b = (u: string, p: string) => ({ authorization: `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}` });
    const basic = scheme("basic", {}, [cred("pw:with:colons", { keyId: "bob" })]);
    expect(checkAuth(basic, req({ headers: b("bob", "pw:with:colons") })).ok).toBe(true);
    expect(checkAuth(basic, req({ headers: b("bob", "x") })).ok).toBe(false);
  });
  it("hmac verifies the raw body, with or without algorithm prefix", () => {
    const s = scheme("hmac", { header: "x-signature" }, [cred("shh")]);
    const body = '{"a":1}';
    const sig = createHmac("sha256", "shh").update(body).digest("hex");
    expect(checkAuth(s, req({ rawBody: body, headers: { "x-signature": sig } })).ok).toBe(true);
    expect(checkAuth(s, req({ rawBody: body, headers: { "x-signature": `sha256=${sig}` } })).ok).toBe(true);
    expect(checkAuth(s, req({ rawBody: body + " ", headers: { "x-signature": sig } })).ok).toBe(false);
  });
});

describe("mask", () => {
  it("hides credentials but keeps the scheme", () => {
    expect(maskHeaders({ authorization: "Bearer abc", "x-api-key": "k", accept: "*/*" })).toEqual({
      authorization: "Bearer ***",
      "x-api-key": "***",
      accept: "*/*",
    });
  });
});

// ---------------- engine ----------------
const rule = (over: Partial<RuleConfig> = {}): RuleConfig => ({
  id: "r1",
  name: "default",
  scenarioId: null,
  priority: 0,
  isDefault: true,
  conditions: [],
  status: 200,
  headers: {},
  contentType: "application/json",
  body: '{"ok":true}',
  delayMs: 0,
  ...over,
});
const endpoint = (over: Partial<EndpointConfig> = {}): EndpointConfig => ({
  id: "e1",
  name: "ep",
  method: "GET",
  path: "/orders/:id",
  requestSchema: null,
  matchers: [],
  enabled: true,
  rules: [rule()],
  ...over,
});
const collection = (over: Partial<CollectionConfig> = {}): CollectionConfig => ({
  id: "c1",
  name: "Payments",
  slug: "payments",
  protocol: "rest",
  mode: "mock",
  validationMode: "strict",
  errorTemplate: null,
  defaultHeaders: {},
  variables: {},
  endpoints: [endpoint()],
  authSchemes: [],
  ...over,
});
const project = (over: Partial<ProjectContext> = {}): ProjectContext => ({
  id: "p1",
  activeScenarioId: null,
  activeScenarioName: null,
  globalLatencyMs: 0,
  outage: false,
  ...over,
});

describe("engine", () => {
  it("serves the default rule with a rendered body and explanation", () => {
    const res = handle({
      req: req({ path: "/orders/55" }),
      collection: collection({ endpoints: [endpoint({ rules: [rule({ body: '{"id":"{{request.params.id}}"}' })] })] }),
      project: project(),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ id: "55" });
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.log.matched).toBe(true);
    expect(res.log.explanation).toContain("default rule");
  });

  it("404 explains method mismatch and unknown paths", () => {
    const c = collection();
    const wrongMethod = handle({ req: req({ method: "POST", path: "/orders/1" }), collection: c, project: project() });
    expect(wrongMethod.status).toBe(404);
    expect(wrongMethod.log.explanation).toContain("method is POST");
    const wrongPath = handle({ req: req({ path: "/nope" }), collection: c, project: project() });
    expect(wrongPath.log.explanation).toContain("Known: GET /orders/:id");
    expect(wrongPath.log.matched).toBe(false);
  });

  it("HEAD is served by a GET endpoint", () => {
    expect(handle({ req: req({ method: "HEAD", path: "/orders/1" }), collection: collection(), project: project() }).status).toBe(200);
  });

  it("prefers the most specific endpoint", () => {
    const c = collection({
      endpoints: [
        endpoint({ id: "a", path: "/orders/:id", rules: [rule({ body: "param" })] }),
        endpoint({ id: "b", path: "/orders/recent", rules: [rule({ body: "literal" })] }),
      ],
    });
    expect(handle({ req: req({ path: "/orders/recent" }), collection: c, project: project() }).body).toBe("literal");
    expect(handle({ req: req({ path: "/orders/7" }), collection: c, project: project() }).body).toBe("param");
  });

  it("endpoint matchers choose between endpoints sharing a path", () => {
    const c = collection({
      endpoints: [
        endpoint({ id: "a", method: "POST", path: "/pay", matchers: [{ source: "header", expr: "x-mode", op: "equals", value: "3ds" }], rules: [rule({ body: "3ds" })] }),
        endpoint({ id: "b", method: "POST", path: "/pay", rules: [rule({ body: "plain" })] }),
      ],
    });
    const post = (headers = {}) => handle({ req: req({ method: "POST", path: "/pay", headers }), collection: c, project: project() }).body;
    expect(post({ "x-mode": "3ds" })).toBe("3ds");
    expect(post()).toBe("plain");
  });

  it("conditional rules beat the default; scenario rules beat generic ones", () => {
    const happy = rule({ id: "h", name: "happy", isDefault: true, body: "ok" });
    const vip = rule({
      id: "v",
      name: "vip",
      isDefault: false,
      priority: 5,
      conditions: [{ source: "body", expr: "$.vip", op: "equals", value: "true" }],
      body: "vip",
    });
    const fail = rule({ id: "f", name: "declined", isDefault: false, scenarioId: "sc-fail", status: 402, body: "declined" });
    const c = collection({ endpoints: [endpoint({ method: "POST", path: "/pay", rules: [happy, vip, fail] })] });
    const call = (p: ProjectContext, body: unknown = {}) =>
      handle({ req: req({ method: "POST", path: "/pay", body, rawBody: JSON.stringify(body) }), collection: c, project: p });

    expect(call(project()).body).toBe("ok");
    expect(call(project(), { vip: true }).body).toBe("vip");
    const failing = call(project({ activeScenarioId: "sc-fail", activeScenarioName: "payment-fails" }), { vip: true });
    expect(failing.status).toBe(402);
    expect(failing.log.explanation).toContain('scenario "payment-fails"');
  });

  it("501 when an endpoint has no rule for the active scenario", () => {
    const c = collection({ endpoints: [endpoint({ rules: [rule({ isDefault: false, scenarioId: "other" })] })] });
    const res = handle({ req: req({ path: "/orders/1" }), collection: c, project: project() });
    expect(res.status).toBe(501);
    expect(res.log.matched).toBe(true);
  });

  it("strict validation rejects with the default or a custom error body", () => {
    const schema = { type: "object", required: ["amount"] };
    const ep = endpoint({ method: "POST", path: "/pay", requestSchema: schema });
    const bad = req({ method: "POST", path: "/pay", body: {}, rawBody: "{}" });

    const def = handle({ req: bad, collection: collection({ endpoints: [ep] }), project: project() });
    expect(def.status).toBe(400);
    expect(JSON.parse(def.body).details[0]).toContain("amount");

    const custom = handle({
      req: bad,
      collection: collection({
        endpoints: [ep],
        errorTemplate: { status: 422, contentType: "application/json", body: '{"code":"INVALID","n":{{errors.length}}}' },
      }),
      project: project(),
    });
    expect(custom.status).toBe(422);
    expect(JSON.parse(custom.body)).toEqual({ code: "INVALID", n: 1 });
  });

  it("a broken custom error template falls back to the default body", () => {
    const ep = endpoint({ method: "POST", path: "/pay", requestSchema: { type: "object", required: ["a"] } });
    const res = handle({
      req: req({ method: "POST", path: "/pay", body: {}, rawBody: "{}" }),
      collection: collection({ endpoints: [ep], errorTemplate: { status: 422, contentType: "application/json", body: "{{#if}}" } }),
      project: project(),
    });
    expect(res.status).toBe(400);
  });

  it("warn validation lets the request through but records the errors", () => {
    const ep = endpoint({ method: "POST", path: "/pay", requestSchema: { type: "object", required: ["a"] } });
    const res = handle({
      req: req({ method: "POST", path: "/pay", body: {}, rawBody: "{}" }),
      collection: collection({ endpoints: [ep], validationMode: "warn" }),
      project: project(),
    });
    expect(res.status).toBe(200);
    expect(res.log.validationErrors.length).toBe(1);
  });

  it("auth: strict rejects with 401 or custom body; warn allows; endpoint scheme overrides collection", () => {
    const apiKey = { ...scheme("api_key", {}, [cred("good")]), id: "col" };
    const c = collection({ authSchemes: [apiKey] });
    const denied = handle({ req: req({ path: "/orders/1" }), collection: c, project: project() });
    expect(denied.status).toBe(401);
    expect(denied.log.authResult).toContain("missing");
    expect(handle({ req: req({ path: "/orders/1", headers: { "x-api-key": "good" } }), collection: c, project: project() }).status).toBe(200);

    const custom = collection({
      authSchemes: [{ ...apiKey, onFail: { status: 403, contentType: "application/xml", body: "<denied/>" } }],
    });
    const r403 = handle({ req: req({ path: "/orders/1" }), collection: custom, project: project() });
    expect([r403.status, r403.body, r403.headers["content-type"]]).toEqual([403, "<denied/>", "application/xml"]);

    const warn = collection({ authSchemes: [{ ...apiKey, mode: "warn" }] });
    const w = handle({ req: req({ path: "/orders/1" }), collection: warn, project: project() });
    expect(w.status).toBe(200);
    expect(w.log.authResult).toContain("warn mode");

    const open = { ...scheme("none"), endpointId: "e1" };
    expect(handle({ req: req({ path: "/orders/1" }), collection: collection({ authSchemes: [apiKey, open] }), project: project() }).status).toBe(200);
  });

  it("outage returns 503; latency adds up and is capped", () => {
    expect(handle({ req: req({ path: "/orders/1" }), collection: collection(), project: project({ outage: true }) }).status).toBe(503);
    const c = collection({ endpoints: [endpoint({ rules: [rule({ delayMs: 250 })] })] });
    expect(handle({ req: req({ path: "/orders/1" }), collection: c, project: project({ globalLatencyMs: 100 }) }).delayMs).toBe(350);
    const slow = collection({ endpoints: [endpoint({ rules: [rule({ delayMs: 9e9 })] })] });
    expect(handle({ req: req({ path: "/orders/1" }), collection: slow, project: project() }).delayMs).toBe(60_000);
  });

  it("template failure gives a 500 that names the rule, not a crash", () => {
    const c = collection({ endpoints: [endpoint({ rules: [rule({ name: "bad", body: '{{faker "nope.x"}}' })] })] });
    const res = handle({ req: req({ path: "/orders/1" }), collection: c, project: project() });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).rule).toBe("bad");
  });

  it("merges default headers with rule headers, templated, rule winning", () => {
    const c = collection({
      defaultHeaders: { "X-Provider": "acme", "X-Region": "{{vars.r}}" },
      variables: { r: "eu" },
      endpoints: [endpoint({ rules: [rule({ headers: { "x-provider": "override", "X-Id": "{{request.params.id}}" } })] })],
    });
    const h = handle({ req: req({ path: "/orders/3" }), collection: c, project: project() }).headers;
    expect(h["x-provider"]).toBe("override");
    expect(h["x-region"]).toBe("eu");
    expect(h["x-id"]).toBe("3");
  });

  it("disabled endpoints and non-mock modes are not served", () => {
    const c = collection({ endpoints: [endpoint({ enabled: false })] });
    expect(handle({ req: req({ path: "/orders/1" }), collection: c, project: project() }).status).toBe(404);
    // SOAP is served now: a GET to a SOAP collection is refused with a Fault that says to POST an envelope
    const soapRes = handle({ req: req({ path: "/" }), collection: collection({ protocol: "soap" }), project: project() });
    expect(soapRes.status).toBe(405);
    expect(soapRes.body).toContain("POSTed");
    expect(handle({ req: req({ path: "/orders/1" }), collection: collection({ mode: "pass_through" }), project: project() }).status).toBe(501);
  });
});
