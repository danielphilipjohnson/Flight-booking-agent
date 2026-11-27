import { pingPostgres, pool } from "../db/postgres.ts";
import { mulberry32 } from "../seed/generate.ts";
import { isoDay, parseIsoDate } from "./dates.ts";
import { buildToolDefs, type ToolContext } from "./tools.ts";
import type { Offer } from "./shortlist.ts";

const SEED = Number.parseInt(process.env.FUZZ_SEED ?? "42", 10) || 42;
const ITERATIONS =
  Number.parseInt(process.env.FUZZ_ITERATIONS ?? "200", 10) || 200;

const rng = mulberry32(SEED);
let cases = 0;

function fail(label: string, detail: unknown): never {
  const sample = typeof detail === "string" ? detail.slice(0, 300) : JSON.stringify(detail)?.slice(0, 300);
  throw new Error(`live fuzz failure at seed=${SEED} case=${cases} — ${label}: ${sample}`);
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
  const offset = randInt(-2, offsetRange);
  return isoDay(new Date(Date.now() + offset * 86_400_000));
}

function passengersArg(): number | undefined {
  return rng() < 0.6 ? 1 : randInt(1, 6);
}

function assertShortlistShape(
  result: Record<string, unknown>,
  passengers: number | undefined,
  cabin: string | undefined,
  label: string,
): void {
  const shortlist = result.shortlist as Record<string, Offer> | undefined;
  if (!shortlist) fail(`${label}: shortlist missing despite results`, result);
  for (const slot of ["best", "cheapest", "fastest"] as const) {
    const offer = shortlist![slot]!;
    if (cabin !== undefined && offer.cabin !== cabin) {
      fail(`${label}: ${slot} cabin ${offer.cabin} != requested ${cabin}`, offer);
    }
    if (passengers !== undefined) {
      if (offer.price_total !== Math.round(offer.price_per_person * passengers * 100) / 100) {
        fail(`${label}: ${slot} price_total != price_per_person * passengers`, offer);
      }
      if (offer.seats_available < passengers) {
        fail(`${label}: ${slot} offered with fewer seats than passengers`, offer);
      }
    }
  }
  const cheapest = shortlist!.cheapest!;
  for (const slot of ["best", "fastest"] as const) {
    if (shortlist![slot]!.price_total < cheapest.price_total) {
      fail(`${label}: ${slot} is cheaper than the cheapest pick`, { cheapest, other: shortlist![slot] });
    }
  }
  const fastest = shortlist!.fastest!;
  for (const slot of ["best", "cheapest"] as const) {
    if (shortlist![slot]!.duration_minutes < fastest.duration_minutes) {
      fail(`${label}: ${slot} is faster than the fastest pick`, { fastest, other: shortlist![slot] });
    }
  }
  const alternatives = (result.alternatives ?? []) as Offer[];
  if (alternatives.length > 5) fail(`${label}: alternatives exceed 5`, alternatives.length);
  for (const alternative of alternatives) {
    if (alternative.price_total < cheapest.price_total) {
      fail(`${label}: alternative cheaper than cheapest pick`, alternative);
    }
  }
}

