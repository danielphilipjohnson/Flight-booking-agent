import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  AIRPORTS,
  DAYS,
  DEMO_HOLD_MINUTES,
  FARE_RULES,
  SEATS_PER_FLIGHT,
  SELLOUT_DEMO_HOLD_SEAT,
  SELLOUT_FREE_SEATS,
  USERS,
  generateDataset,
  isWindowSeat,
  uuidFor,
  type Dataset,
} from "./generate.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, "..", "db", "schema.sql");

let passed = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

function seatsOf(data: Dataset, flightNo: string) {
  const flight = data.flights.find((f) => f.flight_no === flightNo)!;
  return data.seats.filter((s) => s.flight_id === flight.id);
}

function section(title: string): void {
  console.log(`\n# ${title}`);
}

const fixedNow = new Date("2026-11-20T12:00:00.000Z");
const data = generateDataset(42, { now: fixedNow });
const dataAgain = generateDataset(42, { now: fixedNow });
const otherSeed = generateDataset(43, { now: fixedNow });
const withHold = generateDataset(42, { now: fixedNow, demoHold: true });

section("structure");
ok(data.airports.length === 8, "8 airports seeded");
ok(data.airlines.length === 1 && data.airlines[0]!.code === "FF", "1 airline seeded (FF)");
ok(data.fareRules.length === 3, "3 fare rules seeded");
ok(
  FARE_RULES.every((rule) => {
    const brand = rule.brand;
    const expected = { basic: [false, 0, false, true, "45.00"], standard: [true, 1, false, true, "25.00"], flex: [true, 2, true, true, "0.00"] }[brand];
    return (
      expected !== undefined &&
      rule.carry_on === expected[0] &&
      rule.checked_bags === expected[1] &&
      rule.refundable === expected[2] &&
      rule.changeable === expected[3] &&
      rule.change_fee === expected[4]
    );
  }),
  "fare rules: basic has no carry-on, standard has 1 bag, flex is refundable",
);
ok(
  data.airports.filter((a) => a.tags.includes("beach")).map((a) => a.iata).sort().join(",") === "BCN,LIS,MAD",
  "beach tag on LIS/BCN/MAD only",
);
ok(data.users.length === 5 && data.users.every((u) => u.pin === "4321"), "5 mock users, shared demo PIN");
ok(data.flights.length === 10 * DAYS * 3, "420 flights (10 directed routes x 14 days x 3 waves)");
ok(new Set(data.flights.map((f) => f.flight_no)).size === data.flights.length, "flight_no unique");
ok(data.seats.length === data.flights.length * SEATS_PER_FLIGHT, "72 seats per flight (30240 total)");
const airportCodes = new Set(data.airports.map((a) => a.iata));
ok(data.flights.every((f) => airportCodes.has(f.origin) && airportCodes.has(f.destination)), "every flight endpoint is a known airport");
ok(data.airports.every((a) => data.flights.some((f) => f.origin === a.iata || f.destination === a.iata)), "all 8 airports in use");
ok(data.flights.every((f) => f.departs_at < f.arrives_at), "departs_at < arrives_at for every flight");
ok(data.flights.every((f) => f.airline_code === "FF"), "every flight belongs to airline FF");
ok(
  data.flights.every((f) => {
    const pct = Number(f.on_time_pct);
    const waveBand: Record<number, [number, number]> = { 0: [93, 98], 1: [95, 99], 2: [87, 95] };
    const [low, high] = waveBand[f.wave]!;
    return pct >= low && pct <= high;
  }),
  "on-time pct within the per-wave band on every flight",
);
const perFlightSeats = new Map<string, number>();
for (const s of data.seats) perFlightSeats.set(s.flight_id, (perFlightSeats.get(s.flight_id) ?? 0) + 1);
ok([...perFlightSeats.values()].every((n) => n === SEATS_PER_FLIGHT), "exactly 72 seats per flight");
ok(
  data.flights.every((f) => {
    const seats = seatsOf(data, f.flight_no);
    const byBrand = (brand: string) => seats.filter((s) => s.fare_brand === brand).length;
    return byBrand("flex") === 12 && byBrand("standard") === 24 && byBrand("basic") === 36;
  }),
  "fare brands per flight: 12 flex (rows 1-2), 24 standard (rows 3-6), 36 basic (rows 7-12)",
);
ok(
  data.flights.every((f) => {
    const business = seatsOf(data, f.flight_no).filter((s) => s.class === "business");
    return business.length === 12 && business.every((s) => /^([12])[A-F]$/.test(s.seat_no));
  }),
  "rows 1-2 business (12 seats), rows 3-12 economy, on every flight",
);

