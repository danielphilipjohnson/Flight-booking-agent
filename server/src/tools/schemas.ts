import { z } from "zod";
import type { OllamaToolSchema } from "../agent/ollama.ts";

export interface ToolContext {
  userRef: string;
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

export const getFlightDetailsInput = z.object({
  flight_id: z.string().uuid(),
});

export const listAvailableSeatsInput = z.object({
  flight_id: z.string().uuid(),
  class: z.enum(["economy", "business"]).optional(),
});

export const listMyBookingsInput = z.object({});

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
