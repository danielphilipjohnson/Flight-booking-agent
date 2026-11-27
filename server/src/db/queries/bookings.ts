import { iso } from "../../agent/dates.ts";
import type { Queryable } from "../types.ts";

export async function releaseExpiredHoldsStatements(q: Queryable, now = new Date()): Promise<number> {
  const cutoff = iso(now);
  const expired = await q.query(
    "SELECT id FROM booking WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at < $1",
    [cutoff],
  );
  if (expired.rows.length === 0) return 0;
  await q.query(
    "UPDATE booking_seat SET active = FALSE WHERE booking_id IN (SELECT id FROM booking WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at < $1)",
    [cutoff],
  );
  await q.query(
    "UPDATE seat SET status = 'available', hold_expires_at = NULL WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at < $1",
    [cutoff],
  );
  await q.query(
    "UPDATE booking SET status = 'cancelled', hold_expires_at = NULL WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at < $1",
    [cutoff],
  );
  return expired.rows.length;
}

export async function createHold(
  q: Queryable,
  params: { id: string; userRef: string; passengerName: string; now: Date; holdExpiresAt: Date },
): Promise<void> {
  await q.query(
    "INSERT INTO booking (id, user_ref, status, passenger_name, created_at, hold_expires_at) VALUES ($1, $2, 'held', $3, $4, $5)",
    [params.id, params.userRef, params.passengerName, iso(params.now), iso(params.holdExpiresAt)],
  );
}

export async function insertSeatClaim(q: Queryable, bookingId: string, flightId: string, seatNo: string): Promise<void> {
  await q.query(
    "INSERT INTO booking_seat (booking_id, flight_id, seat_no, active) VALUES ($1, $2, $3, TRUE)",
    [bookingId, flightId, seatNo],
  );
}

export async function lockBookingForUpdate(q: Queryable, bookingId: string): Promise<Record<string, unknown>[]> {
  return (
    await q.query(
      "SELECT id, user_ref, status, hold_expires_at FROM booking WHERE id = $1 FOR UPDATE",
      [bookingId],
    )
  ).rows;
}

export async function confirmBooking(q: Queryable, bookingId: string, passengerName: string): Promise<void> {
  await q.query(
    "UPDATE booking SET status = 'confirmed', passenger_name = $2, hold_expires_at = NULL WHERE id = $1",
    [bookingId, passengerName],
  );
}

export async function activeSeatClaims(q: Queryable, bookingId: string): Promise<Record<string, unknown>[]> {
  return (
    await q.query(
      "SELECT flight_id, seat_no FROM booking_seat WHERE booking_id = $1 AND active = TRUE",
      [bookingId],
    )
  ).rows;
}

export async function deactivateSeatClaims(q: Queryable, bookingId: string): Promise<void> {
  await q.query("UPDATE booking_seat SET active = FALSE WHERE booking_id = $1", [bookingId]);
}

export async function cancelBookingRecord(q: Queryable, bookingId: string): Promise<void> {
  await q.query("UPDATE booking SET status = 'cancelled' WHERE id = $1", [bookingId]);
}

export async function lockBookingForCancel(q: Queryable, bookingId: string): Promise<Record<string, unknown>[]> {
  return (
    await q.query(
      "SELECT id, user_ref, status FROM booking WHERE id = $1 FOR UPDATE",
      [bookingId],
    )
  ).rows;
}

export async function bookingsByUser(q: Queryable, userRef: string): Promise<Record<string, unknown>[]> {
  return (
    await q.query(
      `SELECT b.id AS booking_id, b.status, b.passenger_name, b.created_at,
              bs.flight_id, bs.seat_no, f.flight_no, f.origin, f.destination, f.departs_at
       FROM booking b
       JOIN booking_seat bs ON bs.booking_id = b.id AND bs.active = TRUE
       JOIN flight f ON f.id = bs.flight_id
       WHERE b.user_ref = $1 AND b.status <> 'cancelled'
       ORDER BY b.created_at`,
      [userRef],
    )
  ).rows;
}
