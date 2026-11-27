import type { OllamaToolCall } from "./ollama.ts";
import type { ToolDef } from "../tools/schemas.ts";

export interface PendingConfirmation {
  tool: string;
  args: Record<string, unknown>;
  id?: string;
}

export type ResolvedToolCall =
  | { kind: "error"; error: string }
  | { kind: "execute"; def: ToolDef; args: never }
  | { kind: "gate"; pending: PendingConfirmation; note: string };

export function resolveToolCall(
  tools: ToolDef[],
  call: OllamaToolCall,
  opts: { makeProposalId?: (() => string) | undefined } = {},
): ResolvedToolCall {
  const def = tools.find((t) => t.name === call.function.name);
  if (!def) return { kind: "error", error: `unknown tool: ${call.function.name}` };
  const parsed = def.schema.safeParse(call.function.arguments);
  if (!parsed.success) {
    return {
      kind: "error",
      error: `invalid arguments for ${def.name}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  if (def.requiresConfirmation) {
    return {
      kind: "gate",
      pending: {
        tool: def.name,
        args: parsed.data as Record<string, unknown>,
        ...(opts.makeProposalId ? { id: opts.makeProposalId() } : {}),
      },
      note: `proposed ${def.name}; awaiting user confirmation`,
    };
  }
  return { kind: "execute", def, args: parsed.data as never };
}

export function summarizeResult(name: string, result: unknown): string {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.error === "string") return r.error;
    if (Array.isArray(r.results)) return `${name}: ${r.results.length} results`;
    if (Array.isArray(r.available_seats)) return `${name}: ${r.available_seats.length} seats`;
    if (Array.isArray(r.bookings)) return `${name}: ${r.bookings.length} bookings`;
    if (Array.isArray(r.seat_summary)) return `${name}: summary ok`;
  }
  return `${name}: done`;
}
