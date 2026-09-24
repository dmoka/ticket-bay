import { defineConfig } from "drizzle-kit";
import { loadLocalEnv } from "./scripts/local-env";

loadLocalEnv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
