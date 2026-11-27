import assert from "node:assert/strict";
import { mulberry32 } from "../seed/generate.ts";
import { resolveAirports, type AirportRowLite } from "../agent/airports.ts";
import { addDays, dateWindow, parseHhmm, parseIsoDate } from "../agent/dates.ts";
import { createFlightTools, setPinnedOffers, type PinnedOffer } from "../tools/flights.ts";
import type { ToolDef } from "../tools/schemas.ts";
import { seededQueryable } from "./fixtures.ts";

const SEED = 42;
const ITERATIONS = 400;

const rng = mulberry32(SEED);
let cases = 0;

function fail(label: string, detail: unknown): never {
  const sample = typeof detail === "string" ? detail.slice(0, 200) : JSON.stringify(detail)?.slice(0, 200);
  throw new Error(`fuzz failure at seed=${SEED} case=${cases} - ${label}: ${sample}`);
}

function randInt(min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(items: readonly T[]): T {
  return items[randInt(0, items.length - 1)]!;
}

function randomString(): string {
  const alphabet = ["abcXYZ 0129", "'", '"', "\\", ";", "--", "/*", "\n", "\t", "%", "_", "é", "日本", "\u{1F600}", "OR", "NULL", "undefined"];
  const length = randInt(0, 20);
  let out = "";
  for (let i = 0; i < length; i++) out += pick(alphabet);
  return out;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function randomJson(depth: number): Json {
  const choice = randInt(0, depth <= 0 ? 4 : 6);
  switch (choice) {
    case 0:
    case 4:
      return randomString();
    case 1:
      return pick([0, 1, -1, 0.5, 6, 7, 1e9, -1e9, Number.NaN, Number.POSITIVE_INFINITY]);
    case 2:
      return pick([true, false]);
    case 3:
      return null;
    case 5:
      return Array.from({ length: randInt(0, 3) }, () => randomJson(depth - 1));
    default:
      return randomArgObject(depth - 1);
  }
}

function randomArgObject(depth: number): { [key: string]: Json } {
  const keys = ["origin", "destination", "date", "from_date", "to_date", "return_date", "month", "days", "class", "max_price", "depart_after", "depart_before", "sort", "theme", "flight_id", "seat_no", "extra", "__proto__", "constructor", "toString"];
  const obj: { [key: string]: Json } = {};
  for (let i = 0; i < randInt(0, 5); i++) {
    Object.defineProperty(obj, pick(keys), {
      value: randomJson(depth),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return obj;
}

function randomIsoDate(): string {
  return `20${randInt(20, 30)}-${String(randInt(1, 15)).padStart(2, "0")}-${String(randInt(1, 40)).padStart(2, "0")}`;
}

const AIRPORTS: (AirportRowLite & { tags: string })[] = [
  { iata: "LHR", name: "Heathrow", city: "London", country: "United Kingdom", tags: "city" },
  { iata: "LGW", name: "Gatwick", city: "London", country: "United Kingdom", tags: "city" },
  { iata: "MAN", name: "Manchester", city: "Manchester", country: "United Kingdom", tags: "city" },
  { iata: "LIS", name: "Humberto Delgado", city: "Lisbon", country: "Portugal", tags: "beach,city" },
];

console.log("\n# tool schemas reject junk without throwing");
const stubDb = { query: async () => ({ rows: [] }) } as never;
const tools: ToolDef[] = createFlightTools(stubDb);
for (let i = 0; i < ITERATIONS; i++) {
  cases++;
  const def = pick(tools);
  const args = rng() < 0.5 ? randomArgObject(2) : randomJson(2);
  try {
    const result = def.schema.safeParse(args);
    if (result.success && result.data !== null && typeof result.data === "object") {
      const record = result.data as Record<string, unknown>;
      if (record.flight_id !== undefined && record.flight_id !== null) {
        assert.ok(/^[0-9a-f-]{36}$/i.test(String(record.flight_id)), `flight_id survived schema as ${String(record.flight_id)}`);
      }
    }
  } catch (err) {
    fail(`${def.name} schema threw instead of returning a safeParse result`, err instanceof Error ? err.message : err);
  }
}
console.log(`ok - ${ITERATIONS} random arg shapes: schema.safeParse never threw, accepted values type-safe`);

console.log("\n# airport resolution is total over random strings");
for (let i = 0; i < ITERATIONS; i++) {
  cases++;
  const query = pick([randomString(), randomString().toLowerCase(), pick(AIRPORTS).iata, pick(AIRPORTS).city, pick(AIRPORTS).country]);
  let resolution: ReturnType<typeof resolveAirports>;
  try {
    resolution = resolveAirports(query, AIRPORTS);
  } catch (err) {
    fail("resolveAirports threw", err instanceof Error ? err.message : err);
  }
  const lower = query.trim().toLowerCase();
  if (lower.length === 0) {
    assert.ok(resolution!.exact.length === 0 && resolution!.candidates.length === 0, "empty query matches nothing");
    continue;
  }
  if (resolution!.exact.length > 0) {
    assert.ok(resolution!.candidates.length === 0, "exact match short-circuits candidates");
  }
  for (const airport of [...resolution!.exact, ...resolution!.candidates]) {
    const matches =
      airport.iata.toLowerCase() === lower ||
      airport.name.toLowerCase() === lower ||
      airport.city.toLowerCase().includes(lower) ||
      airport.name.toLowerCase().includes(lower) ||
      airport.country.toLowerCase().includes(lower);
    assert.ok(matches, `candidate ${airport.iata} does not match query "${query}"`);
  }
}
console.log(`ok - ${ITERATIONS} random strings: never threw, exact/containment contract held`);

console.log("\n# date helpers over random inputs");
for (let i = 0; i < ITERATIONS; i++) {
  cases++;
  const raw = pick([randomString(), randomIsoDate(), "2026-02-30", "2024-02-29", "2026-13-01"]);
  let parsed: ReturnType<typeof parseIsoDate>;
  try {
    parsed = parseIsoDate(raw);
  } catch (err) {
    fail("parseIsoDate threw", err instanceof Error ? err.message : err);
  }
  if (parsed !== null) {
    assert.ok(parsed.date.toISOString().startsWith(parsed.iso), "parsed iso round-trips");
    const days = randInt(1, 14);
    const window = dateWindow(parsed.iso, days);
    assert.ok((window.end.getTime() - window.start.getTime()) / 86_400_000 === days, `window spans exactly ${days}`);
    assert.ok(window.end.getTime() > window.start.getTime(), "window end after start");
    assert.ok(addDays(parsed.iso, 1) > parsed.iso, "addDays monotone for +1");
  }
  const hhmm = pick([randomString(), `${randInt(0, 24)}:${randInt(0, 70)}`, "07:30", "23:59", "24:00"]);
  let minutes: ReturnType<typeof parseHhmm>;
  try {
    minutes = parseHhmm(hhmm);
  } catch (err) {
    fail("parseHhmm threw", err instanceof Error ? err.message : err);
  }
  if (minutes !== null) assert.ok(minutes >= 0 && minutes <= 23 * 60 + 59, "minutes within day bounds");
}
console.log(`ok - ${ITERATIONS} random date/time inputs: never threw, bounds held`);

console.log("\n# filter_offers over random pins (sqlite-backed registry)");
const { q } = await seededQueryable();
const liveTools: ToolDef[] = createFlightTools(q);
const filterDef = liveTools.find((t) => t.name === "filter_offers")!;
let accepted = 0;
let noPinErrors = 0;
for (let i = 0; i < ITERATIONS; i++) {
  cases++;
  const pinCount = randInt(0, 4);
  const pins: PinnedOffer[] = Array.from({ length: pinCount }, (_, n) => ({
    flight_id: `00000000-0000-4000-8000-00000000000${n}`,
    flight_no: `FF${n}${randInt(10, 99)}`,
    origin: "LHR",
    destination: "LIS",
    departs_at: `2026-12-${String(randInt(1, 14)).padStart(2, "0")}T${String(randInt(0, 23)).padStart(2, "0")}:${String(randInt(0, 59)).padStart(2, "0")}:00.000Z`,
    arrives_at: "2026-12-01T12:00:00.000Z",
    base_price: randInt(1, 5000),
    on_time_pct: randInt(80, 99),
    leg: rng() < 0.3 ? ("return" as const) : ("outbound" as const),
  }));
  setPinnedOffers(`fuzz-${i}`, pins);
  const argsRaw = randomArgObject(2);
  const parsed = filterDef.schema.safeParse(argsRaw);
  if (!parsed.success) continue;
  accepted++;
  let result: unknown;
  try {
    result = await filterDef.run(parsed.data as never, { userRef: "ava", sessionId: `fuzz-${i}` });
  } catch (err) {
    fail("filter_offers.run threw", err instanceof Error ? err.message : err);
  }
  const record = result as Record<string, unknown>;
  if (pinCount === 0) {
    if (record.error === undefined) fail("expected no-pin error", result);
    noPinErrors++;
    continue;
  }
  if (record.error !== undefined) continue;
  const requestedLeg = (parsed.data as { leg?: "outbound" | "return" }).leg ?? "outbound";
  const results = (record.results ?? []) as PinnedOffer[];
  for (const offer of results) {
    if ((offer.leg ?? "outbound") !== requestedLeg) fail("filtered result from the wrong leg", offer);
    if (parsed.data.max_price !== undefined && offer.base_price > parsed.data.max_price) {
      fail("filtered result exceeds max_price", offer);
    }
    const time = offer.departs_at.slice(11, 16);
    if (parsed.data.depart_after !== undefined && time < parsed.data.depart_after) fail("result departs before depart_after", offer);
    if (parsed.data.depart_before !== undefined && time > parsed.data.depart_before) fail("result departs after depart_before", offer);
  }
}
console.log(`ok - ${accepted}/${ITERATIONS} arg shapes accepted, no-pin errors correct (${noPinErrors}), invariants held`);

console.log(`\nfuzz pass: seed=${SEED}, ${cases} randomized cases, no invariant violations`);