const selloutSeats = seatsOf(data, data.selloutFlightNo);
const selloutFlight = data.flights.find((f) => f.flight_no === data.selloutFlightNo)!;
const nonSellout = data.flights.filter((f) => f.flight_no !== data.selloutFlightNo);
ok(
  nonSellout.every((f) => {
    const booked = seatsOf(data, f.flight_no).filter((s) => s.status === "booked").length;
    const fraction = booked / SEATS_PER_FLIGHT;
    return fraction >= 0.08 && fraction <= 0.181;
  }),
  "occupancy band 8-18% on every non-sellout flight",
);

section("london fan-out");
const londonCodes = data.airports.filter((a) => a.city === "London").map((a) => a.iata).sort();
ok(londonCodes.join(",") === "LGW,LHR", "London = LHR + LGW");
const toLondon = data.flights.filter((f) => londonCodes.includes(f.destination));
ok(toLondon.length > 0 && toLondon.every((f) => londonCodes.includes(f.destination)), "city fan-out resolves to LHR/LGW destinations only");

section("near-sellout flight");
ok(selloutFlight.origin === "LHR" && selloutFlight.destination === "LIS" && selloutFlight.day === 2, "sellout is LHR->LIS day+2");
const selloutFree = selloutSeats.filter((s) => s.status === "available").map((s) => s.seat_no).sort();
ok(selloutFree.join(",") === [...SELLOUT_FREE_SEATS].sort().join(","), `sellout free set exactly {${SELLOUT_FREE_SEATS.join(",")}}`);
ok(selloutSeats.filter((s) => s.status === "booked").length === 69, "sellout 69/72 booked");
ok(selloutSeats.filter((s) => s.class === "business").every((s) => s.status === "booked"), "sellout business cabin full");
const selloutWindowsFree = selloutSeats.filter((s) => s.status === "available" && isWindowSeat(s.seat_no)).map((s) => s.seat_no);
ok(selloutWindowsFree.join(",") === "12F", "only window left on sellout is 12F");

section("seeded booking history");
const bookingsByUser = (d: Dataset) => {
  const map = new Map<string, typeof d.bookings>();
  for (const u of USERS) map.set(u.user_ref, []);
  for (const b of d.bookings) map.get(b.user_ref)!.push(b);
  return map;
};
const byUser = bookingsByUser(data);
ok(byUser.get("ava")!.length === 2, "ava has 2 booking rows");
ok(byUser.get("ava")!.filter((b) => b.status === "confirmed").length === 1 && byUser.get("ava")!.filter((b) => b.status === "cancelled").length === 1, "ava: 1 confirmed + 1 cancelled");
ok(byUser.get("ben")!.length === 2 && byUser.get("ben")!.every((b) => b.status === "confirmed"), "ben: 2 confirmed");
ok(byUser.get("chloe")!.length === 1 && byUser.get("chloe")![0]!.status === "confirmed", "chloe: 1 confirmed");
ok(byUser.get("dan")!.length === 0 && byUser.get("elena")!.length === 0, "dan & elena: no bookings");
ok(data.bookings.some((b) => b.id === uuidFor("booking:ava:1")), "booking IDs are name-based deterministic UUIDs");

const activeClaims = data.bookingSeats.filter((bs) => bs.active);
const claimKeys = activeClaims.map((bs) => `${bs.flight_id}:${bs.seat_no}`);
ok(new Set(claimKeys).size === claimKeys.length, "no seat actively claimed twice");
const seatByKey = new Map(data.seats.map((s) => [`${s.flight_id}:${s.seat_no}`, s]));
const flightById = new Map(data.flights.map((f) => [f.id, f]));
for (const bs of data.bookingSeats) {
  const seat = seatByKey.get(`${bs.flight_id}:${bs.seat_no}`)!;
  const booking = data.bookings.find((b) => b.id === bs.booking_id)!;
  if (bs.active && booking.status === "confirmed") ok(seat.status === "booked", `confirmed claim ${bs.seat_no} flips seat to booked`);
  if (!bs.active) ok(seat.status === "available", `cancelled claim ${bs.seat_no} releases seat to available`);
}
const displayByRef = new Map(USERS.map((u) => [u.user_ref, u.display_name]));
ok(data.bookings.every((b) => b.passenger_name === displayByRef.get(b.user_ref)), "passenger_name = display_name");
ok(
  data.bookings.every((b) => {
    const seat = data.bookingSeats.find((bs) => bs.booking_id === b.id)!;
    const flight = flightById.get(seat.flight_id)!;
    const leadMs = flight.departs_at.getTime() - b.created_at.getTime();
    const leadDays = leadMs / 86_400_000;
    return Number.isInteger(leadDays) && leadDays >= 3 && leadDays <= 12;
  }),
  "created_at = departs_at - integer lead of 3-12 days",
);
const avaConfirmed = byUser.get("ava")!.find((b) => b.status === "confirmed")!;
const avaSeat = data.bookingSeats.find((bs) => bs.booking_id === avaConfirmed.id)!;
ok(flightById.get(avaSeat.flight_id)!.flight_no === data.flights.find((f) => f.origin === "LHR" && f.destination === "LIS" && f.day === 3 && f.wave === 0)!.flight_no && avaSeat.seat_no === "4A", "ava's confirmed booking: LHR->LIS day+3 morning, window 4A");

