import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema";

// Embedded Postgres (PGlite) for solo local use. Swap this file for node-postgres
// (drizzle-orm/node-postgres + DATABASE_URL) to move to a real server; the schema is unchanged.
// Stored on globalThis so Next.js dev-mode module reloads don't open the data dir twice.
type Db = PgliteDatabase<typeof schema>;
const g = globalThis as unknown as { __mockDb?: { client: PGlite; db: Db } };

export const DATA_DIR = process.env.MOCKGW_DATA_DIR ?? "./.data/pg";

export function getDb(): Db {
  if (!g.__mockDb) {
    mkdirSync(DATA_DIR, { recursive: true }); // PGlite won't create parent folders
    const client = new PGlite(DATA_DIR);
    g.__mockDb = { client, db: drizzle(client, { schema }) };
  }
  return g.__mockDb.db;
}

/** Flush and release the data dir. Scripts must call this, or the process never exits. */
export async function closeDb(): Promise<void> {
  if (g.__mockDb) {
    await g.__mockDb.client.close();
    g.__mockDb = undefined;
  }
}

export { schema };
