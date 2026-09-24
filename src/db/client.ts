import path from "node:path";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema> & { $client: Pool };
/** A transaction handle — same query API as `Db`, scoped to one transaction. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything repository functions can run against. */
export type DbLike = Db | Tx;

const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

/** A connection pool over one Postgres database. Close it with `closeDb`. */
export function openDb(url: string): Db {
  return drizzle(new Pool({ connectionString: url }), { schema });
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}

/** Applies the committed migrations in drizzle/. Safe to run twice. */
export async function migrateDb(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env, then run `npm run db:up`.");
  return url;
}

const globalForDb = globalThis as unknown as { __ticketbayDb?: Db };

/** The app's shared pool. One per process, survives dev hot reloads. */
export function getDb(): Db {
  if (!globalForDb.__ticketbayDb) globalForDb.__ticketbayDb = openDb(databaseUrl());
  return globalForDb.__ticketbayDb;
}
