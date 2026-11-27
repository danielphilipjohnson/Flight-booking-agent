import assert from "node:assert/strict";
import { seededQueryable, sqliteDb, loadSchemaSql, toQueryable } from "./fixtures.ts";
import { generateDataset, uuidFor } from "../seed/generate.ts";
import { createToolRegistry } from "../tools/registry.ts";
import { iso, releaseExpiredHolds } from "../tools/flights.ts";

let passed = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

interface ToolResult {
  hold_id?: string;
  booking_id?: string;
  status?: string;
  error?: string;
  seat_no?: string;
  hold_expires_at?: string;
}

const { data, q } = await seededQueryable();
const registry = createToolRegistry(q, { holdMinutes: 10 });
const ava = { userRef: "ava", displayName: "Ava" };
const ben = { userRef: "ben", displayName: "Ben" };

const selloutId = data.flights.find((f) => f.flight_no === data.selloutFlightNo)!.id;
const avaConfirmed = data.bookings.find((b) => b.user_ref === "ava" && b.status === "confirmed")!;
const avaClaim = data.bookingSeats.find((bs) => bs.booking_id === avaConfirmed.id)!;
const avaFlightId = avaClaim.flight_id;

const seatStatus = async (flightId: string, seatNo: string) =>
  ((await q.query("SELECT status FROM seat WHERE flight_id = ? AND seat_no = ?", [flightId, seatNo])).rows[0] as { status: string }).status;
const activeClaims = async (flightId: string, seatNo: string) =>
  (await q.query("SELECT COUNT(*) AS n FROM booking_seat WHERE flight_id = ? AND seat_no = ? AND active = TRUE", [flightId, seatNo])).rows[0] as { n: number };
const myBookings = async (userRef: string) =>
  (await q.query("SELECT COUNT(*) AS n FROM booking WHERE user_ref = ? AND status <> 'cancelled'", [userRef])).rows[0] as { n: number };
const avaCountBaseline = (await myBookings("ava")).n;

console.log("\n# registry shape");
ok(registry.tools.length === 12, "12 tools registered (9 read + 3 write)");
const writeTools = registry.tools.filter((t) => t.requiresConfirmation);
ok(writeTools.map((t) => t.name).sort().join(",") === "cancel_booking,create_booking,hold_seat", "exactly the 3 write tools are confirm-gated");

console.log("\n# confirm gate enforcement");
const readGate = await registry.executeConfirmed("search_flights", { origin: "LHR", destination: "LIS", date: "2026-11-21" }, ava);
ok(!readGate.ok && readGate.error!.includes("not confirm-gated"), "read tools cannot be executed via the confirm endpoint");
const badArgs = await registry.executeConfirmed("hold_seat", { flight_id: "not-a-uuid", seat_no: "99Z" }, ava);
ok(!badArgs.ok && badArgs.error!.includes("invalid arguments"), "confirm endpoint re-validates args with Zod");
const unknown = await registry.executeConfirmed("nuke_everything", {}, ava);
ok(!unknown.ok && unknown.error!.includes("unknown tool"), "unknown tool rejected");

console.log("\n# hold_seat happy path");
const hold = (await registry.executeConfirmed("hold_seat", { flight_id: selloutId, seat_no: "12F" }, ava)) as { ok: boolean; result: ToolResult };
ok(hold.ok && typeof hold.result.hold_id === "string", "hold_seat returns a hold_id");
ok(hold.result.seat_no === "12F" && typeof hold.result.hold_expires_at === "string", "returns seat + expiry");
ok(Math.abs(new Date(hold.result.hold_expires_at!).getTime() - (Date.now() + 10 * 60_000)) < 60_000, "expiry = now + configured holdMinutes (10)");
ok((await seatStatus(selloutId, "12F")) === "held", "seat flipped to held");
ok((await activeClaims(selloutId, "12F")).n === 1, "one active booking_seat claim");
const holdRow = (await q.query("SELECT user_ref, status FROM booking WHERE id = ?", [hold.result.hold_id!])).rows[0] as { user_ref: string; status: string };
ok(holdRow.user_ref === "ava" && holdRow.status === "held", "hold booking owned by the session user");

