import assert from "node:assert/strict";
import { mulberry32 } from "../seed/generate.ts";
import { dateWindow, parseHhmm, parseIsoDate } from "./dates.ts";
import { normalizeToolCalls, stripThinking, type OllamaMessage } from "./ollama.ts";
import { resolveAirports, type AirportRowLite } from "./airports.ts";
import { rankOffers, type Offer } from "./shortlist.ts";
import { buildToolDefs, type ToolContext } from "./tools.ts";

const SEED = 42;
const ITERATIONS = 500;

const rng = mulberry32(SEED);
let cases = 0;

function fail(label: string, detail: unknown): never {
  const sample = typeof detail === "string" ? detail.slice(0, 200) : JSON.stringify(detail)?.slice(0, 200);
  throw new Error(`fuzz failure at seed=${SEED} case=${cases} — ${label}: ${sample}`);
}

function randInt(min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(items: readonly T[]): T {
  return items[randInt(0, items.length - 1)]!;
}

function randomString(): string {
  const alphabet = [
    "abcXYZ 0129", "'", '"', "\\", ";", "--", "/*", "*/", "\n", "\t", "%", "_",
    "é", "ü", "日本", "\u{1F600}", "OR", "AND", "NULL", "undefined", "dayEndUtc(",
  ];
  const length = randInt(0, 20);
  let out = "";
  for (let i = 0; i < length; i++) out += pick(alphabet);
  return out;
}

type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

function randomJson(depth: number): Json {
  const choice = randInt(0, depth <= 0 ? 4 : 7);
  switch (choice) {
    case 0:
      return randomString();
    case 1:
      return pick([0, 1, -1, 0.5, 6, 7, 1e9, -1e9, Number.NaN, Number.POSITIVE_INFINITY]);
    case 2:
      return pick([true, false]);
    case 3:
      return null;
    case 4:
      return randomString();
    case 5:
      return Array.from({ length: randInt(0, 3) }, () => randomJson(depth - 1));
    case 6:
      return randomArgObject(depth - 1);
    default:
      return randomString();
  }
}

function randomArgObject(depth: number): { [key: string]: Json } {
  const keys = ["origin", "destination", "date", "from_date", "return_date", "days", "passengers", "cabin", "max_price", "depart_after", "depart_before", "sort", "query", "theme", "flight_id", "extra", "__proto__", "constructor", "toString"];
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

function section(title: string): void {
  console.log(`\n# ${title}`);
}

const AIRPORTS: AirportRowLite[] = [
  { iata: "LHR", name: "Heathrow", city: "London", country: "United Kingdom" },
  { iata: "LGW", name: "Gatwick", city: "London", country: "United Kingdom" },
  { iata: "MAN", name: "Manchester", city: "Manchester", country: "United Kingdom" },
  { iata: "LIS", name: "Humberto Delgado", city: "Lisbon", country: "Portugal" },
  { iata: "AMS", name: "Schiphol", city: "Amsterdam", country: "Netherlands" },
];

section("tool schemas reject junk without throwing");
const tools = buildToolDefs();
for (let i = 0; i < ITERATIONS; i++) {
  cases++;
  const def = pick(tools);
  const args = rng() < 0.5 ? randomArgObject(2) : randomJson(2);
  let result: ReturnType<typeof def.schema.safeParse>;
  try {
    result = def.schema.safeParse(args);
  } catch (err) {
    fail(`${def.name} schema threw instead of returning safeParse result`, err instanceof Error ? err.message : err);
  }
  if (result!.success) {
    const args_ = result!.data as Record<string, unknown>;
    if (args_.passengers !== undefined && args_.passengers !== null) {
      const p = args_.passengers as number;
      assert.ok(Number.isInteger(p) && p >= 1 && p <= 6, `passengers survived schema as ${String(args_.passengers)}`);
    }
    if (args_.cabin !== undefined && args_.cabin !== null) {
      assert.ok(args_.cabin === "economy" || args_.cabin === "business", `cabin survived schema as ${String(args_.cabin)}`);
    }
    for (const key of ["date", "from_date"] as const) {
      if (args_[key] !== undefined) {
        assert.ok(parseIsoDate(args_[key] as string) !== null, `${key} survived schema as ${args_[key]}`);
      }
    }
    for (const key of ["depart_after", "depart_before"] as const) {
      if (args_[key] !== undefined) {
        assert.ok(parseHhmm(args_[key] as string) !== null, `${key} survived schema as ${args_[key]}`);
      }
    }
  }
}
console.log(`ok - ${ITERATIONS} random arg shapes: schema.safeParse never threw, accepted values type-safe`);

section("filter_offers is total over random pins and args");
const ctx: ToolContext = { sessionId: "fuzz" };
const filterDef = tools.find((t) => t.name === "filter_offers")!;
let accepted = 0;
let noPinErrors = 0;
for (let i = 0; i < ITERATIONS; i++) {
  cases++;
  const pinCount = randInt(0, 4);
  const pins: Offer[] = Array.from({ length: pinCount }, (_, n) => ({
    flight_id: `f${n}`,
    flight_no: `FF${n}${randInt(10, 99)}`,
    origin: "LHR",
    origin_city: "London",
    destination: "LIS",
    destination_city: "Lisbon",
    date: randomIsoDate(),
    departs_at: `${String(randInt(0, 23)).padStart(2, "0")}:${String(randInt(0, 59)).padStart(2, "0")}`,
    arrives_at: "12:00",
    duration_minutes: randInt(60, 600),
    price_per_person: randInt(1, 5000),
    price_total: randInt(1, 5000),
    currency: "EUR",
    passengers: 1,
    cabin: pick(["economy", "business"] as const),
    airline_code: "FF",
    airline_name: "FlyFast",
    fare_brand: pick(["basic", "standard", "flex"] as const),
    carry_on: rng() < 0.5,
    checked_bags: randInt(0, 2),
    refundable: rng() < 0.5,
    changeable: rng() < 0.5,
    change_fee: randInt(0, 60),
    on_time_pct: randInt(80, 99),
    seats_available: randInt(0, 72),
    window_available: rng() < 0.5,
    expires_at: "2026-12-01T23:59:00.000Z",
  }));
  const argsRaw = randomArgObject(2);
  const parsed = filterDef.schema.safeParse(argsRaw);
  if (!parsed.success) continue;
  accepted++;
  let result: unknown;
  try {
    result = await filterDef.run(parsed.data, ctx);
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
  const total = record.total_results as number;
  assert.ok(typeof total === "number" && total >= 0);
  const alternatives = (record.alternatives ?? []) as Offer[];
  assert.ok(alternatives.length <= 5, `alternatives too long: ${alternatives.length}`);
  const maxPrice = parsed.data.max_price;
  if (maxPrice !== undefined && total > 0) {
    const shortlist = record.shortlist as Record<string, Offer>;
    for (const slot of ["best", "cheapest", "fastest"] as const) {
      assert.ok(shortlist[slot]!.price_total <= maxPrice, `shortlist ${slot} exceeds max_price`);
    }
  }
  const after = parsed.data.depart_after !== undefined ? (parseHhmm(parsed.data.depart_after) ?? undefined) : undefined;
  const before = parsed.data.depart_before !== undefined ? (parseHhmm(parsed.data.depart_before) ?? undefined) : undefined;
  if (total > 0) {
    const shortlist = record.shortlist as Record<string, Offer>;
    for (const slot of ["best", "cheapest", "fastest"] as const) {
      const minutes = Number(shortlist[slot]!.departs_at.slice(0, 2)) * 60 + Number(shortlist[slot]!.departs_at.slice(3, 5));
      if (after !== undefined) assert.ok(minutes >= after, `shortlist ${slot} departs before depart_after`);
      if (before !== undefined) assert.ok(minutes <= before, `shortlist ${slot} departs after depart_before`);
    }
  }
}
console.log(`ok - ${accepted}/${ITERATIONS} arg shapes accepted, no-pin errors correct (${noPinErrors}), invariants held`);

section("rankOffers invariants over random offer sets");
for (let i = 0; i < ITERATIONS; i++) {
  cases++;
  const count = randInt(0, 8);
  const offers: Offer[] = Array.from({ length: count }, (_, n) => ({
    flight_id: `f${n}`,
    flight_no: `FF${randInt(100, 999)}`,
    origin: "LHR",
    origin_city: "London",
    destination: "LIS",
    destination_city: "Lisbon",
    date: "2026-12-01",
    departs_at: `${String(randInt(0, 23)).padStart(2, "0")}:${String(randInt(0, 59)).padStart(2, "0")}`,
    arrives_at: "12:00",
    duration_minutes: randInt(60, 600),
    price_per_person: randInt(1, 5000),
    price_total: randInt(1, 5000),
    currency: "EUR",
    passengers: 1,
    cabin: "economy",
    airline_code: "FF",
    airline_name: "FlyFast",
    fare_brand: pick(["basic", "standard", "flex"] as const),
    carry_on: rng() < 0.5,
    checked_bags: randInt(0, 2),
    refundable: rng() < 0.5,
    changeable: rng() < 0.5,
    change_fee: randInt(0, 60),
    on_time_pct: randInt(80, 99),
    seats_available: randInt(0, 72),
    window_available: rng() < 0.5,
    expires_at: "2026-12-01T23:59:00.000Z",
  }));
  const ranked = rankOffers(offers);
  if (count === 0) {
    assert.ok(ranked === null, "empty input must return null");
    continue;
  }
  assert.ok(ranked !== null);
  const ids = new Set(offers.map((o) => o.flight_id));
  for (const slot of ["best", "cheapest", "fastest"] as const) {
    assert.ok(ids.has(ranked![slot]!.flight_id), `${slot} pick must be a member of the input`);
  }
  const minPrice = Math.min(...offers.map((o) => o.price_total));
  const minDuration = Math.min(...offers.map((o) => o.duration_minutes));
  assert.ok(ranked!.cheapest.price_total === minPrice, "cheapest is the price minimum");
  assert.ok(ranked!.fastest.duration_minutes === minDuration, "fastest is the duration minimum");
  const again = rankOffers(offers);
  assert.ok(JSON.stringify(again) === JSON.stringify(ranked), "ranking is deterministic");
}
console.log(`ok - ${ITERATIONS} random sets: membership, minima, determinism, empty -> null`);

section("airport resolution is total over random strings");
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

section("date helpers over random inputs");
for (let i = 0; i < ITERATIONS; i++) {
  cases++;
  const raw = pick([randomString(), randomIsoDate(), "2026-02-30", "2024-02-29", "2026-13-01", "0000-01-01"]);
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

section("ollama message normalization over random shapes");
const THINK_OPEN = `${String.fromCharCode(60)}think${String.fromCharCode(62)}`;
const THINK_CLOSE = `${String.fromCharCode(60)}/think${String.fromCharCode(62)}`;
for (let i = 0; i < ITERATIONS; i++) {
  cases++;
  const toolCalls = Array.from({ length: randInt(0, 3) }, () => ({
    function: {
      name: pick(["search_flight_offers", "", randomString()]),
      arguments: pick([
        randomArgObject(1),
        randomString(),
        null,
        randInt(0, 9),
        undefined,
      ]) as unknown as Record<string, unknown> | string,
    },
  }));
  const message: OllamaMessage = {
    role: "assistant",
    content: pick([
      randomString(),
      "answer",
      THINK_OPEN + randomString() + THINK_CLOSE,
      "prefix " + THINK_OPEN + randomString(),
      "prefix " + THINK_OPEN + randomString() + THINK_CLOSE + " tail",
    ]),
  };
  if (rng() >= 0.2) message.tool_calls = toolCalls;
  let normalized: ReturnType<typeof normalizeToolCalls>;
  try {
    normalized = normalizeToolCalls(message);
    stripThinking(message.content);
  } catch (err) {
    fail("normalize/strip threw", err instanceof Error ? err.message : err);
  }
  for (const call of normalized!) {
    assert.ok(typeof call.function.name === "string");
    assert.ok(typeof call.function.arguments === "object" && call.function.arguments !== null && !Array.isArray(call.function.arguments), "arguments normalized to a plain object");
  }
  const stripped = stripThinking(message.content);
  assert.ok(!stripped.includes(THINK_OPEN), "stripped content still contains the opening tag");
}
console.log(`ok - ${ITERATIONS} random messages: normalization and tag-stripping never threw`);

console.log(`\nfuzz pass: seed=${SEED}, ${cases} randomized cases, no invariant violations`);
