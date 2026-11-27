import { assembleChat, type ChatChunk, type OllamaClient, type OllamaMessage } from "./ollama.ts";
import { selectContext, type ContextOptions } from "./context.ts";
import { toOllamaMessages } from "./prompt.ts";
import { resolveToolCall, summarizeResult, type PendingConfirmation } from "./dispatch.ts";
import type { ToolContext, ToolDef } from "../tools/schemas.ts";
import type { StoredMessage } from "../db/mongo.ts";

export type { PendingConfirmation };

export interface ToolTraceEntry {
  name: string;
  status: "ok" | "error" | "pending_confirmation";
  summary: string;
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
  /** Non-fatal diagnostics (e.g. a retry after an empty model response). */
  onWarning?: (message: string) => void;
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
    onWarning,
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
  let emptyRetries = 0;

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
    const {
      message,
      evalCount: evals,
      promptEvalCount: promptEvals,
      thinking,
      doneReason,
    } = assembleChat(chunks);
    if (evals) evalCount = evals;
    if (promptEvals) promptEvalCount = promptEvals;

    if (message.tool_calls.length === 0) {
      // A completion with neither content nor tool calls is not an answer.
      // Thinking models can do this by finishing with only `thinking` tokens.
      const diagnostics = [
        "model returned an empty response",
        `model=${model}`,
        `attempt=${emptyRetries + 1}`,
        `iteration=${iterations}`,
        `done_reason=${doneReason ?? "unknown"}`,
        `thinking_chars=${thinking.length}`,
        `eval_count=${evalCount}`,
        `prompt_eval_count=${promptEvalCount}`,
      ].join(" ");
      if (message.content.trim() === "") {
        if (emptyRetries < 1 && i < maxIterations - 1) {
          emptyRetries += 1;
          onWarning?.(`${diagnostics} — retrying once with a nudge`);
          messages.push({
            role: "user",
            content:
              "Your previous response was empty. Please answer the user's last request in plain text, or call a tool if you need data.",
          });
          continue;
        }
        throw new Error(diagnostics);
      }
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
      const resolved = resolveToolCall(tools, call, { makeProposalId });
      let result: unknown;
      let status: ToolTraceEntry["status"] = "ok";
      if (resolved.kind === "error") {
        result = { error: resolved.error };
        status = "error";
      } else if (resolved.kind === "gate") {
        pendingConfirmation = resolved.pending;
        result = { pendingConfirmation: resolved.note };
        status = "pending_confirmation";
      } else {
        try {
          result = await resolved.def.run(resolved.args, ctx);
        } catch (err) {
          result = { error: `tool ${resolved.def.name} failed: ${(err as Error).message}` };
          status = "error";
        }
      }
      const summary = summarizeResult(call.function.name, result);
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
