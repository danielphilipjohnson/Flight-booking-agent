import assert from "node:assert/strict";
import {
  buildCompactionPrompt,
  extractActiveIds,
  selectContext,
  windowMessages,
} from "../agent/context.ts";
import type { StoredMessage } from "../db/mongo.ts";

let passed = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

const msg = (role: StoredMessage["role"], content: string): StoredMessage => ({
  role,
  content,
  ts: new Date("2026-11-20T10:00:00.000Z"),
});

console.log("\n# windowMessages is tool-pair-safe");
const history: StoredMessage[] = [
  msg("user", "find me flights"),
  msg("assistant", "searching..."),
  msg("user", "to Lisbon"),
  msg("assistant", ""),
  msg("tool", '{"results":[{"flight_id":"123cc3ed-c1d6-58f2-8d3f-aaaaaaaaaaaa"}]}'),
  msg("user", "any seats?"),
  msg("assistant", "checking"),
  msg("user", "and price"),
  msg("assistant", "here"),
  msg("user", "thanks"),
];
history[3]!.tool_calls = [{ id: "c1" } as never];
const { kept, evicted } = windowMessages(history, 6);
ok(kept.length === 5 && evicted.length === 5, "window keeps at most maxMessages, pulling the tool's assistant message in with it");
ok(kept[0]!.role === "user", "window never starts on a dangling tool result");
ok(evicted.some((m) => m.role === "tool") && evicted.some((m) => m.tool_calls), "evicted block contains the tool pair");
const noCut = windowMessages(history, 40);
ok(noCut.evicted.length === 0 && noCut.kept.length === 10, "short history passes through untouched");

console.log("\n# extractActiveIds");
const ids = extractActiveIds([
  msg("tool", '{"results":[{"flight_id":"123cc3ed-c1d6-58f2-8d3f-aaaaaaaaaaaa"}]}'),
  msg("tool", '{"hold_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","error":"x"}'),
  msg("assistant", "no ids here"),
]);
ok(ids.length === 2 && ids.includes("123cc3ed-c1d6-58f2-8d3f-aaaaaaaaaaaa"), "flight/hold/booking uuids extracted from tool results");

console.log("\n# compaction prompt carries active IDs forward");
const prompt = buildCompactionPrompt(evicted, ids);
ok(prompt.includes("123cc3ed-c1d6-58f2-8d3f-aaaaaaaaaaaa") && prompt.includes("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), "compaction prompt lists active IDs verbatim");
ok(prompt.includes("Never invent IDs"), "compaction prompt states the never-invent-IDs rule");

console.log("\n# selectContext: threshold + compaction + storage untouched");
let captured = "";
const compact = async (p: string) => {
  captured = p;
  return "SUMMARY: user wants LHR->LIS; active ids preserved";
};
const sel = await selectContext(history, { maxMessages: 6, compactThreshold: 4, compact });
ok(sel.compacted && sel.evicted === 5, "compaction fires when evicted >= compactThreshold");
ok(sel.messages[0]!.role === "assistant" && sel.messages[0]!.content.startsWith("SUMMARY"), "summary becomes the first message (after system)");
ok(sel.messages.length === 6, "summary + 5-message window");
ok(captured.includes("123cc3ed"), "compact was called with the ID-carrying prompt");
const noCompact = await selectContext(history, { maxMessages: 6, compactThreshold: 100, compact });
ok(!noCompact.compacted && noCompact.evicted === 5 && noCompact.messages.length === 5, "below threshold: plain window, no LLM call");
const short = await selectContext(history.slice(0, 3), { maxMessages: 6, compactThreshold: 4, compact });
ok(!short.compacted && short.messages.length === 3, "short history: untouched");

console.log(`\n${passed} assertions passed`);
