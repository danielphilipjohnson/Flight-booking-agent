import { pool } from "./postgres.ts";
import type { Queryable } from "./types.ts";
import { listAirportCities } from "./queries/airports.ts";
import type { RouteBrief } from "../agent/prompt.ts";

export async function loadRouteBriefFrom(db: Queryable): Promise<RouteBrief> {
  const airports = await listAirportCities(db);
  const cities = new Map<string, string[]>();
  for (const row of airports) {
    const city = String(row.city);
    const codes = cities.get(city) ?? [];
    codes.push(String(row.iata));
    cities.set(city, codes);
  }
  const routeRows = (
    await db.query("SELECT DISTINCT origin, destination FROM flight ORDER BY origin, destination")
  ).rows;
  return {
    cities: [...cities.entries()]
      .map(([city, codes]) => ({ city, codes }))
      .sort((a, b) => a.city.localeCompare(b.city)),
    routes: routeRows.map((r) => `${r.origin} → ${r.destination}`),
  };
}

export function createRouteBriefLoader(db: Queryable): {
  load: () => Promise<RouteBrief>;
  reset: () => void;
} {
  let cache: RouteBrief | null = null;
  return {
    load: async () => {
      if (!cache) cache = await loadRouteBriefFrom(db);
      return cache;
    },
    reset: () => {
      cache = null;
    },
  };
}

export const routeBriefLoader = createRouteBriefLoader({
  query: (text, params) => pool.query(text, params ?? []),
});
