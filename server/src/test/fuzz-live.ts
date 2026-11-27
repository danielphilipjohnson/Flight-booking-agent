import { config } from "../config.ts";
import { pingPostgres, pgQueryable, pool } from "../db/postgres.ts";
import { mulberry32 } from "../seed/generate.ts";
import { isoDay } from "../agent/dates.ts";
import { createToolRegistry } from "../tools/registry.ts";
import { setPinnedOffers, clearPinnedOffers } from "../tools/flights.ts";

const SEED = Number.parseInt(process.env.FUZZ_SEED ?? "42", 10) || 42;
const ITERATIONS = Number.parseInt(process.env.FUZZ_ITERATIONS ?? "150", 10) || 150;

const rng = mulberry32(SEED);
let cases = 0;

function fail(label: string, detail: unknown): never {
  const sample = typeof detail === "string" ? detail.slice(0, 300) : JSON.stringify(detail)?.slice(0, 300);
  throw new Error(`live fuzz failure at seed=${SEED} case=${cases} - ${label}: ${sample}`);
}

function randInt(min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(items: readonly T[]): T {
  return items[randInt(0, items.length - 1)]!;
}

const CITIES = ["London", "Manchester", "Lisbon", "Amsterdam", "Barcelona", "Paris", "Madrid", "Japan", "Tokyo"];
const THEMES = ["beach", "warm", "city", "city break", "ski", "pub crawl"];
const CABINS = ["economy", "business"] as const;

function windowDate(offsetRange: number): string {
  return isoDay(new Date(Date.now() + randInt(-2, offsetRange) * 86_400_000));
}

interface FlightResult {
  flight_id: string;
  flight_no: string;
  base_price: unknown;
  on_time_pct?: number;
}

async function main(): Promise<void> {
  if (!(await pingPostgres())) {
    console.error("Postgres not reachable - start the stack first: docker compose up -d && npm run seed");
    process.exit(1);
  }
  const registry = createToolRegistry(pgQueryable, { holdMinutes: config.holdMinutes });
  const byName = (name: string) => registry.tools.find((t) => t.name === name)!;
  let searches = 0;
  let empty = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    cases++;
    const sessionId = `fuzz-live-${SEED}-${i}`;
    clearPinnedOffers(sessionId);
    const ctx = { userRef: "dan", sessionId };
    const tool = pick(["search_flights", "search_flexible_prices", "search_anywhere", "search_inspiration"]);

    let args: Record<string, unknown>;
    let def;
    if (tool === "search_flights") {
      args = { origin: pick(CITIES), destination: pick(CITIES), date: windowDate(15) };
      if (rng() < 0.3) args.return_date = windowDate(18);
      def = byName("search_flights");
    } else if (tool === "search_flexible_prices") {
      args = { origin: pick(CITIES), destination: pick(CITIES), from_date: windowDate(8) };
      if (rng() < 0.5) args.days = randInt(1, 14);
      if (rng() < 0.4) args.class = pick(CABINS);
      def = byName("search_flexible_prices");
    } else if (tool === "search_inspiration") {
      args = { origin: pick(CITIES), theme: pick(THEMES), from_date: windowDate(8) };
      if (rng() < 0.4) args.max_price = randInt(30, 300);
      def = byName("search_inspiration");
    } else {
      args = { origin: pick(CITIES), from_date: windowDate(8) };
      if (rng() < 0.5) args.days = randInt(1, 14);
      if (rng() < 0.4) args.max_price = randInt(30, 300);
      def = byName("search_anywhere");
    }

    const parsed = def.schema.safeParse(args);
    if (!parsed.success) fail(`${tool}: generated args rejected by own schema`, { args, issues: parsed.error.issues });
    let result: unknown;
    try {
      result = await def.run(parsed.data as never, ctx);
    } catch (err) {
      fail(`${tool}.run threw on valid args`, err instanceof Error ? err.message : err);
    }
    const record = result as Record<string, unknown>;
    if (record.error !== undefined) {
      const unknownUsed =
        [args.origin, args.destination].some((v) => v === "Japan" || v === "Tokyo") ||
        args.theme === "ski" ||
        args.theme === "pub crawl";
      if (!unknownUsed) fail(`${tool}: unexpected error for a known place`, result);
      continue;
    }

    if (tool === "search_flights") {
      const results = (record.results ?? []) as FlightResult[];
      const returnResults = record.return_results as FlightResult[] | undefined;
      if (results.length === 0 && (!returnResults || returnResults.length === 0)) {
        empty++;
        if (args.return_date && record.empty_leg === undefined) {
          fail("round-trip: both legs empty but empty_leg missing", result);
        }
        continue;
      }
      searches++;
      if (results.length > 0) {
        for (const flight of results) {
          if (flight.base_price === undefined || flight.base_price === null) {
            fail("search_flights: result missing base_price", flight);
          }
          if (flight.on_time_pct !== undefined && (flight.on_time_pct < 80 || flight.on_time_pct > 99)) {
            fail("search_flights: on_time_pct out of dataset band", flight);
          }
        }
      }
      if (args.return_date && record.empty_leg === undefined && returnResults && returnResults.length > 0) {
        const total = record.round_trip_total_from as number;
        const cheapestOut = Math.min(...results.map((r) => Number(r.base_price)));
        const cheapestRet = Math.min(...returnResults.map((r) => Number(r.base_price)));
        if (Math.abs(total - (cheapestOut + cheapestRet)) > 0.01) {
          fail("round-trip: round_trip_total_from != cheapest outbound + cheapest return", record);
        }
      }
      continue;
    }

    if (tool === "search_flexible_prices") {
      const days = (record.days ?? []) as { date: string; min_price_per_person: number }[];
      if (days.length === 0) {
        empty++;
        continue;
      }
      searches++;
      for (let d = 1; d < days.length; d++) {
        if (days[d]!.date <= days[d - 1]!.date) fail("search_flexible_prices: days not ascending", days.slice(d - 1, d + 1));
        if (days[d]!.min_price_per_person <= 0) fail("search_flexible_prices: non-positive price", days[d]);
      }
      const cheapest = record.cheapest_day as { date: string; min_price_per_person: number };
      const minDay = days.reduce((a, b) => (a.min_price_per_person <= b.min_price_per_person ? a : b));
      if (cheapest.date !== minDay.date) fail("search_flexible_prices: cheapest_day is not the minimum", { cheapest, minDay });
      continue;
    }

    const destinations = (record.destinations ?? []) as { destination: string; min_price_per_person: number; flights_available: number }[];
    if (destinations.length === 0) {
      empty++;
      continue;
    }
    searches++;
    for (let d = 1; d < destinations.length; d++) {
      if (destinations[d]!.min_price_per_person < destinations[d - 1]!.min_price_per_person) {
        fail(`${tool}: destinations not price-sorted`, destinations.slice(d - 1, d + 1));
      }
    }
    for (const destination of destinations) {
      if (destination.min_price_per_person <= 0 || destination.flights_available <= 0) {
        fail(`${tool}: non-positive price or flight count`, destination);
      }
      if (args.max_price !== undefined && destination.min_price_per_person > (args.max_price as number)) {
        fail(`${tool}: destination exceeds max_price`, destination);
      }
    }

    if (rng() < 0.3) {
      cases++;
      const fareDef = byName("get_flight_details");
      const fareParsed = fareDef.schema.safeParse({ flight_id: "00000000-0000-4000-8000-000000000000" });
      if (!fareParsed.success) fail("get_flight_details: valid-uuid args rejected", {});
      const fareResult = (await fareDef.run(fareParsed.data as never, ctx)) as Record<string, unknown>;
      if (fareResult.error === undefined) fail("get_flight_details: unknown uuid did not error", fareResult);
    }

    if (rng() < 0.5 && tool === "search_flights" && (record.results as FlightResult[]).length > 0) {
      cases++;
      const filterDef = byName("filter_offers");
      const filterArgs: Record<string, unknown> = {};
      if (rng() < 0.6) filterArgs.max_price = randInt(40, 600);
      if (rng() < 0.4) filterArgs.depart_after = `${String(randInt(5, 12)).padStart(2, "0")}:00`;
      if (rng() < 0.4) filterArgs.depart_before = `${String(randInt(13, 23)).padStart(2, "0")}:00`;
      if (rng() < 0.5) filterArgs.sort = pick(["best", "cheapest", "fastest"]);
      const filterParsed = filterDef.schema.safeParse(filterArgs);
      if (!filterParsed.success) fail("filter_offers: generated args rejected", filterArgs);
      let filterResult: unknown;
      try {
        filterResult = await filterDef.run(filterParsed.data as never, ctx);
      } catch (err) {
        fail("filter_offers.run threw on valid args", err instanceof Error ? err.message : err);
      }
      const filterRecord = filterResult as Record<string, unknown>;
      if (filterRecord.error !== undefined) fail("filter_offers: error despite pinned search", filterResult);
      for (const offer of (filterRecord.results ?? []) as FlightResult[]) {
        if (filterArgs.max_price !== undefined && Number(offer.base_price) > (filterArgs.max_price as number)) {
          fail("filter_offers: result exceeds max_price", offer);
        }
      }
    }
  }

  await pool.end();
  console.log(`\nlive fuzz pass: seed=${SEED}, ${cases} cases, ${searches} with results, ${empty} empty`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
