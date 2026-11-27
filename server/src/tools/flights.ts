import type { Queryable } from "../db/types.ts";
import { resolveAirports, type AirportRowLite } from "../agent/airports.ts";
import { dateWindow, iso, isoDay } from "../agent/dates.ts";
import {
  allFlights as allFlightsRows,
  flightExists,
  flightWithAirline,
  flightsBetween as flightsBetweenRows,
  listRoutePairs,
} from "../db/queries/flights.ts";
import { listAirports } from "../db/queries/airports.ts";
import {
  filterOffersInput,
  findFirstAvailableFlightInput,
  getFlightDetailsInput,
  listAvailableSeatsInput,
  listMyBookingsInput,
  searchAnywhereInput,
  searchFlexiblePricesInput,
  searchFlightsInput,
  searchInspirationInput,
  toolToOllamaSchema,
  type FilterOffersArgs,
  type SearchAnywhereArgs,
  type SearchFlexiblePricesArgs,
  type SearchFlightsArgs,
  type SearchInspirationArgs,
  type ToolContext,
  type ToolDef,
} from "./schemas.ts";

export { iso } from "../agent/dates.ts";

function seatSortKey(seatNo: string): [number, string] {
  const match = /^(\d+)([A-F])$/.exec(seatNo);
  return match ? [Number(match[1]), match[2]!] : [999, seatNo];
}

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

export async function releaseExpiredHolds(db: Queryable, now = new Date()): Promise<number> {
  if (db.tx) {
    return db.tx((q) => releaseExpiredHoldsStatements(q, now));
  }
  return releaseExpiredHoldsStatements(db, now);
}

async function resolveCodes(db: Queryable, value: string): Promise<string[]> {
  const airports = await allAirports(db);
  const { exact, candidates } = resolveAirports(value, airports);
  const matches = exact.length > 0 ? exact : candidates;
  return matches.map((m) => m.iata);
}

async function allAirports(db: Queryable): Promise<(AirportRowLite & { tags: string })[]> {
  const rows = await listAirports(db);
  return rows.map((r) => ({
    iata: String(r.iata),
    name: String(r.name),
    city: String(r.city),
    country: String(r.country),
    tags: String(r.tags ?? ""),
  }));
}

function utcDay(value: unknown): string {
  return iso(value).slice(0, 10);
}

function durationMinutes(departsAt: unknown, arrivesAt: unknown): number {
  return Math.round((new Date(iso(arrivesAt)).getTime() - new Date(iso(departsAt)).getTime()) / 60_000);
}

function monthBounds(month: string | undefined, now: Date): { from: string; to: string } {
  const year = month ? Number(month.slice(0, 4)) : now.getUTCFullYear();
  const monthIndex = month ? Number(month.slice(5, 7)) - 1 : now.getUTCMonth();
  const from = new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(year, monthIndex + 1, 0)).toISOString().slice(0, 10);
  return { from, to };
}

interface FlightRow {
  id: unknown;
  flight_no: unknown;
  origin: unknown;
  destination: unknown;
  departs_at: unknown;
  arrives_at: unknown;
  base_price: unknown;
  airline_code?: unknown;
  on_time_pct?: unknown;
}

async function allFlights(db: Queryable): Promise<FlightRow[]> {
  return (await allFlightsRows(db)) as unknown as FlightRow[];
}

async function flightsBetween(
  db: Queryable,
  originCodes: string[],
  destinationCodes: string[],
): Promise<FlightRow[]> {
  return (await flightsBetweenRows(db, originCodes, destinationCodes)) as unknown as FlightRow[];
}

interface SeatAggregate {
  min_price: number | null;
  available: number;
}

async function seatAggregatesByFlight(
  db: Queryable,
  cabin: string | undefined,
): Promise<Map<string, SeatAggregate>> {
  const rows = cabin
    ? (
        await db.query(
          "SELECT flight_id, MIN(price) AS min_price, COUNT(*) AS n FROM seat WHERE status = 'available' AND class = $1 GROUP BY flight_id",
          [cabin],
        )
      ).rows
    : (
        await db.query(
          "SELECT flight_id, MIN(price) AS min_price, COUNT(*) AS n FROM seat WHERE status = 'available' GROUP BY flight_id",
        )
      ).rows;
  const map = new Map<string, SeatAggregate>();
  for (const r of rows) {
    map.set(String(r.flight_id), {
      min_price: r.min_price === null || r.min_price === undefined ? null : Number(r.min_price),
      available: Number(r.n),
    });
  }
  return map;
}

