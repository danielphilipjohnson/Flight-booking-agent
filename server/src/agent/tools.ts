import { z } from "zod";
import { pool } from "../db/postgres.ts";
import { resolveAirports, type AirportRowLite } from "./airports.ts";
import { dateWindow, dayEndUtc, dayStartUtc, hhmmUtc, isoDay, parseHhmm, parseIsoDate } from "./dates.ts";
import { rankOffers, type FareBrand, type Offer, type Shortlist, type UpgradePick } from "./shortlist.ts";

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

const OFFER_TTL_MINUTES = 15;
const UPGRADE_MAX_DELTA = 150;

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
  airline_code: string;
  airline_name: string;
  on_time_pct: string;
  fare_brand: string;
  carry_on: boolean;
  checked_bags: number;
  refundable: boolean;
  changeable: boolean;
  change_fee: string;
  min_price: string;
  seats_available: string;
  window_available: boolean;
}

const FLIGHT_AGG_SQL = `
  SELECT f.id, f.flight_no, f.departs_at, f.arrives_at,
         o.iata AS origin, o.city AS origin_city,
         d.iata AS destination, d.city AS destination_city,
         al.code AS airline_code, al.name AS airline_name,
         f.on_time_pct,
         (ARRAY_AGG(s.fare_brand ORDER BY s.price) FILTER (WHERE s.status = 'available'))[1] AS fare_brand,
         (ARRAY_AGG(fr.carry_on ORDER BY s.price) FILTER (WHERE s.status = 'available'))[1] AS carry_on,
         (ARRAY_AGG(fr.checked_bags ORDER BY s.price) FILTER (WHERE s.status = 'available'))[1] AS checked_bags,
         (ARRAY_AGG(fr.refundable ORDER BY s.price) FILTER (WHERE s.status = 'available'))[1] AS refundable,
         (ARRAY_AGG(fr.changeable ORDER BY s.price) FILTER (WHERE s.status = 'available'))[1] AS changeable,
         (ARRAY_AGG(fr.change_fee ORDER BY s.price) FILTER (WHERE s.status = 'available'))[1] AS change_fee,
         MIN(s.price) FILTER (WHERE s.status = 'available') AS min_price,
         COUNT(*) FILTER (WHERE s.status = 'available') AS seats_available,
         BOOL_OR(s.status = 'available' AND s.seat_no ~ '[AF]$') AS window_available
  FROM flight f
  JOIN seat s ON s.flight_id = f.id AND s.class = $3
  JOIN airport o ON o.iata = f.origin
  JOIN airport d ON d.iata = f.destination
  JOIN airline al ON al.code = f.airline_code
  JOIN fare_rule fr ON fr.brand = s.fare_brand
  WHERE f.origin = ANY($1) AND f.destination = ANY($2)
    AND f.departs_at >= $4 AND f.departs_at < $5
  GROUP BY f.id, o.iata, o.city, d.iata, d.city, al.code, al.name, f.on_time_pct
  HAVING COUNT(*) FILTER (WHERE s.status = 'available') >= $6`;

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
    airline_code: row.airline_code,
    airline_name: row.airline_name,
    fare_brand: row.fare_brand as FareBrand,
    carry_on: row.carry_on,
    checked_bags: Number(row.checked_bags),
    refundable: row.refundable,
    changeable: row.changeable,
    change_fee: Number(row.change_fee),
    on_time_pct: Number(row.on_time_pct),
    seats_available: Number(row.seats_available),
    window_available: row.window_available,
    expires_at: new Date(Date.now() + OFFER_TTL_MINUTES * 60_000).toISOString(),
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
    note: "Prices are demo data in EUR for the cheapest available seat in the requested cabin; bags and refundability describe that seat's fare brand; seat inventory is as of this search.",
  };
}

