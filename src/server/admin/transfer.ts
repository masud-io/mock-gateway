import { and, eq, isNull, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../../db";
import { checkTemplate } from "../../core/template";
import { isPostmanCollection, postmanToExport } from "../../core/postman";

const { collections, endpoints, scenarios, responseRules, variables, authSchemes, savedRequests } = schema;

/** Export / import of one API (collection): its endpoints, rules, conditions, scenario names and plain variables.
 *  Credentials, auth schemes and secret variables are never written to the file; the counts are recorded so the user knows. */

const FORMAT = "mock-gateway/collection";
const VERSION = 1;

const matcher = z.object({
  source: z.enum(["header", "query", "body", "path"]),
  expr: z.string().min(1),
  op: z.enum(["equals", "not_equals", "contains", "regex", "exists", "not_exists"]),
  value: z.string().optional(),
});
const stringMap = z.record(z.string(), z.string());
const errorTemplate = z.object({ status: z.number().int().min(100).max(599), contentType: z.string().min(1), body: z.string() });

const ruleSchema = z.object({
  scenario: z.string().min(1).nullable().default(null),
  name: z.string().min(1).max(120),
  priority: z.number().int().min(-1000).max(1000).default(0),
  isDefault: z.boolean().default(false),
  conditions: z.array(matcher).default([]),
  status: z.number().int().min(100).max(599).default(200),
  headers: stringMap.default({}),
  contentType: z.string().min(1).default("application/json"),
  body: z.string().default(""),
  delayMs: z.number().int().min(0).max(60_000).default(0),
  faultType: z.enum(["error", "malformed", "timeout"]).nullable().default(null),
  faultRate: z.number().int().min(1).max(100).nullable().default(null),
});

const endpointSchema = z.object({
  name: z.string().min(1).max(120),
  method: z.string().min(1).default("GET"),
  path: z.string().min(1).default("/"),
  soapAction: z.string().nullable().default(null),
  operation: z.string().nullable().default(null),
  requestSchema: z.unknown().nullable().default(null),
  matchers: z.array(matcher).default([]),
  enabled: z.boolean().default(true),
  rules: z.array(ruleSchema).default([]),
});

export const exportFileSchema = z.object({
  format: z.literal(FORMAT),
  version: z.literal(VERSION),
  collection: z.object({
    name: z.string().min(1).max(120),
    slug: z.string().min(1),
    protocol: z.enum(["rest", "soap"]),
    mode: z.enum(["mock", "pass_through", "record"]).default("mock"),
    validationMode: z.enum(["strict", "warn", "off"]).default("strict"),
    passThroughUrl: z.string().nullable().default(null),
    defaultHeaders: stringMap.default({}),
    errorTemplate: errorTemplate.nullable().default(null),
    wsdl: z.string().nullable().default(null),
  }),
  variables: z.array(z.object({ key: z.string().min(1), value: z.string() })).default([]),
  endpoints: z.array(endpointSchema).default([]),
  requests: z.array(z.object({
    name: z.string().min(1).max(120),
    folder: z.string().max(120).nullable().default(null),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).default("GET"),
    path: z.string().max(2000).default("/"),
    headers: stringMap.default({}),
    body: z.string().max(1_000_000).default(""),
  })).default([]),
  excluded: z.object({ authSchemes: z.number().default(0), secretVariables: z.number().default(0) }).default({ authSchemes: 0, secretVariables: 0 }),
});

export type ExportFile = z.infer<typeof exportFileSchema>;

export class TransferError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function exportCollection(collectionId: string): Promise<ExportFile> {
  const db = getDb();
  const [col] = await db.select().from(collections).where(and(eq(collections.id, collectionId), isNull(collections.deletedAt)));
  if (!col) throw new TransferError(404, "Collection not found");

  const eps = await db.select().from(endpoints).where(and(eq(endpoints.collectionId, col.id), isNull(endpoints.deletedAt))).orderBy(endpoints.createdAt);
  const rules = eps.length
    ? await db.select().from(responseRules).where(inArray(responseRules.endpointId, eps.map((e) => e.id))).orderBy(responseRules.priority, responseRules.createdAt)
    : [];
  const scenarioIds = [...new Set(rules.map((r) => r.scenarioId).filter((s): s is string => !!s))];
  const scenarioRows = scenarioIds.length ? await db.select().from(scenarios).where(inArray(scenarios.id, scenarioIds)) : [];
  const scenarioName = new Map(scenarioRows.map((s) => [s.id, s.name]));
  const vars = await db.select().from(variables).where(and(eq(variables.scope, "collection"), eq(variables.scopeId, col.id)));
  const schemes = await db.select().from(authSchemes).where(eq(authSchemes.collectionId, col.id));
  const saved = await db.select().from(savedRequests).where(eq(savedRequests.collectionId, col.id)).orderBy(savedRequests.folder, savedRequests.name);

