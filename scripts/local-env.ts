// Local development settings for the CLI scripts (migrate, seed, drizzle-kit).
// Reads .env if you made one, then fills anything still unset from
// .env.example — so the README quick start works without copying a file.
// Variables already in the environment always win.
import fs from "node:fs";

export function loadLocalEnv(): void {
  for (const file of [".env", ".env.example"]) {
    if (fs.existsSync(file)) process.loadEnvFile(file);
  }
}
