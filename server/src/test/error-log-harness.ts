import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

let passed = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

const logPath = resolve("/tmp/opencode/error-log-harness.log");
if (existsSync(logPath)) rmSync(logPath);
process.env.ERROR_LOG_FILE = logPath;

const { appendError, appendWarning, errorLogPath } = await import("../logging.ts");

console.log("\n# append-only error log");
ok(errorLogPath === logPath, "ERROR_LOG_FILE overrides the default path");

appendError("model returned an empty response", { sessionId: "s1", model: "fake" }, new Error("bad reply"));
appendWarning("retrying once", { sessionId: "s1" });

const lines = readFileSync(errorLogPath, "utf8").trim().split("\n");
ok(lines.length === 2, "error and warning each append one line");
const first = JSON.parse(lines[0]!) as Record<string, unknown>;
ok(first.level === "error" && first.message === "model returned an empty response", "first line is the error entry");
ok((first.err as Record<string, unknown>).message === "bad reply", "Error message and stack are captured");
const second = JSON.parse(lines[1]!) as Record<string, unknown>;
ok(second.level === "warn" && second.sessionId === "s1", "second line carries context");

appendError("another failure", { sessionId: "s2" });
const appended = readFileSync(errorLogPath, "utf8").trim().split("\n");
ok(appended.length === 3, "a later error appends instead of overwriting");
ok(JSON.parse(appended[0]!).message === "model returned an empty response", "earlier entries stay intact");

console.log(`\n${passed} assertions passed`);
