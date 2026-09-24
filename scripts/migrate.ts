// Applies the committed Drizzle migrations (drizzle/) to DATABASE_URL.
import { closeDb, databaseUrl, migrateDb, openDb } from "../src/db/client";
import { loadLocalEnv } from "./local-env";

loadLocalEnv();
const db = openDb(databaseUrl());
try {
  await migrateDb(db);
  console.log(`migrated ${new URL(databaseUrl()).pathname.slice(1)} on ${new URL(databaseUrl()).host}`);
} finally {
  await closeDb(db);
}
