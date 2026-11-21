import { createHash } from "node:crypto";

export interface AirportRow {
  iata: string;
  name: string;
  city: string;
  country: string;
}

export interface UserRow {
  user_ref: string;
  display_name: string;
  pin: string;
}

export interface FlightRow {
  id: string;
  flight_no: string;
  origin: string;
  destination: string;
  departs_at: Date;
  arrives_at: Date;
  base_price: string;
  day: number;
  wave: number;
}

export interface SeatRow {
  flight_id: string;
  seat_no: string;
  class: "economy" | "business";
  price: string;
  status: "available" | "held" | "booked";
  hold_expires_at: Date | null;
}

export interface BookingRow {
  id: string;
  user_ref: string;
  status: "held" | "confirmed" | "cancelled";
  passenger_name: string;
  created_at: Date;
  hold_expires_at: Date | null;
}

export interface BookingSeatRow {
  booking_id: string;
  flight_id: string;
  seat_no: string;
  active: boolean;
}

export interface Dataset {
  airports: AirportRow[];
  users: UserRow[];
  flights: FlightRow[];
  seats: SeatRow[];
  bookings: BookingRow[];
  bookingSeats: BookingSeatRow[];
  fingerprint: string;
  selloutFlightNo: string;
  demoHold: boolean;
}

export const DEMO_PIN = "4321";
export const SEAT_ROWS = 12;
export const SEAT_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;
export const BUSINESS_ROWS = 2;
export const DAYS = 14;
export const WAVES_PER_DAY = 3;
export const SEATS_PER_FLIGHT = SEAT_ROWS * SEAT_LETTERS.length;
export const DEMO_HOLD_MINUTES = 6;

export const AIRPORTS: AirportRow[] = [
  { iata: "LHR", name: "Heathrow", city: "London", country: "United Kingdom" },
  { iata: "LGW", name: "Gatwick", city: "London", country: "United Kingdom" },
  { iata: "MAN", name: "Manchester", city: "Manchester", country: "United Kingdom" },
  { iata: "LIS", name: "Humberto Delgado", city: "Lisbon", country: "Portugal" },
  { iata: "AMS", name: "Schiphol", city: "Amsterdam", country: "Netherlands" },
  { iata: "BCN", name: "Barcelona-El Prat", city: "Barcelona", country: "Spain" },
  { iata: "CDG", name: "Charles de Gaulle", city: "Paris", country: "France" },
  { iata: "MAD", name: "Adolfo Suarez Madrid-Barajas", city: "Madrid", country: "Spain" },
];

export const USERS: UserRow[] = [
  { user_ref: "ava", display_name: "Ava", pin: DEMO_PIN },
  { user_ref: "ben", display_name: "Ben", pin: DEMO_PIN },
  { user_ref: "chloe", display_name: "Chloe", pin: DEMO_PIN },
  { user_ref: "dan", display_name: "Dan", pin: DEMO_PIN },
  { user_ref: "elena", display_name: "Elena", pin: DEMO_PIN },
];

const ROUTES: { from: string; to: string; minutes: number; basePrice: number }[] = [
  { from: "LHR", to: "LIS", minutes: 155, basePrice: 89 },
  { from: "LIS", to: "LHR", minutes: 165, basePrice: 95 },
  { from: "LHR", to: "CDG", minutes: 75, basePrice: 69 },
  { from: "CDG", to: "LHR", minutes: 80, basePrice: 72 },
  { from: "LGW", to: "AMS", minutes: 70, basePrice: 59 },
  { from: "AMS", to: "LGW", minutes: 75, basePrice: 62 },
  { from: "MAN", to: "BCN", minutes: 125, basePrice: 79 },
  { from: "BCN", to: "MAN", minutes: 130, basePrice: 82 },
  { from: "LGW", to: "MAD", minutes: 145, basePrice: 99 },
  { from: "MAD", to: "LGW", minutes: 150, basePrice: 105 },
];

const WAVES: { minutesFrom: number; minutesTo: number; multiplier: number }[] = [
  { minutesFrom: 6 * 60 + 30, minutesTo: 9 * 60 + 30, multiplier: 1.15 },
  { minutesFrom: 11 * 60, minutesTo: 14 * 60, multiplier: 0.9 },
  { minutesFrom: 17 * 60, minutesTo: 20 * 60, multiplier: 1.25 },
];

export const SELLOUT = { route: 0, day: 2, wave: 2 };
export const SELLOUT_FREE_SEATS = ["7D", "12C", "12F"];
export const SELLOUT_DEMO_HOLD_SEAT = "12C";

