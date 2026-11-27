import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAYS,
  DEMO_HOLD_MINUTES,
  FARE_RULES,
  SEATS_PER_FLIGHT,
  SELLOUT_DEMO_HOLD_SEAT,
  USERS,
  generateDataset,
  isWindowSeat,
  type Dataset,
} from "./generate.ts";

const MIGRATIONS: string[] = [
  "ALTER TABLE airport ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE flight ADD COLUMN IF NOT EXISTS airline_code TEXT NOT NULL DEFAULT 'FF'",
  "ALTER TABLE flight ADD COLUMN IF NOT EXISTS on_time_pct NUMERIC(5, 2) NOT NULL DEFAULT 95.00",
  "ALTER TABLE seat ADD COLUMN IF NOT EXISTS fare_brand TEXT NOT NULL DEFAULT 'standard'",
];

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, "..", "db", "schema.sql");

function parseArgs(argv: string[]): { check: boolean; demoHold: boolean; seed: number } {
  let check = false;
  let demoHold = false;
  let seed = Number.parseInt(process.env.SEED ?? "42", 10);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--check") check = true;
    else if (arg === "--demo-hold") demoHold = true;
    else if (arg === "--seed" && argv[i + 1] !== undefined) {
      seed = Number.parseInt(argv[++i]!, 10);
      if (!Number.isFinite(seed)) throw new Error(`invalid --seed: ${argv[i]}`);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { check, demoHold, seed };
}

function preview(data: Dataset, seed: number): void {
  const bookedSeats = data.seats.filter((s) => s.status === "booked").length;
  const heldSeats = data.seats.filter((s) => s.status === "held").length;
  console.log(`seed=${seed} demoHold=${data.demoHold}`);
  console.log(
    `airports=${data.airports.length} users=${data.users.length} flights=${data.flights.length} ` +
      `seats=${data.seats.length} (${SEATS_PER_FLIGHT}/flight, ${DAYS} days) ` +
      `bookedSeats=${bookedSeats} heldSeats=${heldSeats}`,
  );
  console.log(`fingerprint=${data.fingerprint}`);
  console.log(`airline: ${data.airlines.map((a) => `${a.code} = ${a.name}`).join(", ")}`);
  for (const rule of data.fareRules) {
    console.log(
      `fare ${rule.brand}: carry-on ${rule.carry_on ? "included" : "NOT included"}, ${rule.checked_bags} checked bag(s), ${rule.refundable ? "refundable" : "non-refundable"}, change fee ${rule.change_fee}`,
    );
  }
  const london = data.airports.filter((a) => a.city === "London").map((a) => a.iata);
  console.log(`London fan-out: London = ${london.join(" + ")}`);

  const flightById = new Map(data.flights.map((f) => [f.id, f]));
  const perUser = new Map<string, string[]>();
  for (const user of USERS) perUser.set(user.user_ref, []);
  for (const booking of data.bookings) {
    const seat = data.bookingSeats.find((bs) => bs.booking_id === booking.id)!;
    const flight = flightById.get(seat.flight_id)!;
    perUser.get(booking.user_ref)!.push(
      `${booking.status} ${flight.flight_no} ${flight.origin}->${flight.destination} day+${flight.day} seat ${seat.seat_no}${seat.active ? "" : " (inactive claim)"}`,
    );
  }
  console.log("booking history:");
  for (const user of USERS) {
    const rows = perUser.get(user.user_ref)!;
    console.log(`  ${user.user_ref}: ${rows.length === 0 ? "none" : ""}`);
    for (const row of rows) console.log(`    - ${row}`);
  }

  const sellout = data.flights.find((f) => f.flight_no === data.selloutFlightNo)!;
  const free = data.seats
    .filter((s) => s.flight_id === sellout.id && s.status === "available")
    .map((s) => s.seat_no)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const held = data.seats
    .filter((s) => s.flight_id === sellout.id && s.status === "held")
    .map((s) => s.seat_no)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const windowsFree = free.filter(isWindowSeat);
  console.log(
    `near-sellout: ${sellout.flight_no} ${sellout.origin}->${sellout.destination} day+${sellout.day} ` +
      `available={${free.join(",")}} held={${held.join(",") || "-"}} windowsFree={${windowsFree.join(",") || "-"}}`,
  );
  if (data.demoHold) {
    console.log(
      `demo hold: elena holds ${SELLOUT_DEMO_HOLD_SEAT} on ${sellout.flight_no}, expires seed-time + ${DEMO_HOLD_MINUTES} min`,
    );
  }
}

async function insertChunk(
  client: { query: (text: string, values: unknown[]) => Promise<unknown> },
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples = rows.map((row) => {
    const placeholders = row.map((value) => {
      values.push(value);
      return `$${values.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  await client.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`,
    values,
  );
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function writeToPostgres(data: Dataset): Promise<void> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://flight:flight@localhost:5432/flight_agent",
  });
  await client.connect();
  try {
    const schema = await readFile(schemaPath, "utf8");
    await client.query(schema);
    for (const migration of MIGRATIONS) {
      await client.query(migration);
    }
    await client.query("BEGIN");
    await client.query(
      "TRUNCATE booking_seat, booking, seat, flight, app_user, airline, airport, fare_rule RESTART IDENTITY CASCADE",
    );
    for (const rows of chunk(data.airports, 100)) {
      await insertChunk(client, "airport", ["iata", "name", "city", "country", "tags"], rows.map((a) => [a.iata, a.name, a.city, a.country, a.tags]));
    }
    for (const rows of chunk(data.airlines, 100)) {
      await insertChunk(client, "airline", ["code", "name"], rows.map((a) => [a.code, a.name]));
    }
    for (const rows of chunk(data.users, 100)) {
      await insertChunk(client, "app_user", ["user_ref", "display_name", "pin"], rows.map((u) => [u.user_ref, u.display_name, u.pin]));
    }
    for (const rows of chunk(data.fareRules, 100)) {
      await insertChunk(client, "fare_rule", ["brand", "carry_on", "checked_bags", "refundable", "changeable", "change_fee"], rows.map((r) => [r.brand, r.carry_on, r.checked_bags, r.refundable, r.changeable, r.change_fee]));
    }
    for (const rows of chunk(data.flights, 500)) {
      await insertChunk(
        client,
        "flight",
        ["id", "flight_no", "origin", "destination", "departs_at", "arrives_at", "base_price", "airline_code", "on_time_pct"],
        rows.map((f) => [f.id, f.flight_no, f.origin, f.destination, f.departs_at, f.arrives_at, f.base_price, f.airline_code, f.on_time_pct]),
      );
    }
    for (const rows of chunk(data.seats, 2000)) {
      await insertChunk(
        client,
        "seat",
        ["flight_id", "seat_no", "class", "fare_brand", "price", "status", "hold_expires_at"],
        rows.map((s) => [s.flight_id, s.seat_no, s.class, s.fare_brand, s.price, s.status, s.hold_expires_at]),
      );
    }
    for (const rows of chunk(data.bookings, 100)) {
      await insertChunk(
        client,
        "booking",
        ["id", "user_ref", "status", "passenger_name", "created_at", "hold_expires_at"],
        rows.map((b) => [b.id, b.user_ref, b.status, b.passenger_name, b.created_at, b.hold_expires_at]),
      );
    }
    for (const rows of chunk(data.bookingSeats, 100)) {
      await insertChunk(
        client,
        "booking_seat",
        ["booking_id", "flight_id", "seat_no", "active"],
        rows.map((bs) => [bs.booking_id, bs.flight_id, bs.seat_no, bs.active]),
      );
    }
    await client.query("COMMIT");
    console.log(
      `seeded: ${data.airports.length} airports, ${data.airlines.length} airline(s), ${data.users.length} users, ${data.flights.length} flights, ${data.seats.length} seats, ${data.bookings.length} bookings, ${data.bookingSeats.length} booking_seats, ${data.fareRules.length} fare rules (fingerprint ${data.fingerprint})`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

const { check, demoHold, seed } = parseArgs(process.argv.slice(2));
const dataset = generateDataset(seed, { demoHold });
preview(dataset, seed);
if (!check) {
  await writeToPostgres(dataset);
} else {
  console.log("check only — no database writes");
}
