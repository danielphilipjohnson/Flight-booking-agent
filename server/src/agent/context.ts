import type { StoredMessage } from "../db/mongo.ts";

export interface ContextOptions {
  maxMessages: number;
  compactThreshold: number;
  compact?: (prompt: string) => Promise<string>;
  summaryCache?: SummaryCache;
}

export interface CachedSummary {
  summary: string;
  evictedCount: number;
}

export interface SummaryCache {
  get(): CachedSummary | null;
  set(value: CachedSummary): void;
}

export interface ContextSelection {
  messages: StoredMessage[];
  compacted: boolean;
  evicted: number;
}

export function windowMessages(
  history: StoredMessage[],
  maxMessages: number,
): { kept: StoredMessage[]; evicted: StoredMessage[] } {
  if (history.length <= maxMessages) return { kept: history, evicted: [] };
  let cut = history.length - maxMessages;
  while (cut < history.length && history[cut]!.role === "tool") cut += 1;
  return { kept: history.slice(cut), evicted: history.slice(0, cut) };
}

export function extractActiveIds(messages: StoredMessage[]): string[] {
  const ids = new Set<string>();
  const re =
    /"(?:flight_id|hold_id|booking_id|bookingId|id)"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;
  for (const m of messages) {
    for (const match of m.content.matchAll(re)) {
      if (match[1]) ids.add(match[1]);
    }
  }
  return [...ids].sort();
}

export function buildCompactionPrompt(
  evicted: StoredMessage[],
  activeIds: string[],
): string {
  const transcript = evicted
    .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
    .join("\n");
  return [
    "Summarize the following earlier conversation turns into one short, factual summary message.",
    "Keep: the user's goals, flights/seats discussed, decisions made, and any pending action awaiting confirmation.",
    "Preserve these IDs VERBATIM in the summary (the agent may only reference IDs a tool returned this session):",
    activeIds.length > 0 ? activeIds.join(", ") : "(none)",
    "Never invent IDs. Do not include pleasantries.",
    "",
    transcript,
  ].join("\n");
}

export async function selectContext(
  history: StoredMessage[],
  opts: ContextOptions,
): Promise<ContextSelection> {
  const { kept, evicted } = windowMessages(history, opts.maxMessages);
  if (evicted.length === 0) {
    return { messages: kept, compacted: false, evicted: 0 };
  }
  if (!opts.compact || evicted.length < opts.compactThreshold) {
    return { messages: kept, compacted: false, evicted: evicted.length };
  }
  const cached = opts.summaryCache?.get() ?? null;
  if (cached && cached.evictedCount === evicted.length) {
    return {
      messages: [{ role: "assistant", content: cached.summary, ts: new Date() }, ...kept],
      compacted: true,
      evicted: evicted.length,
    };
  }
  const activeIds = extractActiveIds(history);
  const summary = await opts.compact(buildCompactionPrompt(evicted, activeIds));
  opts.summaryCache?.set({ summary, evictedCount: evicted.length });
  return {
    messages: [{ role: "assistant", content: summary, ts: new Date() }, ...kept],
    compacted: true,
    evicted: evicted.length,
  };
}
