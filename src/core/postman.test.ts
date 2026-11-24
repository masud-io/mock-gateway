/* eslint-disable @typescript-eslint/no-explicit-any -- converter output is asserted loosely on purpose */
import { describe, expect, it } from "vitest";
import { isPostmanCollection, postmanToExport } from "./postman";

const SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

const collection = {
  info: { name: "Orders API", schema: SCHEMA },
  item: [
    {
      name: "Orders",
      item: [
        {
          name: "Get order",
          request: { method: "get", url: { raw: "{{baseUrl}}/orders/:id?expand=1", host: ["{{baseUrl}}"], path: ["orders", ":id"] } },
          response: [
            { name: "Found", code: 200, header: [{ key: "Content-Type", value: "application/json; charset=utf-8" }, { key: "X-Req", value: "a{{b}}" }, { key: "Content-Length", value: "9" }], body: '{"id":"{{orderId}}"}' },
            { name: "Not found", code: 404, header: [], body: "nope" },
          ],
        },
        {
          name: "Create order",
          request: {
            method: "POST", url: { path: ["orders"] },
            header: [{ key: "X-Token", value: "{{token}}" }, { key: "Skip-Me", value: "x", disabled: true }, { key: "Content-Length", value: "9" }],
            body: { mode: "raw", raw: '{"t":"{{token}}","n":1}' },
          },
          response: [],
        },
      ],
    },
    { name: "By raw url", request: { method: "DELETE", url: "https://api.example.com/v1/orders/{{orderId}}/items" } },
    { name: "Duplicate", request: { method: "GET", url: { path: ["orders", ":id"] } } },
    { name: "folder without requests", item: [] },
  ],
};

describe("postman import", () => {
  it("recognises Postman collections and nothing else", () => {
    expect(isPostmanCollection(collection)).toBe(true);
    expect(isPostmanCollection({ info: { name: "x" }, item: [] })).toBe(false);
    expect(isPostmanCollection({ format: "mock-gateway/collection" })).toBe(false);
    expect(isPostmanCollection(null)).toBe(false);
    expect(isPostmanCollection("x")).toBe(false);
  });

  const { file, warnings } = postmanToExport(collection) as { file: any; warnings: string[] };

  it("turns folders and requests into endpoints, with methods and paths", () => {
    expect(file.collection).toMatchObject({ name: "Orders API", slug: "Orders API", protocol: "rest" });
    expect(file.endpoints.map((e: any) => `${e.method} ${e.path}`)).toEqual(["GET /orders/:id", "POST /orders", "DELETE /v1/orders/:orderId/items"]);
    expect(file.endpoints.map((e: any) => e.name)).toEqual(["Get order", "Create order", "By raw url"]);
  });

  it("skips a request whose method and path were already taken, and says so", () => {
    expect(warnings.join("\n")).toContain('Skipped "Duplicate"');
  });

  it("makes the first example the default rule and parks the rest behind a placeholder condition", () => {
    const [found, notFound] = file.endpoints[0].rules;
    expect(found).toMatchObject({ name: "Found", isDefault: true, status: 200, contentType: "application/json", conditions: [] });
    expect(notFound).toMatchObject({ name: "Not found", isDefault: false, status: 404, contentType: "text/plain" });
    expect(notFound.conditions).toEqual([{ source: "header", expr: "x-edit-me", op: "exists" }]);
    expect(warnings.join("\n")).toContain("placeholder condition");
  });

  it("keeps {{ }} in examples literal, and drops transport headers", () => {
    const found = file.endpoints[0].rules[0];
    expect(found.body).toBe('{"id":"\\{{orderId}}"}');
    expect(found.headers).toEqual({ "X-Req": "a\\{{b}}" });
  });

  it("a request without examples answers {} and the user is told", () => {
    expect(file.endpoints[1].rules).toEqual([expect.objectContaining({ isDefault: true, status: 200, body: "{}" })]);
    expect(warnings.join("\n")).toContain('"Create order" has no saved example response');
  });

  it("also keeps every request as a saved request, ready to send, with Postman variables as {{vars.x}}", () => {
    expect(file.requests.map((r: any) => `${r.folder ?? "-"} | ${r.method} ${r.path}`)).toEqual([
      "Orders | GET /orders/:id",
      "Orders | POST /orders",
      "- | DELETE /v1/orders/{{vars.orderId}}/items", // a {{var}} stays a variable here, unlike the endpoint's :orderId
      "- | GET /orders/:id", // the duplicate endpoint was skipped, but the request itself is still kept
    ]);
    const create = file.requests[1];
    expect(create.name).toBe("Create order");
    expect(create.headers).toEqual({ "X-Token": "{{vars.token}}" }); // disabled and Content-Length headers dropped
    expect(create.body).toBe('{"t":"{{vars.token}}","n":1}');
    expect(file.requests[0]).toMatchObject({ headers: {}, body: "" });
  });

  it("an empty collection yields no endpoints and a warning, not a crash", () => {
    const r = postmanToExport({ info: { name: "Empty", schema: SCHEMA }, item: [] }) as { file: any; warnings: string[] };
    expect(r.file.endpoints).toEqual([]);
    expect(r.warnings.join("\n")).toContain("No requests were found");
  });
});
