/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are asserted loosely on purpose */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
let dbm: typeof import("../../db");
let admin: typeof import("./router");
let auth: typeof import("./auth");
let mock: typeof import("../handler");

const LOCAL = "localhost:3000";
const LAN = "192.168.1.20:3000";

async function api(method: string, p: string, body?: unknown, o: { host?: string; cookie?: string } = {}) {
  const res = await admin.handleAdmin(
    new Request(`http://${o.host ?? LOCAL}/api/admin${p}`, {
      method,
      headers: { host: o.host ?? LOCAL, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(o.cookie ? { cookie: o.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, data: (await res.json()) as any, cookie: setCookie?.split(";")[0] ?? null, setCookie };
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "mockgw-auth-"));
  process.env.MOCKGW_DATA_DIR = path.join(dir, "pg");
  dbm = await import("../../db");
  admin = await import("./router");
  auth = await import("./auth");
  mock = await import("../handler");
  await migrate(dbm.getDb(), { migrationsFolder: "./drizzle" });
});
afterAll(async () => {
  await dbm.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("admin login", () => {
  let cookie: string;
  const ada = { email: "Ada@Example.com", name: "Ada", password: "correct horse" };

  it("before any admin exists, only this machine may use the admin API", async () => {
    expect((await api("GET", "/tree")).status).toBe(200);
    const remote = await api("GET", "/tree", undefined, { host: LAN });
    expect(remote.status).toBe(403);
    expect(remote.data.error).toContain("localhost");
    const st = (await api("GET", "/auth/status", undefined, { host: LAN })).data;
    expect(st).toMatchObject({ authRequired: false, setupNeeded: true, canSetup: false, user: null });
  });

  it("the first admin can be created from localhost only, with a decent password", async () => {
    expect((await api("POST", "/auth/setup", ada, { host: LAN })).status).toBe(403);
    expect((await api("POST", "/auth/setup", { ...ada, password: "short" })).status).toBe(400);
    const r = await api("POST", "/auth/setup", ada);
    expect(r.status).toBe(201);
    expect(r.data.email).toBe("ada@example.com");
    expect(r.data.passwordHash).toBeUndefined();
    expect(r.setCookie).toMatch(/HttpOnly/);
    expect(r.setCookie).toMatch(/SameSite=Lax/);
    cookie = r.cookie!;
    expect((await api("POST", "/auth/setup", { ...ada, email: "b@example.com" })).status).toBe(409);
  });

  it("the password is stored as a salted hash, not in clear", async () => {
    const [row] = await dbm.getDb().select().from(dbm.schema.users);
    expect(row.passwordHash).toMatch(/^scrypt:/);
    expect(row.passwordHash).not.toContain(ada.password);
  });

  it("once an admin exists, nothing works without signing in, from anywhere", async () => {
    for (const host of [LOCAL, LAN]) {
      const r = await api("GET", "/tree", undefined, { host });
      expect(r.status).toBe(401);
      expect(r.data.login).toBe(true);
      expect((await api("POST", "/clients", { name: "X" }, { host })).status).toBe(401);
    }
    expect((await api("GET", "/tree", undefined, { host: LAN, cookie })).status).toBe(200);
    expect((await api("GET", "/auth/users")).status).toBe(401);
    expect((await api("GET", "/auth/status")).data).toMatchObject({ authRequired: true, setupNeeded: false, user: null });
    expect((await api("GET", "/auth/status", undefined, { cookie })).data.user.email).toBe("ada@example.com");
  });

  it("rejects tampered, foreign and expired session cookies", async () => {
    const value = cookie.split("=")[1];
    expect((await api("GET", "/tree", undefined, { cookie: `mockgw_session=${value}x` })).status).toBe(401);
    expect((await api("GET", "/tree", undefined, { cookie: `mockgw_session=${value.replace(/\.[^.]+$/, ".AAAA")}` })).status).toBe(401);
    const [user] = await dbm.getDb().select().from(dbm.schema.users);
    const old = auth.makeSession(user, Date.now() - 8 * 24 * 3600_000);
    expect((await api("GET", "/tree", undefined, { cookie: `mockgw_session=${old}` })).status).toBe(401);
  });

  it("login: wrong password and unknown email look identical; the right one signs in", async () => {
    const wrong = await api("POST", "/auth/login", { email: "ada@example.com", password: "nope nope nope" });
    const unknown = await api("POST", "/auth/login", { email: "nobody@example.com", password: "nope nope nope" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.data.error).toBe(unknown.data.error);
    expect(wrong.cookie).toBeNull();
    const ok = await api("POST", "/auth/login", { email: " ADA@example.com ", password: ada.password });
    expect(ok.status).toBe(200);
    expect((await api("GET", "/tree", undefined, { cookie: ok.cookie! })).status).toBe(200);
  });

  it("logout clears the cookie", async () => {
    const r = await api("POST", "/auth/logout", {});
    expect(r.setCookie).toMatch(/Max-Age=0/);
  });

  it("refuses cross-origin logins", async () => {
    const res = await admin.handleAdmin(new Request(`http://${LOCAL}/api/admin/auth/login`, { method: "POST", headers: { host: LOCAL, origin: "http://evil.example", "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com", password: ada.password }) }));
    expect(res.status).toBe(403);
  });

  it("users: add, list, can't delete yourself; a changed password signs the old session out", async () => {
    expect((await api("POST", "/auth/users", { email: "bo@example.com", name: "Bo", password: "12345678" }, { cookie })).status).toBe(201);
    expect((await api("POST", "/auth/users", { email: "bo@example.com", name: "Bo", password: "12345678" }, { cookie })).status).toBe(409);
    const list = (await api("GET", "/auth/users", undefined, { cookie })).data;
    expect(list.map((u: any) => u.email)).toEqual(["ada@example.com", "bo@example.com"]);
    expect(list.every((u: any) => u.passwordHash === undefined)).toBe(true);
    const me = list.find((u: any) => u.isMe);
    expect((await api("DELETE", `/auth/users/${me.id}`, undefined, { cookie })).status).toBe(400);

    const bo = (await api("POST", "/auth/login", { email: "bo@example.com", password: "12345678" }));
    expect(bo.status).toBe(200);
    expect((await api("POST", "/auth/password", { current: "wrong", next: "brand new pw" }, { cookie: bo.cookie! })).status).toBe(400);
    const changed = await api("POST", "/auth/password", { current: "12345678", next: "brand new pw" }, { cookie: bo.cookie! });
    expect(changed.status).toBe(200);
    expect((await api("GET", "/tree", undefined, { cookie: bo.cookie! })).status).toBe(401); // old session ended
    expect((await api("GET", "/tree", undefined, { cookie: changed.cookie! })).status).toBe(200); // fresh one works
    expect((await api("POST", "/auth/login", { email: "bo@example.com", password: "12345678" })).status).toBe(401);

    const boId = list.find((u: any) => u.email === "bo@example.com").id;
    expect((await api("DELETE", `/auth/users/${boId}`, undefined, { cookie })).status).toBe(200);
    expect((await api("GET", "/tree", undefined, { cookie: changed.cookie! })).status).toBe(401); // deleted users are out
  });

  it("repeated wrong passwords are throttled, and the right password is refused while throttled", async () => {
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await api("POST", "/auth/login", { email: "ada@example.com", password: `bad password ${i}` })).status;
    expect(last).toBe(429);
    expect((await api("POST", "/auth/login", { email: "ada@example.com", password: ada.password })).status).toBe(429);
  });

  it("the mock endpoints stay open (no admin login needed to call a mock)", async () => {
    const res = await mock.handleMockRequest(new Request(`http://${LAN}/mock/none/none/none/x`));
    expect(res.status).toBe(404); // reaches the engine; not blocked by admin auth
  });
});
