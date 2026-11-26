import { config } from "../config.ts";

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaChatResponse {
  message: OllamaMessage;
}

export class OllamaUnavailableError extends Error {
  constructor(detail: string) {
    super(`Ollama is not reachable at ${config.ollamaUrl} (${detail})`);
    this.name = "OllamaUnavailableError";
  }
}

export async function ollamaChat(
  messages: OllamaMessage[],
  tools: OllamaTool[],
): Promise<OllamaMessage> {
  let response: Response;
  try {
    response = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.ollamaModel,
        messages,
        tools,
        stream: false,
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    throw new OllamaUnavailableError(err instanceof Error ? err.message : String(err));
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Ollama /api/chat failed: ${response.status} ${detail.slice(0, 300)}`);
  }
  const data = (await response.json()) as OllamaChatResponse;
  return data.message;
}

const THINK_OPEN = `${String.fromCharCode(60)}think${String.fromCharCode(62)}`;
const THINK_CLOSED = new RegExp(`${THINK_OPEN}[\\s\\S]*?${String.fromCharCode(60)}/think${String.fromCharCode(62)}`, "g");
const THINK_UNCLOSED = new RegExp(`${THINK_OPEN}[\\s\\S]*$`, "g");

export function stripThinking(content: string): string {
  return content.replace(THINK_CLOSED, "").replace(THINK_UNCLOSED, "").trim();
}

export interface NormalizedToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export function normalizeToolCalls(message: OllamaMessage): NormalizedToolCall[] {
  const calls = message.tool_calls ?? [];
  return calls.map((call) => {
    const args = call.function.arguments;
    const parsed =
      typeof args === "string"
        ? (safeParse(args) ?? {})
        : args ?? {};
    return { function: { name: call.function.name, arguments: parsed } };
  });
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
