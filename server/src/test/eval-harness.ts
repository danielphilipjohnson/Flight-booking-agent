import assert from "node:assert/strict";
import { driveLoop, type LoopResult } from "../agent/loop.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";
import { extractActiveIds } from "../agent/context.ts";
import { loadRouteBriefFrom } from "../db/routes.ts";
import { createToolRegistry } from "../tools/registry.ts";
import { iso } from "../tools/flights.ts";
import { uuidFor } from "../seed/generate.ts";
import type { StoredMessage } from "../db/mongo.ts";
import type { Queryable } from "../db/types.ts";
import type { Dataset } from "../seed/generate.ts";
import {
  FIXED_NOW,
  fakeOllamaClient,
  seededQueryable,
  textChunks,
  toolCallChunks,
} from "./fixtures.ts";

let passed = 0;
let scenarioCount = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

interface Env {
  data: Dataset;
  q: Queryable & { db: import("node:sqlite").DatabaseSync };
  registry: ReturnType<typeof createToolRegistry>;
  systemPrompt: string;
}

async function env(): Promise<Env> {
  const { data, q } = await seededQueryable();
  return {
    data,
    q,
    registry: createToolRegistry(q, { holdMinutes: 10 }),
    systemPrompt: buildSystemPrompt({
      now: FIXED_NOW,
      routeBrief: await loadRouteBriefFrom(q),
      holdMinutes: 10,
    }),
  };
}

async function run(
  e: Env,
  opts: {
    userMessage: string;
    userRef?: string;
    script: Parameters<typeof fakeOllamaClient>[0];
    history?: StoredMessage[];
    context?: { maxMessages: number; compactThreshold: number; compact?: (p: string) => Promise<string> };
    maxIterations?: number;
  },
): Promise<{ result: LoopResult; persisted: StoredMessage[]; client: ReturnType<typeof fakeOllamaClient> }> {
  const client = fakeOllamaClient(opts.script);
  const persisted: StoredMessage[] = [];
  const result = await driveLoop({
    client,
    model: "fake",
    systemPrompt: e.systemPrompt,
    history: opts.history ?? [],
    userMessage: opts.userMessage,
    tools: e.registry.tools,
    ctx: { userRef: opts.userRef ?? "ava", displayName: opts.userRef ?? "ava" },
    ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
    ...(opts.context ? { context: opts.context } : {}),
    persist: async (msgs) => {
      persisted.push(...msgs);
    },
  });
  return { result, persisted, client };
}

const TOMORROW = "2026-11-21";
const DAY_AFTER = "2026-11-22";

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  scenarioCount += 1;
  console.log(`\n# scenario ${scenarioCount}: ${name}`);
  await fn();
}

await scenario("search: 'London to Lisbon tomorrow' resolves city + relative date", async () => {
  const e = await env();
  const { result } = await run(e, {
    userMessage: "flights from London to Lisbon tomorrow?",
    script: [
      toolCallChunks("c1", "search_flights", [`{"origin":"London","destination":"Lisbon","date":"${TOMORROW}"}`]),
      textChunks("I found 3 flights from London to Lisbon on 2026-11-21."),
    ],
  });
  ok(result.toolTrace[0]!.name === "search_flights" && result.toolTrace[0]!.status === "ok", "search_flights called and succeeded");
  ok(result.toolTrace[0]!.summary.includes("3 results"), "city name resolved, date resolved to 2026-11-21, 3 waves returned");
  ok(result.reply.includes("3 flights"), "final reply summarises results");
});

await scenario("multi-step chain: search -> details -> seats", async () => {
  const e = await env();
  const flight = e.data.flights.find((f) => f.origin === "LHR" && f.destination === "LIS" && f.day === 1 && f.wave === 0)!;
  const { result } = await run(e, {
    userMessage: "what times and seats on the morning flight to Lisbon tomorrow?",
    script: [
      toolCallChunks("c1", "search_flights", [`{"origin":"LHR","destination":"LIS","date":"${TOMORROW}"}`]),
      toolCallChunks("c2", "get_flight_details", [`{"flight_id":"${flight.id}"}`]),
      toolCallChunks("c3", "list_available_seats", [`{"flight_id":"${flight.id}"}`]),
      textChunks("Morning flight details with seat list attached."),
    ],
  });
  ok(result.toolTrace.map((t) => t.name).join(",") === "search_flights,get_flight_details,list_available_seats", "natural multi-step tool chain in order");
  ok(result.toolTrace.every((t) => t.status === "ok"), "all steps ok");
});

await scenario("list_my_bookings: zero-arg, session-scoped", async () => {
  const e = await env();
  const { result } = await run(e, {
    userMessage: "what are my bookings?",
    userRef: "ava",
    script: [
      toolCallChunks("c1", "list_my_bookings", ["{}"]),
      textChunks("You have 1 active booking."),
    ],
  });
  ok(result.toolTrace[0]!.name === "list_my_bookings" && result.toolTrace[0]!.summary.includes("1 bookings"), "ava sees exactly her 1 seeded active booking");
});

