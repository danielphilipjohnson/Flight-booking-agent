export interface ToolChip {
  name: string;
  status: string;
  summary: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolTrace?: ToolChip[];
}

export interface PendingConfirmation {
  tool: string;
  args: Record<string, unknown>;
}

export type ChatStreamEvent =
  | { type: "typing" }
  | { type: "token"; text: string }
  | { type: "tool"; name: string; status: string; summary: string }
  | { type: "confirm"; pending: PendingConfirmation }
  | {
      type: "done";
      reply: string;
      toolTrace: ToolChip[];
      pendingConfirmation: PendingConfirmation | null;
      stats?: unknown;
    }
  | { type: "error"; error: string };

export interface SseFrame {
  event: string;
  data: string;
}

export function createSseParser(
  onFrame: (frame: SseFrame) => void,
): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = raw.split("\n");
      const event =
        lines.find((l) => l.startsWith("event: "))?.slice("event: ".length) ??
        "message";
      const data = lines
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice("data: ".length))
        .join("\n");
      onFrame({ event, data });
      boundary = buffer.indexOf("\n\n");
    }
  };
}

export interface StreamChatTurnOptions {
  sessionId: string;
  message: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function streamChatTurn(
  opts: StreamChatTurnOptions,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn("/api/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: opts.sessionId, message: opts.message }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok || !res.body) {
    let error = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) error = body.error;
    } catch {
      // keep the HTTP status message
    }
    onEvent({ type: "error", error });
    return;
  }

  let sawDone = false;
  let sawError = false;
  const parser = createSseParser(({ event, data }) => {
    if (!data) return;
    let parsed: Record<string, never>;
    try {
      parsed = JSON.parse(data) as Record<string, never>;
    } catch {
      onEvent({ type: "error", error: "malformed SSE event from server" });
      sawError = true;
      return;
    }
    if (event === "token") {
      onEvent({ type: "token", text: parsed.text as unknown as string });
    } else if (event === "tool") {
      onEvent({
        type: "tool",
        name: parsed.name as unknown as string,
        status: parsed.status as unknown as string,
        summary: parsed.summary as unknown as string,
      });
    } else if (event === "confirm") {
      onEvent({ type: "confirm", pending: parsed.pending as unknown as PendingConfirmation });
    } else if (event === "done") {
      sawDone = true;
      onEvent({
        type: "done",
        reply: parsed.reply as unknown as string,
        toolTrace: (parsed.toolTrace ?? []) as unknown as ToolChip[],
        pendingConfirmation: (parsed.pendingConfirmation ?? null) as PendingConfirmation | null,
        stats: parsed.stats,
      });
    } else if (event === "error") {
      sawError = true;
      onEvent({ type: "error", error: parsed.error as unknown as string });
    } else if (event === "typing") {
      onEvent({ type: "typing" });
    }
  });

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser(decoder.decode(value, { stream: true }));
    }
    parser(decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!sawDone && !sawError) {
    onEvent({ type: "error", error: "stream ended before the turn finished" });
  }
}

export function appendUserTurn(messages: ChatMessage[], text: string): ChatMessage[] {
  return [...messages, { id: crypto.randomUUID(), role: "user", content: text }];
}

export function appendAssistantPlaceholder(messages: ChatMessage[]): ChatMessage[] {
  return [
    ...messages,
    { id: crypto.randomUUID(), role: "assistant", content: "", toolTrace: [] },
  ];
}

export function appendTokenToLastAssistant(
  messages: ChatMessage[],
  text: string,
): ChatMessage[] {
  if (messages.length === 0) return messages;
  return messages.map((m, i) =>
    i === messages.length - 1 && m.role === "assistant"
      ? { ...m, content: m.content + text }
      : m,
  );
}

export function appendToolChip(messages: ChatMessage[], chip: ToolChip): ChatMessage[] {
  if (messages.length === 0) return messages;
  return messages.map((m, i) =>
    i === messages.length - 1 ? { ...m, toolTrace: [...(m.toolTrace ?? []), chip] } : m,
  );
}

export function finalizeLastAssistant(
  messages: ChatMessage[],
  reply: string,
  toolTrace: ToolChip[],
): ChatMessage[] {
  if (messages.length === 0) return messages;
  return messages.map((m, i) =>
    i === messages.length - 1 ? { ...m, content: reply, toolTrace } : m,
  );
}

export function removeEmptyTrailingAssistant(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && last.content === "") {
    return messages.slice(0, -1);
  }
  return messages;
}

export function appendAssistantNote(
  messages: ChatMessage[],
  content: string,
  toolTrace?: ToolChip[],
): ChatMessage[] {
  return [...messages, { id: crypto.randomUUID(), role: "assistant", content, toolTrace }];
}

export interface StoredMessage {
  role: string;
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  ts?: string | Date;
}

export function fromStoredMessages(stored: StoredMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of stored) {
    if (m.role === "user" || m.role === "assistant") {
      out.push({ id: crypto.randomUUID(), role: m.role, content: m.content, toolTrace: [] });
    } else if (m.role === "tool") {
      const last = out[out.length - 1];
      if (last && last.role === "assistant") {
        const isError = m.content.includes('"error"');
        const summary = m.content.length > 80 ? `${m.content.slice(0, 80)}…` : m.content;
        last.toolTrace = [
          ...(last.toolTrace ?? []),
          { name: m.name ?? "tool", status: isError ? "error" : "ok", summary },
        ];
      }
    }
  }
  const result: ChatMessage[] = [];
  for (let i = 0; i < out.length; i++) {
    const m = out[i]!;
    if (m.role === "assistant" && m.content === "") {
      const next = out[i + 1];
      if (next && next.role === "assistant") {
        next.toolTrace = [...(m.toolTrace ?? []), ...(next.toolTrace ?? [])];
      }
      continue;
    }
    result.push(m);
  }
  return result;
}
