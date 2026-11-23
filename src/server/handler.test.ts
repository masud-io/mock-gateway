import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real stack: embedded Postgres in a temp dir -> migrations -> seeded config -> handler -> request_logs.
let dir: string;
let db: typeof import("../db");
let handler: typeof import("./handler");
let repo: typeof import("./repository");
let crypto: typeof import("./crypto");
let ids: { project: string; failScenario: string };

const call = (p: string, init: RequestInit = {}) => handler.handleMockRequest(new Request(`http://localhost:3000/mock/acme/checkout/${p}`, init));
const KEY = { "x-api-key": "sk_test_SUPERSECRET" };

async function waitForLogs(n: number) {
  for (let i = 0; i < 100; i++) {
    const rows = await db.getDb().select().from(db.schema.requestLogs);
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`expected ${n} log rows`);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "mockgw-test-"));
  process.env.MOCKGW_DATA_DIR = path.join(dir, "pg"); // secret.key lands in `dir`
  db = await import("../db");
  handler = await import("./handler");
  repo = await import("./repository");
  crypto = await import("./crypto");
  await migrate(db.getDb(), { migrationsFolder: "./drizzle" });

  const { clients, projects, collections, endpoints, scenarios, responseRules, authSchemes, authCredentials, variables } = db.schema;
  const d = db.getDb();
  const [client] = await d.insert(clients).values({ name: "Acme", slug: "acme" }).returning();
  const [project] = await d.insert(projects).values({ clientId: client.id, name: "Checkout", slug: "checkout" }).returning();
  const [, fail] = await d
    .insert(scenarios)
    .values([{ projectId: project.id, name: "happy" }, { projectId: project.id, name: "payment-fails" }])
    .returning();
  const [col] = await d
    .insert(collections)
    .values({ projectId: project.id, name: "Payments", slug: "payments", defaultHeaders: { "x-provider": "acme-pay" } })
    .returning();
  await d.insert(variables).values([
    { scope: "client", scopeId: client.id, key: "currency", value: "USD" },
    { scope: "collection", scopeId: col.id, key: "currency", value: "EUR" }, // collection overrides client
  ]);

  const [getOrder, pay, ping] = await d
    .insert(endpoints)
    .values([
      { collectionId: col.id, name: "Get order", method: "GET", path: "/orders/:id" },
      {
        collectionId: col.id, name: "Pay", method: "POST", path: "/pay",
        requestSchema: { type: "object", required: ["amount"], properties: { amount: { type: "number", minimum: 1 } } },
      },
      { collectionId: col.id, name: "Ping", method: "DELETE", path: "/ping" },
    ])
    .returning();

  await d.insert(responseRules).values([
    { endpointId: getOrder.id, name: "ok", isDefault: true, body: '{"id":"{{request.params.id}}","currency":"{{vars.currency}}"}' },
    { endpointId: getOrder.id, name: "declined", scenarioId: fail.id, status: 402, body: '{"error":"card_declined"}' },
    { endpointId: pay.id, name: "paid", isDefault: true, status: 201, body: '{"paid":{{request.body.amount}}}' },
    { endpointId: ping.id, name: "gone", isDefault: true, status: 204, body: "ignored" },
  ]);

  const [scheme] = await d
    .insert(authSchemes)
    .values({ collectionId: col.id, type: "api_key", config: { name: "x-api-key" }, onFail: { status: 401, contentType: "application/json", body: '{"code":"BAD_KEY"}' } })
    .returning();
  await d.insert(authCredentials).values({ schemeId: scheme.id, label: "test key", secretEncrypted: crypto.encryptSecret("sk_test_SUPERSECRET") });

  ids = { project: project.id, failScenario: fail.id };
});

afterAll(async () => {
  await db.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("mock handler (real database)", () => {
  it("serves a templated response using merged variables and default headers", async () => {
    const res = await call("payments/orders/42", { headers: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "42", currency: "EUR" });
    expect(res.headers.get("x-provider")).toBe("acme-pay");
    expect(res.headers.get("x-mockgw-endpoint")).toBeTruthy();
  });

  it("rejects a missing or wrong key with the provider's own error body", async () => {
    const none = await call("payments/orders/1");
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ code: "BAD_KEY" });
    expect((await call("payments/orders/1", { headers: { "x-api-key": "nope" } })).status).toBe(401);
  });

  it("validates request bodies and renders a body-driven response", async () => {
    const post = (b: unknown) => call("payments/pay", { method: "POST", headers: { ...KEY, "content-type": "application/json" }, body: JSON.stringify(b) });
    const bad = await post({ amount: 0 });
    expect(bad.status).toBe(400);
    expect((await bad.json()).details[0]).toContain("/amount");
    const ok = await post({ amount: 12.5 });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ paid: 12.5 });
  });

  it("returns an explanatory 404 for unknown projects, collections and paths", async () => {
    const proj = await handler.handleMockRequest(new Request("http://localhost:3000/mock/acme/nope/payments/x"));
    expect(proj.status).toBe(404);
    expect((await proj.json()).hint).toContain("No project");
    const col = await call("nope/x");
    expect((await col.json()).hint).toContain("Collections: payments");
    const path = await call("payments/missing", { headers: KEY });
    expect((await path.json()).hint).toContain("Known:");
  });

  it("sends no body for 204 and for HEAD", async () => {
    const del = await call("payments/ping", { method: "DELETE", headers: KEY });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    const head = await call("payments/orders/9", { method: "HEAD", headers: KEY });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("scenario switch takes effect once the cache is invalidated", async () => {
    await db.getDb().update(db.schema.projects).set({ activeScenarioId: ids.failScenario }).where(eq(db.schema.projects.id, ids.project));
    // Cached snapshot still reflects the old scenario: this is why admin writes must invalidate
    expect((await call("payments/orders/1", { headers: KEY })).status).toBe(200);
    repo.invalidateRuntimeCache();
    const res = await call("payments/orders/1", { headers: KEY });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "card_declined" });
  });

  it("stores the credential encrypted and never logs the clear-text key", async () => {
    const [cred] = await db.getDb().select().from(db.schema.authCredentials);
    expect(cred.secretEncrypted).not.toContain("SUPERSECRET");
    expect(crypto.decryptSecret(cred.secretEncrypted)).toBe("sk_test_SUPERSECRET");

    const rows = await waitForLogs(8);
    expect(JSON.stringify(rows)).not.toContain("SUPERSECRET");
    const keyed = rows.find((r) => r.requestHeaders["x-api-key"]);
    expect(keyed?.requestHeaders["x-api-key"]).toBe("***");
  });

  it("logs matches and misses with an explanation", async () => {
    const rows = await waitForLogs(8);
    const miss = rows.find((r) => r.path.endsWith("/payments/missing"));
    expect(miss).toMatchObject({ matched: false, responseStatus: 404 });
    expect(miss?.explanation).toContain("Known:");
    const declined = rows.find((r) => r.responseStatus === 402);
    expect(declined?.explanation).toContain('scenario "payment-fails"');
    const denied = rows.find((r) => r.responseStatus === 401);
    expect(denied?.authResult).toContain("api_key");
  });

  it("prune keeps only the newest rows", async () => {
    const { prune } = await import("./logger");
    await prune(3);
    const rows = await db.getDb().select().from(db.schema.requestLogs);
    expect(rows.length).toBeLessThanOrEqual(4);
  });
});
