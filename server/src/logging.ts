import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// server/src -> repo root, so logs land in one predictable place regardless of
// whether the server was started from the repo root or from server/.
export const errorLogPath = resolve(
  here,
  "../..",
  process.env.ERROR_LOG_FILE ?? "logs/agent-errors.log",
);
mkdirSync(dirname(errorLogPath), { recursive: true });

type LogContext = Record<string, unknown>;

function append(level: "error" | "warn", message: string, context: LogContext, err?: unknown): void {
  const detail =
    err instanceof Error
      ? { name: err.name, message: err.message, stack: err.stack }
      : err !== undefined
        ? { value: String(err) }
        : undefined;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...context,
    ...(detail ? { err: detail } : {}),
  });
  try {
    appendFileSync(errorLogPath, `${line}\n`, "utf8");
  } catch (writeErr) {
    // Never let a logging failure mask the original error.
    console.error("could not append to error log", writeErr);
  }
}

export function appendError(message: string, context: LogContext = {}, err?: unknown): void {
  append("error", message, context, err);
}

export function appendWarning(message: string, context: LogContext = {}): void {
  append("warn", message, context);
}
