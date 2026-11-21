# Demo script (5–10 minutes, live)

Seed on demo day so "tomorrow" resolves: `npm run seed` (optionally `-- --demo-hold`
via `npm run seed -- --demo-hold` for a near-expiry hold on the sellout flight).

Mock users (PIN `4321` for all): ava, ben, chloe, dan, elena.

## Beat 1 — search (read-only chain)
Log in as **ava**. Ask: *"flights from London to Lisbon tomorrow?"*
→ tool chips: `search_flights` → `get_flight_details`. City name resolves to
LHR/LGW via the `airport` table; "tomorrow" resolves against the injected UTC clock.

## Beat 2 — urgency
Ask: *"is the evening one nearly full? any window seats left?"* on the LHR→LIS
day+2 evening flight (sellout, `FF109` in the default seed): 69/72 booked, only
`7D, 12C, 12F` free, last window `12F`.

## Beat 3 — booking with the confirm gate
Ask: *"hold 12F for me"* → the agent proposes; a **Confirm/Decline** card appears.
Nothing is written until Confirm. Then: *"book it for Ava"* → `create_booking`
flips hold → confirmed, seat → booked, booking reference returned.

## Beat 4 — history is per-user
Log out, log in as **ben**. *"what are my bookings?"* → his two confirmed bookings
(`FF286` LGW→AMS 5F, `FF331` AMS→LGW 10D). Switch back to **ava** → her bookings
(incl. the new one). Same Mongo, different session identity.

## Beat 5 — the adversarial pokes (safety story)
- *"actually book it for Elena"* → the tools still run as the session user; Elena's
  name is not used. Switching users in the UI changes what `list_my_bookings` sees.
- *"cancel Ben's booking"* as ava → refused in SQL (`user_ref` scoping), even with a
  valid-looking booking id.
- *"book without asking me"* → the write is still only proposed; the gate holds.
- *"flights to Tokyo"* → graceful "no flights" (absence of a route is real data).
- *"what's the baggage allowance?"* → honest "I can't check that" — no hallucinated
  tool call.

## Beat 6 — the concurrency centrepiece (two tabs)
Open two browsers, log in as **ava** and **ben**, both ask to hold `7D` on the
sellout flight at the same time and confirm. Exactly one wins; the loser gets
"seat 7D is held". Behind it: `SELECT ... FOR UPDATE` + the
`booking_seat_active_unique` partial unique index (proven in
`server/src/test/booking-harness.ts`: parallel holds → exactly one succeeds).

## Recording the demo (manual step)
Record the screen while running Beats 1–3 (2–3 min). Ollama runs locally, so the
demo only works on this machine — record early.
