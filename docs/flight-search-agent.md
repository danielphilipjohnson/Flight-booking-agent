# The flight search agent (Phase 2)

How the search stage of the flight booking agent works, and how conversations
are designed to flow. The design follows the phase notes for the search stage:
intent capture first, live tool-backed results, and conversational refinement
instead of filter sidebars.

For architecture and setup, see the [README](../README.md). Tool implementations live in `server/src/tools/`; this guide explains the search stage's behavior. For the wider
funnel-top roadmap — round trips, fare details, comparison, price tracking —
and the full chat-scenario catalog, see
[scoping/shopping-search-scenarios.md](scoping/shopping-search-scenarios.md).

## What it is

A tool-calling agent. The user chats; a local LLM (Ollama, `gemma4:12b` by
default, configurable via `OLLAMA_MODEL`) decides which tools to call against
Postgres, then presents results as a recommendation with alternatives. The
search stage is read-only: the agent can search, filter and pin offers, but
never writes. Booking tools (`hold_seat`, `create_booking`,
`cancel_booking`) exist in the same registry and run behind the confirm gate
— the agent must state the plan and get explicit confirmation first.

The agent layer lives in `server/src/agent/` + `server/src/tools/`:

| Module | Role |
| --- | --- |
| `loop.ts` | `driveLoop`: model call -> tool calls -> model call, iteration cap, confirm gate, context compaction |
| `tools/flights.ts` | The nine read tools, Zod-validated before SQL |
| `tools/schemas.ts` | Zod input schemas + Ollama schema mapping |
| `tools/registry.ts` | Tool registry + confirm-gate execution |
| `prompt.ts` | Dynamic system prompt: clock, routes from the DB, conversation rules |
| `context.ts` | Sliding-window history with ID-preserving compaction |
| `ollama.ts` | Streaming `/api/chat` client with chunk assembly |

## The tools

| Tool | When it fires | What it returns |
| --- | --- | --- |
| `search_flights` | The user wants flights for a specific date (optional `return_date` for round trips) | Outbound flights sorted by departure (`flight_id`, `flight_no`, airports, times, duration, `base_price`, `on_time_pct`); round trips add `return_results` and `round_trip_total_from` (or `empty_leg` when one leg has no flights) |
| `search_flexible_prices` | The date is vague ("next week", "around the 14th") | Per-day cheapest prices over the window, `cheapest_day` highlighted |
| `search_anywhere` | The user has no destination and no theme ("where can I go for under 300?") | Up to 10 destinations from the origin, cheapest-price order |
| `search_inspiration` | The user has a theme, not a place ("somewhere warm", "beach", "skiing") | Theme-matched destinations price-ranked (beach: LIS/BCN/MAD) |
| `filter_offers` | Refining the last search ("cheaper", "not before noon") | Filtered + re-sorted results from the pinned last search, no re-query |
| `find_first_available_flight` | The date is open-ended ("any day this month") | First date with flights in the range, plus that day's flights |
| `get_flight_details` | "Is a carry-on included?", "can I cancel?" | Flight facts (airline, on-time pct) plus per-class `fare_rules`: cheapest available seat's fare brand (Basic/Standard/Flex), bags, refundability, change fee, price |
| `list_available_seats` | The user cares about the specific seat | Seat map for a flight: row, letter, cabin, status, fare brand |
| `list_my_bookings` | "What have I booked?" | The session user's holds and bookings |
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
   vague dates go to `search_flexible_prices`.
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
    last results it presented; when the user picks, the agent repeats the key
    details.

## Expected conversation flows

The user sees tool activity as chips in the chat; flows below show them as
`[tool]` lines. Examples are illustrative but follow the dataset's shape
(10 directed routes, 3 daily waves, EUR prices, UTC times) — e.g. London ->
Paris is `LHR -> CDG`, London -> Barcelona does not exist.

### 1. Fuzzy date, defaults applied

> **User:** flights to Paris next month
>
> `[search_flexible_prices] origin: London, destination: Paris, from_date: 2026-12-01, days: 7`
>
> **Agent:** I'll assume 1 adult in economy. Over the first week of December,
> the cheapest day to fly London -> Paris is Tue 8 Dec at **56 EUR**. My pick
> for that day:
>
> **FF209 (LHR -> CDG), Tue 8 Dec, 12:20 -> 13:35 UTC, 1h 15m, 56 EUR, on time 96%**
>
> Fastest alternative — FF210, 13:05 -> 14:21 UTC, 1h 16m, 59 EUR.
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
> **FF211 (LHR -> CDG), 17:40 -> 18:57 UTC, 1h 17m, 174 EUR for 2, on time 94%**
> **Cheapest — FF213, 19:05 -> 20:22 UTC, 1h 17m, 180 EUR for 2**
>
> Want to see more, or shall I loosen the price cap?