section("determinism");
ok(data.fingerprint === dataAgain.fingerprint, "same seed => identical fingerprint");
ok(data.fingerprint !== otherSeed.fingerprint, "different seed => different fingerprint");
ok(withHold.fingerprint === data.fingerprint, "--demo-hold does not change the fingerprint");

section("demo hold");
const heldBookings = withHold.bookings.filter((b) => b.status === "held");
ok(heldBookings.length === 1 && heldBookings[0]!.user_ref === "elena", "exactly one held booking (elena) with --demo-hold");
const holdSeat = seatsOf(withHold, withHold.selloutFlightNo).find((s) => s.seat_no === SELLOUT_DEMO_HOLD_SEAT)!;
ok(holdSeat.status === "held", "demo-hold seat is held");
ok(
  holdSeat.hold_expires_at !== null &&
    Math.abs(holdSeat.hold_expires_at.getTime() - (fixedNow.getTime() + DEMO_HOLD_MINUTES * 60_000)) < 1000,
  "hold_expires_at = seed time + 6 min",
);
const holdFree = seatsOf(withHold, withHold.selloutFlightNo).filter((s) => s.status === "available").map((s) => s.seat_no).sort();
ok(holdFree.join(",") === ["7D", "12F"].sort().join(","), "with --demo-hold, sellout free seats drop from 3 to 2");

section("constraint simulation (node:sqlite + real schema.sql)");
const schemaSql = (await readFile(schemaPath, "utf8")).replaceAll(/DEFAULT\s+now\(\)/gi, "DEFAULT CURRENT_TIMESTAMP");
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON;");
db.exec(schemaSql);

function insertAll(d: Dataset): void {
  const insAirline = db.prepare("INSERT INTO airline (code, name) VALUES (?, ?)");
  const insFareRule = db.prepare("INSERT INTO fare_rule (brand, carry_on, checked_bags, refundable, changeable, change_fee) VALUES (?, ?, ?, ?, ?, ?)");
  const insAirport = db.prepare("INSERT INTO airport (iata, name, city, country, tags) VALUES (?, ?, ?, ?, ?)");
  const insUser = db.prepare("INSERT INTO app_user (user_ref, display_name, pin) VALUES (?, ?, ?)");
  const insFlight = db.prepare("INSERT INTO flight (id, flight_no, origin, destination, departs_at, arrives_at, base_price, airline_code, on_time_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insSeat = db.prepare("INSERT INTO seat (flight_id, seat_no, class, fare_brand, price, status, hold_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insBooking = db.prepare("INSERT INTO booking (id, user_ref, status, passenger_name, created_at, hold_expires_at) VALUES (?, ?, ?, ?, ?, ?)");
  const insBs = db.prepare("INSERT INTO booking_seat (booking_id, flight_id, seat_no, active) VALUES (?, ?, ?, ?)");
  for (const a of d.airlines) insAirline.run(a.code, a.name);
  for (const r of d.fareRules) insFareRule.run(r.brand, r.carry_on ? 1 : 0, r.checked_bags, r.refundable ? 1 : 0, r.changeable ? 1 : 0, r.change_fee);
  for (const a of d.airports) insAirport.run(a.iata, a.name, a.city, a.country, a.tags);
  for (const u of d.users) insUser.run(u.user_ref, u.display_name, u.pin);
  for (const f of d.flights) insFlight.run(f.id, f.flight_no, f.origin, f.destination, f.departs_at.toISOString(), f.arrives_at.toISOString(), f.base_price, f.airline_code, f.on_time_pct);
  for (const s of d.seats) insSeat.run(s.flight_id, s.seat_no, s.class, s.fare_brand, s.price, s.status, s.hold_expires_at?.toISOString() ?? null);
  for (const b of d.bookings) insBooking.run(b.id, b.user_ref, b.status, b.passenger_name, b.created_at.toISOString(), b.hold_expires_at?.toISOString() ?? null);
  for (const bs of d.bookingSeats) insBs.run(bs.booking_id, bs.flight_id, bs.seat_no, bs.active ? 1 : 0);
}

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

insertAll(data);
ok(count("airport") === 8 && count("airline") === 1 && count("fare_rule") === 3 && count("app_user") === 5 && count("flight") === 420 && count("seat") === 30240 && count("booking") === 5 && count("booking_seat") === 5, "full dataset lands in the real schema");

function expectThrow(label: string, fn: () => void): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, label);
}

