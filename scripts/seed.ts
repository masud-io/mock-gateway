import { eq } from "drizzle-orm";
import { getDb, closeDb, schema } from "../src/db";
import { encryptSecret } from "../src/server/crypto";

const { clients, projects, collections, endpoints, scenarios, responseRules, roles, authSchemes, authCredentials, variables } = schema;

async function main() {
  const db = getDb();

  const existing = await db.select().from(clients).where(eq(clients.slug, "acme"));
  if (existing.length) {
    console.log("seed already applied");
    return;
  }

  await db.insert(roles).values([
    { name: "owner", permissions: ["*:*"] },
    { name: "editor", permissions: ["endpoint:write", "collection:write", "log:read"] },
    { name: "viewer", permissions: ["log:read"] },
  ]);

  const [client] = await db.insert(clients).values({ name: "Acme Corp", slug: "acme" }).returning();
  const [project] = await db.insert(projects).values({ clientId: client.id, name: "Checkout", slug: "checkout" }).returning();
  const [, failing] = await db
    .insert(scenarios)
    .values([
      { projectId: project.id, name: "happy-path", description: "Everything succeeds" },
      { projectId: project.id, name: "payment-fails", description: "Payment API declines cards" },
    ])
    .returning();

  const [payments] = await db
    .insert(collections)
    .values({
      projectId: project.id,
      name: "Payments API",
      slug: "payments",
      protocol: "rest",
      defaultHeaders: { "x-provider": "acme-pay" },
      errorTemplate: {
        status: 422,
        contentType: "application/json",
        body: '{"error":{"type":"invalid_request","messages":{{json errors}}}}',
      },
    })
    .returning();

  await db.insert(variables).values({ scope: "collection", scopeId: payments.id, key: "currency", value: "USD" });

  const [getOrder, createOrder] = await db
    .insert(endpoints)
    .values([
      { collectionId: payments.id, name: "Get order", method: "GET", path: "/orders/:id" },
      {
        collectionId: payments.id,
        name: "Create order",
        method: "POST",
        path: "/orders",
        requestSchema: {
          type: "object",
          required: ["amount", "items"],
          properties: {
            amount: { type: "number", minimum: 1 },
            items: { type: "array", minItems: 1, items: { type: "object", required: ["sku", "price"] } },
          },
        },
      },
    ])
    .returning();

  await db.insert(responseRules).values([
    {
      endpointId: getOrder.id,
      name: "paid",
      isDefault: true,
      body: '{"id":"{{request.params.id}}","status":"PAID","currency":"{{vars.currency}}","createdAt":"{{now}}","customer":{"name":"{{faker "person.fullName"}}"}}',
    },
    {
      endpointId: getOrder.id,
      scenarioId: failing.id,
      name: "payment-failed",
      status: 402,
      body: '{"id":"{{request.params.id}}","status":"PAYMENT_FAILED"}',
    },
    {
      endpointId: createOrder.id,
      name: "vip",
      priority: 0,
      conditions: [{ source: "header", expr: "x-customer-tier", op: "equals", value: "vip" }],
      status: 201,
      delayMs: 150,
      body: '{"id":"{{uuid}}","priority":true,"total":{{sum request.body.items "price"}}}',
    },
    {
      endpointId: createOrder.id,
      name: "created",
      isDefault: true,
      status: 201,
      body: '{"id":"{{uuid}}","priority":false,"total":{{sum request.body.items "price"}},"items":{{json request.body.items}}}',
    },
  ]);

  const [scheme] = await db
    .insert(authSchemes)
    .values({
      collectionId: payments.id,
      type: "api_key",
      config: { in: "header", name: "x-api-key" },
      onFail: { status: 401, contentType: "application/json", body: '{"error":{"type":"authentication_error","message":"Invalid API key"}}' },
    })
    .returning();
  await db.insert(authCredentials).values({ schemeId: scheme.id, label: "demo key", secretEncrypted: encryptSecret("sk_test_demo") });

  console.log("seeded: acme / checkout / payments (api key: sk_test_demo)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
