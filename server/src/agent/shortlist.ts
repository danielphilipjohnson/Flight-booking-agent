export interface Offer {
  flight_id: string;
  flight_no: string;
  origin: string;
  origin_city: string;
  destination: string;
  destination_city: string;
  date: string;
  departs_at: string;
  arrives_at: string;
  duration_minutes: number;
  price_per_person: number;
  price_total: number;
  currency: string;
  passengers: number;
  cabin: "economy" | "business";
  seats_available: number;
  window_available: boolean;
}

export interface Shortlist {
  best: Offer;
  cheapest: Offer;
  fastest: Offer;
}

function departurePenalty(offer: Offer): number {
  const hour = Number(offer.departs_at.slice(0, 2));
  return hour < 6 || hour >= 23 ? 0.5 : 0;
}

export function rankOffers(offers: Offer[]): Shortlist | null {
  if (offers.length === 0) return null;

  const prices = offers.map((o) => o.price_total);
  const durations = offers.map((o) => o.duration_minutes);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const minDuration = Math.min(...durations);
  const maxDuration = Math.max(...durations);
  const priceSpan = maxPrice - minPrice || 1;
  const durationSpan = maxDuration - minDuration || 1;

  const best = [...offers].sort((a, b) => {
    const scoreA =
      (a.price_total - minPrice) / priceSpan +
      (a.duration_minutes - minDuration) / durationSpan +
      departurePenalty(a);
    const scoreB =
      (b.price_total - minPrice) / priceSpan +
      (b.duration_minutes - minDuration) / durationSpan +
      departurePenalty(b);
    if (scoreA !== scoreB) return scoreA - scoreB;
    if (a.price_total !== b.price_total) return a.price_total - b.price_total;
    return a.departs_at.localeCompare(b.departs_at);
  })[0]!;

  const cheapest = [...offers].sort(
    (a, b) => a.price_total - b.price_total || a.departs_at.localeCompare(b.departs_at),
  )[0]!;

  const fastest = [...offers].sort(
    (a, b) =>
      a.duration_minutes - b.duration_minutes || a.price_total - b.price_total,
  )[0]!;

  return { best, cheapest, fastest };
}
