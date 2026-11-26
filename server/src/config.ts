import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// npm workspaces run this package with cwd=server/, but .env lives at the repo
// root. Resolve it from this file instead of relying on process.cwd(), and keep
// a server/.env override for running the server standalone. Real environment
// variables still win, since dotenv does not override by default.
const here = dirname(fileURLToPath(import.meta.url));
for (const path of [
  resolve(here, "../../.env"),
  resolve(here, "../.env"),
]) {
  if (existsSync(path)) loadEnv({ path });
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: int(process.env.PORT, 3001),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://flight:flight@localhost:5432/flight_agent",
  mongoUrl: process.env.MONGO_URL ?? "mongodb://localhost:27017/flight_agent",
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "gemma4:12b",
  seed: int(process.env.SEED, 42),
  holdMinutes: int(process.env.HOLD_MINUTES, 10),
  maxHistoryMessages: int(process.env.MAX_HISTORY_MESSAGES, 40),
  compactThreshold: int(process.env.COMPACT_THRESHOLD, 8),
};
