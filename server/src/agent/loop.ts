import { assembleChat, type ChatChunk, type OllamaClient, type OllamaMessage } from "./ollama.ts";
import { selectContext, type ContextOptions } from "./context.ts";
import { toOllamaMessages } from "./prompt.ts";
import type { ToolContext, ToolDef } from "../tools/schemas.ts";
import type { StoredMessage } from "../db/mongo.ts";

export interface ToolTraceEntry {
  name: string;
  status: "ok" | "error" | "pending_confirmation";
  summary: string;
}

export interface PendingConfirmation {
  tool: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface LoopResult {
  reply: string;
  toolTrace: ToolTraceEntry[];
  pendingConfirmation: PendingConfirmation | null;
  iterations: number;
  evalCount: number;
  promptEvalCount: number;
  compacted: boolean;
}

export type LoopEvent =
  | { type: "typing" }
  | { type: "token"; text: string }
  | { type: "tool"; name: string; status: ToolTraceEntry["status"]; summary: string }
  | { type: "confirm"; pending: PendingConfirmation }
  | {
      type: "done";
      reply: string;
      toolTrace: ToolTraceEntry[];
      pendingConfirmation: PendingConfirmation | null;
      iterations: number;
      evalCount: number;
      promptEvalCount: number;
      compacted: boolean;
    };

export const DEFAULT_MAX_ITERATIONS = 8;

function summarize(name: string, result: unknown): string {
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

export async function driveLoop(opts: {
  client: OllamaClient;
  model: string;
  systemPrompt: string;
  history: StoredMessage[];
  userMessage: string;
  tools: ToolDef[];
  ctx: ToolContext;
  maxIterations?: number;
  context?: ContextOptions;
  signal?: AbortSignal;
  onEvent?: (event: LoopEvent) => void | Promise<void>;
  persist?: (messages: StoredMessage[]) => Promise<void>;
  makeProposalId?: () => string;
}): Promise<LoopResult> {
  const {
    client,
    model,
    systemPrompt,
    history,
    userMessage,
    tools,
    ctx,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    context,
    signal,
    onEvent,
    persist,
    makeProposalId,
  } = opts;

  let compacted = false;
  let historyForModel = history;
  if (context) {
    const compact =
      context.compact ??
      (async (prompt: string) => {
        const chunks: ChatChunk[] = [];
        for await (const chunk of client.chat({
          model,
          messages: [{ role: "user", content: prompt }],
        })) {
          chunks.push(chunk);
        }
        return assembleChat(chunks).message.content;
      });
    const selection = await selectContext(history, { ...context, compact });
    historyForModel = selection.messages;
    compacted = selection.compacted;
  }

  const messages: OllamaMessage[] = [
    ...toOllamaMessages(historyForModel, systemPrompt),
    { role: "user", content: userMessage },
  ];
  const now = () => new Date();
  if (persist) {
    await persist([{ role: "user", content: userMessage, ts: now() }]);
  }

  const toolTrace: ToolTraceEntry[] = [];
  let pendingConfirmation: PendingConfirmation | null = null;
  let evalCount = 0;
  let promptEvalCount = 0;
  let iterations = 0;

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;
    await onEvent?.({ type: "typing" });
    const chunks: ChatChunk[] = [];
    for await (const chunk of client.chat({
      model,
      messages,
      tools: tools.map((t) => t.toOllamaSchema()),
      ...(signal ? { signal } : {}),
    })) {
      chunks.push(chunk);
      if (chunk.message?.content) {
        await onEvent?.({ type: "token", text: chunk.message.content });
      }
    }
    const { message, evalCount: evals, promptEvalCount: promptEvals } = assembleChat(chunks);
    if (evals) evalCount = evals;
    if (promptEvals) promptEvalCount = promptEvals;

    if (message.tool_calls.length === 0) {
      const reply = message.content;
      if (persist) {
        await persist([{ role: "assistant", content: reply, ts: now() }]);
      }
      const result: LoopResult = { reply, toolTrace, pendingConfirmation, iterations, evalCount, promptEvalCount, compacted };
      await onEvent?.({ type: "done", ...result });
      return result;
    }

    const assistantMessage: OllamaMessage = {
      role: "assistant",
      content: message.content,
      tool_calls: message.tool_calls,
    };
    messages.push(assistantMessage);
    const persisted: StoredMessage[] = [
      {
        role: "assistant",
        content: message.content,
        tool_calls: message.tool_calls,
        ts: now(),
      },
    ];

    for (const call of message.tool_calls) {
      const def = tools.find((t) => t.name === call.function.name);
      let result: unknown;
      let status: ToolTraceEntry["status"] = "ok";
      if (!def) {
        result = { error: `unknown tool: ${call.function.name}` };
        status = "error";
      } else {
        const parsed = def.schema.safeParse(call.function.arguments);
        if (!parsed.success) {
          result = {
            error: `invalid arguments for ${def.name}: ${parsed.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")}`,
          };
          status = "error";
        } else if (def.requiresConfirmation) {
          pendingConfirmation = {
            tool: def.name,
            args: parsed.data as Record<string, unknown>,
            ...(makeProposalId ? { id: makeProposalId() } : {}),
          };
          result = {
            pendingConfirmation: `proposed ${def.name}; awaiting user confirmation`,
          };
          status = "pending_confirmation";
        } else {
          try {
            result = await def.run(parsed.data as never, ctx);
          } catch (err) {
            result = { error: `tool ${def.name} failed: ${(err as Error).message}` };
            status = "error";
          }
        }
      }
      const summary = summarize(call.function.name, result);
      toolTrace.push({ name: call.function.name, status, summary });
      await onEvent?.({ type: "tool", name: call.function.name, status, summary });
      if (status === "pending_confirmation" && pendingConfirmation) {
        await onEvent?.({ type: "confirm", pending: pendingConfirmation });
      }
      const toolMessage: OllamaMessage = {
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(result),
      };
      messages.push(toolMessage);
      persisted.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(result),
        ts: now(),
      });
    }
    if (persist) await persist(persisted);
  }

  const reply =
    "I hit the iteration cap while working on that — please rephrase or break the request into smaller steps.";
  if (persist) {
    await persist([{ role: "assistant", content: reply, ts: now() }]);
  }
  const result: LoopResult = { reply, toolTrace, pendingConfirmation, iterations, evalCount, promptEvalCount, compacted };
  await onEvent?.({ type: "done", ...result });
  return result;
}
