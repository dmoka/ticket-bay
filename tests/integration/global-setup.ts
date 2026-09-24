// One real Postgres per test run. Testcontainers starts it in Docker, the
// committed migrations build a template database once, and every test file
// clones its own database from that template (see database.ts) — so files run
// in parallel without ever seeing each other's rows.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { GlobalSetupContext } from "vitest/node";
import { closeDb, migrateDb, openDb } from "../../src/db/client";
import { TEMPLATE_DATABASE } from "./template";

declare module "vitest" {
  export interface ProvidedContext {
    /** the container's maintenance database: used to create and drop per-file databases */
    adminDatabaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

export default async function setup({ provide }: GlobalSetupContext) {
  // The same major version docker-compose.yml runs for local development.
  container = await new PostgreSqlContainer("postgres:17").withDatabase(TEMPLATE_DATABASE).start();
  const template = openDb(container.getConnectionUri());
  await migrateDb(template);
  await closeDb(template);

  const admin = new URL(container.getConnectionUri());
  admin.pathname = "/postgres";
  provide("adminDatabaseUrl", admin.toString());

  return async () => {
    await container?.stop();
  };
}
