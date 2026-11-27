import type { Queryable } from "../types.ts";

export async function allFlights(q: Queryable): Promise<Record<string, unknown>[]> {
  return (
    await q.query(
      "SELECT id, flight_no, origin, destination, departs_at, arrives_at, base_price, airline_code, on_time_pct FROM flight",
    )
  ).rows;
}

export async function flightsBetween(
  q: Queryable,
  originCodes: string[],
  destinationCodes: string[],
): Promise<Record<string, unknown>[]> {
  const originPh = originCodes.map((_, i) => `$${i + 1}`).join(", ");
  const destPh = destinationCodes
    .map((_, i) => `$${originCodes.length + i + 1}`)
    .join(", ");
  return (
    await q.query(
      `SELECT id, flight_no, origin, destination, departs_at, arrives_at, base_price, airline_code, on_time_pct
       FROM flight WHERE origin IN (${originPh}) AND destination IN (${destPh})`,
      [...originCodes, ...destinationCodes],
    )
  ).rows;
}

export async function flightWithAirline(q: Queryable, flightId: string): Promise<Record<string, unknown>[]> {
  return (
    await q.query(
      `SELECT f.id, f.flight_no, f.origin, f.destination, f.departs_at, f.arrives_at, f.base_price,
              f.airline_code, f.on_time_pct, al.name AS airline_name
       FROM flight f JOIN airline al ON al.code = f.airline_code
       WHERE f.id = $1`,
      [flightId],
    )
  ).rows;
}

export async function flightExists(q: Queryable, flightId: string): Promise<Record<string, unknown>[]> {
  return (await q.query("SELECT id FROM flight WHERE id = $1", [flightId])).rows;
}

export async function listRoutePairs(q: Queryable): Promise<Record<string, unknown>[]> {
  return (await q.query("SELECT DISTINCT origin, destination FROM flight ORDER BY origin, destination")).rows;
}
