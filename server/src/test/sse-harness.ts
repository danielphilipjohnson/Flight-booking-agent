import assert from "node:assert/strict";
import { driveLoop, type LoopEvent } from "../agent/loop.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";
import { loadRouteBriefFrom } from "../db/routes.ts";
import { createToolRegistry } from "../tools/registry.ts";
import { createSseParser, formatSse, type SseEvent } from "../routes/sse.ts";
import type { ChatChunk } from "../agent/ollama.ts";
import {
  FIXED_NOW,
  fakeOllamaClient,
  seededQueryable,
  textChunks,
  toolCallChunks,
} from "./fixtures.ts";

let passed = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

console.log("\n# SSE framing: parse events split across chunk boundaries");
const wire = formatSse("token", { text: "Hel" }) + formatSse("tool", { name: "search_flights", status: "ok", summary: "3 results" }) + formatSse("done", { reply: "hi" });
const parsed: SseEvent[] = [];
const parse = createSseParser((e) => parsed.push(e));
const mid = Math.floor(wire.length / 3);
parse(wire.slice(0, mid));
parse(wire.slice(mid, mid + 5));
parse(wire.slice(mid + 5));
ok(parsed.length === 3, "3 events parsed from fragmented stream");
ok(parsed[0]!.event === "token" && JSON.parse(parsed[0]!.data).text === "Hel", "event name + JSON data survive fragmentation");
ok(parsed[2]!.event === "done" && JSON.parse(parsed[2]!.data).reply === "hi", "done event intact");

console.log("\n# loop event stream: typing -> tokens -> tool -> done");
const { q, data } = await seededQueryable();
const registry = createToolRegistry(q, { holdMinutes: 10 });
const systemPrompt = buildSystemPrompt({
  now: FIXED_NOW,
  routeBrief: await loadRouteBriefFrom(q),
  holdMinutes: 10,
});
const selloutId = data.flights.find((f) => f.flight_no === data.selloutFlightNo)!.id;

const script: ChatChunk[][] = [
  [
    { message: { role: "assistant", content: "Let me " } },
    { message: { tool_calls: [{ index: 0, id: "c1", function: { name: "list_available_seats", arguments: `{"flight_id":"${selloutId}"}` } }] } },
    { done: true, eval_count: 10, prompt_eval_count: 50 },
  ],
  [
    { message: { role: "assistant", content: "There are " } },
    { message: { content: "3 seats left." } },
    { done: true, eval_count: 20, prompt_eval_count: 60 },
  ],
];
const client = fakeOllamaClient(script);
const events: LoopEvent[] = [];
let seenSignal: AbortSignal | undefined;
const origChat = client.chat.bind(client);
client.chat = (opts) => {
  seenSignal = opts.signal;
  return origChat(opts);
};
const abort = new AbortController();
const result = await driveLoop({
  client,
  model: "fake",
  systemPrompt,
  history: [],
  userMessage: "seats left on the evening flight?",
  tools: registry.tools,
  ctx: { userRef: "ava" },
  signal: abort.signal,
  onEvent: (e) => {
    events.push(e);
  },
});
const types = events.map((e) => e.type);
ok(types.join(",") === "typing,token,tool,typing,token,token,done", `event sequence is typing/token/tool per model call then done (got: ${types.join(",")})`);
ok(events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("") === "Let me There are 3 seats left.", "token deltas concatenate to the streamed text");
ok(events.some((e) => e.type === "tool" && (e as { name: string }).name === "list_available_seats"), "tool chip event emitted when the call resolves");
const done = events.find((e) => e.type === "done") as Extract<LoopEvent, { type: "done" }>;
ok(done.reply === "There are 3 seats left." && done.iterations === 2 && done.evalCount === 20 && done.promptEvalCount === 60, "done carries reply + trace + token stats");
ok(result.reply === done.reply, "buffered result matches the streamed done event");
ok(seenSignal === abort.signal, "AbortSignal passed through to the Ollama client (client disconnect aborts the generation)");

console.log("\n# confirm event fires for gated writes");
const client2 = fakeOllamaClient([
  toolCallChunks("c1", "hold_seat", [`{"flight_id":"${selloutId}","seat_no":"12F"}`]),
  textChunks("Proposed. Confirm?"),
]);
const events2: LoopEvent[] = [];
await driveLoop({
  client: client2,
  model: "fake",
  systemPrompt,
  history: [],
  userMessage: "hold 12F",
  tools: registry.tools,
  ctx: { userRef: "ava" },
  onEvent: (e) => {
    events2.push(e);
  },
});
const confirm = events2.find((e) => e.type === "confirm");
ok(confirm !== undefined && (confirm as { pending: { tool: string } }).pending.tool === "hold_seat", "confirm event carries the pending proposal for the UI gate");

console.log(`\n${passed} assertions passed`);