console.log("\n# THE RACE: two concurrent holds on the same seat -> exactly one wins");
const [r1, r2] = await Promise.all([
  registry.executeConfirmed("hold_seat", { flight_id: selloutId, seat_no: "7D" }, ava),
  registry.executeConfirmed("hold_seat", { flight_id: selloutId, seat_no: "7D" }, ben),
]);
const outcomes = [r1, r2].map((r) => (r.ok ? "ok" : "error")).sort();
ok(outcomes.join(",") === "error,ok", "exactly one of two parallel holds succeeds");
const raceWinner = r1.ok ? "ava" : "ben";
const avaRaceExtra = raceWinner === "ava" ? 1 : 0;
const loser = [r1, r2].find((r) => !r.ok)!;
ok(loser.error!.includes("was just taken"), "loser gets the clean mapped error (unique-violation -> friendly message, issue #9): " + loser.error);
ok((await activeClaims(selloutId, "7D")).n === 1, "storage holds exactly one active claim on 7D");
ok((await seatStatus(selloutId, "7D")) === "held", "seat 7D is held exactly once");
const heldBookings = (await q.query("SELECT COUNT(*) AS n FROM booking WHERE status = 'held' AND id IN (SELECT booking_id FROM booking_seat WHERE flight_id = ? AND seat_no = '7D')", [selloutId])).rows[0] as { n: number };
ok(heldBookings.n === 1, "exactly one held booking for the seat");

console.log("\n# hold_seat negative paths");
const onBooked = await registry.executeConfirmed("hold_seat", { flight_id: avaFlightId, seat_no: "4A" }, ben);
ok(!onBooked.ok && onBooked.error!.includes("is booked"), "cannot hold an already-booked seat");
const noSeat = await registry.executeConfirmed("hold_seat", { flight_id: uuidFor("nope"), seat_no: "1A" }, ava);
ok(!noSeat.ok && noSeat.error!.includes("no seat"), "unknown flight/seat -> clean error");

console.log("\n# create_booking: hold -> confirmed");
const create = (await registry.executeConfirmed("create_booking", { hold_id: hold.result.hold_id!, passenger_name: "Ava" }, ava)) as { ok: boolean; result: ToolResult };
ok(create.ok && create.result.status === "confirmed" && create.result.booking_id === hold.result.hold_id, "hold converts to confirmed booking");
ok((await seatStatus(selloutId, "12F")) === "booked", "seat flipped to booked");
ok((await myBookings("ava")).n === avaCountBaseline + 1 + avaRaceExtra, "ava's active bookings grew by exactly 1 (plus her race hold if she won)");
const createAgain = await registry.executeConfirmed("create_booking", { hold_id: hold.result.hold_id!, passenger_name: "Ava" }, ava);
ok(!createAgain.ok && createAgain.error!.includes("not held"), "double-confirm refused (booking is confirmed, not held)");
const foreign = await registry.executeConfirmed("create_booking", { hold_id: hold.result.hold_id!, passenger_name: "Ben" }, ben);
ok(!foreign.ok, "SQL ownership check: ben cannot confirm ava's hold");

console.log("\n# create_booking on an expired hold");
await q.query(
  "INSERT INTO booking (id, user_ref, status, passenger_name, created_at, hold_expires_at) VALUES (?, ?, 'held', 'Elena', ?, ?)",
  [uuidFor("booking:elena:stale"), "elena", iso(new Date("2026-11-20T10:00:00.000Z")), iso(new Date("2020-01-01T00:00:00.000Z"))],
);
await q.query("UPDATE seat SET status = 'held', hold_expires_at = ? WHERE flight_id = ? AND seat_no = '12C'", [iso(new Date("2020-01-01T00:00:00.000Z")), selloutId]);
await q.query("INSERT INTO booking_seat (booking_id, flight_id, seat_no, active) VALUES (?, ?, '12C', TRUE)", [uuidFor("booking:elena:stale"), selloutId]);
const expired = await registry.executeConfirmed("create_booking", { hold_id: uuidFor("booking:elena:stale"), passenger_name: "Elena" }, { userRef: "elena", displayName: "Elena" });
ok(!expired.ok, "expired hold cannot be confirmed (lazily released first)");

console.log("\n# cancel_booking: release seat, ownership, idempotency");
const cancel = (await registry.executeConfirmed("cancel_booking", { booking_id: hold.result.hold_id! }, ava)) as { ok: boolean; result: ToolResult };
ok(cancel.ok && cancel.result.status === "cancelled", "own booking cancels");
ok((await seatStatus(selloutId, "12F")) === "available", "seat released back to available");
ok((await activeClaims(selloutId, "12F")).n === 0, "claim deactivated");
ok((await myBookings("ava")).n === avaCountBaseline + avaRaceExtra, "cancelled booking leaves the active count back at baseline (+ race hold)");
const cancelAgain = await registry.executeConfirmed("cancel_booking", { booking_id: hold.result.hold_id! }, ava);
ok(cancelAgain.ok && (cancelAgain.result as ToolResult).status === "cancelled", "cancelling twice is an idempotent clean refusal");
const avaOther = data.bookings.find((b) => b.user_ref === "ava" && b.status === "confirmed")!;
const foreignCancel = await registry.executeConfirmed("cancel_booking", { booking_id: avaOther.id }, ben);
ok(!foreignCancel.ok && foreignCancel.error!.includes("does not belong"), "ben cannot cancel ava's booking (SQL-enforced ownership)");
const cancelUnknown = await registry.executeConfirmed("cancel_booking", { booking_id: uuidFor("nope") }, ava);
ok(!cancelUnknown.ok && cancelUnknown.error!.includes("no booking"), "unknown booking id -> clean error");

