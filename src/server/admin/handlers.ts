import { and, desc, eq, gte, ilike, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../../db";
import { renderTemplate, checkTemplate, TemplateError, type TemplateContext } from "../../core/template";
import { checkSchema } from "../../core/validate";
import { buildTemplate, buildXmlTemplate, inferPath, inferSchema, parseCurl } from "../../core/infer";
import { parseEnvelope, parseWsdl, wrapEnvelope } from "../../core/soap";
import { encryptSecret, decryptSecret } from "../crypto";

const {
  clients, projects, collections, endpoints, scenarios, responseRules, variables,
  authSchemes, authCredentials, requestLogs,
} = schema;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}
export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** Doesn't change stored data, so the mock cache needn't be invalidated afterwards */
  readonly?: boolean;
  status?: number;
  run: (c: Ctx) => unknown | Promise<unknown>;
}

// ---------- helpers ----------
const db = () => getDb();
const bad = (msg: string) => new HttpError(400, msg);

async function one<T>(rows: Promise<T[]>, what: string): Promise<T> {
  const [r] = await rows;
  if (!r) throw new HttpError(404, `${what} not found`);
  return r;
}

/** Row without the given keys (used to copy a row as a new one). */
function omit<T extends object, K extends keyof T>(row: T, keys: K[]): Omit<T, K> {
  const out = { ...row };
  for (const k of keys) delete out[k];
  return out;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
const tombstone = (slug: string) => `${slug}-deleted-${Date.now().toString(36)}`;

function slugFor(name: string, given?: string): string {
  const slug = slugify(given ?? name);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw bad("slug may only contain a-z, 0-9 and dashes");
  return slug;
}

/** 422 when a template has a syntax error, naming where. */
function assertTemplates(items: Record<string, string | undefined>) {
  for (const [where, src] of Object.entries(items)) {
    if (!src) continue;
    const err = checkTemplate(src);
    if (err) throw new HttpError(422, `Template error in ${where}: ${err}`);
  }
}

const mockBase = (client: string, project: string, collection?: string) =>
  `/mock/${client}/${project}${collection ? `/${collection}` : ""}`;

// ---------- schemas ----------
const matcher = z.object({
  source: z.enum(["header", "query", "body", "path"]),
  expr: z.string().min(1),
  op: z.enum(["equals", "contains", "regex", "exists"]),
  value: z.string().optional(),
});
const stringMap = z.record(z.string(), z.string());
const errorTemplate = z.object({ status: z.number().int().min(100).max(599), contentType: z.string().min(1), body: z.string() });
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "*"] as const;
const apiPath = z.string().min(1).transform((p) => (p.startsWith("/") ? p : `/${p}`));

const ruleInput = z.object({
  name: z.string().min(1).max(120),
  scenarioId: z.string().uuid().nullable(),
  priority: z.number().int().min(-1000).max(1000),
  isDefault: z.boolean(),
  conditions: z.array(matcher),
  status: z.number().int().min(100).max(599),
  headers: stringMap,
  contentType: z.string().min(1),
  body: z.string(),
  delayMs: z.number().int().min(0).max(60_000),
});
const ruleDefaults = {
  name: "New rule", scenarioId: null, priority: 0, isDefault: false, conditions: [], status: 200,
  headers: {}, contentType: "application/json", body: "{}", delayMs: 0,
};

const parse = <T extends z.ZodType>(s: T, v: unknown): z.infer<T> => s.parse(v);

// ---------- reads ----------
async function tree() {
  const [cl, pr, co, ep] = await Promise.all([
    db().select().from(clients).where(isNull(clients.deletedAt)).orderBy(clients.name),
    db().select().from(projects).where(isNull(projects.deletedAt)).orderBy(projects.name),
    db().select().from(collections).where(isNull(collections.deletedAt)).orderBy(collections.name),
    db().select().from(endpoints).where(isNull(endpoints.deletedAt)).orderBy(endpoints.path),
  ]);
  return cl.map((c) => ({
    id: c.id, name: c.name, slug: c.slug,
    projects: pr.filter((p) => p.clientId === c.id).map((p) => ({
      id: p.id, name: p.name, slug: p.slug, outage: p.outage,
      collections: co.filter((x) => x.projectId === p.id).map((x) => ({
        id: x.id, name: x.name, slug: x.slug, protocol: x.protocol, mode: x.mode,
        endpoints: ep.filter((e) => e.collectionId === x.id).map((e) => ({
          id: e.id, name: e.name, method: e.method, path: e.path, operation: e.operation, enabled: e.enabled,
        })),
      })),
    })),
  }));
}

