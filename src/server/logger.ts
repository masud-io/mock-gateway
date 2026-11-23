import { desc, lt } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { EngineLog } from "../core/types";
import { maskHeaders, truncate } from "../core/mask";

export interface LogInput {
  projectId: string | null;
  collectionId: string | null;
  method: string;
  path: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseStatus: number;
  responseBody: string;
  durationMs: number;
  engine: EngineLog;
}

const KEEP = Number(process.env.MOCKGW_LOG_KEEP ?? 5000);
const PRUNE_EVERY = 200;
const g = globalThis as unknown as { __mockLogCount?: number };

/** Await this in tests; request handling should not await it (logging must never slow or fail a mock). */
export async function writeLog(l: LogInput): Promise<void> {
  const db = getDb();
  await db.insert(schema.requestLogs).values({
    projectId: l.projectId,
    collectionId: l.collectionId,
    endpointId: l.engine.endpointId,
    ruleId: l.engine.ruleId,
    method: l.method,
    path: l.path,
    requestHeaders: maskHeaders(l.requestHeaders),
    requestBody: truncate(l.requestBody),
    responseStatus: l.responseStatus,
    responseBody: truncate(l.responseBody),
    durationMs: l.durationMs,
    matched: l.engine.matched,
    validationErrors: l.engine.validationErrors,
    authResult: l.engine.authResult,
    explanation: l.engine.explanation,
  });

  g.__mockLogCount = (g.__mockLogCount ?? 0) + 1;
  if (g.__mockLogCount % PRUNE_EVERY === 0) await prune();
}

/** Keep only the newest KEEP rows so the log can't grow without bound. */
export async function prune(keep = KEEP): Promise<void> {
  const db = getDb();
  const [cutoff] = await db.select({ id: schema.requestLogs.id }).from(schema.requestLogs).orderBy(desc(schema.requestLogs.id)).limit(1).offset(keep);
  if (cutoff) await db.delete(schema.requestLogs).where(lt(schema.requestLogs.id, cutoff.id));
}
