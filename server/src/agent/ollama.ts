export interface OllamaToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OllamaToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface RawToolCallFragment {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    // Ollama nests the parallel-call index inside `function`.
    index?: number;
    name?: string;
    // Ollama sends a ready-made object; OpenAI-compatible streams send JSON
    // string fragments that must be concatenated before parsing.
    arguments?: string | Record<string, unknown>;
  };
}

export interface ChatChunk {
  message?: {
    role?: string;
    content?: string;
    /** Thinking models (gpt-oss, qwen3.8, glm) emit reasoning here. */
    thinking?: string;
    tool_calls?: RawToolCallFragment[];
  };
  done?: boolean;
  done_reason?: string;
  eval_count?: number;
  prompt_eval_count?: number;
  error?: string;
}

export interface AssembledMessage {
  role: string;
  content: string;
  tool_calls: OllamaToolCall[];
}

export interface ChatResult {
  message: AssembledMessage;
  evalCount: number;
  promptEvalCount: number;
  thinking: string;
  doneReason?: string;
}

export interface OllamaClient {
  chat(opts: {
    model: string;
    messages: OllamaMessage[];
    tools?: OllamaToolSchema[];
    signal?: AbortSignal;
  }): AsyncIterable<ChatChunk>;
}

export function createOllamaClient(baseUrl: string): OllamaClient {
  return {
    async *chat(opts) {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          tools: opts.tools,
          stream: true,
        }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const suffix = detail.trim() ? ` — ${detail.trim().slice(0, 300)}` : "";
        throw new Error(`Ollama /api/chat failed: HTTP ${res.status}${suffix}`);
      }
      if (!res.body) {
        throw new Error("Ollama /api/chat failed: empty response body");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const emit = function* (line: string): Generator<ChatChunk> {
        if (line.trim()) yield JSON.parse(line) as ChatChunk;
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          yield* emit(line);
          newline = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      yield* emit(buffer);
    },
  };
}

export function assembleChat(chunks: Iterable<ChatChunk>): ChatResult {
  let content = "";
  let role = "assistant";
  let evalCount = 0;
  let promptEvalCount = 0;
  let thinking = "";
  let doneReason: string | undefined;
  const calls = new Map<
    number,
    {
      id: string;
      name: string;
      argsJson: string;
      argsObject: Record<string, unknown> | null;
    }
  >();
  for (const chunk of chunks) {
    if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);
    const message = chunk.message;
    if (message?.role) role = message.role;
    if (message?.content) content += message.content;
    if (message?.thinking) thinking += message.thinking;
    if (chunk.done_reason) doneReason = chunk.done_reason;
    for (const fragment of message?.tool_calls ?? []) {
      const index = fragment.index ?? fragment.function?.index ?? 0;
      let entry = calls.get(index);
      if (!entry) {
        entry = { id: "", name: "", argsJson: "", argsObject: null };
        calls.set(index, entry);
      }
      if (fragment.id) entry.id = fragment.id;
      if (fragment.function?.name) entry.name = fragment.function.name;
      const rawArgs = fragment.function?.arguments;
      if (typeof rawArgs === "string") entry.argsJson += rawArgs;
      else if (rawArgs && typeof rawArgs === "object") entry.argsObject = rawArgs;
    }
    if (chunk.eval_count !== undefined) evalCount = chunk.eval_count;
    if (chunk.prompt_eval_count !== undefined) {
      promptEvalCount = chunk.prompt_eval_count;
    }
  }
  const toolCalls: OllamaToolCall[] = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, entry], position) => {
      let args: Record<string, unknown> = {};
      if (entry.argsObject) {
        args = entry.argsObject;
      } else if (entry.argsJson.trim()) {
        args = JSON.parse(entry.argsJson) as Record<string, unknown>;
      }
      return {
        id: entry.id || `call_${position}`,
        type: "function",
        function: { name: entry.name, arguments: args },
      };
    });
  return {
    message: { role, content, tool_calls: toolCalls },
    evalCount,
    promptEvalCount,
    thinking,
    ...(doneReason ? { doneReason } : {}),
  };
}
