import { assembleChat, type ChatChunk, type OllamaClient, type OllamaMessage } from "./ollama.ts";
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
}

export interface LoopResult {
  reply: string;
  toolTrace: ToolTraceEntry[];
  pendingConfirmation: PendingConfirmation | null;
  iterations: number;
  evalCount: number;
}

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
  persist?: (messages: StoredMessage[]) => Promise<void>;
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
    persist,
  } = opts;

  const messages: OllamaMessage[] = [
    ...toOllamaMessages(history, systemPrompt),
    { role: "user", content: userMessage },
  ];
  const now = () => new Date();
  if (persist) {
    await persist([{ role: "user", content: userMessage, ts: now() }]);
  }

  const toolTrace: ToolTraceEntry[] = [];
  let pendingConfirmation: PendingConfirmation | null = null;
  let evalCount = 0;
  let iterations = 0;

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;
    const chunks: ChatChunk[] = [];
    for await (const chunk of client.chat({
      model,
      messages,
      tools: tools.map((t) => t.toOllamaSchema()),
    })) {
      chunks.push(chunk);
    }
    const { message, evalCount: evals } = assembleChat(chunks);
    if (evals) evalCount = evals;

    if (message.tool_calls.length === 0) {
      const reply = message.content;
      if (persist) {
        await persist([{ role: "assistant", content: reply, ts: now() }]);
      }
      return { reply, toolTrace, pendingConfirmation, iterations, evalCount };
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
      toolTrace.push({ name: call.function.name, status, summary: summarize(call.function.name, result) });
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
  return { reply, toolTrace, pendingConfirmation, iterations, evalCount };
}