  return {
    format: FORMAT,
    version: VERSION,
    collection: {
      name: col.name, slug: col.slug, protocol: col.protocol, mode: col.mode, validationMode: col.validationMode,
      passThroughUrl: col.passThroughUrl, defaultHeaders: col.defaultHeaders, errorTemplate: col.errorTemplate ?? null, wsdl: col.wsdl,
    },
    variables: vars.filter((v) => !v.isSecret).map((v) => ({ key: v.key, value: v.value })),
    endpoints: eps.map((e) => ({
      name: e.name, method: e.method, path: e.path, soapAction: e.soapAction, operation: e.operation,
      requestSchema: e.requestSchema ?? null, matchers: e.matchers, enabled: e.enabled,
      rules: rules.filter((r) => r.endpointId === e.id).map((r) => ({
        scenario: r.scenarioId ? scenarioName.get(r.scenarioId) ?? null : null,
        name: r.name, priority: r.priority, isDefault: r.isDefault, conditions: r.conditions, status: r.status,
        headers: r.headers, contentType: r.contentType, body: r.body, delayMs: r.delayMs,
        faultType: (["error", "malformed", "timeout"] as const).find((t) => t === r.faultType) ?? null, faultRate: r.faultRate,
      })),
    })),
    requests: saved.map((r) => ({ name: r.name, folder: r.folder, method: r.method as ExportFile["requests"][number]["method"], path: r.path, headers: r.headers, body: r.body })),
    excluded: { authSchemes: schemes.length, secretVariables: vars.filter((v) => v.isSecret).length },
  };
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";

/** Creates a new collection in the project from an export file. Never overwrites: a taken slug or name gets a numeric suffix. */
export async function importCollection(projectId: string, raw: unknown): Promise<{ id: string; slug: string; name: string; endpoints: number; rules: number; warnings: string[] }> {
  // A Postman collection is converted to the export format first; everything after is the same validated path
  let converted: string[] = [];
  if (isPostmanCollection(raw)) {
    const p = postmanToExport(raw);
    raw = p.file;
    converted = p.warnings;
  }
  const parsed = exportFileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const isFormat = first?.path[0] === "format" || first?.path[0] === "version";
    throw new TransferError(400, isFormat
      ? "This is not a mock-gateway collection export (or it is from a newer version)."
      : `The file is not a valid export: ${first?.path.join(".") || "root"}: ${first?.message}`);
  }
  const data = parsed.data;

  // Templates are checked up front so a bad file imports nothing
  for (const ep of data.endpoints) {
    for (const r of ep.rules) {
      const err = checkTemplate(r.body);
      if (err) throw new TransferError(422, `Template error in "${ep.name}" / rule "${r.name}": ${err}`);
    }
  }

  const db = getDb();
  const warnings: string[] = [...converted];
  const taken = await db.select({ slug: collections.slug, name: collections.name }).from(collections).where(and(eq(collections.projectId, projectId), isNull(collections.deletedAt)));
  const slugs = new Set(taken.map((c) => c.slug));
  const names = new Set(taken.map((c) => c.name));
  const baseSlug = slugify(data.collection.slug);
  let slug = baseSlug;
  let name = data.collection.name;
  for (let n = 2; slugs.has(slug); n++) slug = `${baseSlug}-${n}`;
  for (let n = 2; names.has(name); n++) name = `${data.collection.name} (${n})`;
  if (slug !== baseSlug) warnings.push(`This project already had "${baseSlug}", so the import is "${slug}".`);

  let ruleCount = 0;
  const id = await db.transaction(async (tx) => {
    const [col] = await tx.insert(collections).values({
      projectId, name, slug, protocol: data.collection.protocol, mode: data.collection.mode, validationMode: data.collection.validationMode,
      passThroughUrl: data.collection.passThroughUrl, defaultHeaders: data.collection.defaultHeaders, errorTemplate: data.collection.errorTemplate, wsdl: data.collection.wsdl,
    }).returning();

    // Scenarios belong to the project: reuse one with the same name, create the rest
    const needed = [...new Set(data.endpoints.flatMap((e) => e.rules.map((r) => r.scenario)).filter((s): s is string => !!s))];
    const existing = await tx.select().from(scenarios).where(eq(scenarios.projectId, projectId));
    const scenarioId = new Map(existing.map((s) => [s.name, s.id]));
    for (const sName of needed) {
      if (scenarioId.has(sName)) continue;
      const [s] = await tx.insert(scenarios).values({ projectId, name: sName }).returning();
      scenarioId.set(sName, s.id);
      warnings.push(`Created the scenario "${sName}" in this project.`);
    }

    for (const v of data.variables) await tx.insert(variables).values({ scope: "collection", scopeId: col.id, key: v.key, value: v.value, isSecret: false });

    if (data.requests.length) await tx.insert(savedRequests).values(data.requests.map((r) => ({ ...r, collectionId: col.id })));

    for (const ep of data.endpoints) {
      const [e] = await tx.insert(endpoints).values({
        collectionId: col.id, name: ep.name, method: ep.method, path: ep.path.startsWith("/") ? ep.path : `/${ep.path}`,
        soapAction: ep.soapAction, operation: ep.operation, requestSchema: ep.requestSchema, matchers: ep.matchers, enabled: ep.enabled,
      }).returning();
      if (ep.rules.length) {
        await tx.insert(responseRules).values(ep.rules.map((r) => ({
          endpointId: e.id, scenarioId: r.scenario ? scenarioId.get(r.scenario) ?? null : null, name: r.name, priority: r.priority,
          isDefault: r.isDefault, conditions: r.conditions, status: r.status, headers: r.headers, contentType: r.contentType, body: r.body, delayMs: r.delayMs,
          faultType: r.faultType, faultRate: r.faultRate,
        })));
        ruleCount += ep.rules.length;
      }
    }
    return col.id;
  });

  if (data.excluded.authSchemes || data.excluded.secretVariables) {
    warnings.push(`Left out of the file: ${data.excluded.authSchemes} auth scheme(s) and ${data.excluded.secretVariables} secret variable(s). Set them up again on this API.`);
  }
  return { id, slug, name, endpoints: data.endpoints.length, rules: ruleCount, warnings };
}