console.log("\n# storage-level backstop: partial unique index rejects a second active claim");
let threw = false;
try {
  await q.query("INSERT INTO booking_seat (booking_id, flight_id, seat_no, active) VALUES (?, ?, '7D', TRUE)", [uuidFor("booking:ava:1"), selloutId]);
} catch {
  threw = true;
}
ok(threw, "second ACTIVE claim on held seat 7D rejected by booking_seat_active_unique");

console.log("\n# releaseExpiredHolds runs in ONE transaction and rolls back atomically (issue #6)");
const data2 = generateDataset(42, { now: new Date("2026-11-20T12:00:00.000Z") });
const db2 = sqliteDb(data2, await loadSchemaSql());
const realQ = toQueryable(db2, { txMode: "real" });
await realQ.query(
  "INSERT INTO booking (id, user_ref, status, passenger_name, created_at, hold_expires_at) VALUES (?, 'elena', 'held', 'Elena', ?, ?)",
  [uuidFor("booking:elena:tx"), iso(new Date("2026-11-20T10:00:00.000Z")), iso(new Date("2020-01-01T00:00:00.000Z"))],
);
const f2 = data2.flights[0]!;
await realQ.query("UPDATE seat SET status = 'held', hold_expires_at = ? WHERE flight_id = ? AND seat_no = '1A'", [iso(new Date("2020-01-01T00:00:00.000Z")), f2.id]);
await realQ.query("INSERT INTO booking_seat (booking_id, flight_id, seat_no, active) VALUES (?, ?, '1A', TRUE)", [uuidFor("booking:elena:tx"), f2.id]);
const released = await releaseExpiredHolds(realQ, new Date("2026-11-21T00:00:00.000Z"));
ok(released === 1, "expired hold released inside a real transaction");
const st = (await realQ.query("SELECT status FROM booking WHERE id = ?", [uuidFor("booking:elena:tx")])).rows[0] as { status: string };
ok(st.status === "cancelled", "booking cancelled after tx commit");

await realQ.query(
  "INSERT INTO booking (id, user_ref, status, passenger_name, created_at, hold_expires_at) VALUES (?, 'elena', 'held', 'Elena', ?, ?)",
  [uuidFor("booking:elena:tx2"), iso(new Date("2026-11-20T10:00:00.000Z")), iso(new Date("2020-01-01T00:00:00.000Z"))],
);
await realQ.query("UPDATE seat SET status = 'held', hold_expires_at = ? WHERE flight_id = ? AND seat_no = '1B'", [iso(new Date("2020-01-01T00:00:00.000Z")), f2.id]);
await realQ.query("INSERT INTO booking_seat (booking_id, flight_id, seat_no, active) VALUES (?, ?, '1B', TRUE)", [uuidFor("booking:elena:tx2"), f2.id]);
const failingQ = toQueryable(db2, { txMode: "real" });
const origQuery = failingQ.query.bind(failingQ);
let failNext = false;
failingQ.query = async (text, params) => {
  if (failNext && text.includes("UPDATE seat")) throw new Error("simulated mid-transaction failure");
  return origQuery(text, params);
};
failNext = true;
let txThrew = false;
try {
  await releaseExpiredHolds(failingQ, new Date("2026-11-21T00:00:00.000Z"));
} catch {
  txThrew = true;
}
ok(txThrew, "mid-transaction failure propagates");
failNext = false;
const b2 = (await realQ.query("SELECT status FROM booking WHERE id = ?", [uuidFor("booking:elena:tx2")])).rows[0] as { status: string };
const s2 = (await realQ.query("SELECT status FROM seat WHERE flight_id = ? AND seat_no = '1B'", [f2.id])).rows[0] as { status: string };
const c2 = (await realQ.query("SELECT active FROM booking_seat WHERE booking_id = ?", [uuidFor("booking:elena:tx2")])).rows[0] as { active: number };
ok(b2.status === "held" && s2.status === "held" && c2.active === 1, "ROLLBACK left booking/seat/claim untouched — all three statements are atomic");

console.log(`\n${passed} assertions passed`);
