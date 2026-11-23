/* eslint-disable @typescript-eslint/no-explicit-any -- schemas are asserted loosely on purpose */
import { describe, expect, it } from "vitest";
import { buildTemplate, inferPath, inferSchema, parseCurl } from "./infer";
import { checkTemplate, renderTemplate } from "./template";

describe("parseCurl", () => {
  it("reads method, url, headers and body from a multi-line command", () => {
    const r = parseCurl(`curl -X POST 'https://api.acme.com/v1/orders' \\
  -H 'Authorization: Bearer sk_live_123' \\
  -H "Content-Type: application/json" \\
  -d '{"amount": 1200, "currency": "USD"}'`);
    expect(r.method).toBe("POST");
    expect(r.url).toBe("https://api.acme.com/v1/orders");
    expect(r.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(r.body)).toEqual({ amount: 1200, currency: "USD" });
  });
  it("defaults to GET, or POST when there is data", () => {
    expect(parseCurl("curl https://x.test/a").method).toBe("GET");
    expect(parseCurl("curl https://x.test/a -d 'a=1'").method).toBe("POST");
  });
  it("rejects a command with no URL", () => {
    expect(() => parseCurl("curl -X GET")).toThrow(/URL/);
  });
});

describe("inferPath", () => {
  it("turns ids into params and keeps fixed words", () => {
    expect(inferPath("https://api.x.com/v1/orders/12345?expand=items")).toMatchObject({ path: "/v1/orders/:id", params: { id: "12345" }, query: { expand: "items" } });
    expect(inferPath("/v2/health").path).toBe("/v2/health");
  });
  it("names params after the preceding word when there are several", () => {
    const r = inferPath("/customers/cus_8f3k29dkx1/orders/7781");
    expect(r.path).toBe("/customers/:customerId/orders/:orderId");
    expect(r.params).toEqual({ customerId: "cus_8f3k29dkx1", orderId: "7781" });
  });
  it("does not treat versions or dates as ids", () => {
    expect(inferPath("/v1/reports/2024-01").path).toBe("/v1/reports/2024-01");
  });
});

describe("inferSchema", () => {
  it("infers nested types, formats and required fields", () => {
    const s = inferSchema({ id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", n: 3, price: 1.5, ok: true, at: "2024-05-01T10:00:00Z", user: { email: "a@b.co" }, tags: ["a"] });
    expect(s).toMatchObject({
      type: "object",
      required: ["id", "n", "price", "ok", "at", "user", "tags"],
      properties: {
        id: { type: "string", format: "uuid" }, n: { type: "integer" }, price: { type: "number" }, ok: { type: "boolean" },
        at: { type: "string", format: "date-time" }, user: { properties: { email: { format: "email" } } }, tags: { type: "array", items: { type: "string" } },
      },
    });
  });
  it("merges array items so that optional fields aren't required", () => {
    const s = inferSchema([{ a: 1, b: "x" }, { a: 2.5 }]) as any;
    expect(s.items.required).toEqual(["a"]);
    expect(s.items.properties.a.type).toBe("number");
  });
});

describe("buildTemplate", () => {
  it("replaces generated values and echoes, and renders to a valid response", () => {
    const { template, substitutions } = buildTemplate({
      responseBody: JSON.stringify({ id: "ord_8f3k29dkx1", ref: "7c9e6679-7425-40de-944b-e07fc1f90ae7", created: "2024-05-01T10:00:00Z", amount: 1200, currency: "USD", status: "paid", customer: { id: 4521 } }),
      requestBody: { amount: 1200, currency: "USD" },
      params: {},
    });
    expect(checkTemplate(template)).toBeNull();
    expect(substitutions.map((s) => s.at).sort()).toEqual(["amount", "created", "currency", "customer.id", "id", "ref"]);
    const out = JSON.parse(
      renderTemplate(template, { request: { method: "POST", path: "/", params: {}, query: {}, headers: {}, body: { amount: 999, currency: "EUR" }, rawBody: "" }, vars: {}, scenario: null }),
    );
    expect(out.amount).toBe(999);
    expect(out.currency).toBe("EUR");
    expect(out.status).toBe("paid"); // untouched
    expect(out.id).toMatch(/^ord_/);
    expect(out.id).not.toBe("ord_8f3k29dkx1");
    expect(out.created).not.toBe("2024-05-01T10:00:00Z");
    expect(typeof out.customer.id).toBe("number");
  });
  it("echoes path params with the right JSON type", () => {
    const { template } = buildTemplate({ responseBody: '{"id": 123, "ref": "A1B2C3D4E5", "name": "x"}', params: { id: "123", ref: "A1B2C3D4E5" } });
    const out = JSON.parse(renderTemplate(template, { request: { method: "GET", path: "/", params: { id: "9", ref: "ZZ" }, query: {}, headers: {}, body: null, rawBody: "" }, vars: {}, scenario: null }));
    expect(out).toEqual({ id: 9, ref: "ZZ", name: "x" });
  });
  it("keeps non-JSON bodies, tokenising UUIDs", () => {
    const r = buildTemplate({ responseBody: "<ok id='7c9e6679-7425-40de-944b-e07fc1f90ae7'/>", params: {} });
    expect(r.isJson).toBe(false);
    expect(r.template).toBe("<ok id='{{uuid}}'/>");
  });
  it("leaves arrays and booleans alone but still walks into array items", () => {
    const { template } = buildTemplate({ responseBody: '{"items":[{"id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","paid":true}]}', params: {} });
    expect(checkTemplate(template)).toBeNull();
    expect(template).toContain("{{json (uuid)}}");
    expect(template).toContain('"paid": true');
  });
});
