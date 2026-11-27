import assert from "node:assert/strict";
import { checkBookingCancellable, checkBookingConfirmable, checkSeatHoldable } from "../tools/rules.ts";

let passed = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

const NOW = new Date("2026-11-20T12:00:00.000Z");

console.log("\n# checkSeatHoldable");
ok(checkSeatHoldable({ status: "available" }, "f1", "12A").ok, "available seat is holdable");
const unknownSeat = checkSeatHoldable(undefined, "f1", "12A");
ok(!unknownSeat.ok && unknownSeat.error === "no seat 12A on flight f1", "unknown seat -> exact error");
const heldSeat = checkSeatHoldable({ status: "held" }, "f1", "12A");
ok(!heldSeat.ok && heldSeat.error === "seat 12A is held", "held seat -> exact error");
const bookedSeat = checkSeatHoldable({ status: "booked" }, "f1", "12A");
ok(!bookedSeat.ok && bookedSeat.error === "seat 12A is booked", "booked seat -> exact error");

console.log("\n# checkBookingConfirmable");
const ownHold = { user_ref: "ava", status: "held", hold_expires_at: new Date("2026-11-20T12:10:00.000Z") };
ok(checkBookingConfirmable(ownHold, "ava", NOW).ok, "own unexpired hold is confirmable");
ok(
  checkBookingConfirmable({ ...ownHold, hold_expires_at: "2026-11-20T12:10:00.000Z" }, "ava", NOW).ok,
  "string hold_expires_at (sqlite shape) is confirmable",
);
ok(
  checkBookingConfirmable({ ...ownHold, hold_expires_at: null }, "ava", NOW).ok,
  "null hold_expires_at does not block confirmation",
);
const foreign = checkBookingConfirmable(ownHold, "ben", NOW);
ok(!foreign.ok && foreign.error === "this booking does not belong to the session user", "foreign hold -> ownership error");
const confirmed = checkBookingConfirmable({ ...ownHold, status: "confirmed" }, "ava", NOW);
ok(!confirmed.ok && confirmed.error === "booking is confirmed, not held", "confirmed booking -> not-held error");
const cancelled = checkBookingConfirmable({ ...ownHold, status: "cancelled" }, "ava", NOW);
ok(!cancelled.ok && cancelled.error === "booking is cancelled, not held", "cancelled booking -> not-held error");
const expiredDate = checkBookingConfirmable({ ...ownHold, hold_expires_at: new Date("2026-11-20T11:59:59.000Z") }, "ava", NOW);
ok(!expiredDate.ok && expiredDate.error === "hold has expired", "expired Date hold -> expiry error");
const expiredString = checkBookingConfirmable({ ...ownHold, hold_expires_at: "2026-11-20T11:59:59.000Z" }, "ava", NOW);
ok(!expiredString.ok && expiredString.error === "hold has expired", "expired string hold -> expiry error");

console.log("\n# checkBookingCancellable");
ok(checkBookingCancellable({ user_ref: "ava", status: "held" }, "ava").ok, "own held booking is cancellable");
const ownCancelled = checkBookingCancellable({ user_ref: "ava", status: "cancelled" }, "ava");
ok(ownCancelled.ok && ownCancelled.alreadyCancelled, "already-cancelled -> idempotent success flag");
const confirmedCancel = checkBookingCancellable({ user_ref: "ava", status: "confirmed" }, "ava");
ok(confirmedCancel.ok && !confirmedCancel.alreadyCancelled, "confirmed booking is cancellable, not idempotent");
const foreignCancel = checkBookingCancellable({ user_ref: "ben", status: "held" }, "ava");
ok(!foreignCancel.ok && foreignCancel.error === "this booking does not belong to the session user", "foreign booking -> ownership error");

console.log(`\n${passed} rule checks passed`);
