import { z } from "zod";
import { pool } from "../db/postgres.ts";
import { resolveAirports, type AirportRowLite } from "./airports.ts";
import { dateWindow, dayEndUtc, dayStartUtc, hhmmUtc, isoDay, parseHhmm, parseIsoDate } from "./dates.ts";
import { rankOffers, type Offer, type Shortlist } from "./shortlist.ts";

export interface ToolContext {
  sessionId: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  schema: z.ZodTypeAny;
  run(args: unknown, ctx: ToolContext): Promise<unknown>;
}

interface ToolError {
  error: string;
}

const passengerSchema = z.number().int().min(1).max(6).default(1);
const cabinSchema = z.enum(["economy", "business"]).default("economy");
const isoDateSchema = z.string().refine((v) => parseIsoDate(v) !== null, {
  message: "date must be ISO YYYY-MM-DD",
});

function toolError(message: string): ToolError {
  return { error: message };
}

async function airportRows(): Promise<AirportRowLite[]> {
  const result = await pool.query<AirportRowLite>(
    "SELECT iata, name, city, country FROM airport ORDER BY iata",
  );
  return result.rows;
}

function resolveSet(
  rows: AirportRowLite[],
  query: string,
): { iatas: string[]; label: string } | ToolError {
  const { exact, candidates } = resolveAirports(query, rows);
  const matches = exact.length > 0 ? exact : candidates;
  if (matches.length === 0) {
    const known = rows.map((r) => `${r.iata} (${r.city})`).join(", ");
    return toolError(`No airport or city matches "${query}". Known airports: ${known}.`);
  }
  return {
    iatas: matches.map((m) => m.iata),
    label: matches.length === 1 ? matches[0]!.city : matches.map((m) => m.iata).join(" / "),
  };
}

interface FlightRowAgg {
  id: string;
  flight_no: string;
  origin: string;
  origin_city: string;
  destination: string;
  destination_city: string;
  departs_at: Date;
  arrives_at: Date;
  min_price: string;
  seats_available: string;
  window_available: boolean;
}

const FLIGHT_AGG_SQL = `
  SELECT f.id, f.flight_no, f.departs_at, f.arrives_at,
         o.iata AS origin, o.city AS origin_city,
         d.iata AS destination, d.city AS destination_city,
         MIN(s.price) FILTER (WHERE s.status = 'available') AS min_price,
         COUNT(*) FILTER (WHERE s.status = 'available') AS seats_available,
         BOOL_OR(s.status = 'available' AND s.seat_no ~ '[AF]$') AS window_available
  FROM flight f
  JOIN seat s ON s.flight_id = f.id AND s.class = $3
  JOIN airport o ON o.iata = f.origin
  JOIN airport d ON d.iata = f.destination
  WHERE f.origin = ANY($1) AND f.destination = ANY($2)
    AND f.departs_at >= $4 AND f.departs_at < $5
  GROUP BY f.id, o.iata, o.city, d.iata, d.city
  HAVING COUNT(*) FILTER (WHERE s.status = 'available') >= $6
  ORDER BY f.departs_at`;

function toOffer(row: FlightRowAgg, passengers: number, cabin: "economy" | "business"): Offer {
  const pricePerPerson = Number(row.min_price);
  return {
    flight_id: row.id,
    flight_no: row.flight_no,
    origin: row.origin,
    origin_city: row.origin_city,
    destination: row.destination,
    destination_city: row.destination_city,
    date: isoDay(row.departs_at),
    departs_at: hhmmUtc(row.departs_at),
    arrives_at: hhmmUtc(row.arrives_at),
    duration_minutes: Math.round((row.arrives_at.getTime() - row.departs_at.getTime()) / 60_000),
    price_per_person: pricePerPerson,
    price_total: Math.round(pricePerPerson * passengers * 100) / 100,
    currency: "EUR",
    passengers,
    cabin,
    seats_available: Number(row.seats_available),
    window_available: row.window_available,
  };
}

type OfferOrder = (a: Offer, b: Offer) => number;

const byBest: OfferOrder = (a, b) =>
  a.price_total - b.price_total || a.departs_at.localeCompare(b.departs_at);
const byFastest: OfferOrder = (a, b) =>
  a.duration_minutes - b.duration_minutes || a.price_total - b.price_total;

function shortlistPayload(offers: Offer[], order: OfferOrder = byBest): {
  total_results: number;
  shortlist: Shortlist;
  alternatives: Offer[];
  note: string;
} {
  const ranked = rankOffers(offers)!;
  const picked = new Set([ranked.best.flight_id, ranked.cheapest.flight_id, ranked.fastest.flight_id]);
  return {
    total_results: offers.length,
    shortlist: ranked,
    alternatives: [...offers].sort(order).filter((o) => !picked.has(o.flight_id)).slice(0, 5),
    note: "Prices are demo data in EUR for the cheapest available seat in the requested cabin; seat inventory is as of this search.",
  };
}

