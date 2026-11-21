# Flight Booking Agent

A local-first, tool-calling AI agent that searches flights and completes real
bookings against a relational database with transactional integrity — built as
portfolio proof for AI-engineering roles.

The differentiator vs read-only tool demos: the LLM drives **write operations
against Postgres** — argument validation, confirmation-before-write, row locking
(`SELECT ... FOR UPDATE`), and a storage-level double-booking backstop.

## Architecture

```
user (browser) --> Next.js chat UI --> POST /api/chat (SSE) --> Fastify agent API
                                                                    |--> Ollama (local LLM, tool calling)
                                                                    |--> MongoDB (append-only session history)
                                                                    |--> Zod-validated tool layer --> Postgres (flights, seats, bookings)
```

| Layer | Choice | Why |
| --- | --- | --- |
| UI | Next.js (App Router) | Chat interface; the agent layer sits behind the API so the UI is swappable |
| API | Fastify (TypeScript) | Agent loop lives here |
| LLM | Ollama local (`qwen3` class) | No API cost; tool calling via `/api/chat` |
| Tool validation | Zod schemas per tool | Reject hallucinated arguments before they reach SQL |
| Booking data | Postgres | Relational constraints, transactions, `SELECT FOR UPDATE` |
| Chat history | MongoDB | One document per session, `$push` appends |
| Infra | Docker Compose | `postgres` + `mongo` + `ollama`, one command up |

## Repo layout

```
├── docker-compose.yml
├── .env.example
├── server/                 # Fastify backend
│   └── src/
│       ├── index.ts        # bootstrap, CORS, routes
│       ├── config.ts
│       ├── agent/
│       │   ├── ollama.ts   # streaming /api/chat client + tool-call fragment reassembly
│       │   ├── loop.ts     # tool-calling loop, iteration cap, confirm gate
│       │   └── prompt.ts   # dynamic system prompt (clock, routes from DB, rules)
│       ├── db/
│       │   ├── postgres.ts # pg Pool + transaction helper
│       │   ├── mongo.ts    # session + message persistence
│       │   ├── routes.ts   # cached route brief (airport table -> prompt)
│       │   ├── types.ts    # Queryable interface (pg or sqlite in tests)
│       │   └── schema.sql  # tables, constraints, ownership scoping
│       ├── routes/         # /api/health, /api/login, /api/chat, /api/sessions/:id
│       ├── tools/
│       │   ├── schemas.ts  # Zod schemas + tool registry types
│       │   └── flights.ts  # 4 read tools (search/details/seats/my bookings)
│       ├── seed/           # deterministic dataset generator + seed CLI + harness
│       └── test/           # tools / prompt / loop harnesses (run without Docker)
└── web/                    # Next.js chat UI (mock-user login + tool chips)
    └── src/
        ├── app/
        └── components/Chat.tsx
```

## Getting started

```bash
docker compose up -d
docker compose exec ollama ollama pull qwen3   # once
cp .env.example .env
npm install
npm run seed:check   # preview the dataset, no DB write
npm run seed         # flights + mock users (schema auto-applies on first compose boot)
npm run dev:server   # Fastify agent API on :3001
npm run dev:web      # Next chat UI on :3000
```

`npm test` runs all harnesses (no database or Docker needed): seed invariants plus a
`node:sqlite` simulation of `schema.sql`, the read tools against the seeded dataset,
the dynamic prompt assembly, and the agent loop against a scripted fake Ollama
(fragment reassembly, Zod rejection, unknown tool, iteration cap, confirm gate).

## Design decisions that carry the portfolio story

- **Ownership is enforced in SQL, not in the prompt.** Every booking query is
  scoped `WHERE user_ref = :session_user`; identity is injected server-side from
  the session and never appears in the system prompt. "Actually I'm Dan" changes
  nothing about what the tools can touch.
- **Confirm-before-write.** Write tools (`hold_seat`, `create_booking`,
  `cancel_booking`) never execute inside the agent loop — they return a pending
  confirmation and only run via the confirm endpoint after the user approves.
