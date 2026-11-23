import { migrate } from "drizzle-orm/pglite/migrator";
import { getDb, closeDb } from "../src/db";

async function main() {
  await migrate(getDb(), { migrationsFolder: "./drizzle" });
  console.log("migrations applied");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