async function main(): Promise<void> {
  if (!(await pingPostgres())) {
    console.error(`Postgres not reachable — start the stack first: docker compose up -d && npm run seed`);
    process.exit(1);
  }

  const tools = buildToolDefs();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const searchTools = ["search_flight_offers", "search_flexible_dates", "search_anywhere", "search_inspiration"] as const;
  let searches = 0;
  let noResults = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    cases++;
    const toolName = pick(searchTools);
    const def = byName.get(toolName)!;
    const sessionId = `fuzz-live-${SEED}-${i}`;
    const ctx: ToolContext = { sessionId };
    const passengers = passengersArg();

    let args: Record<string, unknown>;
    if (toolName === "search_flight_offers") {
      args = { origin: pick(CITIES), destination: pick(CITIES), date: windowDate(15), passengers, cabin: pick(CABINS) };
      if (rng() < 0.25) args.return_date = windowDate(18);
    } else if (toolName === "search_flexible_dates") {
      args = { origin: pick(CITIES), destination: pick(CITIES), from_date: windowDate(8), days: randInt(1, 14), passengers, cabin: pick(CABINS) };
    } else if (toolName === "search_inspiration") {
      args = { origin: pick(CITIES), theme: pick(THEMES), from_date: windowDate(8), days: randInt(1, 14) };
      if (rng() < 0.4) args.max_price = randInt(30, 300);
    } else {
      args = { origin: pick(CITIES), from_date: windowDate(8), days: randInt(1, 14) };
      if (rng() < 0.4) args.max_price = randInt(30, 300);
    }
    if (passengers === undefined) delete args.passengers;
    if (args.cabin === undefined) delete args.cabin;

    const parsed = def.schema.safeParse(args);
    if (!parsed.success) {
      fail(`${toolName}: generated args rejected by own schema`, { args, issues: parsed.error.issues });
    }
    let result: unknown;
    try {
      result = await def.run(parsed.data, ctx);
    } catch (err) {
      fail(`${toolName}.run threw on valid args`, err instanceof Error ? err.message : err);
    }
    const record = result as Record<string, unknown>;

    if (record.error !== undefined) {
      const unknownUsed =
        [args.origin, args.destination].some((value) => value === "Japan" || value === "Tokyo") ||
        args.theme === "ski" ||
        args.theme === "pub crawl";
      if (!unknownUsed) fail(`${toolName}: unexpected error for a known place`, result);
      continue;
    }
    if (record.total_results === 0) {
      noResults++;
      const noteShaped = toolName === "search_anywhere" || toolName === "search_inspiration";
      if (noteShaped) {
        if (record.note === undefined) fail(`${toolName}: no-results payload missing note`, result);
      } else if (record.suggestions === undefined) {
        fail(`${toolName}: no-results payload missing suggestions`, result);
      }
      continue;
    }

    searches++;
    if (toolName === "search_anywhere" || toolName === "search_inspiration") {
      const destinations = record.destinations as { destination: string; min_price_per_person: number; flights_available: number }[];
      if (!destinations || destinations.length === 0) fail("search_anywhere: results without destinations", result);
      for (let d = 1; d < destinations.length; d++) {
        if (destinations[d]!.min_price_per_person < destinations[d - 1]!.min_price_per_person) {
          fail("search_anywhere: destinations not price-sorted", destinations.slice(d - 1, d + 1));
        }
      }
      for (const destination of destinations) {
        if (destination.min_price_per_person <= 0 || destination.flights_available <= 0) {
          fail("search_anywhere: non-positive price or flight count", destination);
        }
      }
      if (args.max_price !== undefined) {
        for (const destination of destinations) {
          if (destination.min_price_per_person > (args.max_price as number)) {
            fail("search_anywhere: destination exceeds max_price", destination);
          }
        }
      }
      continue;
    }

    if ((record as { trip?: string }).trip === "round-trip") {
      const outbound = (record as { outbound: Record<string, unknown> }).outbound;
      const returnLeg = (record as { return: Record<string, unknown> }).return;
      assertShortlistShape(outbound, passengers, (parsed.data as { cabin?: string }).cabin, "round-trip outbound");
      assertShortlistShape(returnLeg, passengers, (parsed.data as { cabin?: string }).cabin, "round-trip return");
      const totalFrom = (record as { total_from: { price_per_person: number; price_total: number } }).total_from;
      const cheapestOut = (outbound.shortlist as { cheapest: Offer }).cheapest.price_per_person;
      const cheapestRet = (returnLeg.shortlist as { cheapest: Offer }).cheapest.price_per_person;
      if (Math.abs(totalFrom.price_per_person - (cheapestOut + cheapestRet)) > 0.01) {
        fail("round-trip: total_from != cheapest outbound + cheapest return", totalFrom);
      }
    } else {
      assertShortlistShape(record, passengers, (parsed.data as { cabin?: string }).cabin, toolName);
    }

    if (toolName === "search_flexible_dates") {
      const days = record.days as { date: string; min_price_per_person: number }[];
      if (!days || days.length === 0) fail("search_flexible_dates: results without per-day breakdown", result);
      const { from_date } = parsed.data as { from_date: string };
      const windowStart = parseIsoDate(from_date)!.date.getTime();
      const windowEnd = windowStart + ((parsed.data as { days: number }).days) * 86_400_000;
      for (const day of days) {
        const parsedDay = parseIsoDate(day.date)!.date.getTime();
        if (parsedDay < windowStart || parsedDay >= windowEnd) {
          fail("search_flexible_dates: day outside requested window", day);
        }
        if (day.min_price_per_person <= 0) fail("search_flexible_dates: non-positive day price", day);
      }
      const cheapestDay = record.cheapest_day as { date: string; min_price_per_person: number };
      const minDay = days.reduce((a, b) => (a.min_price_per_person <= b.min_price_per_person ? a : b));
      if (cheapestDay.date !== minDay.date) fail("search_flexible_dates: cheapest_day is not the minimum", { cheapestDay, minDay });
    }

    if (rng() < 0.2) {
      cases++;
      const fareDef = byName.get("get_fare_details")!;
      const shortlist = (record as { shortlist?: Record<string, Offer> }).shortlist
        ?? (record as { outbound?: { shortlist: Record<string, Offer> } }).outbound?.shortlist;
      const flightId = shortlist?.best?.flight_id;
      if (flightId === undefined) fail("get_fare_details: no offer from search to inspect", result);
      const fareArgs = { flight_id: flightId, cabin: (parsed.data as { cabin?: "economy" | "business" }).cabin ?? "economy" };
      const fareParsed = fareDef.schema.safeParse(fareArgs);
      if (!fareParsed.success) fail("get_fare_details: generated args rejected", fareArgs);
      let fareResult: unknown;
      try {
        fareResult = await fareDef.run(fareParsed.data, ctx);
      } catch (err) {
        fail("get_fare_details.run threw on valid args", err instanceof Error ? err.message : err);
      }
      const fareRecord = fareResult as Record<string, unknown>;
      if (fareRecord.error !== undefined) fail("get_fare_details: error for a known flight_id", fareResult);
      const seat = fareRecord.cheapest_available_seat as Record<string, unknown> | undefined;
      if (seat !== undefined) {
        if (!["basic", "standard", "flex"].includes(String(seat.fare_brand))) {
          fail("get_fare_details: unknown fare brand", seat);
        }
        if (typeof seat.carry_on_included !== "boolean" || typeof seat.refundable !== "boolean") {
          fail("get_fare_details: fare rules missing", seat);
        }
      }
    }

    if (rng() < 0.5) {
      cases++;
      const filterDef = byName.get("filter_offers")!;
      const filterArgs: Record<string, unknown> = {};
      if (rng() < 0.6) filterArgs.max_price = randInt(40, 600);
      if (rng() < 0.4) filterArgs.depart_after = `${String(randInt(5, 12)).padStart(2, "0")}:00`;
      if (rng() < 0.4) filterArgs.depart_before = `${String(randInt(13, 23)).padStart(2, "0")}:00`;
      if (rng() < 0.5) filterArgs.sort = pick(["best", "cheapest", "fastest"]);
      const filterParsed = filterDef.schema.safeParse(filterArgs);
      if (!filterParsed.success) fail("filter_offers: generated args rejected", filterArgs);
      let filterResult: unknown;
      try {
        filterResult = await filterDef.run(filterParsed.data, ctx);
      } catch (err) {
        fail("filter_offers.run threw on valid args", err instanceof Error ? err.message : err);
      }
      const filterRecord = filterResult as Record<string, unknown>;
      if (filterRecord.error !== undefined) fail("filter_offers: error despite pinned search", filterResult);
      if (((filterRecord.total_results as number | undefined) ?? 0) > 0) {
        assertShortlistShape(filterRecord, passengers, (filterParsed.data as { cabin?: string }).cabin, "filter_offers");
      }
    }
  }

  await pool.end();
  console.log(`\nlive fuzz pass: seed=${SEED}, ${cases} cases, ${searches} with results, ${noResults} empty (suggestions provided)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
