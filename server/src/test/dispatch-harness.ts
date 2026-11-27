import assert from "node:assert/strict";
import { resolveToolCall, summarizeResult } from "../agent/dispatch.ts";
import type { ToolDef } from "../tools/schemas.ts";
import { z } from "zod";

let passed = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

const tools: ToolDef[] = [
  {
    name: "search_flights",
    description: "search",
    schema: z.object({ origin: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD") }),
    run: async () => ({ results: [] }),
    toOllamaSchema: () => ({ type: "function", function: { name: "search_flights", description: "search", parameters: {} } }),
  },
  {
    name: "hold_seat",
    description: "hold",
    schema: z.object({ flight_id: z.string(), seat_no: z.string() }),
    requiresConfirmation: true,
    run: async () => ({}),
    toOllamaSchema: () => ({ type: "function", function: { name: "hold_seat", description: "hold", parameters: {} } }),
  },
];

console.log("\n# resolveToolCall");
const unknown = resolveToolCall(tools, { id: "c1", type: "function", function: { name: "nope", arguments: {} } });
ok(unknown.kind === "error" && unknown.error === "unknown tool: nope", "unknown tool -> error with name");

const malformed = resolveToolCall(tools, {
  id: "c2",
  type: "function",
  function: { name: "search_flights", arguments: { origin: "LHR", date: "tomorrow" } },
});
ok(malformed.kind === "error", "malformed args -> error kind");
ok(
  malformed.kind === "error" && malformed.error === "invalid arguments for search_flights: date: ISO date YYYY-MM-DD",
  "malformed args -> exact zod message shape",
);

const valid = resolveToolCall(tools, {
  id: "c3",
  type: "function",
  function: { name: "search_flights", arguments: { origin: "LHR", date: "2026-12-01" } },
});
ok(valid.kind === "execute" && valid.def.name === "search_flights", "valid read tool -> execute with def");
if (valid.kind === "execute") {
  ok((valid.args as { origin: string }).origin === "LHR", "execute carries parsed args");
}

const gated = resolveToolCall(tools, {
  id: "c4",
  type: "function",
  function: { name: "hold_seat", arguments: { flight_id: "f1", seat_no: "12A" } },
});
ok(gated.kind === "gate", "write tool -> gate kind");
ok(
  gated.kind === "gate" && gated.pending.tool === "hold_seat" && gated.pending.args.seat_no === "12A" && gated.pending.id === undefined,
  "gate carries pending tool + args, no id without makeProposalId",
);
ok(gated.kind === "gate" && gated.note === "proposed hold_seat; awaiting user confirmation", "gate note text stable");

let counter = 0;
const gatedWithId = resolveToolCall(
  tools,
  { id: "c5", type: "function", function: { name: "hold_seat", arguments: { flight_id: "f1", seat_no: "12A" } } },
  { makeProposalId: () => `p${++counter}` },
);
ok(gatedWithId.kind === "gate" && gatedWithId.pending.id === "p1", "makeProposalId supplies the proposal id");

console.log("\n# summarizeResult");
ok(summarizeResult("search_flights", { results: [1, 2, 3] }) === "search_flights: 3 results", "results array -> N results");
ok(summarizeResult("list_available_seats", { available_seats: [1, 2] }) === "list_available_seats: 2 seats", "available_seats -> N seats");
ok(summarizeResult("list_my_bookings", { bookings: [1] }) === "list_my_bookings: 1 bookings", "bookings -> N bookings");
ok(summarizeResult("get_flight_details", { seat_summary: [] }) === "get_flight_details: summary ok", "seat_summary -> summary ok");
ok(summarizeResult("hold_seat", { error: "seat 12A is held" }) === "seat 12A is held", "error result -> error text verbatim");
ok(summarizeResult("hold_seat", { hold_id: "x" }) === "hold_seat: done", "unrecognized object -> done");
ok(summarizeResult("hold_seat", null) === "hold_seat: done", "null result -> done");
ok(summarizeResult("hold_seat", "weird") === "hold_seat: done", "non-object result -> done");

console.log(`\n${passed} dispatch checks passed`);
