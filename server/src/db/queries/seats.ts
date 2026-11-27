import type { Queryable } from "../types.ts";

export async function lockSeatForUpdate(
  q: Queryable,
  flightId: string,
  seatNo: string,
): Promise<Record<string, unknown>[]> {
  return (
    await q.query(
      "SELECT seat_no, class, price, status FROM seat WHERE flight_id = $1 AND seat_no = $2 FOR UPDATE",
      [flightId, seatNo],
    )
  ).rows;
}

export async function seatAvailabilityRows(q: Queryable, cabin?: string): Promise<Record<string, unknown>[]> {
  return cabin
    ? (
        await q.query(
          "SELECT flight_id, MIN(price) AS min_price, COUNT(*) AS n FROM seat WHERE status = 'available' AND class = $1 GROUP BY flight_id",
          [cabin],
        )
      ).rows
    : (
        await q.query(
          "SELECT flight_id, MIN(price) AS min_price, COUNT(*) AS n FROM seat WHERE status = 'available' GROUP BY flight_id",
        )
      ).rows;
}

export async function seatSummaryRows(q: Queryable, flightId: string): Promise<Record<string, unknown>[]> {
  return (
    await q.query(
      "SELECT class, status, COUNT(*) AS n, MIN(price) AS min_price FROM seat WHERE flight_id = $1 GROUP BY class, status ORDER BY class, status",
      [flightId],
    )
  ).rows;
}

export async function fareRuleSeatRows(q: Queryable, flightId: string): Promise<Record<string, unknown>[]> {
  return (
    await q.query(
      `SELECT s.class, s.fare_brand, s.price, s.seat_no,
              fr.carry_on, fr.checked_bags, fr.refundable, fr.changeable, fr.change_fee
       FROM seat s JOIN fare_rule fr ON fr.brand = s.fare_brand
       WHERE s.flight_id = $1 AND s.status = 'available'`,
      [flightId],
    )
  ).rows;
}

export async function availableSeatRows(q: Queryable, flightId: string): Promise<Record<string, unknown>[]> {
  return (
    await q.query(
      "SELECT seat_no, class, price FROM seat WHERE flight_id = $1 AND status = 'available'",
      [flightId],
    )
  ).rows;
}

export async function availableSeatsWithBrand(q: Queryable, flightId: string): Promise<Record<string, unknown>[]> {
  return (
    await q.query(
      "SELECT seat_no, class, price, fare_brand FROM seat WHERE flight_id = $1 AND status = 'available'",
      [flightId],
    )
  ).rows;
}

export async function markSeatHeld(q: Queryable, flightId: string, seatNo: string, holdExpiresAt: string): Promise<void> {
  await q.query(
    "UPDATE seat SET status = 'held', hold_expires_at = $3 WHERE flight_id = $1 AND seat_no = $2",
    [flightId, seatNo, holdExpiresAt],
  );
}

export async function markSeatBooked(q: Queryable, flightId: string, seatNo: string): Promise<void> {
  await q.query(
    "UPDATE seat SET status = 'booked', hold_expires_at = NULL WHERE flight_id = $1 AND seat_no = $2",
    [flightId, seatNo],
  );
}

export async function releaseSeat(q: Queryable, flightId: string, seatNo: string): Promise<void> {
  await q.query(
    "UPDATE seat SET status = 'available', hold_expires_at = NULL WHERE flight_id = $1 AND seat_no = $2",
    [flightId, seatNo],
  );
}
