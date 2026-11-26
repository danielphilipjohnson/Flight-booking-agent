import { z } from "zod";
import type { OllamaToolSchema } from "../agent/ollama.ts";

export interface ToolContext {
  userRef: string;
  displayName?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  requiresConfirmation?: boolean;
  run: (args: never, ctx: ToolContext) => Promise<unknown>;
  toOllamaSchema: () => OllamaToolSchema;
}

export const searchFlightsInput = z.object({
  origin: z.string().min(2).max(40).describe("IATA code or city name, e.g. LHR or London"),
  destination: z.string().min(2).max(40).describe("IATA code or city name, e.g. LIS or Lisbon"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD"),
});

export const findFirstAvailableFlightInput = z.object({
  origin: z
    .string()
    .min(2)
    .max(40)
    .optional()
    .describe("IATA code or city name; omit together with destination to search every route"),
  destination: z
    .string()
    .min(2)
    .max(40)
    .optional()
    .describe("IATA code or city name; omit together with origin to search every route"),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "ISO month YYYY-MM")
    .optional()
    .describe("Month to search, e.g. 2026-11; defaults to the current UTC month"),
  from_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD")
    .optional()
    .describe("Start of an explicit date range"),
  to_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD")
    .optional()
    .describe("End of an explicit date range, inclusive"),
  class: z.enum(["economy", "business"]).optional(),
});

export const getFlightDetailsInput = z.object({
  flight_id: z.string().uuid(),
});

export const listAvailableSeatsInput = z.object({
  flight_id: z.string().uuid(),
  class: z.enum(["economy", "business"]).optional(),
});

export const listMyBookingsInput = z.object({});

export const holdSeatInput = z.object({
  flight_id: z.string().uuid(),
  seat_no: z.string().regex(/^([1-9]|1[0-2])[A-F]$/, "seat like 12A"),
  hold_minutes: z.number().int().min(1).max(60).optional(),
});

export const createBookingInput = z.object({
  hold_id: z.string().uuid(),
  passenger_name: z.string().min(1).max(100),
});

export const cancelBookingInput = z.object({
  booking_id: z.string().uuid(),
});

export function toolToOllamaSchema(def: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}): OllamaToolSchema {
  return {
    type: "function",
    function: { name: def.name, description: def.description, parameters: def.parameters },
  };
}
