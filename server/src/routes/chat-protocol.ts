import { z } from "zod";
import type { LoopEvent, LoopResult } from "../agent/loop.ts";

const chatBody = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(4000),
});

export type ParsedChatBody = { ok: true; sessionId: string; message: string } | { ok: false; error: string };

export function parseChatBody(body: unknown): ParsedChatBody {
  const parsed = chatBody.safeParse(body);
  if (!parsed.success) return { ok: false, error: "sessionId (uuid) and message are required" };
  return { ok: true, sessionId: parsed.data.sessionId, message: parsed.data.message };
}

export interface TurnStats {
  iterations: number;
  evalCount: number;
  promptEvalCount: number;
  compacted: boolean;
  latencyMs: number;
}

export function turnStats(result: Pick<LoopResult, "iterations" | "evalCount" | "promptEvalCount" | "compacted">, startedAt: number): TurnStats {
  return {
    iterations: result.iterations,
    evalCount: result.evalCount,
    promptEvalCount: result.promptEvalCount,
    compacted: result.compacted,
    latencyMs: Date.now() - startedAt,
  };
}

export function toSseFrame(event: LoopEvent, sessionId: string, startedAt: number): { event: string; data: unknown } {
  if (event.type === "done") {
    return {
      event: "done",
      data: {
        sessionId,
        reply: event.reply,
        toolTrace: event.toolTrace,
        pendingConfirmation: event.pendingConfirmation,
        stats: turnStats(event, startedAt),
      },
    };
  }
  return { event: event.type, data: event };
}
