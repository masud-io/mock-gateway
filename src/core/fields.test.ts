import { describe, expect, it } from "vitest";
import { readRequestFields } from "./fields";
import { parseBody } from "./body";
import { testMatcher } from "./matchers";
import { parseEnvelope, wrapEnvelope } from "./soap";
import type { MockRequest } from "./types";

const mockReq = (over: Partial<MockRequest>): MockRequest => ({ method: "POST", path: "/", query: {}, headers: {}, rawBody: "", body: null, ...over });

const TOKEN_REQUEST = `<GetTokenRequest Version="2">
  <InputParameter>
    <BankCode>73</BankCode>
    <UserName>BASIAuser</UserName>
  </InputParameter>
</GetTokenRequest>`;

describe("readRequestFields", () => {
  it("lists SOAP fields from a bare Body, with attributes and a summary", () => {
    const r = readRequestFields(TOKEN_REQUEST, "soap");
    expect(r.summary).toBe("SOAP request: GetTokenRequest");
    // The XML parser reports an element's attributes after its children
    expect(r.fields).toEqual([
      { source: "body", expr: "$.GetTokenRequest.InputParameter.BankCode", value: "73" },
      { source: "body", expr: "$.GetTokenRequest.InputParameter.UserName", value: "BASIAuser" },
      { source: "body", expr: "$.GetTokenRequest['@_Version']", value: "2" },
    ]);
  });

  it("reads a full envelope the same way, whatever the prefix", () => {
    const env = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><o:Pay xmlns:o="urn:x"><o:Amount>5</o:Amount></o:Pay></s:Body></s:Envelope>`;
    expect(readRequestFields(env, "soap").fields).toEqual([{ source: "body", expr: "$.Pay.Amount", value: "5" }]);
  });

  it("every body expression it gives is one the mock really matches (equals, and does not equal)", () => {
    // The point of the feature: a condition built from a field must fire for that very request
    const env = parseEnvelope(wrapEnvelope("1.1", TOKEN_REQUEST), {});
    if ("error" in env) throw new Error(env.error);
    const req = mockReq({ body: env.body });
    const fields = readRequestFields(TOKEN_REQUEST, "soap").fields;
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) {
      expect(testMatcher({ source: f.source, expr: f.expr, op: "equals", value: f.value }, { req, params: {} }), f.expr).toBe(true);
      expect(testMatcher({ source: f.source, expr: f.expr, op: "not_equals", value: f.value }, { req, params: {} }), f.expr).toBe(false);
      expect(testMatcher({ source: f.source, expr: f.expr, op: "equals", value: "other" }, { req, params: {} }), f.expr).toBe(false);
    }
  });

  it("JSON: nested objects, arrays by index, awkward keys in brackets", () => {
    const json = JSON.stringify({ user: { id: 7, "first-name": "Ann", "it's": true }, items: [{ sku: "A" }, { sku: "B" }], gone: null, empty: {} });
    const r = readRequestFields(json, "rest");
    expect(r.fields.map((f) => `${f.expr}=${f.value}`)).toEqual([
      "$.user.id=7", "$.user['first-name']=Ann", "$.user['it\\'s']=true", "$.items[0].sku=A", "$.items[1].sku=B",
    ]);
    const req = mockReq({ body: parseBody("application/json", json) });
    for (const f of r.fields) expect(testMatcher({ source: "body", expr: f.expr, op: "equals", value: f.value }, { req, params: {} }), f.expr).toBe(true);
  });

  it("cURL: body fields plus query parameters and useful headers, not transport noise", () => {
    const r = readRequestFields(
      `curl -X POST 'https://api.x.com/v1/pay?channel=app&n=2' -H 'Content-Type: application/json' -H 'X-Tenant: acme' -H 'User-Agent: curl/8' -H 'Accept: */*' -d '{"amount":10}'`,
      "rest",
    );
    expect(r.summary).toBe("POST JSON/form body");
    expect(r.fields).toEqual([
      { source: "body", expr: "$.amount", value: "10" },
      { source: "query", expr: "channel", value: "app" },
      { source: "query", expr: "n", value: "2" },
      { source: "header", expr: "content-type", value: "application/json" },
      { source: "header", expr: "x-tenant", value: "acme" },
    ]);
  });

  it("a SOAP cURL command works too, and form data is read as fields", () => {
    const c = readRequestFields(`curl https://erp/svc -H 'Content-Type: text/xml' -H 'SOAPAction: "urn:x/Pay"' -d '<Pay><Amount>5</Amount></Pay>'`, "soap");
    expect(c.fields).toContainEqual({ source: "body", expr: "$.Pay.Amount", value: "5" });
    expect(c.fields).toContainEqual({ source: "header", expr: "soapaction", value: '"urn:x/Pay"' });
    const form = readRequestFields(`curl https://x/y -H 'Content-Type: application/x-www-form-urlencoded' -d 'a=1&b=2'`, "rest");
    expect(form.fields.slice(0, 2)).toEqual([{ source: "body", expr: "$.a", value: "1" }, { source: "body", expr: "$.b", value: "2" }]);
  });

  it("says what is wrong instead of returning nothing", () => {
    expect(() => readRequestFields("   ", "soap")).toThrow("Paste a sample request first");
    expect(() => readRequestFields("<a><b></a>", "soap")).toThrow(/not well-formed XML/);
    expect(() => readRequestFields("just words", "rest")).toThrow(/not JSON or form data/);
    expect(() => readRequestFields("{}", "rest")).toThrow(/No fields found/);
  });

  it("an empty element is still a field, with an empty value", () => {
    expect(readRequestFields("<Ping><Note/></Ping>", "soap").fields).toEqual([{ source: "body", expr: "$.Ping.Note", value: "" }]);
  });

  it("caps a huge request instead of flooding the page", () => {
    const big = JSON.stringify({ list: Array.from({ length: 1000 }, (_, i) => ({ n: i })) });
    expect(readRequestFields(big, "rest").fields).toHaveLength(300);
  });
});
