import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Queryable } from "../db/types.ts";
import { generateDataset, type Dataset } from "../seed/generate.ts";
import type { ChatChunk, OllamaClient, OllamaMessage } from "../agent/ollama.ts";

export const FIXED_NOW = new Date("2026-11-20T12:00:00.000Z");

export async function loadSchemaSql(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = await readFile(path.join(here, "..", "db", "schema.sql"), "utf8");
  return raw.replaceAll(/DEFAULT\s+now\(\)/gi, "DEFAULT CURRENT_TIMESTAMP");
}

export function insertDataset(db: DatabaseSync, d: Dataset): void {
  const insAirport = db.prepare("INSERT INTO airport (iata, name, city, country) VALUES (?, ?, ?, ?)");
  const insUser = db.prepare("INSERT INTO app_user (user_ref, display_name, pin) VALUES (?, ?, ?)");
  const insFlight = db.prepare("INSERT INTO flight (id, flight_no, origin, destination, departs_at, arrives_at, base_price) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insSeat = db.prepare("INSERT INTO seat (flight_id, seat_no, class, price, status, hold_expires_at) VALUES (?, ?, ?, ?, ?, ?)");
  const insBooking = db.prepare("INSERT INTO booking (id, user_ref, status, passenger_name, created_at, hold_expires_at) VALUES (?, ?, ?, ?, ?, ?)");
  const insBs = db.prepare("INSERT INTO booking_seat (booking_id, flight_id, seat_no, active) VALUES (?, ?, ?, ?)");
  for (const a of d.airports) insAirport.run(a.iata, a.name, a.city, a.country);
  for (const u of d.users) insUser.run(u.user_ref, u.display_name, u.pin);
  for (const f of d.flights) insFlight.run(f.id, f.flight_no, f.origin, f.destination, f.departs_at.toISOString(), f.arrives_at.toISOString(), f.base_price);
  for (const s of d.seats) insSeat.run(s.flight_id, s.seat_no, s.class, s.price, s.status, s.hold_expires_at?.toISOString() ?? null);
  for (const b of d.bookings) insBooking.run(b.id, b.user_ref, b.status, b.passenger_name, b.created_at.toISOString(), b.hold_expires_at?.toISOString() ?? null);
  for (const bs of d.bookingSeats) insBs.run(bs.booking_id, bs.flight_id, bs.seat_no, bs.active ? 1 : 0);
}

export function sqliteDb(data: Dataset, schemaSql: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(schemaSql);
  insertDataset(db, data);
  return db;
}

export function toQueryable(
  db: DatabaseSync,
  opts: { txMode?: "passthrough" | "real" } = {},
): Queryable & { db: DatabaseSync } {
  const q: Queryable & { db: DatabaseSync } = {
    db,
    query: async (text, params = []) => {
      const placeholders = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      const sql = text
        .replace(/\$\d+/g, "?")
        .replace(/\s+FOR\s+UPDATE\s*$/im, "");
      const raw = placeholders.length > 0 ? placeholders.map((n) => params[n - 1]) : params;
      const values = raw.map((p) => {
        if (p instanceof Date) return p.toISOString();
        if (typeof p === "boolean") return p ? 1 : 0;
        return p;
      });
      const rows = db.prepare(sql).all(...(values as never[])) as Record<string, unknown>[];
      return { rows };
    },
  };
  if (opts.txMode === "real") {
    q.tx = async (fn) => {
      db.exec("BEGIN");
      try {
        const result = await fn(q);
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    };
  } else {
    q.tx = async (fn) => fn(q);
  }
  return q;
}

export async function seededQueryable(): Promise<{ data: Dataset; q: Queryable & { db: DatabaseSync } }> {
  const data = generateDataset(42, { now: FIXED_NOW });
  const db = sqliteDb(data, await loadSchemaSql());
  return { data, q: toQueryable(db) };
}

export function toolCallChunks(id: string, name: string, argsJsonFragments: string[]): ChatChunk[] {
  return [
    { message: { role: "assistant", content: "", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: argsJsonFragments[0] ?? "" } }] } },
    ...argsJsonFragments.slice(1).map((fragment) => ({
      message: { tool_calls: [{ index: 0, function: { arguments: fragment } }] },
    })),
    { done: true, eval_count: 42, prompt_eval_count: 100 },
  ];
}

export function textChunks(text: string): ChatChunk[] {
  return [
    { message: { role: "assistant", content: text.slice(0, 5) } },
    { message: { content: text.slice(5) } },
    { done: true, eval_count: 42 },
  ];
}

export function fakeOllamaClient(script: ChatChunk[][]): OllamaClient & { seenMessages: OllamaMessage[][] } {
  const seenMessages: OllamaMessage[][] = [];
  let call = 0;
  return {
    seenMessages,
    chat(opts) {
      seenMessages.push(opts.messages.map((m) => ({ ...m })));
      const chunks = script[Math.min(call, script.length - 1)]!;
      call += 1;
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}
