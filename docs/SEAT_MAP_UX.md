# Seat map & price display — design sketch

Status: **idea exploration** — no implementation yet.

## The problem

The agent currently answers a seat question with a flat list:

```
3A: 74.30
3B: 74.41
3C: 70.25
...
```

That format loses the information people actually use to choose a seat:

- **Position is gone.** It's hard to tell window from aisle, front from back, or
  which seats sit together.
- **Missing seats vanish.** A gap could mean sold, held, or physically absent.
- **Price has no context.** `€74.30` means nothing without "how does that compare?"
- **It's long.** 28–72 lines dominate the conversation and get truncated on mobile.
- **The model formats it.** Numbers, alignment, and omissions are all decided by
  the LLM, so output is inconsistent between turns.

## Design goals

1. Lead with the decision ("cheapest", "available") and keep the full detail one
   level down.
2. Preserve the plane's spatial layout — rows and columns must line up.
3. Make price comparison instant (heatmap + deltas), without losing the number.
4. Get the numbers from structured data, not from prose the model invents.
5. Work in a chat bubble, on a phone, and with a screen reader.

## Surface 1 — collapsed summary (default in chat)

This is what appears inline after "seats on FF104?". It answers the question
before asking the user to study a map.

```
┌─ Economy · FF104 · LHR → LIS · Fri 27 Nov ──────────────────┐
│                                                             │
│  28 available · from €68.54                                 │
│                                                             │
│  Cheapest overall   5D  €68.54   aisle, row 5               │
│  Cheapest window    9A  €79.88   window, row 9              │
│  Cheapest aisle     5D  €68.54   aisle, row 5               │
│                                                             │
│  [ Show seat map ▾ ]   [ Cheapest first ↗ ]                 │
└─────────────────────────────────────────────────────────────┘
```

Notes:

- One line of context (cabin, flight, route, date) so the card is still
  understandable when scrolled back to later.
- Prices are `€NN.NN` consistently, two decimals.
- Recommendations are derived, not authored by the model.
- If the user asked for something specific ("window seat under €75"), the
  recommendations mirror that request.

## Surface 2 — the seat map (expanded)

```
Seat map · Economy (rows 3–12)

             A      B      C    │    D      E      F
  3       74.30  74.41  70.25   │  70.26  69.64  75.46
  4       80.88  71.10  75.67   │  73.63  73.26  78.88
  5       78.34  71.26  72.88   │  68.54* 74.04  75.35
  6         ✕    70.44    ✕     │  75.53  71.14  77.46
  7       77.87  69.74  74.27   │  74.03  70.63  76.87
  8       75.64    ✕    75.94   │  75.40  70.15  75.87
  9       79.88    ✕    70.96   │  69.32  70.01  80.72
 10       71.22  75.43  73.55   │  74.17  72.91  78.03
 11       74.98  70.02  76.39   │  71.83  69.88  74.61
 12       80.14  73.47  71.65   │  75.06  72.32  76.20

  window   aisle   middle        middle  aisle  window

  ─── price ───
  ░ €68–70   ▒ €70–73   ▓ €73–76   █ €76+        ✕ unavailable

  [ Cheapest first ]   [ For 2 together ]   [ Hide map ▴ ]
```

Rules that make or break it:

- **Keep unavailable seats in the grid.** `✕` is intentionally different from
  "no cell". Never renumber or collapse rows.
- **A–F columns are always present and aligned**, even when an entire column is
  sold out in that row.
- **Aisle gap between C and D**, plus a subtle divider between business (1–2)
  and economy (3–12).
- **Colour is secondary.** The price is always printed; the tint just makes the
  cheap cluster pop. Use per-flight min/max for the scale so contrast is real.
- **`*` marks the current selection or the cheapest reference**, explained in
  the legend.
- **Row direction is explicit** — "row 3 is the front" — ideally with a small
  nose-of-plane cue above the header.
- **Held vs sold.** Held seats (someone has a live hold) can be shown as `◐`
  with a tooltip/expiry; booked/unavailable as `✕`. If that distinction isn't
  available, use `✕` for both and say so in the legend.

### Price presentation options

| Approach | Use when | Tradeoff |
| --- | --- | --- |
| Absolute price | General browsing | Hard to compare across 30 cells |
| Delta from cheapest (`+€6.74`) | User is price-driven | Less useful as an actual fare |
| Heatmap tint + absolute price | Default | Needs a legend and accessible fallback |
| Price bands in legend | Very small screens | Loses the exact number |

Recommendation: **heatmap tint + absolute price**, with deltas available as a
toggle or in the cheapest list.

## Surface 3 — cheapest-first list (alternate view)

Some people don't want a plane, they want a sorted list. Offer it as a tab, not
a replacement.

```
[ Map ] [ Cheapest ] [ For 2 ]

Cheapest first
  5D   €68.54   aisle    row 5
  9D   €69.32   aisle    row 9
  5E   €69.64   middle   row 5
 10E   €69.88   middle   row 10
  7B   €69.74   middle   row 7
  ...
```

- Compact rows: seat, price, position, row.
- Stable sort (price, then row, then letter) so repeated opens don't reshuffle.
- Tapping a row selects it and optionally highlights it on the map.

## Surface 4 — travelling together

"Seats for 2/3 together" is a distinct question and should be a filter, not
something the user has to reverse-engineer from the map.