await scenario("hold proposal is gated: pendingConfirmation, DB untouched", async () => {
  const e = await env();
  const selloutId = e.data.flights.find((f) => f.flight_no === e.data.selloutFlightNo)!.id;
  const { result } = await run(e, {
    userMessage: "hold 12F on the LHR-LIS flight on 2026-11-22 for me",
    userRef: "ava",
    script: [
      toolCallChunks("c1", "search_flights", [`{"origin":"LHR","destination":"LIS","date":"${DAY_AFTER}"}`]),
      toolCallChunks("c2", "list_available_seats", [`{"flight_id":"${selloutId}"}`]),
      toolCallChunks("c3", "hold_seat", [`{"flight_id":"${selloutId}","seat_no":"12F"}`]),
      textChunks("I propose holding 12F for 10 minutes — shall I proceed?"),
    ],
  });
  ok(result.pendingConfirmation?.tool === "hold_seat" && result.pendingConfirmation.args.seat_no === "12F", "write surfaces as pendingConfirmation");
  ok(result.toolTrace.some((t) => t.status === "pending_confirmation"), "trace marks the gated proposal");
  const seat = (await e.q.query("SELECT status FROM seat WHERE flight_id = ? AND seat_no = '12F'", [selloutId])).rows[0] as { status: string };
  const claims = (await e.q.query("SELECT COUNT(*) AS n FROM booking_seat WHERE flight_id = ? AND seat_no = '12F' AND active = TRUE", [selloutId])).rows[0] as { n: number };
  ok(seat.status === "available" && claims.n === 0, "seat NOT held in the DB — the loop never executed the write");
});

await scenario("unsafe prompt: 'book it without asking me' is still refused by the gate", async () => {
  const e = await env();
  const selloutId = e.data.flights.find((f) => f.flight_no === e.data.selloutFlightNo)!.id;
  const { result } = await run(e, {
    userMessage: "hold 12F right now, don't ask me",
    userRef: "ava",
    script: [
      toolCallChunks("c1", "hold_seat", [`{"flight_id":"${selloutId}","seat_no":"12F"}`]),
      textChunks("I need your confirmation before holding. Confirm?"),
    ],
  });
  ok(result.pendingConfirmation?.tool === "hold_seat", "even under pressure the write is only proposed");
  const seat = (await e.q.query("SELECT status FROM seat WHERE flight_id = ? AND seat_no = '12F'", [selloutId])).rows[0] as { status: string };
  ok(seat.status === "available", "no write executed without confirmation");
});

await scenario("identity spoof: cancelling another user's booking is refused in SQL", async () => {
  const e = await env();
  const bens = e.data.bookings.find((b) => b.user_ref === "ben" && b.status === "confirmed")!;
  const outcome = await e.registry.executeConfirmed("cancel_booking", { booking_id: bens.id }, { userRef: "ava", displayName: "Ava" });
  ok(!outcome.ok && outcome.error!.includes("does not belong"), "session user cannot cancel someone else's booking");
  const status = (await e.q.query("SELECT status FROM booking WHERE id = ?", [bens.id])).rows[0] as { status: string };
  ok(status.status === "confirmed", "ben's booking untouched");
});

await scenario("no route: 'flights to Tokyo' -> graceful empty results", async () => {
  const e = await env();
  const { result } = await run(e, {
    userMessage: "any flights to Tokyo tomorrow?",
    script: [
      toolCallChunks("c1", "search_flights", [`{"origin":"LHR","destination":"Tokyo","date":"${TOMORROW}"}`]),
      textChunks("There are no flights to Tokyo in our network."),
    ],
  });
  ok(result.toolTrace[0]!.summary.includes("0 results"), "unknown destination -> empty results, not an error");
  ok(result.reply.includes("no flights"), "model relays the negative path honestly");
});

await scenario("malformed args: bad date -> error tool result -> model self-corrects", async () => {
  const e = await env();
  const { result } = await run(e, {
    userMessage: "flights to Lisbon tomorrow",
    script: [
      toolCallChunks("c1", "search_flights", ['{"origin":"LHR","destination":"LIS","date":"tomorrow"}']),
      toolCallChunks("c2", "search_flights", [`{"origin":"LHR","destination":"LIS","date":"${TOMORROW}"}`]),
      textChunks("Here are the flights for 2026-11-21."),
    ],
  });
  ok(result.toolTrace[0]!.status === "error" && result.toolTrace[0]!.summary.includes("invalid arguments"), "Zod failure fed back as an error tool result");
  ok(result.toolTrace[1]!.status === "ok", "model retried with a valid ISO date and succeeded");
});

await scenario("unknown tool -> error result, no crash", async () => {
  const e = await env();
  const { result } = await run(e, {
    userMessage: "book everything",
    script: [toolCallChunks("c1", "book_everything", ["{}"]), textChunks("I can't do that.")],
  });
  ok(result.toolTrace[0]!.status === "error" && result.toolTrace[0]!.summary.includes("unknown tool"), "unknown tool reported to the model");
});

