// One real Postgres per test run. Testcontainers starts it in Docker, the
// committed migrations build a template database once, and every test file
// clones its own database from that template (see database.ts) — so files run
// in parallel without ever seeing each other's rows.
//
// No Docker? The dev-container box (./box) has its own Postgres at
// DATABASE_URL but no Docker socket. There — or anywhere with
// TICKETBAY_TEST_DB=external — the run uses that server instead: it creates
// its own template database next to the app's, clones the per-file databases
// from it, and drops them all at the end. The database DATABASE_URL names is
// never touched.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import type { GlobalSetupContext } from "vitest/node";
import { closeDb, migrateDb, openDb } from "../../src/db/client";
import { TEMPLATE_DATABASE } from "./template";

declare module "vitest" {
  export interface ProvidedContext {
    /** the server's maintenance database: used to create and drop per-file databases */
    adminDatabaseUrl: string;
    /** the migrated database every test file clones */
    templateDatabase: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/** The Postgres to use instead of a container, or null to start one. */
async function externalPostgres(): Promise<string | null> {
  const url = process.env.DATABASE_URL;
  if (process.env.TICKETBAY_TEST_DB === "external") {
    if (!url) throw new Error("TICKETBAY_TEST_DB=external needs DATABASE_URL: the Postgres the tests may create databases on.");
    return url;
  }
  if (!url) return null;
  try {
    await getContainerRuntimeClient();
    return null;
  } catch {
    console.log("[tests] No Docker: using the Postgres at DATABASE_URL (the run creates and drops its own databases there).");
    return url;
  }
}

async function onServer(adminUrl: string, sql: string) {
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

export default async function setup({ provide }: GlobalSetupContext) {
  const external = await externalPostgres();
  if (external) {
    const admin = new URL(external);
    admin.pathname = "/postgres";
    const name = `${TEMPLATE_DATABASE}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await onServer(admin.toString(), `CREATE DATABASE ${name}`);
    const url = new URL(external);
    url.pathname = `/${name}`;
    const template = openDb(url.toString());
    await migrateDb(template);
    await closeDb(template);
    provide("adminDatabaseUrl", admin.toString());
    provide("templateDatabase", name);
    return async () => {
      await onServer(admin.toString(), `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    };
  }

  // The same major version docker-compose.yml runs for local development.
  container = await new PostgreSqlContainer("postgres:17").withDatabase(TEMPLATE_DATABASE).start();
  const template = openDb(container.getConnectionUri());
  await migrateDb(template);
  await closeDb(template);

  const admin = new URL(container.getConnectionUri());
  admin.pathname = "/postgres";
  provide("adminDatabaseUrl", admin.toString());
  provide("templateDatabase", TEMPLATE_DATABASE);

  return async () => {
    await container?.stop();
  };
}
