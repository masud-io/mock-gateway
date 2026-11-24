import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { AuthSchemeConfig, CollectionConfig, EndpointConfig, ProjectContext, RuleConfig } from "../core/types";
import { decryptSecret } from "./crypto";

const {
  clients, projects, collections, endpoints, scenarios, responseRules, variables, authSchemes, authCredentials,
} = schema;

export interface RuntimeSnapshot {
  project: ProjectContext;
  /** keyed by collection slug */
  collections: Map<string, CollectionConfig>;
}

// Everything the engine needs for one project, cached in memory. Admin writes (step 3) call
// invalidateRuntimeCache(); until then restart the server (or call it) after editing the DB directly.
const g = globalThis as unknown as { __mockSnapshots?: Map<string, Promise<RuntimeSnapshot | null>> };
const snapshots = () => (g.__mockSnapshots ??= new Map());

export function invalidateRuntimeCache(): void {
  snapshots().clear();
}

export function getRuntime(clientSlug: string, projectSlug: string): Promise<RuntimeSnapshot | null> {
  const key = `${clientSlug}/${projectSlug}`;
  let p = snapshots().get(key);
  if (!p) {
    p = loadRuntime(clientSlug, projectSlug);
    snapshots().set(key, p);
    // Don't cache failures (e.g. a transient DB error), and don't cache "not found" so newly created projects appear
    p.then((v: RuntimeSnapshot | null) => v === null && snapshots().delete(key), () => snapshots().delete(key));
  }
  return p;
}

const kv = (rows: { key: string; value: string }[]) => Object.fromEntries(rows.map((r) => [r.key, r.value]));

async function loadRuntime(clientSlug: string, projectSlug: string): Promise<RuntimeSnapshot | null> {
  const db = getDb();

  const [client] = await db.select().from(clients).where(and(eq(clients.slug, clientSlug), isNull(clients.deletedAt)));
  if (!client) return null;
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.clientId, client.id), eq(projects.slug, projectSlug), isNull(projects.deletedAt)));
  if (!project) return null;

  const cols = await db.select().from(collections).where(and(eq(collections.projectId, project.id), isNull(collections.deletedAt)));
  const colIds = cols.map((c) => c.id);

  const eps = colIds.length
    ? await db.select().from(endpoints).where(and(inArray(endpoints.collectionId, colIds), isNull(endpoints.deletedAt)))
    : [];
  const epIds = eps.map((e) => e.id);
  const rules = epIds.length ? await db.select().from(responseRules).where(inArray(responseRules.endpointId, epIds)) : [];
  const schemes = colIds.length ? await db.select().from(authSchemes).where(inArray(authSchemes.collectionId, colIds)) : [];
  const schemeIds = schemes.map((s) => s.id);
  const creds = schemeIds.length ? await db.select().from(authCredentials).where(inArray(authCredentials.schemeId, schemeIds)) : [];

  const vars = await db
    .select()
    .from(variables)
    .where(
      or(
        and(eq(variables.scope, "client"), eq(variables.scopeId, client.id)),
        and(eq(variables.scope, "project"), eq(variables.scopeId, project.id)),
        colIds.length ? and(eq(variables.scope, "collection"), inArray(variables.scopeId, colIds)) : undefined,
      ),
    );

  const scenarioRows = await db.select().from(scenarios).where(eq(scenarios.projectId, project.id));
  const active = scenarioRows.find((s) => s.id === project.activeScenarioId) ?? null;

  const baseVars = { ...kv(vars.filter((v) => v.scope === "client")), ...kv(vars.filter((v) => v.scope === "project")) };

  const out = new Map<string, CollectionConfig>();
  for (const c of cols) {
    const endpointConfigs: EndpointConfig[] = eps
      .filter((e) => e.collectionId === c.id)
      .map((e) => ({
        id: e.id,
        name: e.name,
        method: e.method,
        path: e.path,
        requestSchema: e.requestSchema ?? null,
        operation: e.operation,
        soapAction: e.soapAction,
        matchers: e.matchers,
        enabled: e.enabled,
        rules: rules
          .filter((r) => r.endpointId === e.id)
          .map<RuleConfig>((r) => ({
            id: r.id, name: r.name, scenarioId: r.scenarioId, priority: r.priority, isDefault: r.isDefault,
            conditions: r.conditions, status: r.status, headers: r.headers, contentType: r.contentType, body: r.body, delayMs: r.delayMs,
            faultType: (["error", "malformed", "timeout"] as const).find((t) => t === r.faultType) ?? null, faultRate: r.faultRate,
          })),
      }));

    const schemeConfigs: AuthSchemeConfig[] = schemes
      .filter((s) => s.collectionId === c.id)
      .map((s) => ({
        id: s.id,
        endpointId: s.endpointId,
        type: s.type,
        config: s.config,
        onFail: s.onFail ?? null,
        mode: s.mode,
        credentials: creds
          .filter((k) => k.schemeId === s.id)
          .flatMap((k) => {
            try {
              return [{ label: k.label, keyId: k.keyId, secret: decryptSecret(k.secretEncrypted), scopes: k.scopes, expiresAt: k.expiresAt, isActive: k.isActive }];
            } catch {
              // Undecryptable (e.g. key file was lost): drop it so the scheme fails closed rather than throwing per request
              console.error(`[mockgw] credential "${k.label}" could not be decrypted and was ignored`);
              return [];
            }
          }),
      }));

    out.set(c.slug, {
      id: c.id,
      name: c.name,
      slug: c.slug,
      protocol: c.protocol,
      mode: c.mode,
      validationMode: c.validationMode,
      errorTemplate: c.errorTemplate ?? null,
      wsdl: c.wsdl,
      defaultHeaders: c.defaultHeaders,
      variables: { ...baseVars, ...kv(vars.filter((v) => v.scope === "collection" && v.scopeId === c.id)) },
      endpoints: endpointConfigs,
      authSchemes: schemeConfigs,
    });
  }

  return {
    project: {
      id: project.id,
      activeScenarioId: active?.id ?? null,
      activeScenarioName: active?.name ?? null,
      globalLatencyMs: project.globalLatencyMs,
      outage: project.outage,
    },
    collections: out,
  };
}
