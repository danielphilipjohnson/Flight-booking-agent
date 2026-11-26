# The flight search agent (Phase 2)

How the search stage of the flight booking agent works, and how conversations
are designed to flow. The design follows the phase notes for the search stage:
intent capture first, ranked shortlists, and conversational refinement instead
of filter sidebars.

For architecture and setup, see the [README](../README.md).

## What it is

A read-only, tool-calling agent. The user chats; a local LLM (Ollama, `qwen3`
class) decides which search tools to call against Postgres, then presents
results as a shortlist. Nothing writes to the database in this phase — the
agent can search, filter and pin offers, but booking (hold/create/cancel with
the confirm gate) is Phase 3.

The agent layer lives in `server/src/agent/`:

| Module | Role |
| --- | --- |
| `loop.ts` | Agent loop: model call -> tool calls -> model call, up to 8 tool rounds |
| `tools.ts` | The five read tools, Zod-validated before any SQL |
| `prompt.ts` | System prompt: today's date, dataset facts, conversation rules |
| `shortlist.ts` | Best / cheapest / fastest ranking |
| `history.ts` | Per-session Mongo history (last 30 user/assistant turns replayed) |
| `ollama.ts` | `/api/chat` client, argument normalization, `<think>` stripping |

## The tools

| Tool | When it fires | What it returns |
| --- | --- | --- |
| `search_flight_offers` | The user wants flights for a specific date | Ranked shortlist (best / cheapest / fastest), alternatives, seats-available per offer |
| `search_flexible_dates` | The date is vague ("next week", "around the 14th") | Per-day cheapest prices, cheapest day, shortlist over the window |
| `search_anywhere` | The user has no destination ("where can I go for under 300?") | Up to 10 destinations from the origin, cheapest-price order |
| `filter_offers` | Refining the last search ("cheaper", "not before noon") | Filtered + re-ranked shortlist, no re-query |
| `resolve_airport_code` | The model wants to check which airports a place maps to | Matching airports with city + country |

All tools accept cities or IATA codes for origin/destination. Origin and
destination are resolved independently; a place that maps to several airports
is searched across all of them, and every offer carries its airport.

## Conversation rules

These are encoded in the system prompt (`prompt.ts`) and are the contract for
how the agent should behave:

1. **At most one clarifying question per turn.** "Where are you flying from?"
   is fine. "Where from, what dates, how many passengers, which cabin?" is a
   form wearing a chat costume.
2. **Defaults are stated, not asked.** 1 adult, economy cabin. The agent says
   the assumption once and lets the user correct it.
3. **Destination is required; origin is never guessed.** A first-time user
   gets asked for their origin.
4. **Fuzzy dates are resolved, not bounced.** Relative dates ("tomorrow") are
   converted to ISO dates against today's date (injected into the prompt);
   vague dates go to `search_flexible_dates`.
5. **Multi-airport cities are searched together** (London -> LHR + LGW) and
   labelled per airport, instead of blocking on "which London?".
6. **Vague destinations go to browse mode.** "Somewhere warm" is a
   `search_anywhere` query, not a clarifying question.
7. **Never invent flights.** Everything the agent states about flights,
   prices or times comes from tool output.
8. **No results get alternatives, not a dead end.** Nearby dates and
   destinations reachable from the origin are offered.
9. **Refinement is conversational.** Filters (`filter_offers`) run against the
   last search, pinned in memory per session — no re-querying, no sidebar.
10. **Picks are pinned.** "The second one" resolves against the order of the
    last shortlist; when the user picks, the agent repeats the key details.

## Expected conversation flows

The user sees tool activity as chips in the chat; flows below show them as
`[tool]` lines. Examples are illustrative but follow the dataset's shape
(10 directed routes, 3 daily waves, EUR prices, UTC times) — e.g. London ->
Paris is `LHR -> CDG`, London -> Barcelona does not exist.

### 1. Fuzzy date, defaults applied

> **User:** flights to Paris next month
>
> `[search_flexible_dates] origin: London, destination: Paris, from_date: 2026-12-01, days: 7`
>
> **Agent:** I'll assume 1 adult in economy. Over the first week of December,
> the cheapest day to fly London -> Paris is Tue 8 Dec at **56 EUR**. The
> shortlist for that day:
>
> **Best — FF209 (LHR -> CDG), Tue 8 Dec, 12:20 -> 13:35 UTC, 1h 15m, 56 EUR, 48 seats left**
> **Cheapest — FF209, 56 EUR**
> **Fastest — FF210, 13:05 -> 14:21 UTC, 1h 16m, 59 EUR, window seat available**
>
> Want me to check other days in the window, or filter by price or departure
> time?

The vague "next month" became a windowed flexible search; the agent picked the
cheapest day, stated the defaults once, and invited refinement.

### 2. Missing origin — one question

> **User:** I need to get to Tokyo for a meeting on the 14th
>
> **Agent:** I couldn't find Tokyo in the demo dataset — it covers London
> (LHR, LGW), Manchester, Lisbon, Amsterdam, Barcelona, Paris and Madrid.
> Which of those are you flying from?
>
> **User:** London

Two things happened: the unknown destination was reported honestly (never
invented), and only one question was asked — origin first. Once the user
picks a destination the dataset supports, the flow continues into search.

### 3. Vague destination — browse mode

> **User:** What's cheap to anywhere warm in February?
>
> `[search_anywhere] origin: London, from_date: 2026-12-01, days: 14`
>
> **Agent:** From London over the next two weeks, the cheapest destinations
> are:
>
> 1. **Amsterdam (AMS)** — from 54 EUR
> 2. **Paris (CDG)** — from 57 EUR
> 3. **Lisbon (LIS)** — from 81 EUR
> 4. **Madrid (MAD)** — from 90 EUR
>
> Lisbon or Madrid are your warm-weather bets. Want flights to one of them?

