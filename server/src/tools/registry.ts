import type { Queryable } from "../db/types.ts";
import { createBookingTools } from "./bookings.ts";
import { createFlightTools } from "./flights.ts";
import type { ToolContext, ToolDef } from "./schemas.ts";

export interface ConfirmedOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ToolRegistry {
  tools: ToolDef[];
  byName: (name: string) => ToolDef | undefined;
  executeConfirmed: (
    name: string,
    args: unknown,
    ctx: ToolContext,
  ) => Promise<ConfirmedOutcome>;
}

export function createToolRegistry(
  db: Queryable,
  opts: { holdMinutes: number },
): ToolRegistry {
  const tools = [...createFlightTools(db), ...createBookingTools(db, opts)];
  return {
    tools,
    byName: (name) => tools.find((t) => t.name === name),
    executeConfirmed: async (name, args, ctx) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) return { ok: false, error: `unknown tool: ${name}` };
      if (!tool.requiresConfirmation) {
        return { ok: false, error: `tool ${name} is not confirm-gated and runs inside the agent loop` };
      }
      const parsed = tool.schema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          error: `invalid arguments for ${name}: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        };
      }
      try {
        const result = await tool.run(parsed.data as never, ctx);
        if (
          result !== null &&
          typeof result === "object" &&
          typeof (result as { error?: unknown }).error === "string"
        ) {
          return { ok: false, error: (result as { error: string }).error };
        }
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: `tool ${name} failed: ${(err as Error).message}` };
      }
    },
  };
}
