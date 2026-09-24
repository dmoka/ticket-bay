import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };
/** A transaction handle — same query API as `Db`, scoped to one transaction. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything repository functions can run against. */
export type DbLike = Db | Tx;

export const DEFAULT_DATABASE_PATH = "data/ticketbay.db";
const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

/** Opens (and creates, if needed) a SQLite database file or `:memory:`. */
export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // The app server, the seed script and the e2e suite can hold the file at once.
  sqlite.pragma("busy_timeout = 5000");
  return drizzle(sqlite, { schema });
}

export function migrateDb(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/** A fresh, fully migrated in-memory database. For tests. */
export function createMemoryDb(): Db {
  const db = openDb(":memory:");
  migrateDb(db);
  return db;
}

export function databasePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_PATH || DEFAULT_DATABASE_PATH;
}

const globalForDb = globalThis as unknown as { __ticketbayDb?: Db };

/** The app's shared connection. One per process, survives dev hot reloads. */
export function getDb(): Db {
  if (!globalForDb.__ticketbayDb) globalForDb.__ticketbayDb = openDb(databasePath());
  return globalForDb.__ticketbayDb;
}
