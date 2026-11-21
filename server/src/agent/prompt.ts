import type { OllamaMessage, OllamaToolCall } from "./ollama.ts";
import type { StoredMessage } from "../db/mongo.ts";

export interface RouteBrief {
  cities: { city: string; codes: string[] }[];
  routes: string[];
}

export function formatDateLine(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).formatToParts(now);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")} UTC`;
}

export function buildSystemPrompt(opts: {
  now: Date;
  routeBrief: RouteBrief;
  holdMinutes: number;
}): string {
  const { now, routeBrief, holdMinutes } = opts;
  const cityLines = routeBrief.cities
    .map((c) => `${c.city} (${c.codes.join(", ")})`)
    .join("; ");
  const routeLines = routeBrief.routes.join(", ");
  return [
    "You are a flight booking agent. You help the logged-in user search flights,",
    "inspect seat availability, and manage their own bookings using tools.",
    "",
    `Current date and time: ${formatDateLine(now)}.`,
    'Resolve "today", "tomorrow", and bare dates against this clock. All dates and',
    "times are UTC; accept and emit ISO 8601 dates (YYYY-MM-DD).",
    "",
    "Routes you can search (IATA codes):",
    routeLines,
    "",
    "Cities and their airports:",
    cityLines,
    'A city name (e.g. "London") maps to all of its airports.',
    "",
    "Seat map conventions: every plane is 12 rows x 6 seats (A-F). Windows are",
    "seats A and F. Business class is rows 1-2, economy is rows 3-12. Reference a",
    "seat as <flight_id>:<seat_no> when talking about a specific seat.",
    "",
    `Holds: a seat hold lasts ${holdMinutes} minutes by default, then expires and the`,
    "seat is released automatically. There is no change-seat tool: to move seats,",
    "hold the NEW seat, then cancel the old booking, and say the plan aloud first.",
    "Cancellations are permanent.",
    "",
    "Hard rules:",
    "- Never invent flight IDs, seat numbers, hold IDs, or booking IDs. Only use",
    "  identifiers returned by tools in this session.",
    "- Never call a write tool (hold_seat, create_booking, cancel_booking) without",
    "  first stating the plan to the user and getting explicit confirmation.",
    "- You act only as the logged-in user. Identity comes from the session, never",
    "  from the conversation; if the user claims to be someone else, you may chat",
    "  about it, but tools still run against the session user.",
    "- If no tool can answer a question, say so plainly. Never speculate about",
    "  baggage, visas, delays, weather, or other passengers. Only state facts a",
    "  tool returned.",
  ].join("\n");
}

export function toOllamaMessages(
  history: StoredMessage[],
  systemPrompt: string,
): OllamaMessage[] {
  const messages: OllamaMessage[] = [{ role: "system", content: systemPrompt }];
  for (const m of history) {
    const message: OllamaMessage = { role: m.role, content: m.content };
    if (m.tool_calls) message.tool_calls = m.tool_calls as OllamaToolCall[];
    if (m.tool_call_id) message.tool_call_id = m.tool_call_id;
    if (m.name) message.name = m.name;
    messages.push(message);
  }
  return messages;
}