export type PinnedLeg = "outbound" | "return";

export interface PinnedOffer {
  flight_id: string;
  flight_no: string;
  origin: string;
  destination: string;
  departs_at: string;
  arrives_at: string;
  base_price: number;
  on_time_pct: number;
  leg?: PinnedLeg;
}

const pinnedBySession = new Map<string, PinnedOffer[]>();

const MAX_PINNED_SESSIONS = 200;

export function setPinnedOffers(sessionId: string, offers: PinnedOffer[]): void {
  while (pinnedBySession.size >= MAX_PINNED_SESSIONS && !pinnedBySession.has(sessionId)) {
    const oldest = pinnedBySession.keys().next().value;
    if (oldest === undefined) break;
    pinnedBySession.delete(oldest);
  }
  pinnedBySession.set(sessionId, offers);
}

export function pinnedOfferCount(sessionId: string): number {
  return pinnedBySession.get(sessionId)?.length ?? 0;
}

export function clearPinnedOffers(sessionId: string): void {
  pinnedBySession.delete(sessionId);
}

function toPinned(rows: FlightRow[], leg: PinnedLeg = "outbound"): PinnedOffer[] {
  return rows.map((r) => ({
    flight_id: String(r.id),
    flight_no: String(r.flight_no),
    origin: String(r.origin),
    destination: String(r.destination),
    departs_at: iso(r.departs_at),
    arrives_at: iso(r.arrives_at),
    base_price: Number(r.base_price),
    on_time_pct: Number(r.on_time_pct ?? 95),
    leg,
  }));
}

const THEME_TAGS: Record<string, string> = {
  beach: "beach",
  warm: "beach",
  sun: "beach",
  city: "city",
  "city break": "city",
  culture: "city",
  ski: "ski",
  skiing: "ski",
  snow: "ski",
};

