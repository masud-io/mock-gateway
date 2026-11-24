/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are asserted loosely on purpose */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
let dbm: typeof import("../../db");
let admin: typeof import("./router");
let mock: typeof import("../handler");

const HOST = "localhost:3000";
async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await admin.handleAdmin(
    new Request(`http://${HOST}/api/admin${p}`, {
      method,
      headers: { host: HOST, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, data: (await res.json()) as any };
}
const callMock = (p: string, init: RequestInit = {}) => mock.handleMockRequest(new Request(`http://${HOST}/mock/${p}`, init));

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "mockgw-admin-"));
  process.env.MOCKGW_DATA_DIR = path.join(dir, "pg");
  dbm = await import("../../db");
  admin = await import("./router");
  mock = await import("../handler");
  await migrate(dbm.getDb(), { migrationsFolder: "./drizzle" });
});
afterAll(async () => {
  await dbm.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("admin API", () => {
  let clientId: string, projectId: string, collectionId: string, endpointId: string, ruleId: string, failId: string;

  it("builds the hierarchy and an edit goes live in the mock without any manual cache reset", async () => {
    clientId = (await api("POST", "/clients", { name: "Acme Corp" })).data.id;
    projectId = (await api("POST", "/projects", { clientId, name: "Checkout" })).data.id;
    collectionId = (await api("POST", "/collections", { projectId, name: "Payments" })).data.id;
    const ep = (await api("POST", "/endpoints", { collectionId, name: "Get order", method: "GET", path: "orders/:id" })).data;
    endpointId = ep.id;
    expect(ep.path).toBe("/orders/:id"); // leading slash added

    // The placeholder rule answers immediately
    const first = await callMock("acme-corp/checkout/payments/orders/7");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ message: "mock response" });

    // Edit the default rule through the admin API: the very next mock call must reflect it
    const detail = (await api("GET", `/endpoints/${endpointId}`)).data;
    ruleId = detail.rules[0].id;
    expect((await api("PATCH", `/rules/${ruleId}`, { body: '{"id":"{{request.params.id}}"}', status: 201 })).status).toBe(200);
    const second = await callMock("acme-corp/checkout/payments/orders/7");
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({ id: "7" });
  });

  it("scenario switching changes mock behaviour immediately", async () => {
    failId = (await api("POST", `/projects/${projectId}/scenarios`, { name: "payment-fails" })).data.id;
    await api("POST", `/endpoints/${endpointId}/rules`, { name: "declined", scenarioId: failId, status: 402, body: '{"error":"declined"}' });
    expect((await callMock("acme-corp/checkout/payments/orders/1")).status).toBe(201);
    await api("PATCH", `/projects/${projectId}`, { activeScenarioId: failId });
    expect((await callMock("acme-corp/checkout/payments/orders/1")).status).toBe(402);
    await api("PATCH", `/projects/${projectId}`, { outage: true });
    expect((await callMock("acme-corp/checkout/payments/orders/1")).status).toBe(503);
    await api("PATCH", `/projects/${projectId}`, { outage: false, activeScenarioId: null });
    expect((await callMock("acme-corp/checkout/payments/orders/1")).status).toBe(201);
  });

  it("deleting a scenario removes its rules and clears it as active", async () => {
    await api("PATCH", `/projects/${projectId}`, { activeScenarioId: failId });
    expect((await api("DELETE", `/scenarios/${failId}`)).status).toBe(200);
    const p = (await api("GET", `/projects/${projectId}`)).data;
    expect(p.project.activeScenarioId).toBeNull();
    const rules = (await api("GET", `/endpoints/${endpointId}`)).data.rules;
    expect(rules.every((r: any) => r.scenarioId === null)).toBe(true);
    expect((await callMock("acme-corp/checkout/payments/orders/1")).status).toBe(201);
  });

  it("reorders rules: the new order decides which conditional rule answers first", async () => {
    const a = (await api("POST", `/endpoints/${endpointId}/rules`, { name: "A", status: 211, body: "{}" })).data;
    const b = (await api("POST", `/endpoints/${endpointId}/rules`, { name: "B", status: 212, body: "{}" })).data;
    const order = async () => (await api("GET", `/endpoints/${endpointId}`)).data.rules.filter((r: any) => r.name === "A" || r.name === "B").map((r: any) => r.name);
    expect((await api("POST", `/endpoints/${endpointId}/rules/reorder`, { ids: [b.id, a.id] })).status).toBe(200);
    expect(await order()).toEqual(["B", "A"]);
    expect((await callMock("acme-corp/checkout/payments/orders/1")).status).toBe(212);
    expect((await api("POST", `/endpoints/${endpointId}/rules/reorder`, { ids: [a.id, b.id] })).status).toBe(200);
    expect((await callMock("acme-corp/checkout/payments/orders/1")).status).toBe(211);
    expect((await api("POST", `/endpoints/${endpointId}/rules/reorder`, { ids: [a.id, crypto.randomUUID()] })).status).toBe(400);
    expect((await api("POST", `/endpoints/${endpointId}/rules/reorder`, { ids: [a.id, a.id] })).status).toBe(400);
    await api("DELETE", `/rules/${a.id}`);
    await api("DELETE", `/rules/${b.id}`);
  });

  it("duplicates a rule; a copy of the default does not take over every request", async () => {
    const cond = [{ source: "query", expr: "k", op: "equals", value: "v" }];
    const c = (await api("POST", `/endpoints/${endpointId}/rules`, { name: "C", status: 230, body: "{}", conditions: cond })).data;
    const copy = await api("POST", `/rules/${c.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.data).toMatchObject({ name: "C copy", status: 230, isDefault: false, conditions: cond });
    expect(copy.data.id).not.toBe(c.id);

    const rules = (await api("GET", `/endpoints/${endpointId}`)).data.rules;
    const def = rules.find((r: any) => r.isDefault);
    const dCopy = (await api("POST", `/rules/${def.id}/duplicate`)).data;
    expect(dCopy).toMatchObject({ name: `${def.name} copy`, isDefault: false });
    expect(dCopy.conditions).toHaveLength(1); // the never-matching placeholder
    expect((await callMock("acme-corp/checkout/payments/orders/1")).status).toBe(201); // the real default still answers
    expect((await api("GET", `/endpoints/${endpointId}`)).data.rules.filter((r: any) => r.isDefault)).toHaveLength(1);

    for (const id of [c.id, copy.data.id, dCopy.id]) await api("DELETE", `/rules/${id}`);
    expect((await api("POST", `/rules/${crypto.randomUUID()}/duplicate`)).status).toBe(404);
  });

  it("rejects broken templates, bad schemas and bad rules with a useful message", async () => {
    const t = await api("PATCH", `/rules/${ruleId}`, { body: "{{#if}}" });
    expect(t.status).toBe(422);
    expect(t.data.error).toContain("Template error in response body");
    const h = await api("PATCH", `/rules/${ruleId}`, { headers: { "x-a": "{{#each}}" } });
    expect(h.data.error).toContain("header x-a");
    const s = await api("PATCH", `/endpoints/${endpointId}`, { requestSchema: { type: "nonsense" } });
    expect(s.status).toBe(422);
    expect(s.data.error).toContain("Invalid JSON Schema");
    expect((await api("PATCH", `/rules/${ruleId}`, { isDefault: true, conditions: [{ source: "header", expr: "a", op: "exists" }] })).status).toBe(400);
    expect((await api("PATCH", `/rules/${ruleId}`, { status: 99 })).status).toBe(400);
    expect((await api("PATCH", `/rules/${ruleId}`, { scenarioId: crypto.randomUUID() })).status).toBe(400);
    // nothing broken was stored
    expect((await callMock("acme-corp/checkout/payments/orders/1")).status).toBe(201);
  });

  it("slug conflicts return 409 and deleted slugs can be reused", async () => {
    expect((await api("POST", "/clients", { name: "acme corp" })).status).toBe(409);
    expect((await api("POST", "/projects", { clientId, name: "Checkout" })).status).toBe(409);
    const tmp = (await api("POST", "/clients", { name: "Temp" })).data.id;
    expect((await api("DELETE", `/clients/${tmp}`)).status).toBe(200);
    expect((await api("POST", "/clients", { name: "Temp" })).status).toBe(201);
    const tree = (await api("GET", "/tree")).data;
    expect(tree.map((c: any) => c.slug).sort()).toEqual(["acme-corp", "temp"]);
    expect(tree[0].projects.length + tree[1].projects.length).toBe(1);
  });

  it("deleting an endpoint or collection stops it being served", async () => {
    const extra = (await api("POST", "/endpoints", { collectionId, name: "Ping", method: "GET", path: "/ping" })).data.id;
    expect((await callMock("acme-corp/checkout/payments/ping")).status).toBe(200);
    await api("DELETE", `/endpoints/${extra}`);
    expect((await callMock("acme-corp/checkout/payments/ping")).status).toBe(404);
    const dup = (await api("POST", `/endpoints/${endpointId}/duplicate`)).data;
    expect(dup.name).toContain("(copy)");
    expect((await api("GET", `/endpoints/${dup.id}`)).data.rules.length).toBeGreaterThan(0);
  });

  it("secret variables and credentials are never returned unless revealed", async () => {
    const v = (await api("PUT", "/variables", { scope: "project", scopeId: projectId, key: "token", value: "tok-123", isSecret: true })).data;
    expect(v.value).toBe("");
    const list = (await api("GET", `/projects/${projectId}`)).data.variables;
    expect(JSON.stringify(list)).not.toContain("tok-123");
    expect((await api("GET", `/variables/${v.id}/reveal`)).data.value).toBe("tok-123");
    // upsert, not duplicate
    await api("PUT", "/variables", { scope: "project", scopeId: projectId, key: "token", value: "tok-456", isSecret: true });
    expect((await api("GET", `/projects/${projectId}`)).data.variables.length).toBe(1);

    const scheme = (await api("PUT", `/collections/${collectionId}/auth`, { type: "api_key", config: { name: "x-api-key" } })).data;
    const cred = (await api("POST", `/auth-schemes/${scheme.id}/credentials`, { label: "demo", secret: "sk_live_REAL" })).data;
    expect(JSON.stringify(cred)).not.toContain("sk_live_REAL");
    const col = (await api("GET", `/collections/${collectionId}`)).data;
    expect(JSON.stringify(col)).not.toContain("sk_live_REAL");
    expect(col.authScheme.credentials).toHaveLength(1);

    // the new scheme is enforced immediately
    expect((await callMock("acme-corp/checkout/payments/orders/1")).status).toBe(401);
    expect((await callMock("acme-corp/checkout/payments/orders/1", { headers: { "x-api-key": "sk_live_REAL" } })).status).toBe(201);
    expect((await api("GET", `/credentials/${cred.id}/reveal`)).data.secret).toBe("sk_live_REAL");
    await api("PATCH", `/credentials/${cred.id}`, { isActive: false });
    expect((await callMock("acme-corp/checkout/payments/orders/1", { headers: { "x-api-key": "sk_live_REAL" } })).status).toBe(401);
  });

  it("preview renders templates and reports syntax errors", async () => {
    const ok = await api("POST", "/preview", { template: '{"id":"{{request.params.id}}","v":"{{vars.a}}"}', request: { params: { id: "5" } }, vars: { a: "x" } });
    expect(ok.data.output).toBe('{"id":"5","v":"x"}');
    const err = await api("POST", "/preview", { template: '{{faker "nope.nope"}}' });
    expect(err.status).toBe(422);
  });

  it("log API lists, filters, shows details, and clears", async () => {
    await callMock("acme-corp/checkout/payments/missing-path");
    for (let i = 0; i < 100; i++) {
      const n = (await api("GET", `/logs?projectId=${projectId}`)).data.length;
      if (n >= 5) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const all = (await api("GET", `/logs?projectId=${projectId}`)).data;
    expect(all.length).toBeGreaterThan(3);
    expect(all[0]).not.toHaveProperty("responseBody"); // summary only
    const misses = (await api("GET", `/logs?projectId=${projectId}&status=miss`)).data;
    expect(misses.every((r: any) => r.matched === false)).toBe(true);
    expect((await api("GET", `/logs?projectId=${projectId}&status=4xx&q=missing`)).data.length).toBeGreaterThan(0);
    expect((await api("GET", `/logs?q=${encodeURIComponent("%")}`)).data.length).toBe(0); // % is literal, not a wildcard
    const detail = (await api("GET", `/logs/${all[0].id}`)).data;
    expect(detail).toHaveProperty("responseBody");
    expect((await api("DELETE", `/logs?projectId=${projectId}`)).status).toBe(200);
    expect((await api("GET", `/logs?projectId=${projectId}`)).data).toEqual([]);
  });

  it("sample wizard: a pasted cURL + response becomes a working endpoint", async () => {
    // A fresh collection: the shared one has auth switched on by earlier tests
    const wid = (await api("POST", "/collections", { projectId, name: "Refunds" })).data.id;
    const analyze = `/collections/${wid}/wizard/analyze`;
    const create = `/collections/${wid}/wizard/create`;
    const a = (await api("POST", analyze, {
      curl: `curl -X POST https://api.acme.com/v1/refunds/55102 -H 'Content-Type: application/json' -d '{"amount": 500}'`,
      responseStatus: 201,
      responseBody: JSON.stringify({ id: "re_8f3k29dkx1", amount: 500, created: "2024-05-01T10:00:00Z", status: "succeeded" }),
    })).data;
    expect(a.method).toBe("POST");
    expect(a.path).toBe("/v1/refunds/:id");
    expect(a.requestSchema).toMatchObject({ type: "object", required: ["amount"] });
    expect(a.substitutions.map((s: any) => s.at).sort()).toEqual(["amount", "created", "id"]);

    const made = await api("POST", create, { name: a.name, method: a.method, path: a.path, requestSchema: a.requestSchema, status: a.status, contentType: a.contentType, body: a.body });
    expect(made.status).toBe(201);
    const res = await callMock("acme-corp/checkout/refunds/v1/refunds/9", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: 250 }) });
    expect(res.status).toBe(201);
    const out = (await res.json()) as any;
    expect(out.amount).toBe(250);
    expect(out.status).toBe("succeeded");

    // The same endpoint again is flagged; a broken template and a missing URL are refused
    const again = (await api("POST", analyze, { method: "POST", url: "/v1/refunds/1", responseBody: "{}" })).data;
    expect(again.warnings.join(" ")).toContain("already has");
    expect((await api("POST", create, { name: "x", method: "GET", path: "/x", status: 200, contentType: "text/plain", body: "{{#if}}" })).status).toBe(422);
    expect((await api("POST", analyze, { responseBody: "{}" })).status).toBe(400);
  });

  it("SOAP: WSDL import, dispatch by operation, Faults by scenario, ?wsdl, and clear errors", async () => {
    const col = (await api("POST", "/collections", { projectId, name: "Legacy ERP", protocol: "soap" })).data;
    const base = "acme-corp/checkout/legacy-erp";
    const wsdl = `<definitions name="Erp" targetNamespace="urn:erp" xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="urn:erp" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
      <types><xsd:schema targetNamespace="urn:erp">
        <xsd:element name="GetStockRequest"><xsd:complexType><xsd:sequence><xsd:element name="Sku" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>
        <xsd:element name="GetStockResponse"><xsd:complexType><xsd:sequence><xsd:element name="Sku" type="xsd:string"/><xsd:element name="Qty" type="xsd:int"/></xsd:sequence></xsd:complexType></xsd:element>
      </xsd:schema></types>
      <message name="In"><part name="p" element="tns:GetStockRequest"/></message>
      <message name="Out"><part name="p" element="tns:GetStockResponse"/></message>
      <portType name="Port"><operation name="GetStock"><input message="tns:In"/><output message="tns:Out"/></operation></portType>
      <binding name="B" type="tns:Port"><soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/><operation name="GetStock"><soap:operation soapAction="urn:erp/GetStock"/></operation></binding>
      <service name="ErpService"><port name="P" binding="tns:B"><soap:address location="http://real.erp.example/svc"/></port></service>
    </definitions>`;

    // REST collections refuse a WSDL; a broken WSDL is a 422; a good one creates the operations
    expect((await api("POST", `/collections/${collectionId}/wsdl`, { wsdl })).status).toBe(400);
    expect((await api("POST", `/collections/${col.id}/wsdl`, { wsdl: "<html/>" })).status).toBe(422);
    const imp = (await api("POST", `/collections/${col.id}/wsdl`, { wsdl })).data;
    expect(imp.created).toEqual(["GetStock"]);
    expect((await api("POST", `/collections/${col.id}/wsdl`, { wsdl })).data.skipped).toEqual(["GetStock"]); // re-import doesn't duplicate

    const soapCall = (p: string, body: string, headers: Record<string, string> = {}) =>
      callMock(`${base}${p}`, { method: "POST", headers: { "content-type": "text/xml", ...headers }, body });
    const req11 = (inner: string) => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`;

    // The imported sample answers straight away, wrapped in an envelope
    const first = await soapCall("", req11('<GetStock xmlns="urn:erp"><Sku>A1</Sku></GetStock>'), { soapaction: '"urn:erp/GetStock"' });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/xml");
    const text1 = await first.text();
    expect(text1).toContain("<soap:Envelope");
    expect(text1).toContain("<GetStockResponse");

    // Edit the rule to echo the request; SOAP 1.2 gets a 1.2 envelope back
    const ep = (await api("GET", `/collections/${col.id}`)).data.endpoints[0];
    const detail = (await api("GET", `/endpoints/${ep.id}`)).data;
    await api("PATCH", `/rules/${detail.rules[0].id}`, { body: '<GetStockResponse xmlns="urn:erp"><Sku>{{xml request.body.GetStock.Sku}}</Sku><Qty>{{randomInt 5 5}}</Qty></GetStockResponse>' });
    const r12 = await soapCall("", '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetStock xmlns="urn:erp"><Sku>B&amp;2</Sku></GetStock></s:Body></s:Envelope>');
    const t12 = await r12.text();
    expect(r12.headers.get("content-type")).toContain("application/soap+xml");
    expect(t12).toContain("http://www.w3.org/2003/05/soap-envelope");
    expect(t12).toContain("<Sku>B&amp;2</Sku>");
    expect(t12).toContain("<Qty>5</Qty>");

    // A scenario turns the same request into a Fault
    const sc = (await api("POST", `/projects/${projectId}/scenarios`, { name: "erp-down" })).data;
    await api("POST", `/endpoints/${ep.id}/rules`, { name: "out of stock", scenarioId: sc.id, status: 500, contentType: "text/xml", body: '{{soapFault "Server" "Out of stock"}}' });
    await api("PATCH", `/projects/${projectId}`, { activeScenarioId: sc.id });
    const fault = await soapCall("", req11('<GetStock xmlns="urn:erp"><Sku>A1</Sku></GetStock>'));
    expect(fault.status).toBe(500);
    const ft = await fault.text();
    expect(ft).toContain("<faultcode>soap:Server</faultcode>");
    expect(ft).toContain("Out of stock");
    await api("PATCH", `/projects/${projectId}`, { activeScenarioId: null });

    // Unknown operation, malformed XML and wrong verb all answer with a Fault that says what's wrong
    const unknown = await soapCall("", req11("<Nope/>"));
    expect(unknown.status).toBe(500);
    expect(await unknown.text()).toContain("No operation &quot;Nope&quot;. Known: GetStock");
    const broken = await soapCall("", "<a><b></a>");
    expect(broken.status).toBe(400);
    expect(await broken.text()).toContain("not well-formed");
    expect((await callMock(base)).status).toBe(405);

    // ?wsdl serves the imported document, pointing at the mock
    const served = await callMock(`${base}?wsdl`);
    expect(served.status).toBe(200);
    const wtext = await served.text();
    expect(wtext).toContain(`location="http://${HOST}/mock/${base}"`);
    expect(wtext).not.toContain("real.erp.example");

    // The log explains the SOAP match
    const logs = (await api("GET", `/logs?projectId=${projectId}&q=legacy-erp`)).data;
    expect(logs.some((l: any) => l.explanation.includes("matched") || l.explanation.includes("default rule"))).toBe(true);
  });

  it("SOAP wizard: a pasted envelope pair becomes an operation, with SOAPAction from cURL", async () => {
    const col = (await api("POST", "/collections", { projectId, name: "Billing SOAP", protocol: "soap" })).data;
    const a = (await api("POST", `/collections/${col.id}/wizard/analyze`, {
      curl: `curl https://erp.example.com/svc -H 'SOAPAction: "urn:bill/Charge"' -H 'Content-Type: text/xml' -d '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><Charge xmlns="urn:bill"><Amount>12.50</Amount></Charge></s:Body></s:Envelope>'`,
      responseBody: '<ChargeResponse xmlns="urn:bill"><Amount>12.50</Amount><Id>7c9e6679-7425-40de-944b-e07fc1f90ae7</Id><Status>OK</Status></ChargeResponse>',
    })).data;
    expect(a).toMatchObject({ soap: true, operation: "Charge", soapAction: "urn:bill/Charge", soapVersion: "1.1" });
    expect(a.body).toContain("{{xml request.body.Charge.Amount}}");
    expect(a.body).toContain("{{uuid}}");
    expect((await api("POST", `/collections/${col.id}/wizard/create`, { name: a.name, method: "POST", path: "/", status: 200, contentType: a.contentType, body: a.body, operation: a.operation, soapAction: a.soapAction })).status).toBe(201);
    const res = await callMock("acme-corp/checkout/billing-soap", { method: "POST", headers: { "content-type": "text/xml" }, body: '<e:Envelope xmlns:e="http://schemas.xmlsoap.org/soap/envelope/"><e:Body><Charge><Amount>99.00</Amount></Charge></e:Body></e:Envelope>' });
    const t = await res.text();
    expect(res.status).toBe(200);
    expect(t).toContain("<Amount>99.00</Amount>");
    expect(t).toContain("<Status>OK</Status>");
    // Not XML at all: say so
    expect((await api("POST", `/collections/${col.id}/wizard/analyze`, { requestBody: "not xml", responseBody: "<b/>" })).status).toBe(400);
  });

  it("SOAP wizard: bare Body XML gets a default envelope, and a path only changes the copied URL", async () => {
    const col = (await api("POST", "/collections", { projectId, name: "Tokens SOAP", protocol: "soap" })).data;
    const a = (await api("POST", `/collections/${col.id}/wizard/analyze`, {
      requestBody: "<GetTokenRequest><InputParameter><BankCode>73</BankCode></InputParameter></GetTokenRequest>",
      responseBody: "<GetTokenResponse Response=\"1\"><OutputParameter><BankCode>73</BankCode></OutputParameter></GetTokenResponse>",
    })).data;
    expect(a).toMatchObject({ soap: true, operation: "GetTokenRequest", soapVersion: "1.1" });
    const created = await api("POST", `/collections/${col.id}/wizard/create`, { name: "Get Token", method: "POST", path: "/getToken", status: 200, contentType: a.contentType, body: a.body, operation: a.operation });
    expect(created.status).toBe(201);
    expect((await api("GET", `/endpoints/${created.data.id}`)).data.endpoint.path).toBe("/getToken");
    // The manual form stores a path too, and defaults to "/" without one
    const manual = await api("POST", "/endpoints", { collectionId: col.id, name: "Pay", operation: "PayRequest", path: "/pay" });
    expect((await api("GET", `/endpoints/${manual.data.id}`)).data.endpoint.path).toBe("/pay");
    const bare = await api("POST", "/endpoints", { collectionId: col.id, name: "Ping", operation: "PingRequest" });
    expect((await api("GET", `/endpoints/${bare.data.id}`)).data.endpoint.path).toBe("/");
    // The path is not checked: the Body picks the endpoint, with or without it
    const env = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><GetTokenRequest><InputParameter><BankCode>73</BankCode></InputParameter></GetTokenRequest></s:Body></s:Envelope>';
    for (const suffix of ["", "/getToken", "/anything/else"]) {
      const res = await callMock(`acme-corp/checkout/tokens-soap${suffix}`, { method: "POST", headers: { "content-type": "text/xml" }, body: env });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<GetTokenResponse");
    }
  });

  it("blocks cross-origin writes, non-JSON bodies, bad JSON, and unknown routes", async () => {
    const cross = await api("POST", "/clients", { name: "Evil" }, { origin: "http://evil.example" });
    expect(cross.status).toBe(403);
    const same = await api("POST", "/clients", { name: "Fine" }, { origin: `http://${HOST}` });
    expect(same.status).toBe(201);

    const form = await admin.handleAdmin(new Request(`http://${HOST}/api/admin/clients`, { method: "POST", headers: { host: HOST, "content-type": "text/plain", "content-length": "9" }, body: '{"name":1}' }));
    expect(form.status).toBe(403);
    const badJson = await admin.handleAdmin(new Request(`http://${HOST}/api/admin/clients`, { method: "POST", headers: { host: HOST, "content-type": "application/json" }, body: "{oops" }));
    expect(badJson.status).toBe(400);
    expect((await api("GET", "/nope")).status).toBe(404);
    expect((await api("PUT", "/tree", {})).status).toBe(405);
    expect((await api("POST", "/clients", { name: "" })).data.error).toContain("Invalid input");
    expect((await api("GET", "/endpoints/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });
});
