import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { loadLocalEnv } from "./scripts/local-env";

export default function config(phase: string): NextConfig {
  // `npm run dev` talks to the docker-compose Postgres out of the box: fill
  // DATABASE_URL from .env / .env.example. Builds and `next start` get theirs
  // from the real environment only.
  if (phase === PHASE_DEVELOPMENT_SERVER) loadLocalEnv();
  return {
    // node-postgres: load it from node_modules at runtime, never bundle it.
    serverExternalPackages: ["pg"],
    // CLAUDE.md and .claude/ belong to the course, not to Next's generator.
    agentRules: false,
    devIndicators: false,
  };
}
