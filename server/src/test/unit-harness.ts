import assert from "node:assert/strict";
import { resolveAirports, type AirportRowLite } from "../agent/airports.ts";
import { addDays, dateWindow, hhmmUtc, isoDay, parseHhmm, parseIsoDate } from "../agent/dates.ts";
import { createFlightTools } from "../tools/flights.ts";
import { searchFlightsInput, searchFlexiblePricesInput, searchAnywhereInput, searchInspirationInput, filterOffersInput, getFlightDetailsInput } from "../tools/schemas.ts";
import type { ToolDef } from "../tools/schemas.ts";

let passed = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

const AIRPORTS: (AirportRowLite & { tags: string })[] = [
  { iata: "LHR", name: "Heathrow", city: "London", country: "United Kingdom", tags: "city" },
  { iata: "LGW", name: "Gatwick", city: "London", country: "United Kingdom", tags: "city" },
  { iata: "MAN", name: "Manchester", city: "Manchester", country: "United Kingdom", tags: "city" },
  { iata: "LIS", name: "Humberto Delgado", city: "Lisbon", country: "Portugal", tags: "beach,city" },
];

console.log("\n# airport resolution");
const london = resolveAirports("London", AIRPORTS);
ok(london.exact.length === 0 && london.candidates.length === 2, "multi-airport city yields 2 candidates");
ok(resolveAirports("LHR", AIRPORTS).exact.length === 1, "exact IATA match");
ok(resolveAirports("lhr", AIRPORTS).exact.length === 1, "case-insensitive IATA match");
ok(resolveAirports("Portugal", AIRPORTS).candidates.length === 1, "country match");
ok(resolveAirports("Japan", AIRPORTS).candidates.length === 0, "unknown place yields no candidates");

console.log("\n# dates");
ok(parseIsoDate("2026-12-01") !== null, "valid ISO date parses");
ok(parseIsoDate("2026-13-01") === null, "invalid month rejected");
ok(parseIsoDate("2026-02-30") === null, "impossible calendar date rejected (no rollover)");
ok(parseHhmm("07:30") === 450, "HH:MM parses to minutes");
ok(parseHhmm("25:00") === null, "invalid hour rejected");
ok(addDays("2026-12-01", 3) === "2026-12-04", "addDays adds calendar days");
ok(isoDay(new Date("2026-12-01T23:30:00Z")) === "2026-12-01", "isoDay stays in UTC");
ok(hhmmUtc(new Date("2026-12-01T07:05:00Z")) === "07:05", "hhmmUtc formats padded");

console.log("\n# date windows");
const window7 = dateWindow("2026-12-01", 7);
ok(window7.to === "2026-12-07", "7-day window ends on the 7th day");
ok((window7.end.getTime() - window7.start.getTime()) / 86_400_000 === 7, "window spans exactly the requested days");

console.log("\n# tool schemas");
const stubDb = { query: async () => ({ rows: [] }) } as never;
const tools: ToolDef[] = createFlightTools(stubDb);
ok(tools.length === 9, "nine flight tools registered");
const byName = new Map(tools.map((t) => [t.name, t]));
ok(
  ["search_flights", "find_first_available_flight", "get_flight_details", "list_available_seats", "search_flexible_prices", "search_anywhere", "search_inspiration", "filter_offers", "list_my_bookings"].every(
    (n) => byName.has(n),
  ),
  "tool names cover the funnel-top feature set",
);
ok(byName.get("list_my_bookings")!.toOllamaSchema().function.name === "list_my_bookings", "ollama schemas carry tool names");

const search = byName.get("search_flights")!.schema.safeParse({ origin: "London", destination: "Lisbon", date: "2026-12-01" });
ok(search.success, "search_flights accepts a one-way search");
const roundTrip = searchFlightsInput.safeParse({ origin: "London", destination: "Lisbon", date: "2026-12-01", return_date: "2026-12-08" });
ok(roundTrip.success, "round-trip return_date accepted");
ok(!searchFlightsInput.safeParse({ origin: "LHR", destination: "LIS", date: "tomorrow" }).success, "fuzzy date rejected");
ok(!searchFlightsInput.safeParse({ origin: "LHR", destination: "LIS", date: "2026-12-01", return_date: "soon" }).success, "fuzzy return_date rejected");

ok(!searchFlexiblePricesInput.safeParse({ origin: "LHR", destination: "LIS" }).success, "search_flexible_prices requires from_date");
ok(searchFlexiblePricesInput.safeParse({ origin: "LHR", destination: "LIS", from_date: "2026-12-01" }).success, "search_flexible_prices defaults apply");
ok(!searchAnywhereInput.safeParse({ origin: "LHR", days: 40 }).success, "search_anywhere caps window at 14 days");
ok(searchInspirationInput.safeParse({ origin: "LHR", theme: "warm" }).success, "search_inspiration accepts theme synonyms");
ok(!searchInspirationInput.safeParse({ origin: "LHR" }).success, "search_inspiration requires a theme");
ok(!getFlightDetailsInput.safeParse({ flight_id: "not-a-uuid" }).success, "get_flight_details rejects non-uuid ids");
ok(filterOffersInput.safeParse({}).success, "filter_offers accepts empty filters");
ok(!filterOffersInput.safeParse({ depart_after: "25:00" }).success, "filter_offers rejects invalid times");

console.log(`\nall ${passed} unit checks passed`);
