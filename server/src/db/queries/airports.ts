import type { Queryable } from "../types.ts";

export async function listAirports(q: Queryable): Promise<Record<string, unknown>[]> {
  return (await q.query("SELECT iata, name, city, country, tags FROM airport ORDER BY iata")).rows;
}

export async function listAirportCities(q: Queryable): Promise<Record<string, unknown>[]> {
  return (await q.query("SELECT iata, city FROM airport ORDER BY city, iata")).rows;
}
