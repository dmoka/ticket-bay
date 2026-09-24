// A real, migrated Postgres database for one test file, emptied before every
// test. Isolation is by TRUNCATE, not by wrapping each test in a rolled-back
// transaction: the race tests need two connections that each COMMIT and block
// on each other's row locks. Inside a single wrapping transaction there is one
// connection, nothing commits, and no race can happen.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, inject } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, openDb, type Db } from "../../src/db/client";
import { discountCodes, events, orders } from "../../src/db/schema";
import { TEMPLATE_DATABASE } from "./template";

async function admin<T>(run: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: inject("adminDatabaseUrl") });
  await c.connect();
  try {
    return await run(c);
  } finally {
    await c.end();
  }
}

export interface TestDatabase {
  /** the pool every test in this file uses */
  readonly db: Db;
  /** connection string of this file's database — for a second pool or a child process */
  readonly url: string;
}

/**
 * Registers the hooks that give this test file its own database. Pass
 * `{ truncate: false }` for a file whose tests only read what a beforeAll wrote.
 */
export function useTestDatabase({ truncate = true }: { truncate?: boolean } = {}): TestDatabase {
  const name = `ticketbay_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const url = new URL(inject("adminDatabaseUrl"));
  url.pathname = `/${name}`;
  let db: Db | undefined;

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`));
    db = openDb(url.toString());
  });

  beforeEach(async () => {
    if (truncate) await db!.execute(sql`TRUNCATE ${orders}, ${discountCodes}, ${events} RESTART IDENTITY`);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  return {
    get db() {
      if (!db) throw new Error("the test database is only available inside tests and hooks");
      return db;
    },
    url: url.toString(),
  };
}
