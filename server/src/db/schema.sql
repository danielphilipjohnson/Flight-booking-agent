CREATE TABLE IF NOT EXISTS airline (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fare_rule (
  brand        TEXT PRIMARY KEY,
  carry_on     BOOLEAN NOT NULL,
  checked_bags INT NOT NULL,
  refundable   BOOLEAN NOT NULL,
  changeable   BOOLEAN NOT NULL,
  change_fee   NUMERIC(6, 2) NOT NULL
);

CREATE TABLE IF NOT EXISTS airport (
  iata    TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  city    TEXT NOT NULL,
  country TEXT NOT NULL,
  tags    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS airport_city_idx ON airport (city);

CREATE TABLE IF NOT EXISTS app_user (
  user_ref     TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  pin          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS flight (
  id           UUID PRIMARY KEY,
  flight_no    TEXT NOT NULL UNIQUE,
  origin       TEXT NOT NULL REFERENCES airport (iata),
  destination  TEXT NOT NULL REFERENCES airport (iata),
  departs_at   TIMESTAMPTZ NOT NULL,
  arrives_at   TIMESTAMPTZ NOT NULL,
  base_price   NUMERIC(10, 2) NOT NULL,
  airline_code TEXT NOT NULL DEFAULT 'FF' REFERENCES airline (code),
  on_time_pct  NUMERIC(5, 2) NOT NULL DEFAULT 95.00,
  CONSTRAINT flight_times_valid CHECK (departs_at < arrives_at)
);
CREATE INDEX IF NOT EXISTS flight_route_idx ON flight (origin, destination, departs_at);

CREATE TABLE IF NOT EXISTS seat (
  flight_id        UUID NOT NULL REFERENCES flight (id),
  seat_no          TEXT NOT NULL,
  class            TEXT NOT NULL CHECK (class IN ('economy', 'business')),
  fare_brand       TEXT NOT NULL DEFAULT 'standard' CHECK (fare_brand IN ('basic', 'standard', 'flex')),
  price            NUMERIC(10, 2) NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
  hold_expires_at  TIMESTAMPTZ,
  PRIMARY KEY (flight_id, seat_no)
);
CREATE INDEX IF NOT EXISTS seat_available_idx ON seat (flight_id) WHERE status = 'available';

CREATE TABLE IF NOT EXISTS booking (
  id               UUID PRIMARY KEY,
  user_ref         TEXT NOT NULL REFERENCES app_user (user_ref),
  status           TEXT NOT NULL CHECK (status IN ('held', 'confirmed', 'cancelled')),
  passenger_name   TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  hold_expires_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS booking_user_idx ON booking (user_ref, status);

CREATE TABLE IF NOT EXISTS booking_seat (
  booking_id UUID NOT NULL REFERENCES booking (id),
  flight_id  UUID NOT NULL,
  seat_no    TEXT NOT NULL,
  active     BOOLEAN NOT NULL,
  PRIMARY KEY (booking_id, flight_id, seat_no),
  FOREIGN KEY (flight_id, seat_no) REFERENCES seat (flight_id, seat_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_seat_active_unique
  ON booking_seat (flight_id, seat_no) WHERE active;