async function nearbySuggestions(
  originIatas: string[],
  destIatas: string[],
  requestedDate: string,
  passengers: number,
  cabin: "economy" | "business",
): Promise<Record<string, unknown>> {
  const windowStart = dayStartUtc(requestedDate).getTime() - 3 * 86_400_000;
  const windowEnd = dayEndUtc(requestedDate).getTime() + 3 * 86_400_000;
  const from = isoDay(new Date(Math.max(windowStart, Date.now())));
  const to = isoDay(new Date(windowEnd));

  const flexResult = await pool.query<{ day: Date; min_price: string | null }>(
    `SELECT f.departs_at::date AS day, MIN(s.price) FILTER (WHERE s.status = 'available') AS min_price
     FROM flight f
     JOIN seat s ON s.flight_id = f.id AND s.class = $3
     WHERE f.origin = ANY($1) AND f.destination = ANY($2)
       AND f.departs_at >= $4 AND f.departs_at < $5
     GROUP BY day HAVING MIN(s.price) FILTER (WHERE s.status = 'available') IS NOT NULL
     ORDER BY day`,
    [originIatas, destIatas, cabin, dayStartUtc(from), dayEndUtc(to)],
  );

  const anywhereResult = await pool.query<{ destination: string; city: string; country: string; min_price: string | null }>(
    `SELECT f.destination, d.city AS city, d.country AS country,
            MIN(s.price) FILTER (WHERE s.status = 'available') AS min_price
     FROM flight f
     JOIN seat s ON s.flight_id = f.id AND s.class = 'economy'
     JOIN airport d ON d.iata = f.destination
     WHERE f.origin = ANY($1)
     GROUP BY f.destination, d.city, d.country
     HAVING MIN(s.price) FILTER (WHERE s.status = 'available') IS NOT NULL
     ORDER BY min_price`,
    [originIatas],
  );

  return {
    nearby_dates: flexResult.rows
      .filter((r) => r.min_price !== null)
      .map((r) => ({ date: isoDay(r.day), min_price_per_person: Number(r.min_price) })),
    reachable_destinations: anywhereResult.rows.map((r) => ({
      destination: r.destination,
      city: r.city,
      country: r.country,
      min_price_from_origin: Number(r.min_price),
    })),
    passengers,
    cabin,
  };
}

const pinnedOffers = new Map<string, Offer[]>();

export function setPinnedOffers(sessionId: string, offers: Offer[]): void {
  pinnedOffers.set(sessionId, offers);
}

function pinOffers(sessionId: string, offers: Offer[]): void {
  setPinnedOffers(sessionId, offers);
}

export function pinnedOfferCount(sessionId: string): number {
  return pinnedOffers.get(sessionId)?.length ?? 0;
}

export function clearPinnedOffers(sessionId: string): void {
  pinnedOffers.delete(sessionId);
}