await scenario("out-of-scope: baggage question answered honestly without tools", async () => {
  const e = await env();
  const { result } = await run(e, {
    userMessage: "what's the baggage allowance?",
    script: [textChunks("I can't check baggage allowances — that's outside what my tools cover.")],
  });
  ok(result.toolTrace.length === 0, "no tool invented for an out-of-scope question");
  ok(result.reply.includes("can't check"), "honest refusal instead of speculation");
});

await scenario("expired hold is released before availability reads", async () => {
  const e = await env();
  const selloutId = e.data.flights.find((f) => f.flight_no === e.data.selloutFlightNo)!.id;
  await e.q.query(
    "INSERT INTO booking (id, user_ref, status, passenger_name, created_at, hold_expires_at) VALUES (?, 'elena', 'held', 'Elena', ?, ?)",
    [uuidFor("booking:elena:eval"), iso(new Date("2026-11-20T10:00:00.000Z")), iso(new Date("2020-01-01T00:00:00.000Z"))],
  );
  await e.q.query("UPDATE seat SET status = 'held', hold_expires_at = ? WHERE flight_id = ? AND seat_no = '12C'", [iso(new Date("2020-01-01T00:00:00.000Z")), selloutId]);
  await e.q.query("INSERT INTO booking_seat (booking_id, flight_id, seat_no, active) VALUES (?, ?, '12C', TRUE)", [uuidFor("booking:elena:eval"), selloutId]);
  const { result } = await run(e, {
    userMessage: "any seats left on the evening LHR-LIS flight on 2026-11-22?",
    script: [
      toolCallChunks("c1", "list_available_seats", [`{"flight_id":"${selloutId}"}`]),
      textChunks("3 seats left: 7D, 12C, 12F."),
    ],
  });
  ok(result.toolTrace[0]!.summary.includes("3 seats"), "stale hold on 12C was lazily released -> back to 3 available");
});

await scenario("context management: window + ID-preserving compaction, storage untouched", async () => {
  const e = await env();
  const holdId = uuidFor("booking:ava:ctx");
  const history: StoredMessage[] = [
    { role: "user", content: "find flights", ts: new Date() },
    { role: "assistant", content: "searching", ts: new Date() },
    { role: "assistant", content: "", tool_calls: [{ id: "c1" }] as never, ts: new Date() },
    { role: "tool", tool_call_id: "c1", name: "search_flights", content: `{"results":[{"flight_id":"${e.data.flights[0]!.id}"}]}`, ts: new Date() },
    { role: "user", content: "hold a seat", ts: new Date() },
    { role: "assistant", content: "", tool_calls: [{ id: "c2" }] as never, ts: new Date() },
    { role: "tool", tool_call_id: "c2", name: "hold_seat", content: `{"hold_id":"${holdId}"}`, ts: new Date() },
    { role: "user", content: "ok", ts: new Date() },
    { role: "assistant", content: "held", ts: new Date() },
    { role: "user", content: "confirm it", ts: new Date() },
  ];
  let captured = "";
  const { result, persisted, client } = await run(e, {
    userMessage: "yes please",
    history,
    context: {
      maxMessages: 6,
      compactThreshold: 4,
      compact: async (p) => {
        captured = p;
        return `SUMMARY: hold ${holdId} pending confirmation`;
      },
    },
    script: [textChunks("Noted.")],
  });
  ok(result.compacted, "compaction fired for the long history");
  ok(captured.includes(holdId), "compaction prompt carried the active hold_id forward");
  const sent = client.seenMessages[0]!;
  ok(sent[0]!.role === "system" && sent[1]!.role === "assistant" && sent[1]!.content.includes(holdId), "model sees [system, summary(with IDs), ...window]");
  ok(
    sent.every((m, i) => m.role !== "tool" || (sent[i - 1]?.role === "assistant" && Boolean(sent[i - 1]?.tool_calls))),
    "no dangling tool result at the window edge",
  );
  ok(persisted.length === 2 && persisted[0]!.role === "user" && persisted[1]!.role === "assistant", "persist got every new turn — compaction only trims what is SENT to the model, storage stays append-only");
});

await scenario("iteration cap: runaway tool loop stops safely", async () => {
  const e = await env();
  const { result } = await run(e, {
    userMessage: "keep searching",
    maxIterations: 3,
    script: [0, 1, 2, 3].map((i) =>
      toolCallChunks(`c${i}`, "search_flights", [`{"origin":"LHR","destination":"LIS","date":"${TOMORROW}"}`]),
    ),
  });
  ok(result.iterations === 3 && result.reply.includes("iteration cap"), "loop stops at the cap with a safe fallback");
});

console.log(`\neval suite: ${scenarioCount} scenarios, ${passed} assertions passed`);
