// The Playwright webServer: a throwaway Postgres in Docker (Testcontainers),
// migrated and seeded with the e2e dataset, and the production build of the
// app pointed at it. Playwright sends SIGTERM when the run ends; the container
// goes with the server. (If this process is killed hard, Testcontainers' reaper
// removes the container anyway.)
import { spawn } from "node:child_process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { closeDb, migrateDb, openDb } from "../../src/db/client";
import { E2E_PORT } from "./env";
import { seedE2E } from "./seed";

const container = await new PostgreSqlContainer("postgres:17").start();
const url = container.getConnectionUri();

const db = openDb(url);
await migrateDb(db);
await seedE2E(db);
await closeDb(db);

const app = spawn("npx", ["next", "start", "-p", String(E2E_PORT)], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url, TICKETBAY_TEST_CLOCK: "1", STRIPE_SECRET_KEY: "sk_test_e2e" },
});

let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  app.kill("SIGTERM");
  await container.stop();
  process.exit(code);
}
process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));
app.on("exit", (code) => void stop(code ?? 1));
