import assert from "node:assert/strict";
import { z } from "zod";
import { driveLoop } from "../agent/loop.ts";
import { assembleChat, type ChatChunk, type OllamaClient, type OllamaMessage } from "../agent/ollama.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";
import { loadRouteBriefFrom } from "../db/routes.ts";
import { createFlightTools } from "../tools/flights.ts";
import type { ToolDef } from "../tools/schemas.ts";
import type { StoredMessage } from "../db/mongo.ts";
import { seededQueryable } from "./fixtures.ts";

let passed = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

const { q } = await seededQueryable();
const brief = await loadRouteBriefFrom(q);
const systemPrompt = buildSystemPrompt({
  now: new Date("2026-11-20T12:00:00.000Z"),
  routeBrief: brief,
  holdMinutes: 10,
});
const tools = createFlightTools(q);

function toolCallChunks(id: string, name: string, argsJsonFragments: string[]): ChatChunk[] {
  return [
    { message: { role: "assistant", content: "", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: argsJsonFragments[0] ?? "" } }] } },
    ...argsJsonFragments.slice(1).map((fragment) => ({
      message: { tool_calls: [{ index: 0, function: { arguments: fragment } }] },
    })),
    { done: true, eval_count: 42, prompt_eval_count: 100 },
  ];
}

function textChunks(text: string): ChatChunk[] {
  return [
    { message: { role: "assistant", content: text.slice(0, 5) } },
    { message: { content: text.slice(5) } },
    { done: true, eval_count: 42 },
  ];
}