interface BookingSpec {
  user: string;
  n: number;
  route: number;
  day: number;
  wave: number;
  seat: string;
  status: "confirmed" | "cancelled";
  leadDays: number;
}

const BOOKING_SPECS: BookingSpec[] = [
  { user: "ava", n: 1, route: 0, day: 3, wave: 0, seat: "4A", status: "confirmed", leadDays: 5 },
  { user: "ava", n: 2, route: 2, day: 4, wave: 1, seat: "7C", status: "cancelled", leadDays: 9 },
  { user: "ben", n: 1, route: 4, day: 5, wave: 2, seat: "5F", status: "confirmed", leadDays: 3 },
  { user: "ben", n: 2, route: 5, day: 6, wave: 2, seat: "10D", status: "confirmed", leadDays: 4 },
  { user: "chloe", n: 1, route: 6, day: 8, wave: 1, seat: "11C", status: "confirmed", leadDays: 12 },
];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function parseUuid(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidFor(name: string): string {
  const hash = createHash("sha1");
  hash.update(parseUuid(UUID_NAMESPACE));
  hash.update(name, "utf8");
  const digest = Buffer.from(hash.digest());
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  return formatUuid(digest.subarray(0, 16));
}

function round2(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

function utcMidnight(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function flightNoFor(route: number, day: number, wave: number): string {
  return `FF${101 + route * (DAYS * WAVES_PER_DAY) + day * WAVES_PER_DAY + wave}`;
}

export function isWindowSeat(seatNo: string): boolean {
  return seatNo.endsWith("A") || seatNo.endsWith("F");
}

export interface GenerateOptions {
  now?: Date;
  demoHold?: boolean;
}

export function generateDataset(seed: number, options: GenerateOptions = {}): Dataset {
  const now = options.now ?? new Date();
  const demoHold = options.demoHold ?? false;
  const rng = mulberry32(seed);
  const seedDay = utcMidnight(now);

  const flights: FlightRow[] = [];
  for (let route = 0; route < ROUTES.length; route++) {
    const r = ROUTES[route]!;
    for (let day = 0; day < DAYS; day++) {
      for (let wave = 0; wave < WAVES_PER_DAY; wave++) {
        const w = WAVES[wave]!;
        const minuteOfDay =
          w.minutesFrom + Math.floor(rng() * (w.minutesTo - w.minutesFrom));
        const departsAt = new Date(
          seedDay.getTime() + day * 86_400_000 + minuteOfDay * 60_000,
        );
        const durationMinutes = r.minutes + Math.floor(rng() * 31) - 15;
        const arrivesAt = new Date(departsAt.getTime() + durationMinutes * 60_000);
        const basePrice = round2(
          r.basePrice * w.multiplier * (0.9 + rng() * 0.2),
        );
        const flightNo = flightNoFor(route, day, wave);
        flights.push({
          id: uuidFor(`flight:${flightNo}`),
          flight_no: flightNo,
          origin: r.from,
          destination: r.to,
          departs_at: departsAt,
          arrives_at: arrivesAt,
          base_price: basePrice,
          day,
          wave,
        });
      }
    }
  }

  const seats: SeatRow[] = [];
  for (const flight of flights) {
    const seatNos: string[] = [];
    const priceBySeat = new Map<string, string>();
    const classBySeat = new Map<string, SeatRow["class"]>();
    for (let row = 1; row <= SEAT_ROWS; row++) {
      for (const letter of SEAT_LETTERS) {
        const seatNo = `${row}${letter}`;
        const klass: SeatRow["class"] = row <= BUSINESS_ROWS ? "business" : "economy";
        const window = letter === "A" || letter === "F";
        seatNos.push(seatNo);
        classBySeat.set(seatNo, klass);
        priceBySeat.set(
          seatNo,
          round2(
            Number(flight.base_price) *
              (klass === "business" ? 2.4 : 1) *
              (window ? 1.08 : 1) *
              (0.95 + rng() * 0.1),
          ),
        );
      }
    }
    const bookedCount = 6 + Math.floor(rng() * 8);
    const indices = seatNos.map((_, i) => i);
    for (let i = 0; i < bookedCount; i++) {
      const j = i + Math.floor(rng() * (indices.length - i));
      [indices[i], indices[j]] = [indices[j]!, indices[i]!];
    }
    const booked = new Set(indices.slice(0, bookedCount).map((i) => seatNos[i]!));
    for (const seatNo of seatNos) {
      seats.push({
        flight_id: flight.id,
        seat_no: seatNo,
        class: classBySeat.get(seatNo)!,
        price: priceBySeat.get(seatNo)!,
        status: booked.has(seatNo) ? "booked" : "available",
        hold_expires_at: null,
      });
    }
  }

  const selloutFlightNo = flightNoFor(SELLOUT.route, SELLOUT.day, SELLOUT.wave);
  const selloutFlight = flights.find((f) => f.flight_no === selloutFlightNo)!;
  for (const seat of seats) {
    if (seat.flight_id !== selloutFlight.id) continue;
    seat.status = SELLOUT_FREE_SEATS.includes(seat.seat_no) ? "available" : "booked";
    seat.hold_expires_at = null;
  }

  const bookings: BookingRow[] = [];
  const bookingSeats: BookingSeatRow[] = [];
  const seatByFlight = new Map<string, Map<string, SeatRow>>();
  for (const seat of seats) {
    let bySeat = seatByFlight.get(seat.flight_id);
    if (!bySeat) {
      bySeat = new Map();
      seatByFlight.set(seat.flight_id, bySeat);
    }
    bySeat.set(seat.seat_no, seat);
  }
  const flightByNo = new Map(flights.map((f) => [f.flight_no, f]));
  const userByRef = new Map(USERS.map((u) => [u.user_ref, u]));

  for (const spec of BOOKING_SPECS) {
    const flight = flightByNo.get(flightNoFor(spec.route, spec.day, spec.wave))!;
    const seat = seatByFlight.get(flight.id)!.get(spec.seat)!;
    seat.status = "available";
    seat.hold_expires_at = null;
    const bookingId = uuidFor(`booking:${spec.user}:${spec.n}`);
    bookings.push({
      id: bookingId,
      user_ref: spec.user,
      status: spec.status,
      passenger_name: userByRef.get(spec.user)!.display_name,
      created_at: new Date(flight.departs_at.getTime() - spec.leadDays * 86_400_000),
      hold_expires_at: null,
    });
    bookingSeats.push({
      booking_id: bookingId,
      flight_id: flight.id,
      seat_no: spec.seat,
      active: spec.status !== "cancelled",
    });
    seat.status = spec.status === "confirmed" ? "booked" : "available";
  }

  const fingerprint = fingerprintOf({
    airports: AIRPORTS,
    users: USERS,
    flights,
    seats,
    bookings,
    bookingSeats,
  });

  if (demoHold) {
    const holdId = uuidFor("booking:elena:demo-hold");
    const holdExpires = new Date(now.getTime() + DEMO_HOLD_MINUTES * 60_000);
    bookings.push({
      id: holdId,
      user_ref: "elena",
      status: "held",
      passenger_name: userByRef.get("elena")!.display_name,
      created_at: now,
      hold_expires_at: holdExpires,
    });
    bookingSeats.push({
      booking_id: holdId,
      flight_id: selloutFlight.id,
      seat_no: SELLOUT_DEMO_HOLD_SEAT,
      active: true,
    });
    const heldSeat = seatByFlight.get(selloutFlight.id)!.get(SELLOUT_DEMO_HOLD_SEAT)!;
    heldSeat.status = "held";
    heldSeat.hold_expires_at = holdExpires;
  }

  return {
    airports: AIRPORTS,
    users: USERS,
    flights,
    seats,
    bookings,
    bookingSeats,
    fingerprint,
    selloutFlightNo,
    demoHold,
  };
}

function fingerprintOf(data: {
  airports: AirportRow[];
  users: UserRow[];
  flights: FlightRow[];
  seats: SeatRow[];
  bookings: BookingRow[];
  bookingSeats: BookingSeatRow[];
}): string {
  const stable = {
    airports: data.airports,
    users: data.users,
    flights: data.flights.map((f) => [
      f.flight_no,
      f.origin,
      f.destination,
      f.day,
      f.wave,
      f.base_price,
    ]),
    seats: data.seats.map((s) => [s.flight_id, s.seat_no, s.class, s.price, s.status]),
    bookings: data.bookings.map((b) => [
      b.id,
      b.user_ref,
      b.status,
      b.passenger_name,
    ]),
    bookingSeats: data.bookingSeats,
  };
  return createHash("sha256")
    .update(JSON.stringify(stable, null, 0))
    .digest("hex")
    .slice(0, 16);
}
