export interface AirportRowLite {
  iata: string;
  name: string;
  city: string;
  country: string;
}

export interface AirportResolution {
  exact: AirportRowLite[];
  candidates: AirportRowLite[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveAirports(
  query: string,
  airports: AirportRowLite[],
): AirportResolution {
  const q = normalize(query);
  if (q.length === 0) return { exact: [], candidates: [] };

  const exact = airports.filter(
    (a) => normalize(a.iata) === q || normalize(a.name) === q,
  );
  if (exact.length > 0) return { exact, candidates: [] };

  const candidates = airports.filter(
    (a) =>
      normalize(a.city).startsWith(q) ||
      normalize(a.city).includes(q) ||
      normalize(a.name).includes(q) ||
      normalize(a.country).startsWith(q) ||
      normalize(a.country).includes(q),
  );
  return { exact: [], candidates };
}
