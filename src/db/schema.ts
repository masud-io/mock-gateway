import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  bigserial,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { Matcher } from "../core/types";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const deletedAt = () => timestamp("deleted_at", { withTimezone: true });

// ---------- enums ----------
export const protocolEnum = pgEnum("protocol", ["rest", "soap"]); // v1; extend later (graphql, grpc, ws)
export const collectionModeEnum = pgEnum("collection_mode", ["mock", "pass_through", "record"]);
export const validationModeEnum = pgEnum("validation_mode", ["strict", "warn", "off"]);
export const authTypeEnum = pgEnum("auth_type", ["none", "api_key", "bearer", "basic", "oauth2", "hmac"]);
export const variableScopeEnum = pgEnum("variable_scope", ["client", "project", "collection"]);

// ---------- domain hierarchy ----------
export const clients = pgTable("clients", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: deletedAt(),
});

export const projects = pgTable(
  "projects",
  {
    id: id(),
    clientId: uuid("client_id").notNull().references(() => clients.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    activeScenarioId: uuid("active_scenario_id"), // FK added in migration-free way to avoid a cycle
    globalLatencyMs: integer("global_latency_ms").notNull().default(0),
    outage: boolean("outage").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [uniqueIndex("projects_client_slug_uq").on(t.clientId, t.slug), index("projects_client_idx").on(t.clientId)],
);

export const collections = pgTable(
  "collections",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    protocol: protocolEnum("protocol").notNull().default("rest"),
    mode: collectionModeEnum("mode").notNull().default("mock"),
    validationMode: validationModeEnum("validation_mode").notNull().default("strict"),
    passThroughUrl: text("pass_through_url"),
    defaultHeaders: jsonb("default_headers").$type<Record<string, string>>().notNull().default({}),
    // error body returned when validation fails, in the provider's own format
    errorTemplate: jsonb("error_template").$type<{ status: number; contentType: string; body: string } | null>(),
    wsdl: text("wsdl"), // SOAP only
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [uniqueIndex("collections_project_slug_uq").on(t.projectId, t.slug), index("collections_project_idx").on(t.projectId)],
);

export const endpoints = pgTable(
  "endpoints",
  {
    id: id(),
    collectionId: uuid("collection_id").notNull().references(() => collections.id),
    name: text("name").notNull(),
    method: text("method").notNull().default("GET"), // REST
    path: text("path").notNull().default("/"), // REST, e.g. /orders/:id
    soapAction: text("soap_action"), // SOAP
    operation: text("operation"), // SOAP operation name
    requestSchema: jsonb("request_schema").$type<unknown>(), // JSON Schema (REST) or XSD string (SOAP)
    matchers: jsonb("matchers").$type<Matcher[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index("endpoints_collection_idx").on(t.collectionId)],
);

export const scenarios = pgTable(
  "scenarios",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("scenarios_project_name_uq").on(t.projectId, t.name)],
);

export const responseRules = pgTable(
  "response_rules",
  {
    id: id(),
    endpointId: uuid("endpoint_id").notNull().references(() => endpoints.id),
    scenarioId: uuid("scenario_id").references(() => scenarios.id), // null = applies in every scenario
    name: text("name").notNull(),
    priority: integer("priority").notNull().default(0), // lower runs first
    isDefault: boolean("is_default").notNull().default(false),
    conditions: jsonb("conditions").$type<Matcher[]>().notNull().default([]),
    status: integer("status").notNull().default(200),
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    contentType: text("content_type").notNull().default("application/json"),
    body: text("body").notNull().default(""), // Handlebars template
    delayMs: integer("delay_ms").notNull().default(0),
    faultType: text("fault_type"), // null | timeout | drop | malformed | error_rate
    faultRate: integer("fault_rate"), // percent
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("response_rules_endpoint_idx").on(t.endpointId, t.priority)],
);

export const variables = pgTable(
  "variables",
  {
    id: id(),
    scope: variableScopeEnum("scope").notNull(),
    scopeId: uuid("scope_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    isSecret: boolean("is_secret").notNull().default(false),
  },
  (t) => [uniqueIndex("variables_scope_key_uq").on(t.scope, t.scopeId, t.key)],
);

export const stateEntries = pgTable(
  "state_entries",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("state_project_key_uq").on(t.projectId, t.key)],
);

export const requestLogs = pgTable(
  "request_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    projectId: uuid("project_id"),
    collectionId: uuid("collection_id"),
    endpointId: uuid("endpoint_id"),
    ruleId: uuid("rule_id"),
    method: text("method").notNull(),
    path: text("path").notNull(),
    requestHeaders: jsonb("request_headers").$type<Record<string, string>>().notNull().default({}),
    requestBody: text("request_body"),
    responseStatus: integer("response_status").notNull(),
    responseBody: text("response_body"),
    durationMs: integer("duration_ms").notNull().default(0),
    matched: boolean("matched").notNull().default(false),
    validationErrors: jsonb("validation_errors").$type<string[]>().notNull().default([]),
    authResult: text("auth_result"),
    explanation: text("explanation"), // "why this rule" / "why no match"
  },
  (t) => [index("request_logs_project_at_idx").on(t.projectId, t.at)],
);

// ---------- mock-side authorization ----------
export const authSchemes = pgTable(
  "auth_schemes",
  {
    id: id(),
    collectionId: uuid("collection_id").notNull().references(() => collections.id),
    endpointId: uuid("endpoint_id").references(() => endpoints.id), // null = whole collection
    type: authTypeEnum("type").notNull().default("none"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    onFail: jsonb("on_fail").$type<{ status: number; contentType: string; body: string } | null>(),
    mode: validationModeEnum("mode").notNull().default("strict"),
  },
  (t) => [index("auth_schemes_collection_idx").on(t.collectionId)],
);

export const authCredentials = pgTable("auth_credentials", {
  id: id(),
  schemeId: uuid("scheme_id").notNull().references(() => authSchemes.id),
  label: text("label").notNull(),
  keyId: text("key_id"), // api key id / username
  secretEncrypted: text("secret_encrypted").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
});

export const oauthTokens = pgTable("oauth_tokens", {
  id: id(),
  schemeId: uuid("scheme_id").notNull().references(() => authSchemes.id),
  tokenHash: text("token_hash").notNull().unique(),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revoked: boolean("revoked").notNull().default(false),
});

// ---------- admin-side authorization (off by default in solo mode) ----------
export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
});

export const roles = pgTable("roles", {
  id: id(),
  name: text("name").notNull().unique(),
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]), // "resource:action"
});

export const userRoles = pgTable(
  "user_roles",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id),
    roleId: uuid("role_id").notNull().references(() => roles.id),
    clientId: uuid("client_id").references(() => clients.id), // null = global
    projectId: uuid("project_id").references(() => projects.id),
  },
  (t) => [index("user_roles_user_idx").on(t.userId)],
);

export const adminApiKeys = pgTable("admin_api_keys", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: uuid("user_id"),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  before: jsonb("before").$type<unknown>(),
  after: jsonb("after").$type<unknown>(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});
