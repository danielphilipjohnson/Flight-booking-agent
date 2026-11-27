export type RuleCheck = { ok: true } | { ok: false; error: string };

function isoTime(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function checkSeatHoldable(
  seat: Record<string, unknown> | undefined,
  flightId: string,
  seatNo: string,
): RuleCheck {
  if (!seat) return { ok: false, error: `no seat ${seatNo} on flight ${flightId}` };
  if (seat.status !== "available") return { ok: false, error: `seat ${seatNo} is ${String(seat.status)}` };
  return { ok: true };
}

export function checkBookingConfirmable(
  booking: Record<string, unknown>,
  userRef: string,
  now: Date,
): RuleCheck {
  if (booking.user_ref !== userRef) {
    return { ok: false, error: "this booking does not belong to the session user" };
  }
  if (booking.status !== "held") {
    return { ok: false, error: `booking is ${String(booking.status)}, not held` };
  }
  if (booking.hold_expires_at && isoTime(booking.hold_expires_at) < isoTime(now)) {
    return { ok: false, error: "hold has expired" };
  }
  return { ok: true };
}

export function checkBookingCancellable(
  booking: Record<string, unknown>,
  userRef: string,
): { ok: true; alreadyCancelled: boolean } | { ok: false; error: string } {
  if (booking.user_ref !== userRef) {
    return { ok: false, error: "this booking does not belong to the session user" };
  }
  return { ok: true, alreadyCancelled: booking.status === "cancelled" };
}
