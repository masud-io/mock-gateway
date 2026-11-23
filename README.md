# Mock API Gateway

Mock third-party APIs (REST today, SOAP next) for several clients and projects, from one local app.

```
Client → Project → Collection (one third-party API) → Endpoint → Response rules
```

## Run it

```bash
npm install
npm run db:migrate     # creates the embedded Postgres (PGlite) in .data/pg
npm run db:seed        # optional demo: acme / checkout / payments, API key sk_test_demo
npm run dev            # http://127.0.0.1:3000  (admin UI)
```

On macOS there are helper scripts (Node 20+, e.g. `brew install node`):

```bash
./scripts/mac/setup.sh --seed   # install + create database (+ demo data)
./scripts/mac/dev.sh --open     # dev server with hot reload, opens the browser
./scripts/mac/start.sh          # build + production-style run
./scripts/mac/test.sh           # typecheck, lint, tests
```

To share it with your team on the same network: `HOST=0.0.0.0 ./scripts/mac/start.sh` prints a URL like `http://192.168.1.25:3000`. The admin UI has no login, so only do this on a network you trust.

If a script isn't executable after cloning: `chmod +x scripts/mac/*.sh`.

For a production-style run: `npm run build && npm start`.

The server binds to `127.0.0.1` on purpose: the admin UI/API has no login (solo local tool).

## URLs

| What | URL |
|---|---|
| Admin UI | `/` |
| Mock endpoints | `/mock/{client}/{project}/{collection}/<the provider's own path>` |
| Admin API | `/api/admin/...` (the UI uses it; JSON in/out) |

Point your app at `http://127.0.0.1:3000/mock/acme/checkout/payments` instead of the real provider's base URL.

## Creating endpoints from provider docs

On an API's page, **+ From a sample** takes a cURL command (or method + URL) and the documented response, and builds the endpoint:
the path becomes `/v1/orders/:id`, a JSON Schema is inferred from the request body, and the response becomes a template where
UUIDs, `pay_…`-style IDs and timestamps are generated, and fields echoed from the request (or the URL) stay linked to it.
Review and edit everything before saving; the review page lists exactly what was replaced and why.

## SOAP

Add an API with protocol **SOAP**. A SOAP API has one URL (`/mock/{client}/{project}/{collection}`); each *operation* is an endpoint.

- **Import a WSDL** (1.1) on the API's page: every operation becomes an endpoint with a sample response generated from its schema. `GET …?wsdl` serves it back with the service address pointing at the mock, so SDKs can load it.
- **Dispatch** is by the first element inside the SOAP Body. SOAPAction is stored as documented; a different value from the client is noted in the request log, not rejected. SOAP 1.1 and 1.2 are both answered in the caller's version.
- **Responses**: the rule body is the XML *inside* the Body (the envelope is added). Echo request values with `{{xml request.body.Operation.Field}}`. For a Fault use status 500 and `{{soapFault "Client" "Insufficient balance"}}`. Switch Faults on by scenario or by a body condition (`$.Operation.Field`).
- **Not supported yet**: XSD validation of requests (only well-formed XML, a valid envelope and a known operation are checked), WS-Security, attachments (MTOM), WSDL 2.0, schemas split across imported files.

## Writing responses

Bodies are Handlebars templates (not HTML-escaped):
`{{request.params.id}}` `{{request.body.user.name}}` `{{request.query.page}}` `{{request.headers.x-tenant}}`
`{{vars.name}}` `{{uuid}}` `{{now}}` `{{now days=1}}` `{{faker "person.fullName"}}` `{{randomInt 1 10}}`
`{{json value}}` (valid JSON, quotes escaped) `{{sum request.body.items "price"}}`
`{{#repeat 3}}…{{@index}}…{{/repeat}}`

Rule order: scenario-specific rules first, then the rest by priority; the **default** rule answers when no other rule's conditions match.

## Working in the UI

- **Ctrl+K** (or the Search button in the sidebar) jumps to any project, API or endpoint. The sidebar also has a filter box and Expand/Collapse all.
- **Response bodies** use a bundled code editor (works offline): JSON/XML highlighting, and typing `{{` suggests the template helpers.
- **Ctrl+S** saves the rule or request settings you're editing. Leaving the page (link, tab close) with unsaved edits asks first.
- **Rule order**: rules are numbered in the order they're checked (scenario-specific first, then the rest; the default rule is always last). Drag ⠿ or use ▲▼ to reorder.

## Scripts

| Script | |
|---|---|
| `npm test` | unit + integration tests (embedded DB in a temp dir) |
| `npm run db:generate` | generate a migration after editing `src/db/schema.ts` |
| `npm run db:migrate` / `db:seed` | apply migrations / seed demo data |

## Things to know

- **Stop `next dev` before running the db scripts.** The embedded database (PGlite) locks its folder, and scripts must call `closeDb()` or they never exit.
- This project has Next.js `cacheComponents` on: route files must not export `runtime` or `dynamic`, and client pages sit behind the `Suspense` boundaries in `src/app/layout.tsx`.
- `src/core/` has no Next.js or database imports, so the engine can move to a separate server later (needed for WebSocket and gRPC).
- Swap PGlite for a real PostgreSQL by changing only `src/db/index.ts` (use `drizzle-orm/node-postgres`); the schema is unchanged.
