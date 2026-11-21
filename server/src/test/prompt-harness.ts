import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt, formatDateLine, toOllamaMessages, type RouteBrief } from "../agent/prompt.ts";
import { createRouteBriefLoader, loadRouteBriefFrom } from "../db/routes.ts";
import { seededQueryable } from "./fixtures.ts";
import type { StoredMessage } from "../db/mongo.ts";

let passed = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

const { q } = await seededQueryable();

console.log("\n# formatDateLine");
ok(
  formatDateLine(new Date("2026-11-20T12:34:00.000Z")) === "Friday 20 November 2026, 12:34 UTC",
  "renders weekday, date, time in UTC from the injected clock",
);

console.log("\n# loadRouteBriefFrom (real generator data in sqlite)");
const brief = await loadRouteBriefFrom(q);
ok(brief.cities.length === 7, "7 distinct cities from 8 airports (London shared by LHR + LGW)");
const london = brief.cities.find((c) => c.city === "London")!;
ok(london.codes.join(",") === "LGW,LHR", "London fan-out rendered as LGW, LHR");
ok(brief.routes.length === 10 && brief.routes.includes("LHR → LIS"), "10 directed routes listed");

console.log("\n# buildSystemPrompt");
const prompt = buildSystemPrompt({ now: new Date("2026-11-20T12:34:00.000Z"), routeBrief: brief, holdMinutes: 10 });
ok(prompt.includes("Friday 20 November 2026, 12:34 UTC"), "per-request clock in the prompt");
ok(prompt.includes('Resolve "today", "tomorrow"'), "relative-date rule present");
ok(prompt.includes("LHR → LIS") && prompt.includes("London (LGW, LHR)"), "routes and city fan-out rendered from data");
ok(prompt.includes("12 rows x 6 seats") && prompt.includes("Windows are") && prompt.includes("rows 1-2"), "seat map conventions stated");
ok(prompt.includes("lasts 10 minutes"), "hold window injected from config");
ok(prompt.includes("no change-seat tool"), "hold-new + cancel-old rule present");
ok(prompt.includes("Never invent flight IDs"), "never-invent-IDs rule present");
ok(prompt.includes("explicit confirmation"), "confirm-before-write rule present");
ok(prompt.includes("session"), "session-identity rule present");
ok(prompt.includes("baggage"), "out-of-scope honesty rule present");

const here = path.dirname(fileURLToPath(import.meta.url));
const promptSource = await readFile(path.join(here, "..", "agent", "prompt.ts"), "utf8");
ok(!/\b(LHR|LGW|MAN|LIS|AMS|BCN|CDG|MAD)\b/.test(promptSource), "prompt.ts source contains zero IATA literals — routes come from the DB only");

console.log("\n# route brief caching");
let queries = 0;
const counting = {
  query: async (text: string, params?: unknown[]) => {
    queries += 1;
    return q.query(text, params);
  },
};
const loader = createRouteBriefLoader(counting);
await loader.load();
await loader.load();
ok(queries === 2, "cached loader queries the DB once per process (2 queries)");
loader.reset();
await loader.load();
ok(queries === 4, "reset() forces a reload");

console.log("\n# toOllamaMessages");
const history: StoredMessage[] = [
  { role: "user", content: "hi", ts: new Date() },
  { role: "assistant", content: "", tool_calls: [{ id: "c1" }], ts: new Date() },
  { role: "tool", tool_call_id: "c1", name: "search_flights", content: "{}", ts: new Date() },
];
const messages = toOllamaMessages(history, "SYSTEM");
ok(messages[0]!.role === "system" && messages[0]!.content === "SYSTEM", "system prompt first");
ok(messages[1]!.role === "user" && messages[2]!.role === "assistant" && messages[3]!.role === "tool", "history roles preserved in order");
ok(messages[2]!.tool_calls?.[0]?.id === "c1" && messages[3]!.tool_call_id === "c1", "tool call linkage preserved");

console.log(`\n${passed} assertions passed`);
