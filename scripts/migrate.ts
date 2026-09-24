// Applies the committed Drizzle migrations (drizzle/) to the SQLite file.
import { databasePath, migrateDb, openDb } from "../src/db/client";

const file = databasePath();
migrateDb(openDb(file));
console.log(`migrated ${file}`);
