import assert from "node:assert/strict";
import { resolveAirports, type AirportRowLite } from "./airports.ts";
import { addDays, dateWindow, hhmmUtc, isoDay, parseHhmm, parseIsoDate } from "./dates.ts";
import { normalizeToolCalls, stripThinking } from "./ollama.ts";
import { rankOffers, type Offer } from "./shortlist.ts";
import { buildToolDefs, pinnedOfferCount, setPinnedOffers } from "./tools.ts";

let passed = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

function section(title: string): void {
  console.log(`\n# ${title}`);
}

const AIRPORTS: AirportRowLite[] = [
  { iata: "LHR", name: "Heathrow", city: "London", country: "United Kingdom" },
  { iata: "LGW", name: "Gatwick", city: "London", country: "United Kingdom" },
  { iata: "MAN", name: "Manchester", city: "Manchester", country: "United Kingdom" },
  { iata: "LIS", name: "Humberto Delgado", city: "Lisbon", country: "Portugal" },
];

function offer(partial: Partial<Offer>): Offer {
  return {
    flight_id: partial.flight_no ?? "id",
    flight_no: partial.flight_no ?? "FF000",
    origin: "LHR",
    origin_city: "London",
    destination: "LIS",
    destination_city: "Lisbon",
    date: "2026-12-01",
    departs_at: "10:00",
    arrives_at: "12:30",
    duration_minutes: 150,
    price_per_person: 100,
    price_total: 100,
    currency: "EUR",
    passengers: 1,
    cabin: "economy",
    seats_available: 10,
    window_available: true,
    ...partial,
  };
}

section("airport resolution");
const london = resolveAirports("London", AIRPORTS);
ok(london.exact.length === 0 && london.candidates.length === 2, "multi-airport city yields 2 candidates");
ok(resolveAirports("LHR", AIRPORTS).exact.length === 1, "exact IATA match");
ok(resolveAirports("lhr", AIRPORTS).exact.length === 1, "case-insensitive IATA match");
ok(resolveAirports("lisbon", AIRPORTS).candidates.length === 1, "city name match");
ok(resolveAirports("Japan", AIRPORTS).candidates.length === 0, "unknown place yields no candidates");

section("dates");
ok(parseIsoDate("2026-12-01") !== null, "valid ISO date parses");
ok(parseIsoDate("2026-13-01") === null, "invalid month rejected");
ok(parseIsoDate("tomorrow") === null, "non-ISO date rejected");
ok(parseHhmm("07:30") === 450, "HH:MM parses to minutes");
ok(parseHhmm("25:00") === null, "invalid hour rejected");
ok(addDays("2026-12-01", 3) === "2026-12-04", "addDays adds calendar days");
ok(isoDay(new Date("2026-12-01T23:30:00Z")) === "2026-12-01", "isoDay stays in UTC");
ok(hhmmUtc(new Date("2026-12-01T07:05:00Z")) === "07:05", "hhmmUtc formats padded");

section("shortlist ranking");
const cheapSlow = offer({ flight_no: "SLOW", price_total: 80, duration_minutes: 200, departs_at: "10:00" });
const fastPricey = offer({ flight_no: "FAST", price_total: 120, duration_minutes: 120, departs_at: "12:00" });
const middle = offer({ flight_no: "MID", price_total: 100, duration_minutes: 150, departs_at: "14:00" });
const unsocial = offer({ flight_no: "EARLY", price_total: 85, duration_minutes: 150, departs_at: "04:30" });
const ranked = rankOffers([cheapSlow, fastPricey, middle, unsocial])!;
ok(ranked.cheapest.flight_no === "SLOW", "cheapest is pure price winner");
ok(ranked.fastest.flight_no === "FAST", "fastest is shortest duration");
ok(ranked.best.flight_no === "MID", "best balances price and duration");
ok(ranked.best.flight_no !== "EARLY", "4am departure is penalized unless much cheaper");

const single = rankOffers([cheapSlow])!;
ok(single.best === cheapSlow && single.cheapest === cheapSlow && single.fastest === cheapSlow, "single offer wins all slots");

section("tool schemas");
const tools = buildToolDefs();
const byName = new Map(tools.map((t) => [t.name, t]));
ok(tools.length === 5, "five read tools defined");
ok(
  ["resolve_airport_code", "search_flight_offers", "search_flexible_dates", "search_anywhere", "filter_offers"].every(
    (n) => byName.has(n),
  ),
  "tool names match the phase plan",
);