The dataset window is 14 days from today, so "February" resolves to what the
data can answer; the agent says so rather than showing empty results.

### 4. Refinement loop — no re-query

> **User:** not before noon, and under 200 for two of us
>
> `[filter_offers] max_price: 200, depart_after: 12:00, sort: best`
>
> **Agent:** Two Paris options leave after noon within budget:
>
> **Best — FF211 (LHR -> CDG), 17:40 -> 18:57 UTC, 1h 17m, 174 EUR for 2, 46 seats**
> **Cheapest — FF213, 19:05 -> 20:22 UTC, 1h 17m, 180 EUR for 2, 39 seats**
>
> Want to see more, or shall I loosen the price cap?

`filter_offers` works on the offers pinned by the last search — no database
round trip. Filters: `max_price` (total for the party), `depart_after` /
`depart_before` (UTC), `sort` (best / cheapest / fastest).

### 5. "The second one" — pinned context

> **User:** actually show me the second one again
>
> **Agent:** That's FF213 (LHR -> CDG), 19:05 -> 20:22 UTC, 1h 17m, 90 EUR per
> person, 39 seats left, window seats available. Want me to keep it as your
> pick?

The agent maps ordinal references to the order of the last shortlist it
presented. When the user picks an option, the agent repeats its key details
and treats it as pinned — the handoff point for Phase 3's
`get_fare_details` -> confirm -> passenger details flow.

### 6. No results — alternatives, not a dead end

> **User:** Manchester to Lisbon on the 5th
>
> `[search_flight_offers] origin: Manchester, destination: Lisbon, date: 2026-12-05`
>
> **Agent:** There's no Manchester -> Lisbon route in the demo dataset on that
> date. Nearby options:
>
> - **Manchester -> Barcelona** from 79 EUR on other days in the window
> - **London -> Lisbon (LHR)** from 81 EUR
>
> Would either of those work, or shall I check different dates?

The tool returns `suggestions` (nearby dates with prices, destinations
reachable from the origin); the agent turns them into choices.

## Presenting results

Offer objects carry everything needed to decide without a follow-up call:
total and per-person price (EUR, demo data), flight number, origin ->
destination with airports, departure/arrival times (UTC), duration, seats
remaining, and window-seat availability. The shortlist is three picks —
**Best** (price + duration + departure-time sanity; pre-6am and post-11pm
departures are penalized), **Cheapest**, **Fastest** — followed by up to five
alternatives the agent can reveal on request.

## Edge cases

| Case | Behavior |
| --- | --- |
| Unknown place ("Tokyo") | Tool returns the known airport list; agent explains the dataset limits and asks what to do |
| Ambiguous date ("the 14th") | One clarifying question before searching |
| Multi-airport city ("London") | All airports searched; offers labelled with airport |
| Date outside the 14-day window | Agent states the window and offers in-window alternatives |
| No results | Nearby dates + reachable destinations suggested |
| Model loops or hallucinates a tool | 8-round cap; unknown tools and invalid arguments return error text the model must recover from |

## Fuzzing

| Command | Needs | What it does |
| --- | --- | --- |
| `npm run fuzz` | nothing | Deterministic offline fuzzer (seed 42, 3000 cases) over the pure layers: tool schemas, `filter_offers` against random pins, ranking invariants, resolver contract, date math, message normalization |
| `npm run fuzz:live` | Postgres + seeded data | Generates randomized *valid* tool arguments (cities, fuzzy dates, passengers, cabins, budgets), runs the real SQL tools, and asserts result invariants: shortlist membership, price/duration minima, `price_total == per-person x passengers`, seats >= passengers, price-sorted browse results, per-day windows, no-results carry suggestions. Roughly every other successful search is followed by a randomized `filter_offers` chain. |
| `npm run fuzz:agent` | full stack + Ollama | Runs the real agent loop (`qwen3`) against randomized user openings from the phase notes, plus scripted multi-turn flows ("actually the second one", "book the cheapest one"). Asserts the loop completes within the round cap, replies are non-empty, only known tools are invoked, and every turn lands in Mongo history. Prints transcripts per session. |

All three are seeded (`FUZZ_SEED`, default 42) so failures reproduce. Scale
with `FUZZ_ITERATIONS` (live) and pick the persona with `FUZZ_USER` /
`FUZZ_PIN` (agent). Run order: `docker compose up -d`, `npm run seed`, then
`npm run fuzz:live` / `npm run fuzz:agent`. Re-seed first if the seed day has
drifted, otherwise most date-window searches will correctly return empty.

## Current limits

- One-way searches only; round-trip return dates are a follow-up
  ([#30](https://github.com/danielphilipjohnson/Flight-booking-agent/issues/30)).
- No theme-based inspiration search
  ([#31](https://github.com/danielphilipjohnson/Flight-booking-agent/issues/31));
  no baggage/fare-brand/refundability fields in offers
  ([#32](https://github.com/danielphilipjohnson/Flight-booking-agent/issues/32));
  no upgrade pick ([#33](https://github.com/danielphilipjohnson/Flight-booking-agent/issues/33));
  no reliability-weighted ranking
  ([#34](https://github.com/danielphilipjohnson/Flight-booking-agent/issues/34)).
- Prices are static demo data — the live-vs-cached policy and
  "price may have changed" copy are tracked in
  [#35](https://github.com/danielphilipjohnson/Flight-booking-agent/issues/35).
- Pinned offers live in server memory per session; after a restart the agent
  re-searches instead of filtering.