```
For 2 travelling together

  Row 5   D + E   €142.58   aisle + middle
  Row 9   E + F   €142.74   middle + window
  Row 4   B + C   €146.77   middle + middle
  Row 7   A + B   €147.61   window + middle

  [ Show on map ]
```

- Only show contiguous, same-row blocks.
- Show the combined price, the per-seat split, and the pair type.
- For 3+, reuse the same pattern; cap combinations so the list stays short.

## Selection & confirmation

Selecting a seat should not silently write anything. It stages a proposal:

```
┌─ Selected ──────────────────────────────────┐
│  5D · aisle · row 5                         │
│  €68.54                                     │
│                                             │
│  [ Hold seat for 10 min ]   [ Clear ]       │
└─────────────────────────────────────────────┘
```

- "Hold" goes through the existing confirm-before-write gate.
- The chat bubble can then show: "Holding 5D for 10 minutes — expires at 14:58."
- After confirmation, the seat cell flips to `◐` and the summary updates.
- Keep the confirm card visible in history so the audit trail reads naturally.

## Cabin separation

Business (rows 1–2) prices are a different scale and would skew the economy
heatmap. Options:

- **Collapsed section header** above the map: "Business · from €296.44 · show 12 seats".
- **Separate tabs**: Economy | Business.
- Never mix both cabins in one colour scale unless the scale is global to the
  flight.

## States to design (not just the happy path)

| State | What the card shows |
| --- | --- |
| Loading seats | Skeleton map or "Checking availability…" |
| No seats available | "No seats left in economy on this flight" + alternatives |
| Single seat left | Summary + that seat, no map needed |
| Selected | Highlighted cell + hold card |
| Held by someone else | `◐` marker with expiry ("held until 14:52") |
| Stale data | "Availability may have changed — refresh" before hold |
| Hold expired | "Your hold on 5D expired" + re-hold action |
| Write rejected | Existing error chip + the map re-syncs |

## Mobile

A 6-column map fits on a modern phone only if each cell is compact. Options:

1. **Two-line cells** — seat letter above price:
   ```
    A      B      C   │  D      E      F
   74.30  74.41  70.25│ 70.26  69.64  75.46
   ```
2. **Horizontal scroll** with the row-number column pinned.
3. **Default to the cheapest list** below ~380 px, with "Show map" as opt-in.
4. **Landscape hint** for the map view.

Recommendation: cheapest list as the default on narrow screens, map one tap
away.

## Accessibility

- Don't encode availability or price only in colour; always include text or a
  symbol (`✕`, `€68.54`).
- Seat cells need accessible labels: "Seat 5D, aisle, economy, €68.54, available".
- Provide a table/list alternative to the visual map (the cheapest list covers
  this).
- Hit targets ≥ 44 px on touch.
- Announce selection changes and hold confirmations with a live region.

## What the card needs from the tool

The agent should return structured data and a short prose summary. The model
should never retype the prices.

| Field | Example | Why |
| --- | --- | --- |
| `flight_id`, `flight_no` | `FF104` | Link the hold action to the right flight |
| `origin`, `destination`, `date` | LHR → LIS, 2026-11-27 | Card header context |
| `cabin` | economy | Separate sections / scales |
| `currency` | EUR | Formatting, locale |
| `rows` | 3–12 | Grid bounds |
| `letters` | A–F | Grid bounds, aisle position |
| `seat_no` | 5D | Identity |
| `price` | 68.54 | Display + sorting |
| `status` | available / held / booked | Cell rendering |
| `position` | window / aisle / middle | Derived labels |
| `hold_expires_at` | 2026-11-26T14:58Z | Held-cell tooltip |
| `computed.min_price` | 68.54 | Summary + heatmap scale |
| `computed.cheapest_window` | 9A | Recommendation |
| `computed.cheapest_aisle` | 5D | Recommendation |
| `computed.pairs` | list | "For 2" view |

Client-side derived (not sent): heatmap buckets, deltas from cheapest, sorted
views, adjacency blocks. Keeping derivation in the UI means one payload serves
all three surfaces.

## Agent/chat boundary

- The **tool** returns the structured seat payload plus a one-line factual
  summary.
- The **model** may write a sentence ("28 seats left, cheapest is 5D at €68.54")
  but must not enumerate seats or prices by hand.
- The **UI** renders the card from the payload and attaches it to the assistant
  turn.
- History stores the payload, so reopening a conversation redraws the same card
  instead of a stale text dump.

## Suggested phasing

| Phase | Scope | Effort | Value |
| --- | --- | --- | --- |
| 1 | Summary block + collapsible map with `✕` gaps | Small | Removes the wall of text, restores spatial info |
| 2 | Price heatmap + legend + cheapest-first toggle | Medium | Makes price comparison instant |
| 3 | Selection + hold from the card (reuses confirm gate) | Medium | Turns display into a real booking flow |
| 4 | "For 2 together" + held-expiry markers | Medium | Handles the most common group case |
| 5 | Structured payload stored in history, re-rendered on reopen | Medium | Consistent history, no model-formatted numbers |

Doing Phase 1 alone is already a large improvement over the flat list.

## Open questions

- Should held seats be visually distinct from booked, or is "unavailable" enough?
- Do we need a global (all flights) or per-flight price scale for the heatmap?
- Is the card interactive in the chat transcript, or only on the last turn?
- Group sizes: 2–3 only, or arbitrary parties?
- Currency: fixed EUR for the demo, or per-user locale?
- How do we handle price changes between rendering the card and holding the seat
  (re-validate on hold, show the new price if it moved)?
