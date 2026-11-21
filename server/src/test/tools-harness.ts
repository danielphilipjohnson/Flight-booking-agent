import assert from "node:assert/strict";
import { FIXED_NOW, loadSchemaSql, seededQueryable, sqliteDb, toQueryable } from "./fixtures.ts";
import { generateDataset, uuidFor } from "../seed/generate.ts";
import { createFlightTools, releaseExpiredHolds } from "../tools/flights.ts";
import { searchFlightsInput, type ToolDef } from "../tools/schemas.ts";

let passed = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

const { data, q } = await seededQueryable();
const tools: ToolDef[] = createFlightTools(q);
const byName = (name: string) => tools.find((t) => t.name === name)!;
const ctx = { userRef: "ava" };

console.log("\n# search_flights");
const tomorrow = "2026-11-21";
const search = (await byName("search_flights").run({ origin: "LHR", destination: "LIS", date: tomorrow } as never, ctx)) as { results: { flight_id: string; flight_no: string; departs_at: string }[] };
ok(search.results.length === 3, "LHR->LIS on day+1 returns the 3 daily waves");
ok(search.results.every((r) => r.flight_id && r.flight_no && r.departs_at), "results carry flight_id, flight_no, departs_at only");
ok(
  search.results.every((r, i, arr) => i === 0 || arr[i - 1]!.departs_at <= r.departs_at),
  "results ordered by departure",
);
const citySearch = (await byName("search_flights").run({ origin: "London", destination: "Lisbon", date: tomorrow } as never, ctx)) as typeof search;
ok(citySearch.results.length === 3 && citySearch.results.every((r) => r.flight_no.startsWith("FF1")), "city names resolve via airport table (London -> LHR route)");
const noRoute = (await byName("search_flights").run({ origin: "LHR", destination: "Tokyo", date: tomorrow } as never, ctx)) as typeof search;
ok(noRoute.results.length === 0, "unknown destination -> graceful empty results");
ok(!searchFlightsInput.safeParse({ origin: "LHR", destination: "LIS", date: "tomorrow" }).success, "Zod rejects non-ISO dates");

console.log("\n# get_flight_details");
const flightId = search.results[0]!.flight_id;
const details = (await byName("get_flight_details").run({ flight_id: flightId } as never, ctx)) as {
  flight_no: string; seat_summary: { class: string; status: string; n: number }[];
};
ok(details.flight_no === search.results[0]!.flight_no, "details match the searched flight");
ok(details.seat_summary.reduce((sum, s) => sum + s.n, 0) === 72, "seat_summary counts all 72 seats");
const missing = (await byName("get_flight_details").run({ flight_id: uuidFor("nope") } as never, ctx)) as { error: string };
ok(typeof missing.error === "string", "unknown flight_id -> error result, not a crash");

console.log("\n# list_available_seats");
const selloutId = data.flights.find((f) => f.flight_no === data.selloutFlightNo)!.id;
const seats = (await byName("list_available_seats").run({ flight_id: selloutId } as never, ctx)) as { available_seats: { seat_no: string }[] };
ok(
  seats.available_seats.map((s) => s.seat_no).join(",") === "7D,12C,12F",
  "sellout flight lists exactly {7D,12C,12F}, numerically sorted",
);
const biz = (await byName("list_available_seats").run({ flight_id: selloutId, class: "business" } as never, ctx)) as typeof seats;
ok(biz.available_seats.length === 0, "class filter: sellout business cabin is full");

console.log("\n# list_my_bookings (session-scoped)");
const avaBookings = (await byName("list_my_bookings").run({} as never, { userRef: "ava" })) as { bookings: { seat_no: string; flight_no: string; status: string }[] };
ok(avaBookings.bookings.length === 1 && avaBookings.bookings[0]!.seat_no === "4A", "ava sees exactly 1 active booking (cancelled excluded), seat 4A");
const benBookings = (await byName("list_my_bookings").run({} as never, { userRef: "ben" })) as typeof avaBookings;
ok(benBookings.bookings.length === 2, "ben sees 2 confirmed bookings");
const danBookings = (await byName("list_my_bookings").run({} as never, { userRef: "dan" })) as typeof avaBookings;
ok(danBookings.bookings.length === 0, "dan sees none — identity is injected from the session, not the model");

console.log("\n# releaseExpiredHolds (lazy expiry before availability reads)");
await q.query(
  "INSERT INTO booking (id, user_ref, status, passenger_name, created_at, hold_expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  [uuidFor("booking:elena:expired"), "elena", "held", "Elena", "2026-11-20T10:00:00.000Z", "2099-01-01T00:00:00.000Z"],
);
await q.query("UPDATE seat SET status = 'held', hold_expires_at = ? WHERE flight_id = ? AND seat_no = '7D'", ["2099-01-01T00:00:00.000Z", selloutId]);
await q.query("INSERT INTO booking_seat (booking_id, flight_id, seat_no, active) VALUES (?, ?, ?, ?)", [uuidFor("booking:elena:expired"), selloutId, "7D", 1]);
const duringHold = (await byName("list_available_seats").run({ flight_id: selloutId } as never, ctx)) as typeof seats;
ok(duringHold.available_seats.length === 2, "while held, 7D disappears from available seats");
await q.query("UPDATE booking SET hold_expires_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", uuidFor("booking:elena:expired")]);
await q.query("UPDATE seat SET hold_expires_at = ? WHERE flight_id = ? AND seat_no = '7D'", ["2020-01-01T00:00:00.000Z", selloutId]);
const afterRelease = (await byName("list_available_seats").run({ flight_id: selloutId } as never, ctx)) as typeof seats;
ok(afterRelease.available_seats.length === 3, "expired hold is released lazily on the next availability read");
const holdStatus = (await q.query("SELECT status FROM booking WHERE id = ?", [uuidFor("booking:elena:expired")])).rows[0]!;
ok(holdStatus.status === "cancelled", "expired hold booking is marked cancelled");
const releasedCount = await releaseExpiredHolds(q, new Date(FIXED_NOW.getTime() + 60_000));
ok(releasedCount === 0, "releaseExpiredHolds is idempotent once nothing is expired");

console.log(`\n${passed} assertions passed`);