const probeFlight = db.prepare("INSERT INTO flight (id, flight_no, origin, destination, departs_at, arrives_at, base_price) VALUES (?, ?, ?, ?, ?, ?, ?)");
expectThrow("unknown origin IATA rejected (FK)", () =>
  probeFlight.run(uuidFor("probe:1"), "FF999", "XXX", "LHR", "2026-12-01T10:00:00.000Z", "2026-12-01T11:00:00.000Z", "10.00"),
);
expectThrow("unknown destination IATA rejected (FK)", () =>
  probeFlight.run(uuidFor("probe:2"), "FF998", "LHR", "XXX", "2026-12-01T10:00:00.000Z", "2026-12-01T11:00:00.000Z", "10.00"),
);
expectThrow("arrival before departure rejected (CHECK)", () =>
  probeFlight.run(uuidFor("probe:3"), "FF997", "LHR", "LIS", "2026-12-01T11:00:00.000Z", "2026-12-01T10:00:00.000Z", "10.00"),
);
expectThrow("arrival equal to departure rejected (strict <)", () =>
  probeFlight.run(uuidFor("probe:4"), "FF996", "LHR", "LIS", "2026-12-01T10:00:00.000Z", "2026-12-01T10:00:00.000Z", "10.00"),
);
expectThrow("duplicate airport IATA rejected (PK)", () =>
  db.prepare("INSERT INTO airport (iata, name, city, country) VALUES (?, ?, ?, ?)").run("LHR", "Dup", "London", "United Kingdom"),
);
expectThrow("orphan seat rejected (FK)", () =>
  db.prepare("INSERT INTO seat (flight_id, seat_no, class, price, status, hold_expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(uuidFor("probe:orphan"), "1A", "economy", "10.00", "available", null),
);
expectThrow("invalid seat status rejected (CHECK)", () =>
  db.prepare("INSERT INTO seat (flight_id, seat_no, class, price, status, hold_expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(data.flights[0]!.id, "99Z", "economy", "10.00", "taken", null),
);
const probeBooking = db.prepare("INSERT INTO booking (id, user_ref, status, passenger_name, created_at, hold_expires_at) VALUES (?, ?, ?, ?, ?, ?)");
expectThrow("booking for unknown user rejected (FK)", () =>
  probeBooking.run(uuidFor("probe:booking"), "nobody", "confirmed", "Nobody", "2026-11-01T10:00:00.000Z", null),
);
probeBooking.run(uuidFor("booking:ben:probe"), "ben", "confirmed", "Ben", "2026-11-01T10:00:00.000Z", null);
const probeClaim = db.prepare("INSERT INTO booking_seat (booking_id, flight_id, seat_no, active) VALUES (?, ?, ?, ?)");
expectThrow("second ACTIVE claim on ava's 4A rejected (partial unique index) — the Phase-3 race at storage level", () =>
  probeClaim.run(uuidFor("booking:ben:probe"), avaSeat.flight_id, avaSeat.seat_no, 1),
);
probeClaim.run(uuidFor("booking:ben:probe"), avaSeat.flight_id, avaSeat.seat_no, 0);
ok(true, "inactive (cancelled) claim on the same seat is allowed");
expectThrow("booking_seat row for an unknown seat rejected (FK)", () =>
  probeClaim.run(uuidFor("booking:ben:probe"), data.flights[0]!.id, "99Z", 1),
);

db.exec("DELETE FROM booking_seat; DELETE FROM booking; DELETE FROM seat; DELETE FROM flight; DELETE FROM app_user; DELETE FROM airline; DELETE FROM airport; DELETE FROM fare_rule;");
insertAll(dataAgain);
ok(count("flight") === 420 && count("seat") === 30240 && count("booking") === 5, "reseed is idempotent (TRUNCATE + insert reproduces identical counts)");

console.log(`\n${passed} assertions passed`);