function fakeClient(script: ChatChunk[][]): OllamaClient & { seenMessages: OllamaMessage[][] } {
  const seenMessages: OllamaMessage[][] = [];
  let call = 0;
  return {
    seenMessages,
    chat(opts) {
      seenMessages.push(opts.messages.map((m) => ({ ...m })));
      const chunks = script[Math.min(call, script.length - 1)]!;
      call += 1;
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

console.log("\n# assembleChat: NDJSON + tool-argument fragment reassembly");
const assembled = assembleChat([
  ...toolCallChunks("c1", "search_flights", ['{"origin":"LHR",', '"destination":"LIS","date":"2026-11-21"}']),
]);
ok(assembled.message.tool_calls.length === 1, "one tool call reassembled");
ok(assembled.message.tool_calls[0]!.function.name === "search_flights", "tool name reassembled");
ok(
  assembled.message.tool_calls[0]!.function.arguments.destination === "LIS",
  "arguments JSON fragments merged across chunks",
);
ok(assembled.evalCount === 42, "eval_count captured from the done chunk");

console.log("\n# assembleChat: native Ollama shape (object arguments, nested function.index)");
const native = assembleChat([
  {
    message: {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", type: "function", function: { index: 0, name: "search_flights", arguments: { origin: "LHR", destination: "LIS", date: "2026-11-21" } } },
        { id: "c2", type: "function", function: { index: 1, name: "list_available_seats", arguments: { flight_id: "FF1" } } },
      ],
    },
  },
  { done: true },
]);
ok(native.message.tool_calls.length === 2, "parallel calls stay separate via nested function.index");
ok(
  native.message.tool_calls[0]!.function.arguments.destination === "LIS",
  "object arguments used as-is (no '[object Object]' JSON.parse crash)",
);
ok(native.message.tool_calls[1]!.function.name === "list_available_seats", "second parallel call preserved");

console.log("\n# read-tool turn end to end (real tools on sqlite)");
const persisted: StoredMessage[] = [];
const client1 = fakeClient([
  toolCallChunks("c1", "search_flights", ['{"origin":"LHR","destination":"LIS","date":"2026-11-21"}']),
  textChunks("Found 3 flights to Lisbon tomorrow."),
]);
const result1 = await driveLoop({
  client: client1,
  model: "fake",
  systemPrompt,
  history: [],
  userMessage: "flights to Lisbon tomorrow",
  tools,
  ctx: { userRef: "ava" },
  persist: async (msgs) => {
    persisted.push(...msgs);
  },
});
ok(result1.reply === "Found 3 flights to Lisbon tomorrow.", "final plain reply returned");
ok(result1.toolTrace.length === 1 && result1.toolTrace[0]!.name === "search_flights" && result1.toolTrace[0]!.status === "ok", "tool trace records the read call");
ok(result1.toolTrace[0]!.summary.includes("3 results"), "trace summary reflects real SQL result");
ok(result1.iterations === 2 && result1.evalCount === 42, "two model calls, token count surfaced");
ok(
  persisted.map((m) => m.role).join(",") === "user,assistant,tool,assistant",
  "user + assistant(tool_calls) + tool result + final assistant all persisted (append-only)",
);
const secondCallMessages = client1.seenMessages[1]!;
ok(secondCallMessages.some((m) => m.role === "tool" && m.name === "search_flights" && m.content.includes("FF")), "tool result fed back to the model on the next iteration");
ok(secondCallMessages[0]!.role === "system" && secondCallMessages[0]!.content === systemPrompt, "same system prompt reused across iterations");

console.log("\n# invalid arguments -> error tool result, model self-corrects");
const client2 = fakeClient([
  toolCallChunks("c1", "search_flights", ['{"origin":"LHR","destination":"LIS","date":"tomorrow"}']),
  textChunks("Sorry — give me a date like 2026-11-21."),
]);
const result2 = await driveLoop({
  client: client2,
  model: "fake",
  systemPrompt,
  history: [],
  userMessage: "flights tomorrow",
  tools,
  ctx: { userRef: "ava" },
});
ok(result2.toolTrace[0]!.status === "error" && result2.toolTrace[0]!.summary.includes("invalid arguments"), "Zod failure becomes an error tool result, not a crash");
ok(result2.reply.includes("2026-11-21"), "model recovered and replied");

console.log("\n# unknown tool -> error tool result");
const client3 = fakeClient([
  toolCallChunks("c1", "book_everything", ["{}"]),
  textChunks("I can't do that."),
]);
const result3 = await driveLoop({
  client: client3, model: "fake", systemPrompt, history: [], userMessage: "book everything", tools, ctx: { userRef: "ava" },
});
ok(result3.toolTrace[0]!.summary.includes("unknown tool"), "unknown tool name reported to the model");

console.log("\n# iteration cap");
const loopChunks = toolCallChunks("c1", "search_flights", ['{"origin":"LHR","destination":"LIS","date":"2026-11-21"}']);
const client4 = fakeClient([loopChunks, loopChunks, loopChunks, loopChunks]);
const result4 = await driveLoop({
  client: client4, model: "fake", systemPrompt, history: [], userMessage: "loop", tools, ctx: { userRef: "ava" }, maxIterations: 3,
});
ok(result4.iterations === 3 && result4.reply.includes("iteration cap"), "loop stops at the cap with a safe fallback reply");

console.log("\n# confirm-before-write gate: write tools never run inside the loop");
let writeRan = false;
const writeTool: ToolDef = {
  name: "hold_seat",
  description: "write tool",
  schema: z.object({ flight_id: z.string(), seat_no: z.string() }),
  requiresConfirmation: true,
  run: async () => {
    writeRan = true;
    return {};
  },
  toOllamaSchema: () => ({ type: "function", function: { name: "hold_seat", description: "write tool", parameters: { type: "object", properties: {} } } }),
};
const client5 = fakeClient([
  toolCallChunks("c1", "hold_seat", ['{"flight_id":"abc","seat_no":"12A"}']),
  textChunks("Proposed: hold 12A. Confirm?"),
]);
const result5 = await driveLoop({
  client: client5, model: "fake", systemPrompt, history: [], userMessage: "hold 12A", tools: [...tools, writeTool], ctx: { userRef: "ava" },
});
ok(!writeRan, "write tool run() was never invoked inside the loop");
ok(result5.pendingConfirmation?.tool === "hold_seat" && result5.pendingConfirmation.args.seat_no === "12A", "pendingConfirmation carries tool + validated args");
ok(result5.toolTrace[0]!.status === "pending_confirmation", "trace marks the gated proposal");

console.log(`\n${passed} assertions passed`);
