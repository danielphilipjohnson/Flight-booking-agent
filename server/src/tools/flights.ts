import type { Queryable } from "../db/types.ts";
import {
  getFlightDetailsInput,
  listAvailableSeatsInput,
  listMyBookingsInput,
  searchFlightsInput,
  toolToOllamaSchema,
  type ToolContext,
  type ToolDef,
} from "./schemas.ts";

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function seatSortKey(seatNo: string): [number, string] {
  const match = /^(\d+)([A-F])$/.exec(seatNo);
  return match ? [Number(match[1]), match[2]!] : [999, seatNo];
}

export async function releaseExpiredHolds(db: Queryable, now = new Date()): Promise<number> {
  const cutoff = iso(now);
  const expired = await db.query(
    "SELECT id FROM booking WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at < $1",
    [cutoff],
  );
  if (expired.rows.length === 0) return 0;
  await db.query(
    "UPDATE booking_seat SET active = FALSE WHERE booking_id IN (SELECT id FROM booking WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at < $1)",
    [cutoff],
  );
  await db.query(
    "UPDATE seat SET status = 'available', hold_expires_at = NULL WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at < $1",
    [cutoff],
  );
  const released = await db.query(
    "UPDATE booking SET status = 'cancelled', hold_expires_at = NULL WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at < $1",
    [cutoff],
  );
  return expired.rows.length;
}

async function resolveCodes(db: Queryable, value: string): Promise<string[]> {
  const rows = (
    await db.query(
      "SELECT iata FROM airport WHERE UPPER(iata) = UPPER($1) OR UPPER(city) = UPPER($2) ORDER BY iata",
      [value, value],
    )
  ).rows;
  return rows.map((r) => String(r.iata));
}

function utcDay(value: unknown): string {
  return iso(value).slice(0, 10);
}

