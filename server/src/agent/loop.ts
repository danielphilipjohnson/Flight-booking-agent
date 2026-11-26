import { pool } from "../db/postgres.ts";
import type { StoredMessage } from "../db/mongo.ts";
import { appendMessages, ensureSession, loadHistory } from "./history.ts";
import {
  normalizeToolCalls,
  ollamaChat,
  stripThinking,
  type OllamaMessage,
  type OllamaTool,
} from "./ollama.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { buildToolDefs, type ToolContext } from "./tools.ts";

const MAX_TOOL_ROUNDS = 8;

export type AgentEvent =
  | { type: "tool"; name: string; summary: string }
  | { type: "message"; content: string };

export interface AgentOptions {
  sessionId: string;
  userRef: string;
  pin: string;
  message: string;
  now?: Date;
}

interface LookupRow {
  display_name: string;
}

async function verifyPin(userRef: string, pin: string): Promise<void> {
  const result = await pool.query<LookupRow>(
    "SELECT display_name FROM app_user WHERE user_ref = $1 AND pin = $2",
    [userRef, pin],
  );
  if (result.rowCount === 0) throw new Error("Unknown user or wrong PIN");
}

function summarize(name: string, args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["origin", "destination", "date", "from_date", "query", "max_price", "sort"]) {
    const value = args[key];
    if (value !== undefined) parts.push(`${key}: ${String(value)}`);
  }
  return parts.length > 0 ? `${name}(${parts.join(", ")})` : name;
}

function toHistoryMessage(role: "user" | "assistant", content: string): StoredMessage {
  return { role, content, ts: new Date() };
}

export async function* runAgent(options: AgentOptions): AsyncGenerator<AgentEvent> {
  await verifyPin(options.userRef, options.pin);
  await ensureSession(options.sessionId, options.userRef);
  const history = await loadHistory(options.sessionId, options.userRef);
  const tools = buildToolDefs();
  const toolContext: ToolContext = { sessionId: options.sessionId };
  const ollamaTools: OllamaTool[] = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const messages: OllamaMessage[] = [
    { role: "system", content: buildSystemPrompt(options.now ?? new Date()) },
    ...history.map((m): OllamaMessage => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    })),
    { role: "user", content: options.message },
  ];

  let reply = "";

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await ollamaChat(messages, ollamaTools);
    const toolCalls = normalizeToolCalls(response);

    if (toolCalls.length === 0 || round === MAX_TOOL_ROUNDS) {
      reply = stripThinking(response.content);
      if (!reply) {
        reply =
          toolCalls.length > 0
            ? "I hit my step limit before finishing that search. Could you rephrase or narrow it down?"
            : "I could not produce an answer. Could you rephrase that?";
      }
      break;
    }

    messages.push({
      role: "assistant",
      content: stripThinking(response.content),
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const def = tools.find((t) => t.name === call.function.name);
      let resultText: string;
      if (!def) {
        resultText = JSON.stringify({
          error: `Unknown tool "${call.function.name}". Available tools: ${tools.map((t) => t.name).join(", ")}.`,
        });
      } else {
        const parsed = def.schema.safeParse(call.function.arguments);
        if (!parsed.success) {
          resultText = JSON.stringify({
            error: `Invalid arguments for ${def.name}: ${parsed.error.issues
              .map((i) => `${i.path.join(".") || "args"}: ${i.message}`)
              .join("; ")}.`,
          });
        } else {
          const result = await def.run(parsed.data, toolContext);
          resultText = JSON.stringify(result);
        }
      }
      yield { type: "tool", name: call.function.name, summary: summarize(call.function.name, call.function.arguments) };
      messages.push({ role: "tool", content: resultText, tool_name: call.function.name });
    }
  }

  await appendMessages(options.sessionId, options.userRef, [
    toHistoryMessage("user", options.message),
    toHistoryMessage("assistant", reply),
  ]);

  yield { type: "message", content: reply };
}