export function buildToolDefs(): ToolDef[] {
  return [
    {
      name: "resolve_airport_code",
      description:
        "Resolve a city, airport name, country or IATA code to dataset airports. Use when unsure which airports a place maps to; each result notes its city so multi-airport cities are visible.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "City, airport name, country or IATA code" },
        },
        required: ["query"],
      },
      schema: z.object({ query: z.string().min(1) }),
      async run(args) {
        const { query } = args as { query: string };
        const rows = await airportRows();
        const { exact, candidates } = resolveAirports(query, rows);
        const matches = exact.length > 0 ? exact : candidates;
        if (matches.length === 0) {
          return toolError(
            `No airport or city matches "${query}". Known airports: ${rows
              .map((r) => `${r.iata} (${r.city})`)
              .join(", ")}.`,
          );
        }
        return {
          query,
          matches: matches.map((m) => ({
            iata: m.iata,
            name: m.name,
            city: m.city,
            country: m.country,
          })),
        };
      },
    },
    {
      name: "search_flight_offers",
      description:
        "Search direct flights for one specific date. Origin and destination accept cities or IATA codes; multi-airport cities are searched across all their airports. Returns a ranked shortlist (best, cheapest, fastest).",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "Origin city or IATA code" },
          destination: { type: "string", description: "Destination city or IATA code" },
          date: { type: "string", description: "Departure date, ISO YYYY-MM-DD" },
          passengers: { type: "integer", minimum: 1, maximum: 6, description: "Default 1" },
          cabin: { type: "string", enum: ["economy", "business"], description: "Default economy" },
        },
        required: ["origin", "destination", "date"],
      },
      schema: z.object({
        origin: z.string().min(1),
        destination: z.string().min(1),
        date: isoDateSchema,
        passengers: passengerSchema,
        cabin: cabinSchema,
      }),
      async run(args, ctx) {
        const { origin, destination, date, passengers, cabin } = args as {
          origin: string;
          destination: string;
          date: string;
          passengers: number;
          cabin: "economy" | "business";
        };
        const rows = await airportRows();
        const originSet = resolveSet(rows, origin);
        if ("error" in originSet) return originSet;
        const destSet = resolveSet(rows, destination);
        if ("error" in destSet) return destSet;

        const result = await pool.query<FlightRowAgg>(
          FLIGHT_AGG_SQL,
          [originSet.iatas, destSet.iatas, cabin, dayStartUtc(date), dayEndUtc(date), passengers],
        );
        const offers = result.rows.map((row) => toOffer(row, passengers, cabin));
        if (offers.length === 0) {
          return {
            total_results: 0,
            query: { origin: originSet.label, destination: destSet.label, date, passengers, cabin },
            suggestions: await nearbySuggestions(originSet.iatas, destSet.iatas, date, passengers, cabin),
          };
        }
        pinOffers(ctx.sessionId, offers);
        return {
          query: { origin: originSet.label, destination: destSet.label, date, passengers, cabin },
          ...shortlistPayload(offers),
        };
      },
    },
    {
      name: "search_flexible_dates",
      description:
        "Find the cheapest day to fly between an origin and destination over a date window. Use when the user is vague about dates ('next week', 'around the 14th').",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "Origin city or IATA code" },
          destination: { type: "string", description: "Destination city or IATA code" },
          from_date: { type: "string", description: "Window start, ISO YYYY-MM-DD" },
          days: { type: "integer", minimum: 1, maximum: 14, description: "Window length in days, default 7" },
          passengers: { type: "integer", minimum: 1, maximum: 6, description: "Default 1" },
          cabin: { type: "string", enum: ["economy", "business"], description: "Default economy" },
        },
        required: ["origin", "destination", "from_date"],
      },
      schema: z.object({
        origin: z.string().min(1),
        destination: z.string().min(1),
        from_date: isoDateSchema,
        days: z.number().int().min(1).max(14).default(7),
        passengers: passengerSchema,
        cabin: cabinSchema,
      }),
      async run(args, ctx) {
        const { origin, destination, from_date, days, passengers, cabin } = args as {
          origin: string;
          destination: string;
          from_date: string;
          days: number;
          passengers: number;
          cabin: "economy" | "business";
        };
        const rows = await airportRows();
        const originSet = resolveSet(rows, origin);
        if ("error" in originSet) return originSet;
        const destSet = resolveSet(rows, destination);
        if ("error" in destSet) return destSet;

        const window = dateWindow(from_date, days);
        const to_date = window.to;
        const result = await pool.query<FlightRowAgg>(
          FLIGHT_AGG_SQL,
          [originSet.iatas, destSet.iatas, cabin, window.start, window.end, passengers],
        );
        const offers = result.rows.map((row) => toOffer(row, passengers, cabin));
        if (offers.length === 0) {
          return {
            total_results: 0,
            query: { origin: originSet.label, destination: destSet.label, from_date, to_date, passengers, cabin },
            suggestions: await nearbySuggestions(originSet.iatas, destSet.iatas, from_date, passengers, cabin),
          };
        }
        pinOffers(ctx.sessionId, offers);
        const byDay = new Map<string, Offer[]>();
        for (const offer of offers) {
          const bucket = byDay.get(offer.date);
          if (bucket) bucket.push(offer);
          else byDay.set(offer.date, [offer]);
        }
        const days_ = [...byDay.entries()]
          .map(([day, dayOffers]) => ({
            date: day,
            min_price_per_person: Math.min(...dayOffers.map((o) => o.price_per_person)),
            flights_available: dayOffers.length,
          }))
          .sort((a, b) => a.date.localeCompare(b.date));
        return {
          query: { origin: originSet.label, destination: destSet.label, from_date, to_date, passengers, cabin },
          days: days_,
          cheapest_day: days_.reduce((a, b) => (a.min_price_per_person <= b.min_price_per_person ? a : b)),
          ...shortlistPayload(offers),
        };
      },
    },
    {
      name: "search_anywhere",
      description:
        "Browse mode for users without a destination: cheapest reachable destinations from an origin over a date window, sorted by price. Use for queries like 'where can I go for under 300'.",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "Origin city or IATA code" },
          from_date: { type: "string", description: "Window start, ISO YYYY-MM-DD; defaults to today" },
          days: { type: "integer", minimum: 1, maximum: 14, description: "Window length in days, default 14" },
          max_price: { type: "number", minimum: 0, description: "Optional per-person price ceiling in EUR" },
        },
        required: ["origin"],
      },
      schema: z.object({
        origin: z.string().min(1),
        from_date: isoDateSchema.optional(),
        days: z.number().int().min(1).max(14).default(14),
        max_price: z.number().min(0).optional(),
      }),
      async run(args, ctx) {
        const { origin, from_date, days, max_price } = args as {
          origin: string;
          from_date?: string;
          days: number;
          max_price?: number;
        };
        const rows = await airportRows();
        const originSet = resolveSet(rows, origin);
        if ("error" in originSet) return originSet;

        const start = from_date ?? isoDay(new Date());
        const window = dateWindow(start, days);
        const to_date = window.to;
        const result = await pool.query<{
          destination: string;
          city: string;
          country: string;
          min_price: string | null;
          flights: string;
          next_departure: Date;
        }>(
          `SELECT f.destination, d.city AS city, d.country AS country,
                  MIN(s.price) FILTER (WHERE s.status = 'available') AS min_price,
                  COUNT(DISTINCT f.id) AS flights,
                  MIN(f.departs_at) AS next_departure
           FROM flight f
           JOIN seat s ON s.flight_id = f.id AND s.class = 'economy'
           JOIN airport d ON d.iata = f.destination
           WHERE f.origin = ANY($1) AND f.departs_at >= $2 AND f.departs_at < $3
           GROUP BY f.destination, d.city, d.country
           HAVING MIN(s.price) FILTER (WHERE s.status = 'available') IS NOT NULL
           ORDER BY min_price`,
          [originSet.iatas, window.start, window.end],
        );
        const destinations = result.rows
          .map((row) => ({
            destination: row.destination,
            city: row.city,
            country: row.country,
            min_price_per_person: Number(row.min_price),
            flights_available: Number(row.flights),
            next_departure: isoDay(row.next_departure),
          }))
          .filter((d) => max_price === undefined || d.min_price_per_person <= max_price);
        if (destinations.length === 0) {
          return {
            total_results: 0,
            query: { origin: originSet.label, from_date: start, to_date, max_price },
            note: "No destination within budget in the window. Suggest a higher budget or a different date range.",
          };
        }
        return {
          query: { origin: originSet.label, from_date: start, to_date, max_price },
          total_results: destinations.length,
          destinations: destinations.slice(0, 10),
          note: "Prices are demo data in EUR for the cheapest economy seat in the window. After the user picks a destination, follow up with search_flight_offers or search_flexible_dates for exact dates.",
        };
      },
    },
    {
      name: "filter_offers",
      description:
        "Refine the last search in this conversation without re-querying: filter by max total price and departure time window, and re-rank. Use when the user says 'cheaper', 'not before noon', 'nonstop only' (all flights are nonstop), etc.",
      parameters: {
        type: "object",
        properties: {
          max_price: { type: "number", minimum: 0, description: "Maximum total price for the party, EUR" },
          depart_after: { type: "string", description: "Earliest departure, HH:MM UTC" },
          depart_before: { type: "string", description: "Latest departure, HH:MM UTC" },
          sort: { type: "string", enum: ["best", "cheapest", "fastest"], description: "Ranking for the shortlist, default best" },
        },
        required: [],
      },
      schema: z.object({
        max_price: z.number().min(0).optional(),
        depart_after: z.string().refine((v) => parseHhmm(v) !== null, { message: "must be HH:MM" }).optional(),
        depart_before: z.string().refine((v) => parseHhmm(v) !== null, { message: "must be HH:MM" }).optional(),
        sort: z.enum(["best", "cheapest", "fastest"]).default("best"),
      }),
      async run(args, ctx) {
        const { max_price, depart_after, depart_before, sort } = args as {
          max_price?: number;
          depart_after?: string;
          depart_before?: string;
          sort: "best" | "cheapest" | "fastest";
        };
        const pinned = pinnedOffers.get(ctx.sessionId);
        if (!pinned || pinned.length === 0) {
          return toolError(
            "No recent search to filter in this conversation. Run search_flight_offers or search_flexible_dates first.",
          );
        }
        const after = depart_after === undefined ? undefined : (parseHhmm(depart_after) ?? undefined);
        const before = depart_before === undefined ? undefined : (parseHhmm(depart_before) ?? undefined);
        const filtered = pinned.filter((offer) => {
          if (max_price !== undefined && offer.price_total > max_price) return false;
          const minutes = Number(offer.departs_at.slice(0, 2)) * 60 + Number(offer.departs_at.slice(3, 5));
          if (after !== undefined && minutes < after) return false;
          if (before !== undefined && minutes > before) return false;
          return true;
        });
        if (filtered.length === 0) {
          return {
            total_results: 0,
            filters: { max_price, depart_after, depart_before },
            note: "Nothing matches these filters. Suggest relaxing one of them, or re-run search_flight_offers for nearby dates.",
          };
        }
        const order = sort === "fastest" ? byFastest : byBest;
        return {
          filters: { max_price, depart_after, depart_before, sort },
          ...shortlistPayload(filtered, order),
        };
      },
    },
  ];
}