export function createFlightTools(db: Queryable): ToolDef[] {
  const searchFlights: ToolDef = {
    name: "search_flights",
    description:
      "Search flights by origin and destination (IATA code or city name) on a single ISO date, optionally with a return_date for a round trip. Returns flights with price and on-time record; call get_flight_details for seat-level fares and baggage rules. For a month or open-ended range, use find_first_available_flight instead; for vague dates ('next week'), use search_flexible_prices.",
    schema: searchFlightsInput,
    run: async (args, ctx) => {
      const { origin, destination, date, return_date } = searchFlightsInput.parse(args) as SearchFlightsArgs;
      await releaseExpiredHolds(db);
      const originCodes = await resolveCodes(db, origin);
      const destinationCodes = await resolveCodes(db, destination);
      if (originCodes.length === 0 || destinationCodes.length === 0) {
        if (ctx.sessionId) clearPinnedOffers(ctx.sessionId);
        const unresolved = [
          ...(originCodes.length === 0 ? [`origin "${origin}"`] : []),
          ...(destinationCodes.length === 0 ? [`destination "${destination}"`] : []),
        ].join(" and ");
        return {
          results: [],
          resolved: { origin: originCodes, destination: destinationCodes },
          note: `No airports match the ${unresolved}. Say the place isn't in the network, or call resolve_airport_code to list what is.`,
          return_results: return_date ? [] : undefined,
        };
      }
      const outbound = (await flightsBetween(db, originCodes, destinationCodes)).filter(
        (r) => utcDay(r.departs_at) === date,
      );
      outbound.sort((a, b) => iso(a.departs_at).localeCompare(iso(b.departs_at)));

      if (!return_date) {
        if (outbound.length === 0) {
          if (ctx.sessionId) clearPinnedOffers(ctx.sessionId);
          return { results: [], resolved: { origin: originCodes, destination: destinationCodes } };
        }
        if (ctx.sessionId) setPinnedOffers(ctx.sessionId, toPinned(outbound));
        return {
          results: outbound.map((r) => ({
            flight_id: r.id,
            flight_no: r.flight_no,
            origin: r.origin,
            destination: r.destination,
            departs_at: iso(r.departs_at),
            arrives_at: iso(r.arrives_at),
            duration_minutes: durationMinutes(r.departs_at, r.arrives_at),
            base_price: r.base_price,
            on_time_pct: Number(r.on_time_pct ?? 95),
          })),
        };
      }

      const returnRows = (await flightsBetween(db, destinationCodes, originCodes)).filter(
        (r) => utcDay(r.departs_at) === return_date,
      );
      returnRows.sort((a, b) => iso(a.departs_at).localeCompare(iso(b.departs_at)));
      if (outbound.length === 0 || returnRows.length === 0) {
        if (ctx.sessionId) clearPinnedOffers(ctx.sessionId);
        return {
          results: outbound.map((r) => ({ flight_id: r.id, flight_no: r.flight_no, departs_at: iso(r.departs_at) })),
          return_results: returnRows.map((r) => ({ flight_id: r.id, flight_no: r.flight_no, departs_at: iso(r.departs_at) })),
          empty_leg: outbound.length === 0 ? "outbound" : "return",
          resolved: { origin: originCodes, destination: destinationCodes },
        };
      }
      if (ctx.sessionId) setPinnedOffers(ctx.sessionId, [...toPinned(outbound, "outbound"), ...toPinned(returnRows, "return")]);
      const cheapestOut = Math.min(...outbound.map((r) => Number(r.base_price)));
      const cheapestRet = Math.min(...returnRows.map((r) => Number(r.base_price)));
      return {
        results: outbound.map((r) => ({
          flight_id: r.id,
          flight_no: r.flight_no,
          origin: r.origin,
          destination: r.destination,
          departs_at: iso(r.departs_at),
          arrives_at: iso(r.arrives_at),
          duration_minutes: durationMinutes(r.departs_at, r.arrives_at),
          base_price: r.base_price,
          on_time_pct: Number(r.on_time_pct ?? 95),
        })),
        return_results: returnRows.map((r) => ({
          flight_id: r.id,
          flight_no: r.flight_no,
          origin: r.origin,
          destination: r.destination,
          departs_at: iso(r.departs_at),
          arrives_at: iso(r.arrives_at),
          duration_minutes: durationMinutes(r.departs_at, r.arrives_at),
          base_price: r.base_price,
          on_time_pct: Number(r.on_time_pct ?? 95),
        })),
        round_trip_total_from: Math.round((cheapestOut + cheapestRet) * 100) / 100,
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
            return_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Return date for a round trip (ISO YYYY-MM-DD); omit for one-way" },
          },
          required: ["origin", "destination", "date"],
        },
      }),
  };

  const findFirstAvailableFlight: ToolDef = {
    name: "find_first_available_flight",
    description:
      "Find the earliest flight in a month or date range that still has an available seat, optionally in a given class. Omit origin and destination to search every route. Use this instead of calling search_flights day by day for open-ended requests like 'first available flight this month'. Returns flight details, times, price, on-time record, and sample seats.",
    schema: findFirstAvailableFlightInput,
    run: async (args, _ctx) => {
      const parsed = findFirstAvailableFlightInput.parse(args);
      const { origin, destination } = parsed;
      const cabin = parsed.class;
      if ((parsed.from_date && !parsed.to_date) || (!parsed.from_date && parsed.to_date)) {
        return { error: "from_date and to_date must be supplied together" };
      }
      const range =
        parsed.from_date && parsed.to_date
          ? { from: parsed.from_date, to: parsed.to_date }
          : monthBounds(parsed.month, new Date());
      if (range.from > range.to) {
        return { error: "from_date must not be after to_date" };
      }

      await releaseExpiredHolds(db);
      const searched = {
        ...range,
        origin: origin ?? null,
        destination: destination ?? null,
        class: cabin ?? null,
      };
      if (Boolean(origin) !== Boolean(destination)) {
        return { error: "supply both origin and destination, or neither" };
      }

      let candidates: FlightRow[];
      if (origin && destination) {
        const originCodes = await resolveCodes(db, origin);
        const destinationCodes = await resolveCodes(db, destination);
        if (originCodes.length === 0 || destinationCodes.length === 0) {
          return { results: [], searched };
        }
        candidates = await flightsBetween(db, originCodes, destinationCodes);
      } else {
        candidates = await allFlights(db);
      }
      candidates = candidates
        .filter((r) => {
          const day = utcDay(r.departs_at);
          return day >= range.from && day <= range.to;
        })
        .sort((a, b) => iso(a.departs_at).localeCompare(iso(b.departs_at)));

      for (const flight of candidates) {
        const seatRows = (
          await db.query(
            "SELECT seat_no, class, price FROM seat WHERE flight_id = $1 AND status = 'available'",
            [flight.id],
          )
        ).rows.filter((r) => !cabin || r.class === cabin);
        if (seatRows.length === 0) continue;
        seatRows.sort((a, b) => {
          const [ra, la] = seatSortKey(String(a.seat_no));
          const [rb, lb] = seatSortKey(String(b.seat_no));
          return ra - rb || la.localeCompare(lb);
        });
        const prices = seatRows
          .map((s) => Number(s.price))
          .filter((p) => Number.isFinite(p));
        return {
          results: [
            {
              flight_id: flight.id,
              flight_no: flight.flight_no,
              origin: flight.origin,
              destination: flight.destination,
              departs_at: iso(flight.departs_at),
              arrives_at: iso(flight.arrives_at),
              base_price: flight.base_price,
              on_time_pct: Number(flight.on_time_pct ?? 95),
              available_seat_count: seatRows.length,
              min_seat_price: prices.length ? Math.min(...prices).toFixed(2) : null,
              example_seats: seatRows.slice(0, 3).map((s) => ({
                seat_no: s.seat_no,
                class: s.class,
                price: s.price,
              })),
            },
          ],
          searched,
        };
      }
      return { results: [], searched };
    },
    toOllamaSchema: () =>
      toolToOllamaSchema({
        name: findFirstAvailableFlight.name,
        description: findFirstAvailableFlight.description,
        parameters: {
          type: "object",
          properties: {
            origin: { type: "string", description: "Optional IATA code or city name; supply together with destination" },
            destination: { type: "string", description: "Optional IATA code or city name; omit both to search every route" },
            month: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}$",
              description: "ISO month YYYY-MM, e.g. 2026-11. Defaults to the current UTC month.",
            },
            from_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Start date of an explicit range" },
            to_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "End date of an explicit range, inclusive" },
            class: { type: "string", enum: ["economy", "business"] },
          },
          required: [],
        },
      }),
  };

  const getFlightDetails: ToolDef = {
    name: "get_flight_details",
    description:
      "Full breakdown for one flight: airline, on-time record, times, base price, per-class seat summary (counts by status, min price), and per-class fare rules from the cheapest available seat (fare brand, carry-on and checked-bag allowance, refundability, change fee). Use it to answer 'is a carry-on included?', 'can I cancel?', or any what's-included question.",
    schema: getFlightDetailsInput,
    run: async (args, _ctx) => {
      const { flight_id } = getFlightDetailsInput.parse(args) as { flight_id: string };
      await releaseExpiredHolds(db);
      const flights = await flightWithAirline(db, flight_id);
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

      const seatRows = (
        await db.query(
          `SELECT s.class, s.fare_brand, s.price, s.seat_no,
                  fr.carry_on, fr.checked_bags, fr.refundable, fr.changeable, fr.change_fee
           FROM seat s JOIN fare_rule fr ON fr.brand = s.fare_brand
           WHERE s.flight_id = $1 AND s.status = 'available'`,
          [flight_id],
        )
      ).rows;
      const fareRules: Record<string, unknown> = {};
      for (const row of seatRows) {
        const cabinClass = String(row.class);
        const price = Number(row.price);
        const existing = fareRules[cabinClass] as { min_price_per_person: number } | undefined;
        if (!existing || price < existing.min_price_per_person) {
          fareRules[cabinClass] = {
            fare_brand: row.fare_brand,
            example_seat: row.seat_no,
            min_price_per_person: price,
            carry_on_included: Boolean(row.carry_on),
            checked_bags_included: Number(row.checked_bags),
            refundable: Boolean(row.refundable),
            changeable: Boolean(row.changeable),
            change_fee: Number(row.change_fee),
          };
        }
      }

      return {
        flight_id: f.id,
        flight_no: f.flight_no,
        origin: f.origin,
        destination: f.destination,
        departs_at: iso(f.departs_at),
        arrives_at: iso(f.arrives_at),
        duration_minutes: durationMinutes(f.departs_at, f.arrives_at),
        base_price: f.base_price,
        airline: { code: f.airline_code, name: f.airline_name },
        on_time_pct: Number(f.on_time_pct ?? 95),
        seat_summary: summary,
        fare_rules: fareRules,
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
          "SELECT seat_no, class, price, fare_brand FROM seat WHERE flight_id = $1 AND status = 'available'",
          [flight_id],
        )
      ).rows;
      if (parsed.class) rows = rows.filter((r) => r.class === parsed.class);
      rows.sort((a, b) => {
        const [ra, la] = seatSortKey(String(a.seat_no));
        const [rb, lb] = seatSortKey(String(b.seat_no));
        return ra - rb || la.localeCompare(lb);
      });
      const exists = await flightExists(db, flight_id);
      if (exists.length === 0) return { error: `no flight with id ${flight_id}` };
      return {
        flight_id,
        available_seats: rows.map((r) => ({
          seat_no: r.seat_no,
          class: r.class,
          fare_brand: r.fare_brand,
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

  const searchFlexiblePrices: ToolDef = {
    name: "search_flexible_prices",
    description:
      "Price calendar: cheapest available seat per day for a route over a date window (up to 14 days). Use when the date is vague ('next week', 'around the 14th', 'is it cheaper a day later?').",
    schema: searchFlexiblePricesInput,
    run: async (args, _ctx) => {
      const { origin, destination, from_date, days, class: cabin } = searchFlexiblePricesInput.parse(args) as SearchFlexiblePricesArgs;
      const windowDays = days ?? 7;
      await releaseExpiredHolds(db);
      const originCodes = await resolveCodes(db, origin);
      const destinationCodes = await resolveCodes(db, destination);
      const searched = { from: from_date, days: windowDays, origin: originCodes, destination: destinationCodes, class: cabin ?? null };
      if (originCodes.length === 0 || destinationCodes.length === 0) {
        return { days: [], cheapest_day: null, searched };
      }
      const window = dateWindow(from_date, windowDays);
      const rows = (await flightsBetween(db, originCodes, destinationCodes)).filter((r) => {
        const day = utcDay(r.departs_at);
        return day >= window.from && day <= window.to;
      });
      if (rows.length === 0) {
        return { days: [], cheapest_day: null, searched };
      }
      const aggregates = await seatAggregatesByFlight(db, cabin);
      const byDay = new Map<string, { min: number; flights: number }>();
      for (const flight of rows) {
        const aggregate = aggregates.get(String(flight.id));
        if (!aggregate || aggregate.min_price === null) continue;
        const day = utcDay(flight.departs_at);
        const bucket = byDay.get(day);
        if (bucket) {
          bucket.min = Math.min(bucket.min, aggregate.min_price);
          bucket.flights += 1;
        } else {
          byDay.set(day, { min: aggregate.min_price, flights: 1 });
        }
      }
      const days_ = [...byDay.entries()]
        .map(([date, v]) => ({ date, min_price_per_person: v.min, flights_available: v.flights }))
        .sort((a, b) => a.date.localeCompare(b.date));
      return {
        days: days_,
        cheapest_day: days_.reduce((a, b) => (a.min_price_per_person <= b.min_price_per_person ? a : b)),
        searched,
      };
    },
    toOllamaSchema: () =>
      toolToOllamaSchema({
        name: "search_flexible_prices",
        description: searchFlexiblePrices.description,
        parameters: {
          type: "object",
          properties: {
            origin: { type: "string", description: "IATA code or city name" },
            destination: { type: "string", description: "IATA code or city name" },
            from_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Window start, ISO YYYY-MM-DD" },
            days: { type: "integer", minimum: 1, maximum: 14, description: "Window length in days, default 7" },
            class: { type: "string", enum: ["economy", "business"] },
          },
          required: ["origin", "destination", "from_date"],
        },
      }),
  };

  async function browseDestinations(
    originCodes: string[],
    themeCodes: string[] | null,
    fromDate: string,
    windowDays: number,
    maxPrice: number | undefined,
  ): Promise<Record<string, unknown>[]> {
    const window = dateWindow(fromDate, windowDays);
    const candidates = themeCodes
      ? await flightsBetween(db, originCodes, themeCodes)
      : (await allFlights(db)).filter((r) => originCodes.includes(String(r.origin)));
    const inWindow = candidates.filter((r) => {
      const day = utcDay(r.departs_at);
      return day >= window.from && day <= window.to;
    });
    const aggregates = await seatAggregatesByFlight(db, "economy");
    const byDestination = new Map<string, { min: number; flights: number; next: string }>();
    for (const flight of inWindow) {
      const aggregate = aggregates.get(String(flight.id));
      if (!aggregate || aggregate.min_price === null) continue;
      if (maxPrice !== undefined && aggregate.min_price > maxPrice) continue;
      const destination = String(flight.destination);
      const bucket = byDestination.get(destination);
      if (bucket) {
        bucket.min = Math.min(bucket.min, aggregate.min_price);
        bucket.flights += 1;
        bucket.next = bucket.next < iso(flight.departs_at) ? bucket.next : iso(flight.departs_at);
      } else {
        byDestination.set(destination, {
          min: aggregate.min_price,
          flights: 1,
          next: iso(flight.departs_at),
        });
      }
    }
    const airports = await allAirports(db);
    const byIata = new Map(airports.map((a) => [a.iata, a]));
    return [...byDestination.entries()]
      .map(([destination, v]) => ({
        destination,
        city: byIata.get(destination)?.city ?? destination,
        country: byIata.get(destination)?.country ?? "",
        min_price_per_person: v.min,
        flights_available: v.flights,
        next_departure: v.next.slice(0, 10),
      }))
      .sort((a, b) => a.min_price_per_person - b.min_price_per_person);
  }

  const searchAnywhere: ToolDef = {
    name: "search_anywhere",
    description:
      "Browse mode for users without a destination: destinations reachable from an origin over a date window, ranked by cheapest economy price. Use for 'where can I go for under 300?' when no theme is given.",
    schema: searchAnywhereInput,
    run: async (args, _ctx) => {
      const { origin, from_date, days, max_price } = searchAnywhereInput.parse(args) as SearchAnywhereArgs;
      const windowDays = days ?? 14;
      await releaseExpiredHolds(db);
      const originCodes = await resolveCodes(db, origin);
      if (originCodes.length === 0) return { destinations: [], searched: { origin: originCodes } };
      const start = from_date ?? isoDay(new Date());
      const destinations = await browseDestinations(originCodes, null, start, windowDays, max_price);
      return {
        searched: { origin: originCodes, from_date: start, days: windowDays, max_price: max_price ?? null },
        destinations: destinations.slice(0, 10),
      };
    },
    toOllamaSchema: () =>
      toolToOllamaSchema({
        name: "search_anywhere",
        description: searchAnywhere.description,
        parameters: {
          type: "object",
          properties: {
            origin: { type: "string", description: "IATA code or city name" },
            from_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Window start, ISO YYYY-MM-DD; defaults to today" },
            days: { type: "integer", minimum: 1, maximum: 14, description: "Window length in days, default 14" },
            max_price: { type: "number", minimum: 0, description: "Per-person price ceiling in EUR" },
          },
          required: ["origin"],
        },
      }),
  };

  const searchInspiration: ToolDef = {
    name: "search_inspiration",
    description:
      "Theme-based browse when the user has a vibe instead of a destination ('somewhere warm', 'beach holiday', 'city break', 'skiing'). Destinations are matched by theme tags and ranked by cheapest economy price. Use this instead of search_anywhere when the user names a theme.",
    schema: searchInspirationInput,
    run: async (args, _ctx) => {
      const { origin, theme, from_date, days, max_price } = searchInspirationInput.parse(args) as SearchInspirationArgs;
      const tag = THEME_TAGS[theme.trim().toLowerCase()];
      if (tag === undefined) {
        return {
          error: `Unknown theme "${theme}". Supported themes: beach (also 'warm', 'sun'), city break (also 'culture'), skiing (also 'ski', 'snow').`,
        };
      }
      await releaseExpiredHolds(db);
      const originCodes = await resolveCodes(db, origin);
      if (originCodes.length === 0) return { destinations: [], theme, searched: { origin: originCodes, theme } };
      const airports = await allAirports(db);
      const themeCodes = airports.filter((a) => a.tags.includes(tag)).map((a) => a.iata);
      if (themeCodes.length === 0) {
        return {
          theme,
          error: `No destinations in the dataset match the theme "${theme}". Supported themes: beach, city break, skiing.`,
        };
      }
      const start = from_date ?? isoDay(new Date());
      const windowDays = days ?? 14;
      const destinations = await browseDestinations(originCodes, themeCodes, start, windowDays, max_price);
      return {
        theme,
        searched: { origin: originCodes, from_date: start, days: windowDays, max_price: max_price ?? null },
        destinations: destinations.slice(0, 10),
      };
    },
    toOllamaSchema: () =>
      toolToOllamaSchema({
        name: "search_inspiration",
        description: searchInspiration.description,
        parameters: {
          type: "object",
          properties: {
            origin: { type: "string", description: "IATA code or city name" },
            theme: { type: "string", description: "beach/warm, city break, or skiing" },
            from_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Window start, ISO YYYY-MM-DD; defaults to today" },
            days: { type: "integer", minimum: 1, maximum: 14, description: "Window length in days, default 14" },
            max_price: { type: "number", minimum: 0, description: "Per-person price ceiling in EUR" },
          },
          required: ["origin", "theme"],
        },
      }),
  };

  const filterOffers: ToolDef = {
    name: "filter_offers",
    description:
      "Narrow the results of the last search_flights call in this conversation without re-querying: filter by per-person price ceiling and departure time window, and re-sort. Use for 'cheaper', 'not before noon', 'show fastest first'. After a round-trip search, pass leg: 'return' to refine the return leg (default filters the outbound leg).",
    schema: filterOffersInput,
    run: async (args, ctx) => {
      const { max_price, depart_after, depart_before, sort, leg: legFilter } = filterOffersInput.parse(args) as FilterOffersArgs;
      if (!ctx.sessionId) {
        return { error: "filter_offers needs a session; run search_flights first." };
      }
      const pinned = pinnedBySession.get(ctx.sessionId);
      if (!pinned || pinned.length === 0) {
        return { error: "No recent search to filter in this conversation. Run search_flights first." };
      }
      const leg: PinnedLeg = legFilter ?? "outbound";
      const legPool = pinned.filter((offer) => (offer.leg ?? "outbound") === leg);
      const filters = { max_price: max_price ?? null, depart_after: depart_after ?? null, depart_before: depart_before ?? null, sort: sort ?? "best", leg };
      if (legPool.length === 0) {
        return {
          results: [],
          filters,
          note: leg === "return" ? "The last search has no return leg. Run search_flights with return_date first." : "Nothing matches these filters. Suggest relaxing one of them or searching different dates.",
        };
      }
      const filtered = legPool.filter((offer) => {
        if (max_price !== undefined && offer.base_price > max_price) return false;
        const time = offer.departs_at.slice(11, 16);
        if (depart_after !== undefined && time < depart_after) return false;
        if (depart_before !== undefined && time > depart_before) return false;
        return true;
      });
      if (filtered.length === 0) {
        return {
          results: [],
          filters,
          note: "Nothing matches these filters. Suggest relaxing one of them or searching different dates.",
        };
      }
      const sorted =
        sort === "cheapest"
          ? [...filtered].sort((a, b) => a.base_price - b.base_price)
          : sort === "fastest"
            ? [...filtered].sort(
                (a, b) =>
                  durationMinutes(a.departs_at, a.arrives_at) - durationMinutes(b.departs_at, b.arrives_at) ||
                  a.base_price - b.base_price,
              )
            : [...filtered].sort((a, b) => {
                const score = (o: PinnedOffer) =>
                  o.base_price / 100 + durationMinutes(o.departs_at, o.arrives_at) / 200 + (100 - o.on_time_pct) / 100;
                return score(a) - score(b);
              });
      return {
        results: sorted.map((offer) => ({
          flight_id: offer.flight_id,
          flight_no: offer.flight_no,
          leg: offer.leg ?? "outbound",
          origin: offer.origin,
          destination: offer.destination,
          departs_at: offer.departs_at,
          arrives_at: offer.arrives_at,
          duration_minutes: durationMinutes(offer.departs_at, offer.arrives_at),
          base_price: offer.base_price,
          on_time_pct: offer.on_time_pct,
        })),
        filters,
      };
    },
    toOllamaSchema: () =>
      toolToOllamaSchema({
        name: "filter_offers",
        description: filterOffers.description,
        parameters: {
          type: "object",
          properties: {
            max_price: { type: "number", minimum: 0, description: "Per-person price ceiling in EUR" },
            depart_after: { type: "string", pattern: "^\\d{2}:\\d{2}$", description: "Earliest departure, HH:MM UTC" },
            depart_before: { type: "string", pattern: "^\\d{2}:\\d{2}$", description: "Latest departure, HH:MM UTC" },
            sort: { type: "string", enum: ["best", "cheapest", "fastest"] },
            leg: { type: "string", enum: ["outbound", "return"], description: "Which leg of a round-trip search to filter; default outbound" },
          },
          required: [],
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

  return [
    searchFlights,
    findFirstAvailableFlight,
    getFlightDetails,
    listAvailableSeats,
    searchFlexiblePrices,
    searchAnywhere,
    searchInspiration,
    filterOffers,
    listMyBookings,
  ];
}
