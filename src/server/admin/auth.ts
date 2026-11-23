import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "../../db";
import { derivedSecret } from "../crypto";

const { users } = schema;
export type AdminUser = typeof users.$inferSelect;

export const COOKIE = "mockgw_session";
const SESSION_MS = 7 * 24 * 3600_000;

// ---------- passwords (scrypt, salted; format scrypt:N:r:p:salt:hash) ----------
const scrypt = (pw: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((res, rej) => scryptCb(pw, salt, 64, { N: n, r, p }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 16384, 8, 1);
  return `scrypt:16384:8:1:${salt.toString("base64")}:${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split(":");
  if (alg !== "scrypt" || !hash) return false;
  const key = await scrypt(pw, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  const want = Buffer.from(hash, "base64");
  return key.length === want.length && timingSafeEqual(key, want);
}

let dummyHash: Promise<string> | undefined;
/** Burn the same time for unknown emails as for wrong passwords, so response time doesn't reveal which emails exist. */
export const verifyAgainstDummy = async (pw: string) => {
  dummyHash ??= hashPassword(randomBytes(12).toString("hex"));
  await verifyPassword(pw, await dummyHash);
};

export const passwordProblem = (pw: string) => (pw.length < 8 ? "Password must be at least 8 characters" : pw.length > 200 ? "Password is too long" : null);

// ---------- sessions: stateless signed cookie "<userId>.<expiryMs>.<passwordVersion>.<signature>" ----------
const pvOf = (passwordHash: string) => createHash("sha256").update(passwordHash).digest("hex").slice(0, 16);
const sign = (payload: string) => createHmac("sha256", derivedSecret("admin-session-v1")).update(payload).digest("base64url");

/** Changing a password changes its "version", which signs every older session out. */
export function makeSession(user: Pick<AdminUser, "id" | "passwordHash">, now = Date.now()): string {
  const payload = `${user.id}.${now + SESSION_MS}.${pvOf(user.passwordHash)}`;
  return `${payload}.${sign(payload)}`;
}

function readSession(value: string, now = Date.now()): { uid: string; pv: string } | null {
  const cut = value.lastIndexOf(".");
  if (cut < 0) return null;
  const payload = value.slice(0, cut);
  const given = Buffer.from(value.slice(cut + 1));
  const want = Buffer.from(sign(payload));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  const [uid, exp, pv] = payload.split(".");
  if (!uid || !pv || !(Number(exp) > now)) return null;
  return { uid, pv };
}

const secure = (request: Request) => new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
export const sessionCookie = (request: Request, value: string) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure(request) ? "; Secure" : ""}`;
export const clearCookie = (request: Request) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(request) ? "; Secure" : ""}`;

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// ---------- users ----------
export async function userCount(): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(users);
  return row?.n ?? 0;
}

/** The signed-in user for this request, or null (no/invalid/expired cookie, deactivated user, or changed password). */
export async function currentUser(request: Request): Promise<AdminUser | null> {
  const raw = cookieValue(request, COOKIE);
  const session = raw ? readSession(raw) : null;
  if (!session) return null;
  const [user] = await getDb().select().from(users).where(eq(users.id, session.uid));
  return user && user.isActive && pvOf(user.passwordHash) === session.pv ? user : null;
}

export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

/**
 * Who may use the admin API right now?
 *  - once an admin user exists: only a signed-in one;
 *  - before that: only requests addressed to this machine (localhost), so a freshly exposed server can't be driven by strangers.
 */
export async function gate(request: Request): Promise<{ status: number; error: string; login?: boolean } | null> {
  if ((await userCount()) > 0) return (await currentUser(request)) ? null : { status: 401, error: "Not signed in", login: true };
  if (isLoopbackHost(request.headers.get("host"))) return null;
  return { status: 403, error: "No admin user exists yet. Open the app on this machine at http://localhost:3000/login to create the first one." };
}

// ---------- login throttling ----------
const g = globalThis as unknown as { __loginFails?: Map<string, { n: number; first: number }> };
const fails = (g.__loginFails ??= new Map());
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 8;

export function throttled(key: string, now = Date.now()): number {
  const f = fails.get(key);
  if (!f || now - f.first > WINDOW_MS) return 0;
  return f.n >= MAX_FAILS ? Math.ceil((f.first + WINDOW_MS - now) / 1000) : 0;
}
export function noteFailure(key: string, now = Date.now()) {
  const f = fails.get(key);
  if (!f || now - f.first > WINDOW_MS) fails.set(key, { n: 1, first: now });
  else f.n++;
}
export const clearFailures = (key: string) => void fails.delete(key);
