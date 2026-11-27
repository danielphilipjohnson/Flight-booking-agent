import assert from "node:assert/strict";
import { parseChatBody, toSseFrame, turnStats } from "../routes/chat-protocol.ts";
import type { LoopEvent, LoopResult } from "../agent/loop.ts";

let passed = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

console.log("\n# parseChatBody");
const valid = parseChatBody({ sessionId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", message: "flights to Lisbon" });
ok(valid.ok && valid.sessionId === "3f2504e0-4f89-11d3-9a0c-0305e82c3301" && valid.message === "flights to Lisbon", "valid body parses");
ok(!parseChatBody({ sessionId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }).ok, "missing message rejected");
ok(!parseChatBody({ message: "hi" }).ok, "missing sessionId rejected");
ok(!parseChatBody({ sessionId: "not-a-uuid", message: "hi" }).ok, "bad uuid rejected");
ok(!parseChatBody({ sessionId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", message: "" }).ok, "empty message rejected");
ok(!parseChatBody({ sessionId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", message: "x".repeat(4001) }).ok, "oversized message rejected");
ok(!parseChatBody(null).ok, "null body rejected");
const bad = parseChatBody({});
ok(!bad.ok && bad.error === "sessionId (uuid) and message are required", "rejection carries the 400 error text");

console.log("\n# toSseFrame");
const started = Date.now() - 50;
const typing = toSseFrame({ type: "typing" }, "s1", started);
ok(typing.event === "typing" && (typing.data as { type: string }).type === "typing", "typing frame passes through");
const token = toSseFrame({ type: "token", text: "Hello" }, "s1", started);
ok(token.event === "token" && (token.data as { text: string }).text === "Hello", "token frame passes through");
const tool = toSseFrame({ type: "tool", name: "search_flights", status: "ok", summary: "search_flights: 3 results" }, "s1", started);
ok(tool.event === "tool" && (tool.data as { name: string }).name === "search_flights", "tool frame passes through");
const confirm = toSseFrame({ type: "confirm", pending: { tool: "hold_seat", args: {} } }, "s1", started);
ok(confirm.event === "confirm" && (confirm.data as { pending: { tool: string } }).pending.tool === "hold_seat", "confirm frame passes through");
const doneEvent: LoopEvent = {
  type: "done",
  reply: "here you go",
  toolTrace: [{ name: "search_flights", status: "ok", summary: "search_flights: 3 results" }],
  pendingConfirmation: null,
  iterations: 2,
  evalCount: 100,
  promptEvalCount: 50,
  compacted: false,
};
const done = toSseFrame(doneEvent, "s1", started);
ok(done.event === "done", "done frame named done");
const doneData = done.data as { sessionId: string; reply: string; toolTrace: unknown[]; stats: { latencyMs: number; iterations: number } };
ok(doneData.sessionId === "s1" && doneData.reply === "here you go" && doneData.toolTrace.length === 1, "done frame carries sessionId, reply, toolTrace");
ok(doneData.stats.iterations === 2 && doneData.stats.latencyMs >= 0, "done frame carries stats with non-negative latency");

console.log("\n# turnStats");
const result: LoopResult = {
  reply: "ok",
  toolTrace: [],
  pendingConfirmation: null,
  iterations: 3,
  evalCount: 10,
  promptEvalCount: 20,
  compacted: true,
};
const stats = turnStats(result, Date.now() - 25);
ok(stats.iterations === 3 && stats.evalCount === 10 && stats.promptEvalCount === 20 && stats.compacted === true, "turnStats carries loop counters");
ok(stats.latencyMs >= 0, "turnStats latencyMs non-negative");
ok(Object.keys(stats).length === 5, "turnStats has exactly the five fields");

console.log(`\n${passed} chat-protocol checks passed`);