async function projectContext(projectId: string) {
  const p = await one(db().select().from(projects).where(and(eq(projects.id, projectId), isNull(projects.deletedAt))), "Project");
  const c = await one(db().select().from(clients).where(eq(clients.id, p.clientId)), "Client");
  return { project: p, client: c };
}

async function collectionContext(collectionId: string) {
  const col = await one(db().select().from(collections).where(and(eq(collections.id, collectionId), isNull(collections.deletedAt))), "Collection");
  return { collection: col, ...(await projectContext(col.projectId)) };
}

async function endpointContext(endpointId: string) {
  const ep = await one(db().select().from(endpoints).where(and(eq(endpoints.id, endpointId), isNull(endpoints.deletedAt))), "Endpoint");
  return { endpoint: ep, ...(await collectionContext(ep.collectionId)) };
}

async function listVariables(scope: "client" | "project" | "collection", scopeId: string) {
  const rows = await db().select().from(variables).where(and(eq(variables.scope, scope), eq(variables.scopeId, scopeId))).orderBy(variables.key);
  // Secret values are never sent to the browser unless explicitly revealed
  return rows.map((v) => ({ ...v, value: v.isSecret ? "" : v.value }));
}

// ---------- routes ----------
export const routes: Route[] = [
  { method: "GET", path: "/tree", run: tree },

  // ----- clients -----
  {
    method: "POST", path: "/clients", status: 201,
    run: async ({ body }) => {
      const b = parse(z.object({ name: z.string().min(1).max(120), slug: z.string().optional(), notes: z.string().optional() }), body);
      const slug = slugFor(b.name, b.slug);
      if ((await db().select().from(clients).where(eq(clients.slug, slug))).length) throw new HttpError(409, `A client with slug "${slug}" already exists`);
      const [row] = await db().insert(clients).values({ name: b.name, slug, notes: b.notes }).returning();
      return row;
    },
  },
  {
    method: "PATCH", path: "/clients/:id",
    run: async ({ params, body }) => {
      const b = parse(z.object({ name: z.string().min(1).max(120).optional(), notes: z.string().nullable().optional() }), body);
      const [row] = await db().update(clients).set({ ...b, updatedAt: new Date() }).where(and(eq(clients.id, params.id), isNull(clients.deletedAt))).returning();
      if (!row) throw new HttpError(404, "Client not found");
      return row;
    },
  },
  {
    method: "DELETE", path: "/clients/:id",
    run: async ({ params }) => {
      const c = await one(db().select().from(clients).where(and(eq(clients.id, params.id), isNull(clients.deletedAt))), "Client");
      // Soft delete; the slug is released so it can be reused. Projects underneath become unreachable.
      await db().update(clients).set({ deletedAt: new Date(), slug: tombstone(c.slug) }).where(eq(clients.id, c.id));
      return { ok: true };
    },
  },

  // ----- projects -----
  {
    method: "POST", path: "/projects", status: 201,
    run: async ({ body }) => {
      const b = parse(z.object({ clientId: z.string().uuid(), name: z.string().min(1).max(120), slug: z.string().optional() }), body);
      await one(db().select().from(clients).where(and(eq(clients.id, b.clientId), isNull(clients.deletedAt))), "Client");
      const slug = slugFor(b.name, b.slug);
      if ((await db().select().from(projects).where(and(eq(projects.clientId, b.clientId), eq(projects.slug, slug)))).length)
        throw new HttpError(409, `This client already has a project with slug "${slug}"`);
      const [row] = await db().insert(projects).values({ clientId: b.clientId, name: b.name, slug }).returning();
      return row;
    },
  },
  {
    method: "GET", path: "/projects/:id",
    run: async ({ params }) => {
      const { project, client } = await projectContext(params.id);
      const [sc, co, ep] = await Promise.all([
        db().select().from(scenarios).where(eq(scenarios.projectId, project.id)).orderBy(scenarios.name),
        db().select().from(collections).where(and(eq(collections.projectId, project.id), isNull(collections.deletedAt))).orderBy(collections.name),
        db().select({ collectionId: endpoints.collectionId }).from(endpoints).where(isNull(endpoints.deletedAt)),
      ]);
      return {
        project, client, scenarios: sc,
        variables: await listVariables("project", project.id),
        collections: co.map((c) => ({
          id: c.id, name: c.name, slug: c.slug, protocol: c.protocol, mode: c.mode,
          endpointCount: ep.filter((e) => e.collectionId === c.id).length,
          mockBase: mockBase(client.slug, project.slug, c.slug),
        })),
        mockBase: mockBase(client.slug, project.slug),
      };
    },
  },
  {
    method: "PATCH", path: "/projects/:id",
    run: async ({ params, body }) => {
      const b = parse(
        z.object({
          name: z.string().min(1).max(120).optional(),
          globalLatencyMs: z.number().int().min(0).max(60_000).optional(),
          outage: z.boolean().optional(),
          activeScenarioId: z.string().uuid().nullable().optional(),
        }),
        body,
      );
      if (b.activeScenarioId) {
        const [s] = await db().select().from(scenarios).where(and(eq(scenarios.id, b.activeScenarioId), eq(scenarios.projectId, params.id)));
        if (!s) throw bad("That scenario doesn't belong to this project");
      }
      const [row] = await db().update(projects).set({ ...b, updatedAt: new Date() }).where(and(eq(projects.id, params.id), isNull(projects.deletedAt))).returning();
      if (!row) throw new HttpError(404, "Project not found");
      return row;
    },
  },
  {
    method: "DELETE", path: "/projects/:id",
    run: async ({ params }) => {
      const { project } = await projectContext(params.id);
      await db().update(projects).set({ deletedAt: new Date(), slug: tombstone(project.slug) }).where(eq(projects.id, project.id));
      return { ok: true };
    },
  },
  {
    method: "POST", path: "/projects/:id/scenarios", status: 201,
    run: async ({ params, body }) => {
      const b = parse(z.object({ name: z.string().min(1).max(60), description: z.string().optional() }), body);
      await projectContext(params.id);
      if ((await db().select().from(scenarios).where(and(eq(scenarios.projectId, params.id), eq(scenarios.name, b.name)))).length)
        throw new HttpError(409, `Scenario "${b.name}" already exists`);
      const [row] = await db().insert(scenarios).values({ projectId: params.id, name: b.name, description: b.description }).returning();
      return row;
    },
  },
  {
    method: "DELETE", path: "/scenarios/:id",
    run: async ({ params }) => {
      const s = await one(db().select().from(scenarios).where(eq(scenarios.id, params.id)), "Scenario");
      // Rules that only apply in this scenario would silently become "any scenario" if just unlinked, so remove them.
      await db().delete(responseRules).where(eq(responseRules.scenarioId, s.id));
      await db().update(projects).set({ activeScenarioId: null }).where(and(eq(projects.id, s.projectId), eq(projects.activeScenarioId, s.id)));
      await db().delete(scenarios).where(eq(scenarios.id, s.id));
      return { ok: true };
    },
  },

  // ----- variables -----
  {
    method: "GET", path: "/variables",
    run: async ({ query }) => {
      const scope = z.enum(["client", "project", "collection"]).parse(query.get("scope"));
      return listVariables(scope, z.string().uuid().parse(query.get("scopeId")));
    },
  },
  {
    method: "PUT", path: "/variables",
    run: async ({ body }) => {
      const b = parse(
        z.object({
          scope: z.enum(["client", "project", "collection"]),
          scopeId: z.string().uuid(),
          key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "key must be a valid identifier (letters, digits, _)"),
          value: z.string(),
          isSecret: z.boolean().default(false),
        }),
        body,
      );
      const [row] = await db()
        .insert(variables).values(b)
        .onConflictDoUpdate({ target: [variables.scope, variables.scopeId, variables.key], set: { value: b.value, isSecret: b.isSecret } })
        .returning();
      return { ...row, value: row.isSecret ? "" : row.value };
    },
  },
  {
    method: "GET", path: "/variables/:id/reveal", readonly: true,
    run: async ({ params }) => ({ value: (await one(db().select().from(variables).where(eq(variables.id, params.id)), "Variable")).value }),
  },
  {
    method: "DELETE", path: "/variables/:id",
    run: async ({ params }) => {
      await db().delete(variables).where(eq(variables.id, params.id));
      return { ok: true };
    },
  },

  // ----- collections -----
  {
    method: "POST", path: "/collections", status: 201,
    run: async ({ body }) => {
      const b = parse(
        z.object({ projectId: z.string().uuid(), name: z.string().min(1).max(120), slug: z.string().optional(), protocol: z.enum(["rest", "soap"]).default("rest") }),
        body,
      );
      await projectContext(b.projectId);
      const slug = slugFor(b.name, b.slug);
      if ((await db().select().from(collections).where(and(eq(collections.projectId, b.projectId), eq(collections.slug, slug)))).length)
        throw new HttpError(409, `This project already has a collection with slug "${slug}"`);
      const [row] = await db().insert(collections).values({ projectId: b.projectId, name: b.name, slug, protocol: b.protocol }).returning();
      return row;
    },
  },
  {
    method: "GET", path: "/collections/:id",
    run: async ({ params }) => {
      const { collection, project, client } = await collectionContext(params.id);
      const eps = await db().select().from(endpoints).where(and(eq(endpoints.collectionId, collection.id), isNull(endpoints.deletedAt))).orderBy(endpoints.path);
      const [scheme] = await db().select().from(authSchemes).where(and(eq(authSchemes.collectionId, collection.id), isNull(authSchemes.endpointId)));
      const creds = scheme ? await db().select().from(authCredentials).where(eq(authCredentials.schemeId, scheme.id)) : [];
      return {
        collection, project, client,
        endpoints: eps.map((e) => ({ id: e.id, name: e.name, method: e.method, path: e.path, operation: e.operation, soapAction: e.soapAction, enabled: e.enabled })),
        authScheme: scheme
          ? { ...scheme, credentials: creds.map((c) => ({ id: c.id, label: c.label, keyId: c.keyId, scopes: c.scopes, expiresAt: c.expiresAt, isActive: c.isActive })) }
          : null,
        variables: await listVariables("collection", collection.id),
        mockBase: mockBase(client.slug, project.slug, collection.slug),
      };
    },
  },
  {
    method: "PATCH", path: "/collections/:id",
    run: async ({ params, body }) => {
      const b = parse(
        z.object({
          name: z.string().min(1).max(120).optional(),
          mode: z.enum(["mock", "pass_through", "record"]).optional(),
          validationMode: z.enum(["strict", "warn", "off"]).optional(),
          defaultHeaders: stringMap.optional(),
          errorTemplate: errorTemplate.nullable().optional(),
          passThroughUrl: z.string().url().nullable().optional(),
        }),
        body,
      );
      assertTemplates({
        "error template": b.errorTemplate?.body,
        ...Object.fromEntries(Object.entries(b.defaultHeaders ?? {}).map(([k, v]) => [`header ${k}`, v])),
      });
      const [row] = await db().update(collections).set({ ...b, updatedAt: new Date() }).where(and(eq(collections.id, params.id), isNull(collections.deletedAt))).returning();
      if (!row) throw new HttpError(404, "Collection not found");
      return row;
    },
  },
  {
    method: "DELETE", path: "/collections/:id",
    run: async ({ params }) => {
      const { collection } = await collectionContext(params.id);
      await db().update(collections).set({ deletedAt: new Date(), slug: tombstone(collection.slug) }).where(eq(collections.id, collection.id));
      return { ok: true };
    },
  },

  // ----- collection-level mock auth -----
  {
    method: "PUT", path: "/collections/:id/auth",
    run: async ({ params, body }) => {
      const b = parse(
        z.object({
          type: z.enum(["none", "api_key", "bearer", "basic", "oauth2", "hmac"]),
          config: z.record(z.string(), z.unknown()).default({}),
          onFail: errorTemplate.nullable().default(null),
          mode: z.enum(["strict", "warn", "off"]).default("strict"),
        }),
        body,
      );
      await collectionContext(params.id);
      assertTemplates({ "auth failure body": b.onFail?.body });
      const [existing] = await db().select().from(authSchemes).where(and(eq(authSchemes.collectionId, params.id), isNull(authSchemes.endpointId)));
      if (existing) {
        const [row] = await db().update(authSchemes).set(b).where(eq(authSchemes.id, existing.id)).returning();
        return row;
      }
      const [row] = await db().insert(authSchemes).values({ collectionId: params.id, ...b }).returning();
      return row;
    },
  },
  {
    method: "POST", path: "/auth-schemes/:id/credentials", status: 201,
    run: async ({ params, body }) => {
      const b = parse(
        z.object({
          label: z.string().min(1).max(80),
          keyId: z.string().nullable().optional(),
          secret: z.string().min(1),
          scopes: z.array(z.string()).default([]),
          expiresAt: z.string().datetime().nullable().optional(),
        }),
        body,
      );
      await one(db().select().from(authSchemes).where(eq(authSchemes.id, params.id)), "Auth scheme");
      const [row] = await db().insert(authCredentials).values({
        schemeId: params.id, label: b.label, keyId: b.keyId ?? null, secretEncrypted: encryptSecret(b.secret),
        scopes: b.scopes, expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
      }).returning();
      return { id: row.id, label: row.label, keyId: row.keyId, scopes: row.scopes, expiresAt: row.expiresAt, isActive: row.isActive };
    },
  },
  {
    method: "PATCH", path: "/credentials/:id",
    run: async ({ params, body }) => {
      const b = parse(z.object({ isActive: z.boolean() }), body);
      const [row] = await db().update(authCredentials).set(b).where(eq(authCredentials.id, params.id)).returning();
      if (!row) throw new HttpError(404, "Credential not found");
      return { id: row.id, isActive: row.isActive };
    },
  },
  {
    method: "GET", path: "/credentials/:id/reveal", readonly: true,
    run: async ({ params }) => ({ secret: decryptSecret((await one(db().select().from(authCredentials).where(eq(authCredentials.id, params.id)), "Credential")).secretEncrypted) }),
  },
  {
    method: "DELETE", path: "/credentials/:id",
    run: async ({ params }) => {
      await db().delete(authCredentials).where(eq(authCredentials.id, params.id));
      return { ok: true };
    },
  },

  // ----- endpoints -----
  {
    method: "POST", path: "/endpoints", status: 201,
    run: async ({ body }) => {
      const b = parse(
        z.object({
          collectionId: z.string().uuid(), name: z.string().min(1).max(120), method: z.enum(METHODS).default("GET"), path: apiPath.default("/"),
          operation: z.string().trim().min(1).max(200).optional(), soapAction: z.string().max(500).optional(),
        }),
        body,
      );
      const { collection } = await collectionContext(b.collectionId);
      const soap = collection.protocol === "soap";
      if (soap && !b.operation) throw bad("A SOAP endpoint needs an operation: the name of the first element inside the SOAP Body");
      const [row] = soap
        ? await db().insert(endpoints).values({ collectionId: b.collectionId, name: b.name, method: "POST", path: "/", operation: b.operation, soapAction: b.soapAction || null }).returning()
        : await db().insert(endpoints).values({ collectionId: b.collectionId, name: b.name, method: b.method, path: b.path }).returning();
      // A new endpoint answers immediately with a placeholder instead of "no response rule"
      await db().insert(responseRules).values(
        soap
          ? { endpointId: row.id, name: "default", isDefault: true, contentType: "text/xml", body: `<${b.operation}Response>\n  <Result>mock response</Result>\n</${b.operation}Response>` }
          : { endpointId: row.id, name: "default", isDefault: true, body: '{"message":"mock response"}' },
      );
      return row;
    },
  },
  {
    method: "GET", path: "/endpoints/:id",
    run: async ({ params }) => {
      const { endpoint, collection, project, client } = await endpointContext(params.id);
      const [rules, sc] = await Promise.all([
        db().select().from(responseRules).where(eq(responseRules.endpointId, endpoint.id)).orderBy(responseRules.priority, responseRules.createdAt),
        db().select().from(scenarios).where(eq(scenarios.projectId, project.id)).orderBy(scenarios.name),
      ]);
      return {
        endpoint, collection, project, client, rules, scenarios: sc,
        mockBase: mockBase(client.slug, project.slug, collection.slug),
      };
    },
  },
  {
    method: "PATCH", path: "/endpoints/:id",
    run: async ({ params, body }) => {
      const b = parse(
        z.object({
          name: z.string().min(1).max(120).optional(),
          method: z.enum(METHODS).optional(),
          path: apiPath.optional(),
          requestSchema: z.unknown().nullable().optional(),
          matchers: z.array(matcher).optional(),
          enabled: z.boolean().optional(),
          operation: z.string().trim().min(1).max(200).optional(),
          soapAction: z.string().max(500).nullable().optional(),
        }),
        body,
      );
      if (b.requestSchema !== undefined) {
        const err = checkSchema(b.requestSchema);
        if (err) throw new HttpError(422, `Invalid JSON Schema: ${err}`);
      }
      const [row] = await db().update(endpoints).set({ ...b, updatedAt: new Date() }).where(and(eq(endpoints.id, params.id), isNull(endpoints.deletedAt))).returning();
      if (!row) throw new HttpError(404, "Endpoint not found");
      return row;
    },
  },
  {
    method: "POST", path: "/endpoints/:id/duplicate", status: 201,
    run: async ({ params }) => {
      const { endpoint } = await endpointContext(params.id);
      const [copy] = await db()
        .insert(endpoints)
        .values({ ...omit(endpoint, ["id", "createdAt", "updatedAt", "deletedAt"]), name: `${endpoint.name} (copy)` })
        .returning();
      const rules = await db().select().from(responseRules).where(eq(responseRules.endpointId, endpoint.id));
      if (rules.length) {
        await db().insert(responseRules).values(rules.map((r) => ({ ...omit(r, ["id", "createdAt", "updatedAt"]), endpointId: copy.id })));
      }
      return copy;
    },
  },
  {
    method: "DELETE", path: "/endpoints/:id",
    run: async ({ params }) => {
      await endpointContext(params.id);
      await db().update(endpoints).set({ deletedAt: new Date() }).where(eq(endpoints.id, params.id));
      return { ok: true };
    },
  },

  // ----- sample → mock wizard -----
  {
    method: "POST", path: "/collections/:id/wizard/analyze", readonly: true,
    run: async ({ params, body }) => {
      const b = parse(
        z.object({
          curl: z.string().optional(),
          method: z.enum(METHODS).optional(),
          url: z.string().optional(),
          requestBody: z.string().optional(),
          responseStatus: z.number().int().min(100).max(599).default(200),
          responseContentType: z.string().optional(),
          responseBody: z.string().default(""),
          soapAction: z.string().optional(),
        }),
        body,
      );
      const { collection } = await collectionContext(params.id);
      const warnings: string[] = [];

      if (collection.protocol === "soap") {
        // The request is an envelope: its Body's first element names the operation, a SOAPAction header may come with it
        let raw = b.requestBody ?? "";
        const headers: Record<string, string> = {};
        if (b.curl?.trim()) {
          try {
            const c = parseCurl(b.curl);
            raw = c.body;
            for (const [k, v] of Object.entries(c.headers)) headers[k.toLowerCase()] = v;
          } catch (e) {
            throw bad((e as Error).message);
          }
        }
        if (b.soapAction?.trim()) headers["soapaction"] = b.soapAction.trim();
        // Provider docs usually show only the Body content: put it in a default envelope (a full envelope is kept as is)
        if (raw.trim()) raw = wrapEnvelope("1.1", raw);
        const env = parseEnvelope(raw, headers);
        if ("error" in env) throw bad(env.error);

        const { template, substitutions } = buildXmlTemplate(b.responseBody, env.body);
        const tplError = checkTemplate(template);
        if (tplError) warnings.push(`The sample contains text that looks like template syntax (${tplError}). Edit the body before saving.`);
        if (!b.responseBody.trim()) warnings.push("The response body is empty.");
        const existing = await db().select().from(endpoints).where(and(eq(endpoints.collectionId, collection.id), isNull(endpoints.deletedAt)));
        if (existing.some((e) => e.operation === env.operation)) warnings.push(`This API already has an operation "${env.operation}". Saving adds a second one; give it a condition so they don't compete.`);
        const fault = /<(?:[\w.-]+:)?Fault[\s>]/.test(b.responseBody);
        if (fault && b.responseStatus < 400) warnings.push("This response is a SOAP Fault, which providers usually send with HTTP status 500: check the status.");
        return {
          soap: true, name: env.operation, method: "POST", path: "/", operation: env.operation, soapAction: env.soapAction, soapVersion: env.version,
          pathParams: {}, query: {}, requestSchema: null, requestBody: env.body, status: b.responseStatus, contentType: "text/xml",
          body: template, substitutions, warnings,
        };
      }

      let req: { method: string; url: string; body: string } = { method: b.method ?? "GET", url: b.url ?? "", body: b.requestBody ?? "" };
      if (b.curl?.trim()) {
        try {
          const c = parseCurl(b.curl);
          req = { method: c.method, url: c.url, body: c.body };
        } catch (e) {
          throw bad((e as Error).message);
        }
      }
      if (!req.url.trim()) throw bad("Give a URL or a cURL command for the request.");
      if (!(METHODS as readonly string[]).includes(req.method)) throw bad(`Unsupported method ${req.method}`);

      const { path, params: pathParams, query } = inferPath(req.url.trim());
      let requestBody: unknown;
      let requestSchema: unknown = null;
      if (req.body.trim()) {
        try {
          requestBody = JSON.parse(req.body);
          requestSchema = inferSchema(requestBody);
        } catch {
          warnings.push("The request body isn't JSON, so no request schema was inferred.");
        }
      }

      const { template, substitutions, isJson } = buildTemplate({ responseBody: b.responseBody, requestBody, params: pathParams });
      const contentType = b.responseContentType?.trim() || (isJson && b.responseBody.trim() ? "application/json" : b.responseBody.trim().startsWith("<") ? "application/xml" : "text/plain");
      const tplError = checkTemplate(template);
      if (tplError) warnings.push(`The sample contains text that looks like template syntax (${tplError}). Edit the body before saving.`);
      if (b.responseBody.trim() && isJson && !template.trim()) warnings.push("The response body is empty.");

      const shape = (p: string) => p.replace(/:[A-Za-z_]\w*/g, ":");
      const existing = await db().select().from(endpoints).where(and(eq(endpoints.collectionId, collection.id), isNull(endpoints.deletedAt)));
      if (existing.some((e) => e.method === req.method && shape(e.path) === shape(path))) {
        warnings.push(`This collection already has a ${req.method} ${path} endpoint. Saving adds a second one; the more specific or earlier match wins.`);
      }

      return {
        name: `${req.method} ${path}`, method: req.method, path, pathParams, query,
        requestSchema, requestBody: requestBody ?? null, status: b.responseStatus, contentType, body: template, substitutions, warnings,
      };
    },
  },
  {
    method: "POST", path: "/collections/:id/wizard/create", status: 201,
    run: async ({ params, body }) => {
      const b = parse(
        z.object({
          name: z.string().min(1).max(120),
          method: z.enum(METHODS),
          path: apiPath,
          requestSchema: z.unknown().nullable().default(null),
          status: z.number().int().min(100).max(599),
          contentType: z.string().min(1),
          headers: stringMap.default({}),
          body: z.string(),
          operation: z.string().trim().min(1).max(200).optional(),
          soapAction: z.string().max(500).nullable().optional(),
        }),
        body,
      );
      const { collection } = await collectionContext(params.id);
      const soap = collection.protocol === "soap";
      if (soap && !b.operation) throw bad("A SOAP endpoint needs an operation");
      const schemaErr = soap || b.requestSchema == null ? null : checkSchema(b.requestSchema);
      if (schemaErr) throw new HttpError(422, `Invalid JSON Schema: ${schemaErr}`);
      assertTemplates({ "response body": b.body });
      const [ep] = await db().insert(endpoints).values(
        soap
          ? { collectionId: collection.id, name: b.name, method: "POST", path: b.path, operation: b.operation, soapAction: b.soapAction || null }
          : { collectionId: collection.id, name: b.name, method: b.method, path: b.path, requestSchema: b.requestSchema },
      ).returning();
      await db().insert(responseRules).values({
        endpointId: ep.id, name: "default", isDefault: true,
        status: b.status, contentType: b.contentType, headers: b.headers, body: b.body,
      });
      return ep;
    },
  },

  // ----- SOAP: WSDL import -----
  {
    method: "POST", path: "/collections/:id/wsdl",
    run: async ({ params, body }) => {
      const b = parse(z.object({ wsdl: z.string().min(1).max(5_000_000) }), body);
      const { collection } = await collectionContext(params.id);
      if (collection.protocol !== "soap") throw bad("WSDL can only be imported into a SOAP API");
      let wsdl;
      try {
        wsdl = parseWsdl(b.wsdl);
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
      const existing = await db().select().from(endpoints).where(and(eq(endpoints.collectionId, collection.id), isNull(endpoints.deletedAt)));
      const have = new Set(existing.map((e) => e.operation));
      const created: string[] = [];
      const skipped: string[] = [];
      for (const op of wsdl.operations) {
        if (have.has(op.name)) {
          skipped.push(op.name);
          continue;
        }
        assertTemplates({ [`sample response of ${op.name}`]: op.sampleResponse });
        const [ep] = await db().insert(endpoints).values({ collectionId: collection.id, name: op.name, method: "POST", path: "/", operation: op.name, soapAction: op.soapAction }).returning();
        await db().insert(responseRules).values({ endpointId: ep.id, name: "default", isDefault: true, contentType: "text/xml", body: op.sampleResponse });
        created.push(op.name);
      }
      await db().update(collections).set({ wsdl: b.wsdl, updatedAt: new Date() }).where(eq(collections.id, collection.id));
      return { created, skipped, version: wsdl.version, service: wsdl.serviceName, warnings: wsdl.warnings };
    },
  },

  // ----- response rules -----
  {
    method: "POST", path: "/endpoints/:id/rules", status: 201,
    run: async ({ params, body }) => {
      const b = parse(ruleInput.partial(), body ?? {});
      const { project } = await endpointContext(params.id);
      const v = { ...ruleDefaults, ...b };
      await assertRule(v, project.id);
      const [row] = await db().insert(responseRules).values({ ...v, endpointId: params.id }).returning();
      return row;
    },
  },
  {
    // Drag-to-reorder: ids in the new evaluation order; priorities become 10, 20, 30…
    method: "POST", path: "/endpoints/:id/rules/reorder",
    run: async ({ params, body }) => {
      const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).min(1) }), body);
      await endpointContext(params.id);
      const rules = await db().select().from(responseRules).where(eq(responseRules.endpointId, params.id));
      const known = new Set(rules.map((r) => r.id));
      if (new Set(ids).size !== ids.length || ids.some((i) => !known.has(i))) throw new HttpError(400, "ids must be distinct rules of this endpoint");
      await Promise.all(ids.map((id, i) => db().update(responseRules).set({ priority: (i + 1) * 10, updatedAt: new Date() }).where(eq(responseRules.id, id))));
      return { ok: true };
    },
  },
  {
    method: "PATCH", path: "/rules/:id",
    run: async ({ params, body }) => {
      const b = parse(ruleInput.partial(), body);
      const rule = await one(db().select().from(responseRules).where(eq(responseRules.id, params.id)), "Rule");
      const { project } = await endpointContext(rule.endpointId);
      await assertRule({ ...rule, ...b }, project.id);
      const [row] = await db().update(responseRules).set({ ...b, updatedAt: new Date() }).where(eq(responseRules.id, params.id)).returning();
      return row;
    },
  },
  {
    method: "DELETE", path: "/rules/:id",
    run: async ({ params }) => {
      await db().delete(responseRules).where(eq(responseRules.id, params.id));
      return { ok: true };
    },
  },

  // ----- template preview -----
  {
    method: "POST", path: "/preview", readonly: true,
    run: ({ body }) => {
      const b = parse(
        z.object({
          template: z.string(),
          request: z.object({
            method: z.string().default("GET"), path: z.string().default("/"),
            params: stringMap.default({}), query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
            headers: stringMap.default({}), body: z.unknown().default(null),
          }).default({ method: "GET", path: "/", params: {}, query: {}, headers: {}, body: null }),
          vars: stringMap.default({}),
          scenario: z.string().nullable().default(null),
        }),
        body,
      );
      const ctx: TemplateContext = {
        request: { ...b.request, rawBody: b.request.body == null ? "" : JSON.stringify(b.request.body) },
        vars: b.vars,
        scenario: b.scenario,
      };
      try {
        return { output: renderTemplate(b.template, ctx) };
      } catch (e) {
        throw new HttpError(422, e instanceof TemplateError ? e.message : "Template failed to render");
      }
    },
  },

  // ----- request log -----
  {
    method: "GET", path: "/logs", readonly: true,
    run: async ({ query }) => {
      const filters = [];
      const projectId = query.get("projectId");
      const collectionId = query.get("collectionId");
      const status = query.get("status"); // 2xx | 3xx | 4xx | 5xx | miss
      const q = query.get("q")?.trim();
      if (projectId) filters.push(eq(requestLogs.projectId, z.string().uuid().parse(projectId)));
      if (collectionId) filters.push(eq(requestLogs.collectionId, z.string().uuid().parse(collectionId)));
      if (status === "miss") filters.push(eq(requestLogs.matched, false));
      else if (status && /^[1-5]xx$/.test(status)) {
        const lo = Number(status[0]) * 100;
        filters.push(and(gte(requestLogs.responseStatus, lo), lt(requestLogs.responseStatus, lo + 100)));
      }
      if (q) filters.push(ilike(requestLogs.path, `%${q.replace(/[%_\\]/g, "\\$&")}%`));
      const limit = Math.min(Number(query.get("limit") ?? 100) || 100, 500);
      // Summary columns only: bodies can be large and are fetched per row
      return db()
        .select({
          id: requestLogs.id, at: requestLogs.at, method: requestLogs.method, path: requestLogs.path,
          responseStatus: requestLogs.responseStatus, durationMs: requestLogs.durationMs, matched: requestLogs.matched,
          explanation: requestLogs.explanation, projectId: requestLogs.projectId,
        })
        .from(requestLogs)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(requestLogs.id))
        .limit(limit);
    },
  },
  {
    method: "GET", path: "/logs/:id", readonly: true,
    run: async ({ params }) => one(db().select().from(requestLogs).where(eq(requestLogs.id, z.coerce.number().int().parse(params.id))), "Log entry"),
  },
  {
    method: "DELETE", path: "/logs",
    readonly: true, // clearing the log doesn't affect mock configuration
    run: async ({ query }) => {
      const projectId = query.get("projectId");
      await db().delete(requestLogs).where(projectId ? eq(requestLogs.projectId, z.string().uuid().parse(projectId)) : undefined);
      return { ok: true };
    },
  },
];

/** Shared checks for creating/updating a rule. */
async function assertRule(
  r: { scenarioId: string | null; body: string; headers: Record<string, string>; isDefault: boolean; conditions: unknown[] },
  projectId: string,
) {
  assertTemplates({
    "response body": r.body,
    ...Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [`header ${k}`, v])),
  });
  if (r.scenarioId) {
    const [s] = await db().select().from(scenarios).where(and(eq(scenarios.id, r.scenarioId), eq(scenarios.projectId, projectId)));
    if (!s) throw bad("That scenario doesn't belong to this project");
  }
  if (r.isDefault && r.conditions.length) throw bad("A default rule can't have conditions (it is the fallback when no other rule matches)");
}