const search = byName.get("search_flight_offers")!.schema;
const searchArgs = search.safeParse({ origin: "London", destination: "Lisbon", date: "2026-12-01" });
ok(searchArgs.success, "search defaults apply");
if (searchArgs.success) {
  ok(searchArgs.data.passengers === 1 && searchArgs.data.cabin === "economy", "defaults: 1 adult, economy");
}
ok(!search.safeParse({ origin: "LHR", destination: "LIS", date: "tomorrow" }).success, "fuzzy date rejected at schema level");
ok(!search.safeParse({ origin: "LHR", destination: "LIS", date: "2026-12-01", passengers: 0 }).success, "zero passengers rejected");
ok(!search.safeParse({ origin: "LHR", destination: "LIS", date: "2026-12-01", cabin: "first" }).success, "unknown cabin rejected");

const filter = byName.get("filter_offers")!.schema;
ok(!filter.safeParse({ depart_after: "25:00" }).success, "invalid departure time rejected");
const filterArgs = filter.safeParse({ sort: "cheapest" });
ok(filterArgs.success, "empty filter args allowed");

section("filter_offers without a pinned search");
const filterRun = await byName.get("filter_offers")!.run({ sort: "best" }, { sessionId: "no-pins" });
ok(typeof filterRun === "object" && filterRun !== null && "error" in filterRun, "filtering with no recent search returns a recoverable error");
ok(pinnedOfferCount("no-pins") === 0, "no offers pinned for fresh session");

section("ollama message handling");
ok(stripThinking("answer") === "answer", "plain content untouched");
ok(stripThinking("<think>hmm</think>final") === "final", "closed thinking stripped");
ok(stripThinking("<think>only") === "", "unclosed thinking stripped");
const stringArgs = normalizeToolCalls({
  role: "assistant",
  content: "",
  tool_calls: [{ function: { name: "search_flight_offers", arguments: '{"origin":"LHR"}' } }],
});
ok(stringArgs.length === 1 && stringArgs[0]!.function.arguments.origin === "LHR", "string tool arguments parsed");
const brokenArgs = normalizeToolCalls({
  role: "assistant",
  content: "",
  tool_calls: [{ function: { name: "search_flight_offers", arguments: "{oops" } }],
});
ok(brokenArgs.length === 1 && Object.keys(brokenArgs[0]!.function.arguments).length === 0, "malformed arguments degrade to empty object");


section("date windows");
const window7 = dateWindow("2026-12-01", 7);
ok(window7.to === "2026-12-07", "7-day window ends on the 7th day");
ok((window7.end.getTime() - window7.start.getTime()) / 86_400_000 === 7, "window spans exactly the requested days");
const window1 = dateWindow("2026-12-31", 1);
ok(window1.to === "2026-12-31" && window1.end.getTime() > window1.start.getTime(), "single-day window is one day");

section("filter_offers ordering over pinned offers");
const pinned = [
  offer({ flight_no: "A1", price_total: 90, duration_minutes: 180, departs_at: "09:00" }),
  offer({ flight_no: "B2", price_total: 110, duration_minutes: 110, departs_at: "11:00" }),
  offer({ flight_no: "C3", price_total: 130, duration_minutes: 95, departs_at: "13:00" }),
  offer({ flight_no: "D4", price_total: 100, duration_minutes: 150, departs_at: "10:00" }),
  offer({ flight_no: "E5", price_total: 120, duration_minutes: 120, departs_at: "15:00" }),
  offer({ flight_no: "F6", price_total: 140, duration_minutes: 100, departs_at: "16:00" }),
];
setPinnedOffers("rev-pins", pinned);
ok(pinnedOfferCount("rev-pins") === 6, "offers pinned for session");
const defaultRun = (await byName.get("filter_offers")!.run({}, { sessionId: "rev-pins" })) as {
  shortlist: { best: { flight_no: string }; cheapest: { flight_no: string }; fastest: { flight_no: string } };
  alternatives: { flight_no: string }[];
};
ok(defaultRun.shortlist.best.flight_no === "B2", "default ranking balances price and duration");
ok(defaultRun.shortlist.cheapest.flight_no === "A1" && defaultRun.shortlist.fastest.flight_no === "C3", "cheapest and fastest slots unchanged");
ok(
  defaultRun.alternatives.map((o) => o.flight_no).join(",") === "D4,E5,F6",
  "default alternatives are price-ordered",
);
const fastestRun = (await byName.get("filter_offers")!.run({ sort: "fastest" }, { sessionId: "rev-pins" })) as {
  alternatives: { flight_no: string }[];
};
ok(
  fastestRun.alternatives.map((o) => o.flight_no).join(",") === "F6,E5,D4",
  "fastest sort reorders alternatives by duration",
);
const priceCapRun = (await byName.get("filter_offers")!.run({ max_price: 95 }, { sessionId: "rev-pins" })) as {
  total_results: number;
};
ok(priceCapRun.total_results === 1, "max_price filter narrows to one offer");

console.log(`\nall ${passed} agent checks passed`);
