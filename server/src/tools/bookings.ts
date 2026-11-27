import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/types.ts";
import { iso, releaseExpiredHoldsStatements } from "./flights.ts";
import { checkBookingCancellable, checkBookingConfirmable, checkSeatHoldable } from "./rules.ts";
import {
  cancelBookingInput,
  createBookingInput,
  holdSeatInput,
  toolToOllamaSchema,
  type ToolContext,
  type ToolDef,
} from "./schemas.ts";

function inTx(db: Queryable, fn: (q: Queryable) => Promise<unknown>): Promise<unknown> {
  return db.tx ? db.tx(fn) : fn(db);
}

export function createBookingTools(db: Queryable, opts: { holdMinutes: number }): ToolDef[] {
  const holdSeat: ToolDef = {
    name: "hold_seat",
    description:
      "Hold a seat on a flight for the session user. Transactional: row-locks the seat (SELECT ... FOR UPDATE) so two concurrent holds can never both win. Requires user confirmation before it runs.",
    schema: holdSeatInput,
    requiresConfirmation: true,
    run: async (args, ctx: ToolContext) => {
      const { flight_id, seat_no, hold_minutes } = holdSeatInput.parse(args) as {
        flight_id: string;
        seat_no: string;
        hold_minutes?: number;
      };
      const minutes = hold_minutes ?? opts.holdMinutes;
      return inTx(db, async (q) => {
        const now = new Date();
        await releaseExpiredHoldsStatements(q, now);
        const seats = (
          await q.query(
            "SELECT seat_no, class, price, status FROM seat WHERE flight_id = $1 AND seat_no = $2 FOR UPDATE",
            [flight_id, seat_no],
          )
        ).rows;
        const seat = seats[0]!;
        const seatCheck = checkSeatHoldable(seat, flight_id, seat_no);
        if (!seatCheck.ok) return { error: seatCheck.error };
        const holdExpiresAt = new Date(now.getTime() + minutes * 60_000);
        const holdId = randomUUID();
        await q.query(
          "INSERT INTO booking (id, user_ref, status, passenger_name, created_at, hold_expires_at) VALUES ($1, $2, 'held', $3, $4, $5)",
          [holdId, ctx.userRef, ctx.displayName ?? ctx.userRef, iso(now), iso(holdExpiresAt)],
        );
        await q.query(
          "UPDATE seat SET status = 'held', hold_expires_at = $3 WHERE flight_id = $1 AND seat_no = $2",
          [flight_id, seat_no, iso(holdExpiresAt)],
        );
        try {
          await q.query(
            "INSERT INTO booking_seat (booking_id, flight_id, seat_no, active) VALUES ($1, $2, $3, TRUE)",
            [holdId, flight_id, seat_no],
          );
        } catch (err) {
          const code = (err as { code?: string }).code;
          const message = (err as Error).message;
          if (code === "23505" || /UNIQUE constraint failed/i.test(message)) {
            return { error: `seat ${seat_no} was just taken by another booking` };
          }
          throw err;
        }
        return {
          hold_id: holdId,
          seat_no,
          flight_id,
          class: seat.class,
          price: seat.price,
          hold_expires_at: iso(holdExpiresAt),
        };
      });
    },
    toOllamaSchema: () =>
      toolToOllamaSchema({
        name: "hold_seat",
        description: holdSeat.description,
        parameters: {
          type: "object",
          properties: {
            flight_id: { type: "string", format: "uuid" },
            seat_no: { type: "string", description: "e.g. 12A; rows 1-12, letters A-F" },
            hold_minutes: { type: "integer", minimum: 1, maximum: 60 },
          },
          required: ["flight_id", "seat_no"],
        },
      }),
  };

  const createBooking: ToolDef = {
    name: "create_booking",
    description:
      "Convert a hold into a confirmed booking for the session user. Re-verifies ownership, held status, and expiry in SQL inside one transaction. Requires user confirmation before it runs.",
    schema: createBookingInput,
    requiresConfirmation: true,
    run: async (args, ctx: ToolContext) => {
      const { hold_id, passenger_name } = createBookingInput.parse(args) as {
        hold_id: string;
        passenger_name: string;
      };
      return inTx(db, async (q) => {
        const now = new Date();
        await releaseExpiredHoldsStatements(q, now);
        const rows = (
          await q.query(
            "SELECT id, user_ref, status, hold_expires_at FROM booking WHERE id = $1 FOR UPDATE",
            [hold_id],
          )
        ).rows;
        if (rows.length === 0) return { error: `no booking with id ${hold_id}` };
        const b = rows[0]!;
        const confirmCheck = checkBookingConfirmable(b, ctx.userRef, now);
        if (!confirmCheck.ok) return { error: confirmCheck.error };
        await q.query(
          "UPDATE booking SET status = 'confirmed', passenger_name = $2, hold_expires_at = NULL WHERE id = $1",
          [hold_id, passenger_name],
        );
        const claims = (
          await q.query(
            "SELECT flight_id, seat_no FROM booking_seat WHERE booking_id = $1 AND active = TRUE",
            [hold_id],
          )
        ).rows;
        for (const claim of claims) {
          await q.query(
            "UPDATE seat SET status = 'booked', hold_expires_at = NULL WHERE flight_id = $1 AND seat_no = $2",
            [claim.flight_id, claim.seat_no],
          );
        }
        return { booking_id: hold_id, status: "confirmed", passenger_name };
      });
    },
    toOllamaSchema: () =>
      toolToOllamaSchema({
        name: "create_booking",
        description: createBooking.description,
        parameters: {
          type: "object",
          properties: {
            hold_id: { type: "string", format: "uuid", description: "hold_id returned by hold_seat" },
            passenger_name: { type: "string" },
          },
          required: ["hold_id", "passenger_name"],
        },
      }),
  };

  const cancelBooking: ToolDef = {
    name: "cancel_booking",
    description:
      "Cancel one of the session user's bookings and release its seat back to available. Ownership is re-checked in SQL even if the ID was hallucinated. Idempotent: cancelling an already-cancelled booking is a clean refusal. Requires user confirmation before it runs.",
    schema: cancelBookingInput,
    requiresConfirmation: true,
    run: async (args, ctx: ToolContext) => {
      const { booking_id } = cancelBookingInput.parse(args) as { booking_id: string };
      return inTx(db, async (q) => {
        const rows = (
          await q.query(
            "SELECT id, user_ref, status FROM booking WHERE id = $1 FOR UPDATE",
            [booking_id],
          )
        ).rows;
        if (rows.length === 0) return { error: `no booking with id ${booking_id}` };
        const b = rows[0]!;
        const cancelCheck = checkBookingCancellable(b, ctx.userRef);
        if (!cancelCheck.ok) return { error: cancelCheck.error };
        if (cancelCheck.alreadyCancelled) return { booking_id, status: "cancelled" };
        const claims = (
          await q.query(
            "SELECT flight_id, seat_no FROM booking_seat WHERE booking_id = $1 AND active = TRUE",
            [booking_id],
          )
        ).rows;
        for (const claim of claims) {
          await q.query(
            "UPDATE seat SET status = 'available', hold_expires_at = NULL WHERE flight_id = $1 AND seat_no = $2",
            [claim.flight_id, claim.seat_no],
          );
        }
        await q.query("UPDATE booking_seat SET active = FALSE WHERE booking_id = $1", [booking_id]);
        await q.query("UPDATE booking SET status = 'cancelled' WHERE id = $1", [booking_id]);
        return { booking_id, status: "cancelled" };
      });
    },
    toOllamaSchema: () =>
      toolToOllamaSchema({
        name: "cancel_booking",
        description: cancelBooking.description,
        parameters: {
          type: "object",
          properties: {
            booking_id: { type: "string", format: "uuid" },
          },
          required: ["booking_id"],
        },
      }),
  };

  return [holdSeat, createBooking, cancelBooking];
}