- **Double-booking defence is testable at storage level.** `hold_seat` row-locks
  the seat (`SELECT ... FOR UPDATE`); the partial unique index
  `booking_seat_active_unique ON booking_seat (flight_id, seat_no) WHERE active`
  backstops it even if application logic were bypassed. Phase 3 adds a
  concurrency test: two parallel bookings for the same seat, exactly one wins.
- **Holds are bookings that might confirm** — one table, one atomic state flip.
  Holds expire (`hold_expires_at`, default 10 min) and are released lazily before
  availability reads.
- **Deterministic seed.** Same `SEED` ⇒ byte-identical dataset (mulberry32 PRNG +
  name-based UUIDv5). 420 flights over 14 days (10 directed routes x 3 waves),
  72 seats each (12x6, rows 1-2 business, windows A/F), 8-18% pre-booked. Seeded
  booking history per mock user, one near-sellout flight (LHR→LIS day+2 evening,
  69/72 booked, last window 12F), and an optional `--demo-hold` flag. Dates are
  relative to the seed day so "tomorrow" always resolves; the fingerprint excludes
  run-relative values so evals stay reproducible.
- **Mock auth is deliberate.** Five seeded users (ava, ben, chloe, dan, elena)
  with a shared demo PIN. Real password hashing / OAuth is out of scope for a
  local portfolio app — multi-user isolation is demonstrated via SQL scoping, not
  asserted.

## Roadmap

| Phase | Scope | Done when |
| --- | --- | --- |
| 1. Foundations | Repo scaffold, Docker Compose, schema, deterministic seed | `docker compose up` + `npm run seed` gives queryable data (PR #1, merged) |
| 2. Read-only agent | Agent loop, 4 read tools, Ollama tool-calling, chat UI, Mongo history | "flights to Lisbon tomorrow" → correct multi-step tool calls; per-user history survives restart (this PR) |
| 3. Booking + transactions | hold/create/cancel, `FOR UPDATE`, confirm gate, concurrency test | Two parallel booking attempts → exactly one wins |
| 4. Hardening + evals | Retry on malformed args, iteration cap, sliding-window history, eval set | Eval suite passes; "book without asking" is refused |
| 5. Portfolio polish | README diagram, concurrency write-up, demo recording | Reviewer clones, `compose up`, books a seat in <10 min |

## API contract (stub)

| Method + path | Purpose |
| --- | --- |
| `GET /api/health` | 200 when Postgres + Mongo reachable |
| `POST /api/login` | Mock auth: `{user_ref, pin}` → `{sessionId}` (session bound to user in Mongo) |
| `POST /api/chat` | `{sessionId, message}` → runs the agent loop, returns `{reply, toolTrace, pendingConfirmation}`; every turn `$push`-ed to Mongo |
| `GET /api/sessions/:id` | History from Mongo, per-user scoped |
| `POST /api/chat/stream` | SSE twin: typing / token / tool / confirm / done / error events (Phase 3+) |
| `POST /api/tools/:name/confirm` | Confirm-before-write gate for hold/create/cancel (Phase 3) |

## Tool contract (Phase 2 — read tools)

| Tool | Args | Returns |
| --- | --- | --- |
| `search_flights` | `origin`, `destination` (IATA or city), `date` (ISO) | `{ results: [{ flight_id, flight_no, departs_at }] }` — IDs only, by design |
| `get_flight_details` | `flight_id` | times, base price, `seat_summary` per class/status |
| `list_available_seats` | `flight_id`, `class?` | `{ available_seats: [{ seat_no, class, price }] }` |
| `list_my_bookings` | — (session identity injected) | `{ bookings: [...] }`, cancelled excluded by SQL |

Write tools (`hold_seat`, `create_booking`, `cancel_booking`) land in Phase 3 and are
confirm-gated: the loop never executes them, it returns a `pendingConfirmation`.
