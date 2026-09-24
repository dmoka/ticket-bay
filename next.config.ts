import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module: load it from node_modules at runtime,
  // never bundle it.
  serverExternalPackages: ["better-sqlite3"],
  // CLAUDE.md and .claude/ belong to the course, not to Next's generator.
  agentRules: false,
  devIndicators: false,
};

export default nextConfig;