export function createFlightTools(db: Queryable): ToolDef[] {
  const searchFlights: ToolDef = {
    name: "search_flights",
    description:
      "Search flights by origin and destination (IATA code or city name) on a single ISO date. Returns flight IDs only; call get_flight_details for times and prices.",
    schema: searchFlightsInput,
    run: async (args, _ctx) => {
      const { origin, destination, date } = searchFlightsInput.parse(args) as {
        origin: string;
        destination: string;
        date: string;
      };
      await releaseExpiredHolds(db);
      const originCodes = await resolveCodes(db, origin);
      const destinationCodes = await resolveCodes(db, destination);
      if (originCodes.length === 0 || destinationCodes.length === 0) {
        return { results: [] };
      }
      const originPh = originCodes.map((_, i) => `$${i + 1}`).join(", ");
      const destPh = destinationCodes.map((_, i) => `$${originCodes.length + i + 1}`).join(", ");
      const rows = (
        await db.query(
          `SELECT id, flight_no, departs_at FROM flight WHERE origin IN (${originPh}) AND destination IN (${destPh})`,
          [...originCodes, ...destinationCodes],
        )
      ).rows.filter((r) => utcDay(r.departs_at) === date);
      rows.sort((a, b) => iso(a.departs_at).localeCompare(iso(b.departs_at)));
      return {
        results: rows.map((r) => ({
          flight_id: r.id,
          flight_no: r.flight_no,
          departs_at: iso(r.departs_at),
        })),
      };
    },
    toOllamaSchema: () =>
      toolToOllamaSchema({
        name: "search_flights",
        description: searchFlights.description,
        parameters: {
          type: "object",
          properties: {
            origin: { type: "string", description: "IATA code or city name, e.g. LHR or London" },
            destination: { type: "string", description: "IATA code or city name, e.g. LIS or Lisbon" },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "ISO date YYYY-MM-DD (UTC)" },
          },
          required: ["origin", "destination", "date"],
        },
      }),
  };

  const getFlightDetails: ToolDef = {
    name: "get_flight_details",
    description:
      "Get times, base price, and a per-class seat summary (counts by status, min price) for one flight.",
    schema: getFlightDetailsInput,
    run: async (args, _ctx) => {
      const { flight_id } = getFlightDetailsInput.parse(args) as { flight_id: string };
      await releaseExpiredHolds(db);
      const flights = (
        await db.query(
          "SELECT id, flight_no, origin, destination, departs_at, arrives_at, base_price FROM flight WHERE id = $1",
          [flight_id],
        )
      ).rows;
      if (flights.length === 0) return { error: `no flight with id ${flight_id}` };
      const f = flights[0]!;
      const summary = (
        await db.query(
          "SELECT class, status, COUNT(*) AS n, MIN(price) AS min_price FROM seat WHERE flight_id = $1 GROUP BY class, status ORDER BY class, status",
          [flight_id],
        )
      ).rows.map((r) => ({
        class: r.class,
        status: r.status,
        n: Number(r.n),
        min_price: r.min_price,
      }));
      return {
        flight_id: f.id,
        flight_no: f.flight_no,
        origin: f.origin,
        destination: f.destination,
        departs_at: iso(f.departs_at),
        arrives_at: iso(f.arrives_at),
        base_price: f.base_price,
        seat_summary: summary,
      };
    },
    toOllamaSchema: () =>
      toolToOllamaSchema({
        name: "get_flight_details",
        description: getFlightDetails.description,
        parameters: {
          type: "object",
          properties: { flight_id: { type: "string", format: "uuid" } },
          required: ["flight_id"],
        },
      }),
  };

  const listAvailableSeats: ToolDef = {
    name: "list_available_seats",
    description:
      "List seats currently available on a flight, optionally filtered by class. Occupied seats are counted in get_flight_details, not listed here.",
    schema: listAvailableSeatsInput,
    run: async (args, _ctx) => {
      const parsed = listAvailableSeatsInput.parse(args) as {
        flight_id: string;
        class?: "economy" | "business";
      };
      const flight_id = parsed.flight_id;
      await releaseExpiredHolds(db);
      let rows = (
        await db.query(
          "SELECT seat_no, class, price FROM seat WHERE flight_id = $1 AND status = 'available'",
          [flight_id],
        )
      ).rows;
      if (parsed.class) rows = rows.filter((r) => r.class === parsed.class);
      rows.sort((a, b) => {
        const [ra, la] = seatSortKey(String(a.seat_no));
        const [rb, lb] = seatSortKey(String(b.seat_no));
        return ra - rb || la.localeCompare(lb);
      });
      const exists = (
        await db.query("SELECT id FROM flight WHERE id = $1", [flight_id])
      ).rows;
      if (exists.length === 0) return { error: `no flight with id ${flight_id}` };
      return {
        flight_id,
        available_seats: rows.map((r) => ({
          seat_no: r.seat_no,
          class: r.class,
          price: r.price,
        })),
      };
    },
    toOllamaSchema: () =>
      toolToOllamaSchema({
        name: "list_available_seats",
        description: listAvailableSeats.description,
        parameters: {
          type: "object",
          properties: {
            flight_id: { type: "string", format: "uuid" },
            class: { type: "string", enum: ["economy", "business"] },
          },
          required: ["flight_id"],
        },
      }),
  };

  const listMyBookings: ToolDef = {
    name: "list_my_bookings",
    description:
      "List the logged-in session user's active bookings with flight info. Takes no arguments; identity comes from the session. Cancelled bookings are excluded.",
    schema: listMyBookingsInput,
    run: async (_args, ctx: ToolContext) => {
      const rows = (
        await db.query(
          `SELECT b.id AS booking_id, b.status, b.passenger_name, b.created_at,
                  bs.flight_id, bs.seat_no, f.flight_no, f.origin, f.destination, f.departs_at
           FROM booking b
           JOIN booking_seat bs ON bs.booking_id = b.id AND bs.active = TRUE
           JOIN flight f ON f.id = bs.flight_id
           WHERE b.user_ref = $1 AND b.status <> 'cancelled'
           ORDER BY b.created_at`,
          [ctx.userRef],
        )
      ).rows;
      return {
        bookings: rows.map((r) => ({
          booking_id: r.booking_id,
          status: r.status,
          passenger_name: r.passenger_name,
          created_at: iso(r.created_at),
          flight_id: r.flight_id,
          seat_no: r.seat_no,
          flight_no: r.flight_no,
          origin: r.origin,
          destination: r.destination,
          departs_at: iso(r.departs_at),
        })),
      };
    },
    toOllamaSchema: () =>
      toolToOllamaSchema({
        name: "list_my_bookings",
        description: listMyBookings.description,
        parameters: { type: "object", properties: {} },
      }),
  };

  return [searchFlights, getFlightDetails, listAvailableSeats, listMyBookings];
}
