import { eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import { getDb, schema } from "../../db";
import { clearCookie, clearFailures, currentUser, hashPassword, isLoopbackHost, makeSession, noteFailure, passwordProblem, sessionCookie, throttled, userCount, verifyAgainstDummy, verifyPassword, type AdminUser } from "./auth";
import { csrfProblem, json } from "./http";

const { users } = schema;
const publicUser = (u: Pick<AdminUser, "id" | "email" | "name" | "createdAt">) => ({ id: u.id, email: u.email, name: u.name, createdAt: u.createdAt });

const credentials = z.object({ email: z.string().trim().toLowerCase().email().max(200), name: z.string().trim().min(1).max(120), password: z.string() });

/** Routes under /api/admin/auth/*. Only status, login, setup and logout work without being signed in. */
export async function handleAuthRoute(request: Request, path: string): Promise<Response> {
  const method = request.method;
  const route = `${method} ${path.replace(/^\/auth/, "")}`;
  const blocked = csrfProblem(request);
  if (blocked) return json(403, { error: blocked });

  try {
    const body = method === "GET" || method === "DELETE" ? undefined : await request.json().catch(() => ({}));
    const db = getDb();

    if (route === "GET /status") {
      const n = await userCount();
      const user = await currentUser(request);
      return json(200, { authRequired: n > 0, setupNeeded: n === 0, canSetup: n === 0 && isLoopbackHost(request.headers.get("host")), user: user ? publicUser(user) : null });
    }

    if (route === "POST /setup") {
      if ((await userCount()) > 0) return json(409, { error: "An admin user already exists" });
      if (!isLoopbackHost(request.headers.get("host"))) return json(403, { error: "The first admin can only be created from this machine, at http://localhost:3000/login" });
      const b = credentials.parse(body);
      const problem = passwordProblem(b.password);
      if (problem) return json(400, { error: problem });
      const [user] = await db.insert(users).values({ email: b.email, name: b.name, passwordHash: await hashPassword(b.password) }).returning();
      return json(201, publicUser(user), { "set-cookie": sessionCookie(request, makeSession(user)) });
    }

    if (route === "POST /login") {
      const b = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) }).parse(body);
      const wait = throttled(b.email);
      if (wait) return json(429, { error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` }, { "retry-after": String(wait) });
      const [user] = await db.select().from(users).where(eq(users.email, b.email));
      const ok = user && user.isActive ? await verifyPassword(b.password, user.passwordHash) : (await verifyAgainstDummy(b.password), false);
      if (!ok || !user) {
        noteFailure(b.email);
        return json(401, { error: "Wrong email or password" });
      }
      clearFailures(b.email);
      return json(200, publicUser(user), { "set-cookie": sessionCookie(request, makeSession(user)) });
    }

    if (route === "POST /logout") return json(200, { ok: true }, { "set-cookie": clearCookie(request) });

    // Everything below needs a real signed-in user.
    const me = await currentUser(request);
    if (!me) return json(401, { error: "Not signed in", login: true });

    if (route === "GET /users") {
      const all = await db.select().from(users).orderBy(users.email);
      return json(200, all.map((u) => ({ ...publicUser(u), isActive: u.isActive, isMe: u.id === me.id })));
    }

    if (route === "POST /users") {
      const b = credentials.parse(body);
      const problem = passwordProblem(b.password);
      if (problem) return json(400, { error: problem });
      if ((await db.select().from(users).where(eq(users.email, b.email))).length) return json(409, { error: `A user with email ${b.email} already exists` });
      const [user] = await db.insert(users).values({ email: b.email, name: b.name, passwordHash: await hashPassword(b.password) }).returning();
      return json(201, publicUser(user));
    }

    const del = /^DELETE \/users\/([0-9a-f-]{36})$/.exec(route);
    if (del) {
      if (del[1] === me.id) return json(400, { error: "You can't delete the account you're signed in with" });
      await db.delete(users).where(eq(users.id, del[1]));
      return json(200, { ok: true });
    }

    if (route === "POST /password") {
      const b = z.object({ current: z.string().max(200), next: z.string() }).parse(body);
      if (!(await verifyPassword(b.current, me.passwordHash))) return json(400, { error: "Current password is wrong" });
      const problem = passwordProblem(b.next);
      if (problem) return json(400, { error: problem });
      const [updated] = await db.update(users).set({ passwordHash: await hashPassword(b.next) }).where(eq(users.id, me.id)).returning();
      // Other sessions end (the password "version" changed); this one continues with a fresh cookie.
      return json(200, { ok: true }, { "set-cookie": sessionCookie(request, makeSession(updated)) });
    }

    return json(404, { error: `No admin route for ${method} ${path}` });
  } catch (e) {
    if (e instanceof ZodError) return json(400, { error: `Invalid input: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` });
    console.error("[mockgw] auth error:", e);
    return json(500, { error: "Internal error" });
  }
}
