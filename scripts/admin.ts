// Admin account helper. Stop the app first: the embedded database allows one process at a time.
//   npm run admin -- status             exit code 1 when no admin exists yet
//   npm run admin -- list
//   npm run admin -- create <email> [name]     (also resets the password if the user exists)
//   ADMIN_PASSWORD=... npm run admin -- create <email>   non-interactive
import { eq } from "drizzle-orm";
import { createInterface } from "node:readline";
import { closeDb, getDb, schema } from "../src/db";
import { hashPassword, passwordProblem, userCount } from "../src/server/admin/auth";

const { users } = schema;

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Don't echo the password while it is typed
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    }
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(a); });
  });
}

async function main() {
  const [cmd, email, ...rest] = process.argv.slice(2);
  const db = getDb();
  if (cmd === "status") {
    const n = await userCount();
    console.log(n ? `${n} admin user(s)` : "no admin user yet");
    if (!n) process.exitCode = 1;
  } else if (cmd === "list") {
    for (const u of await db.select().from(users).orderBy(users.email)) console.log(`${u.email}\t${u.name}${u.isActive ? "" : "\t(inactive)"}`);
  } else if (cmd === "create" && email) {
    const mail = email.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD ?? (await ask("Password (min 8 characters): ", true));
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    const passwordHash = await hashPassword(password);
    const [existing] = await db.select().from(users).where(eq(users.email, mail));
    if (existing) {
      await db.update(users).set({ passwordHash, isActive: true }).where(eq(users.id, existing.id));
      console.log(`Password reset for ${mail} (all their sessions ended)`);
    } else {
      await db.insert(users).values({ email: mail, name: rest.join(" ") || mail.split("@")[0], passwordHash });
      console.log(`Created admin ${mail}`);
    }
  } else {
    console.error("Usage: npm run admin -- status | list | create <email> [name]");
    process.exitCode = 2;
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