async function cheapestBusinessUpgrade(
  originIatas: string[],
  destIatas: string[],
  start: Date,
  end: Date,
  referencePrice: number,
): Promise<UpgradePick | null> {
  const result = await pool.query<FlightRowAgg>(
    `${FLIGHT_AGG_SQL} ORDER BY min_price ASC LIMIT 1`,
    [originIatas, destIatas, "business", start, end, 1],
  );
  const row = result.rows[0];
  if (!row) return null;
  const offer = toOffer(row, 1, "business");
  const delta = Math.round((offer.price_per_person - referencePrice) * 100) / 100;
  if (delta <= 0 || delta > UPGRADE_MAX_DELTA) return null;
  return { offer, delta_per_person: delta };
}

async function searchOffersForWindow(
  originIatas: string[],
  destIatas: string[],
  cabin: "economy" | "business",
  start: Date,
  end: Date,
  passengers: number,
): Promise<Offer[]> {
  const result = await pool.query<FlightRowAgg>(
    `${FLIGHT_AGG_SQL} ORDER BY f.departs_at`,
    [originIatas, destIatas, cabin, start, end, passengers],
  );
  return result.rows.map((row) => toOffer(row, passengers, cabin));
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

const pinnedOffers = new Map<string, Offer[]>();

const MAX_PINNED_SESSIONS = 200;

export function setPinnedOffers(sessionId: string, offers: Offer[]): void {
  while (pinnedOffers.size >= MAX_PINNED_SESSIONS && !pinnedOffers.has(sessionId)) {
    const oldest = pinnedOffers.keys().next().value;
    if (oldest === undefined) break;
    pinnedOffers.delete(oldest);
  }
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

interface DestinationRow {
  destination: string;
  city: string;
  country: string;
  min_price_per_person: number;
  flights_available: number;
  next_departure: string;
}

async function browseDestinations(
  originIatas: string[],
  destIatas: string[] | null,
  start: string,
  days: number,
  maxPrice: number | undefined,
): Promise<DestinationRow[]> {
  const window = dateWindow(start, days);
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
     WHERE f.origin = ANY($1)
       AND ($4::text IS NULL OR f.destination = ANY($4))
       AND f.departs_at >= $2 AND f.departs_at < $3
     GROUP BY f.destination, d.city, d.country
     HAVING MIN(s.price) FILTER (WHERE s.status = 'available') IS NOT NULL
     ORDER BY min_price`,
    [originIatas, window.start, window.end, destIatas],
  );
  return result.rows
    .map((row) => ({
      destination: row.destination,
      city: row.city,
      country: row.country,
      min_price_per_person: Number(row.min_price),
      flights_available: Number(row.flights),
      next_departure: isoDay(row.next_departure),
    }))
    .filter((d) => maxPrice === undefined || d.min_price_per_person <= maxPrice);
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
        "Search direct flights for one specific date (optionally with a return date for a round trip). Origin and destination accept cities or IATA codes; multi-airport cities are searched across all their airports. Returns a ranked shortlist (best, cheapest, fastest) plus a business-class upgrade pick when one is close in price.",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "Origin city or IATA code" },
          destination: { type: "string", description: "Destination city or IATA code" },
          date: { type: "string", description: "Departure date, ISO YYYY-MM-DD" },
          return_date: { type: "string", description: "Return date for round trips, ISO YYYY-MM-DD; omit for one-way" },
          passengers: { type: "integer", minimum: 1, maximum: 6, description: "Default 1" },
          cabin: { type: "string", enum: ["economy", "business"], description: "Default economy" },
        },
        required: ["origin", "destination", "date"],
      },
      schema: z.object({
        origin: z.string().min(1),
        destination: z.string().min(1),
        date: isoDateSchema,
        return_date: isoDateSchema.optional(),
        passengers: passengerSchema,
        cabin: cabinSchema,
      }),
      async run(args, ctx) {
        const { origin, destination, date, return_date, passengers, cabin } = args as {
          origin: string;
          destination: string;
          date: string;
          return_date?: string;
          passengers: number;
          cabin: "economy" | "business";
        };
        const rows = await airportRows();
        const originSet = resolveSet(rows, origin);
        if ("error" in originSet) return originSet;
        const destSet = resolveSet(rows, destination);
        if ("error" in destSet) return destSet;

        const outbound = await searchOffersForWindow(
          originSet.iatas, destSet.iatas, cabin, dayStartUtc(date), dayEndUtc(date), passengers,
        );

        if (return_date === undefined) {
          if (outbound.length === 0) {
            return {
              trip: "one-way",
              total_results: 0,
              query: { origin: originSet.label, destination: destSet.label, date, passengers, cabin },
              suggestions: await nearbySuggestions(originSet.iatas, destSet.iatas, date, passengers, cabin),
            };
          }
          pinOffers(ctx.sessionId, outbound);
          const referencePrice = Math.min(...outbound.map((o) => o.price_per_person));
          const upgrade =
            cabin === "economy"
              ? await cheapestBusinessUpgrade(originSet.iatas, destSet.iatas, dayStartUtc(date), dayEndUtc(date), referencePrice)
              : null;
          return {
            trip: "one-way",
            query: { origin: originSet.label, destination: destSet.label, date, passengers, cabin },
            upgrade,
            ...shortlistPayload(outbound),
          };
        }

        const returnOffers = await searchOffersForWindow(
          destSet.iatas, originSet.iatas, cabin, dayStartUtc(return_date), dayEndUtc(return_date), passengers,
        );

        if (outbound.length === 0 || returnOffers.length === 0) {
          const emptyLeg = outbound.length === 0 ? "outbound" : "return";
          return {
            trip: "round-trip",
            total_results: 0,
            empty_leg: emptyLeg,
            query: { origin: originSet.label, destination: destSet.label, date, return_date, passengers, cabin },
            suggestions:
              emptyLeg === "outbound"
                ? await nearbySuggestions(originSet.iatas, destSet.iatas, date, passengers, cabin)
                : await nearbySuggestions(destSet.iatas, originSet.iatas, return_date, passengers, cabin),
          };
        }

        pinOffers(ctx.sessionId, outbound);
        const cheapestOut = Math.min(...outbound.map((o) => o.price_per_person));
        const cheapestRet = Math.min(...returnOffers.map((o) => o.price_per_person));
        const totalFrom = Math.round((cheapestOut + cheapestRet) * 100) / 100;
        const upgrade =
          cabin === "economy"
            ? await cheapestBusinessUpgrade(originSet.iatas, destSet.iatas, dayStartUtc(date), dayEndUtc(date), cheapestOut)
            : null;
        return {
          trip: "round-trip",
          query: { origin: originSet.label, destination: destSet.label, date, return_date, passengers, cabin },
          upgrade,
          outbound: shortlistPayload(outbound),
          return: shortlistPayload(returnOffers),
          total_from: {
            price_per_person: totalFrom,
            price_total: Math.round(totalFrom * passengers * 100) / 100,
            currency: "EUR",
            note: "cheapest outbound + cheapest return; filter_offers refines the outbound leg",
          },
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
        const offers = await searchOffersForWindow(originSet.iatas, destSet.iatas, cabin, window.start, window.end, passengers);
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
        const daySummaries = [...byDay.entries()]
          .map(([day, dayOffers]) => ({
            date: day,
            min_price_per_person: Math.min(...dayOffers.map((o) => o.price_per_person)),
            flights_available: dayOffers.length,
          }))
          .sort((a, b) => a.date.localeCompare(b.date));
        const referencePrice = Math.min(...offers.map((o) => o.price_per_person));
        const upgrade =
          cabin === "economy"
            ? await cheapestBusinessUpgrade(originSet.iatas, destSet.iatas, window.start, window.end, referencePrice)
            : null;
        return {
          query: { origin: originSet.label, destination: destSet.label, from_date, to_date, passengers, cabin },
          days: daySummaries,
          cheapest_day: daySummaries.reduce((a, b) => (a.min_price_per_person <= b.min_price_per_person ? a : b)),
          upgrade,
          ...shortlistPayload(offers),
        };
      },
    },
    {
      name: "search_anywhere",
      description:
        "Browse mode for users without a destination: cheapest reachable destinations from an origin over a date window, sorted by price. Use for queries like 'where can I go for under 300' when the user gives no theme.",
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
      async run(args) {
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
        const destinations = await browseDestinations(originSet.iatas, null, start, days, max_price);
        if (destinations.length === 0) {
          return {
            total_results: 0,
            query: { origin: originSet.label, from_date: start, to_date: window.to, max_price },
            note: "No destination within budget in the window. Suggest a higher budget or a different date range.",
          };
        }
        return {
          query: { origin: originSet.label, from_date: start, to_date: window.to, max_price },
          total_results: destinations.length,
          destinations: destinations.slice(0, 10),
          note: "Prices are demo data in EUR for the cheapest economy seat in the window. After the user picks a destination, follow up with search_flight_offers or search_flexible_dates for exact dates.",
        };
      },
    },
    {
      name: "search_inspiration",
      description:
        "Theme-based browse for users with a vibe instead of a destination: 'somewhere warm', 'beach holiday', 'city break'. Filters destinations by theme and ranks by price. Use instead of search_anywhere when the user names a theme.",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "Origin city or IATA code" },
          theme: { type: "string", description: "Theme: beach/warm, city break, or skiing" },
          from_date: { type: "string", description: "Window start, ISO YYYY-MM-DD; defaults to today" },
          days: { type: "integer", minimum: 1, maximum: 14, description: "Window length in days, default 14" },
          max_price: { type: "number", minimum: 0, description: "Optional per-person price ceiling in EUR" },
        },
        required: ["origin", "theme"],
      },
      schema: z.object({
        origin: z.string().min(1),
        theme: z.string().min(1),
        from_date: isoDateSchema.optional(),
        days: z.number().int().min(1).max(14).default(14),
        max_price: z.number().min(0).optional(),
      }),
      async run(args) {
        const { origin, theme, from_date, days, max_price } = args as {
          origin: string;
          theme: string;
          from_date?: string;
          days: number;
          max_price?: number;
        };
        const tag = THEME_TAGS[theme.trim().toLowerCase()];
        if (tag === undefined) {
          return toolError(
            `Unknown theme "${theme}". Supported themes: beach (also 'warm', 'sun'), city break (also 'culture'), skiing (also 'snow', 'ski').`,
          );
        }
        const rows = await airportRows();
        const originSet = resolveSet(rows, origin);
        if ("error" in originSet) return originSet;

        const tagResult = await pool.query<{ iata: string }>(
          "SELECT iata FROM airport WHERE tags LIKE $1",
          [`%${tag}%`],
        );
        const themeIatas = tagResult.rows.map((r) => r.iata);
        if (themeIatas.length === 0) {
          return toolError(`No dataset destinations match the theme "${theme}".`);
        }

        const start = from_date ?? isoDay(new Date());
        const window = dateWindow(start, days);
        const destinations = await browseDestinations(originSet.iatas, themeIatas, start, days, max_price);
        if (destinations.length === 0) {
          return {
            theme,
            total_results: 0,
            query: { origin: originSet.label, from_date: start, to_date: window.to, max_price },
            note: "No theme destination within budget in the window. Suggest a higher budget or a different date range.",
          };
        }
        return {
          theme,
          query: { origin: originSet.label, from_date: start, to_date: window.to, max_price },
          total_results: destinations.length,
          destinations: destinations.slice(0, 10),
          note: "Prices are demo data in EUR for the cheapest economy seat in the window. After the user picks a destination, follow up with search_flight_offers or search_flexible_dates for exact dates.",
        };
      },
    },
    {
      name: "get_fare_details",
      description:
        "Full fare breakdown for one offer from the latest search: airline, fare brand (Basic Economy vs standard vs flex), baggage allowance, refundability, change fees, seat availability. Use when the user asks what's included ('is a carry-on included?') or before they commit to an offer.",
      parameters: {
        type: "object",
        properties: {
          flight_id: { type: "string", description: "flight_id from a search offer" },
          cabin: { type: "string", enum: ["economy", "business"], description: "Cabin of the offer, default economy" },
        },
        required: ["flight_id"],
      },
      schema: z.object({
        flight_id: z.string().uuid(),
        cabin: cabinSchema,
      }),
      async run(args) {
        const { flight_id, cabin } = args as { flight_id: string; cabin: "economy" | "business" };
        const flightResult = await pool.query<{
          flight_no: string;
          origin: string;
          origin_city: string;
          destination: string;
          destination_city: string;
          departs_at: Date;
          arrives_at: Date;
          airline_code: string;
          airline_name: string;
          on_time_pct: string;
        }>(
          `SELECT f.flight_no, o.iata AS origin, o.city AS origin_city,
                  d.iata AS destination, d.city AS destination_city,
                  f.departs_at, f.arrives_at,
                  al.code AS airline_code, al.name AS airline_name, f.on_time_pct
           FROM flight f
           JOIN airport o ON o.iata = f.origin
           JOIN airport d ON d.iata = f.destination
           JOIN airline al ON al.code = f.airline_code
           WHERE f.id = $1`,
          [flight_id],
        );
        const flight = flightResult.rows[0];
        if (!flight) {
          return toolError("Unknown offer (flight_id not found). Use a flight_id from the latest search results.");
        }

        const seatResult = await pool.query<{
          seat_no: string;
          price: string;
          fare_brand: string;
          carry_on: boolean;
          checked_bags: number;
          refundable: boolean;
          changeable: boolean;
          change_fee: string;
          seats_available: string;
          window_available: boolean | null;
        }>(
          `SELECT s.seat_no, s.price, s.fare_brand,
                  fr.carry_on, fr.checked_bags, fr.refundable, fr.changeable, fr.change_fee,
                  (SELECT COUNT(*) FROM seat s2 WHERE s2.flight_id = s.flight_id AND s2.class = $2 AND s2.status = 'available') AS seats_available,
                  (SELECT BOOL_OR(s3.seat_no ~ '[AF]$') FROM seat s3 WHERE s3.flight_id = s.flight_id AND s3.class = $2 AND s3.status = 'available') AS window_available
           FROM seat s
           JOIN fare_rule fr ON fr.brand = s.fare_brand
           WHERE s.flight_id = $1 AND s.class = $2 AND s.status = 'available'
           ORDER BY s.price
           LIMIT 1`,
          [flight_id, cabin],
        );
        const seat = seatResult.rows[0];
        if (!seat) {
          return {
            flight: flightBlock(flight),
            cabin,
            seats_available: 0,
            note: "Sold out in this cabin for this flight. Suggest another offer or another date.",
          };
        }

        return {
          flight: flightBlock(flight),
          cabin,
          cheapest_available_seat: {
            seat_no: seat.seat_no,
            price_per_person: Number(seat.price),
            currency: "EUR",
            fare_brand: seat.fare_brand,
            carry_on_included: seat.carry_on,
            checked_bags_included: Number(seat.checked_bags),
            refundable: seat.refundable,
            changeable: seat.changeable,
            change_fee: Number(seat.change_fee),
          },
          seats_available: Number(seat.seats_available),
          window_available: seat.window_available === true,
          expires_at: new Date(Date.now() + OFFER_TTL_MINUTES * 60_000).toISOString(),
          note: "Fare rules apply to the cheapest available seat; other seats on the flight may carry better fare brands.",
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

  function flightBlock(flight: {
    flight_no: string;
    origin: string;
    origin_city: string;
    destination: string;
    destination_city: string;
    departs_at: Date;
    arrives_at: Date;
    airline_code: string;
    airline_name: string;
    on_time_pct: string;
  }): Record<string, unknown> {
    return {
      flight_no: flight.flight_no,
      origin: flight.origin,
      origin_city: flight.origin_city,
      destination: flight.destination,
      destination_city: flight.destination_city,
      date: isoDay(flight.departs_at),
      departs_at: hhmmUtc(flight.departs_at),
      arrives_at: hhmmUtc(flight.arrives_at),
      duration_minutes: Math.round((flight.arrives_at.getTime() - flight.departs_at.getTime()) / 60_000),
      airline: { code: flight.airline_code, name: flight.airline_name },
      on_time_pct: Number(flight.on_time_pct),
    };
  }

}