`filter_offers` works on the offers pinned by the last search — no database
round trip. Filters: `max_price` (total for the party), `depart_after` /
`depart_before` (UTC), `sort` (best / cheapest / fastest).

### 5. "The second one" — pinned context

> **User:** actually show me the second one again
>
> `[get_flight_details] flight_id: <FF213's id>`
>
> **Agent:** That's FF213 (LHR -> CDG), 19:05 -> 20:22 UTC, 1h 17m, 90 EUR per
> person, on time 93%. Cheapest available fare is Standard — carry-on + 1
> checked bag included, 25 EUR change fee. Want me to keep it as your pick?

The agent maps ordinal references to the order of the last results it
presented. When the user picks an option, the agent re-checks it with
`get_flight_details`, repeats the key details, and treats it as pinned — the
handoff point for the confirm -> `hold_seat` -> passenger details flow.

### 6. No results — alternatives, not a dead end

> **User:** Manchester to Lisbon on the 5th
>
> `[search_flights] origin: Manchester, destination: Lisbon, date: 2026-12-05`
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

Search results are live reads, not expiring quotes: each offer carries
`flight_id`, `flight_no`, origin -> destination with airports, departure and
arrival times (UTC), duration, `base_price` (EUR, demo data), and
`on_time_pct`. Fare rules are not per-offer — the agent calls
`get_flight_details` and reads the per-class `fare_rules` block: each class's
cheapest available seat with its fare brand (**Basic** — no carry-on,
non-refundable, 45 EUR change fee / **Standard** — carry-on + 1 bag, 25 EUR
change fee / **Flex** — refundable, 2 bags). The prompt owns presentation:
lead with one recommendation plus at most two alternatives (cheapest,
fastest), one line each on why; never hide a Basic Economy fare's missing
carry-on next to its price; mention the on-time percentage when two options
are close; flag an upgrade when business is within about 150 EUR per person
of economy. `filter_offers` can re-sort the pinned search by `best` (price +
duration + on-time composite score), `cheapest`, or `fastest`.

## Edge cases

| Case | Behavior |
| --- | --- |
| Unknown place ("Tokyo") | Tool returns the known airport list; agent explains the dataset limits and asks what to do |
| Round trip with one empty leg | Tool names the empty leg, suggests for that leg only |
| Theme with no destinations ("skiing") | Tool lists the supported themes; agent offers the closest available |
| Ambiguous date ("the 14th") | One clarifying question before searching |
| Multi-airport city ("London") | All airports searched; offers labelled with airport |
| Date outside the 14-day window | Agent states the window and offers in-window alternatives |
| No results | Nearby dates + reachable destinations suggested |
| Model loops or hallucinates a tool | 8-round cap; unknown tools and invalid arguments return error text the model must recover from |

## Fuzzing

| Command | Needs | What it does |
| --- | --- | --- |
| `npm run fuzz` | nothing | Deterministic offline fuzzer (seed 42, 1600 cases) over the pure layers: every tool's schema against random junk, the airport resolver's contract over random strings, date helpers over random inputs, and `filter_offers` against random pins on a sqlite-backed registry |
| `npm run fuzz:live` | Postgres + seeded data | Generates randomized *valid* tool arguments (places, dates, uuids), runs the real SQL tools, and asserts result invariants: every offer carries a positive `base_price` and an in-band `on_time_pct`, round-trip `round_trip_total_from` equals the cheapest legs, flexible-price days are ascending with a correct `cheapest_day`, browse results are price-sorted and respect `max_price`, unknown uuids error, and `filter_offers` respects its own filters. Roughly every other successful search is followed by a randomized `filter_offers` chain. |
| `npm run fuzz:agent` | full stack + Ollama | Runs the real `driveLoop` against randomized user openings (destinations, fuzzy dates, party sizes, themes), each in its own Mongo session. Asserts the loop completes within the round cap, replies are non-empty, only known tools are invoked, and every turn lands in Mongo history. Prints transcripts per session. |

All three are seeded (`FUZZ_SEED`, default 42) so failures reproduce. Scale
with `FUZZ_ITERATIONS` (live) and pick the persona with `FUZZ_USER` /
`FUZZ_PIN` (agent). Run order: `docker compose up -d`, `npm run seed`, then
`npm run fuzz:live` / `npm run fuzz:agent`. Re-seed first if the seed day has
drifted, otherwise most date-window searches will correctly return empty.

## Current limits

- Multi-city / open-jaw itineraries are not implemented (see the
  [scoping doc](scoping/shopping-search-scenarios.md), section C).
- Child / infant fares are not modeled; the agent should say so.
- One airline (FlyFast) — airline and alliance filters are vacuous for now.
- Prices are static demo data — see "Prices & offers (policy)" in the README;
  the confirm gate owns the "price may have changed" re-validation before any
  write.
- Pinned offers live in server memory per session (capped, FIFO); after a
  restart the agent re-searches instead of filtering.
