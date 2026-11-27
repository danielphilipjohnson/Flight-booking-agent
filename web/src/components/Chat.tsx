"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Markdown } from "./Markdown.tsx";
import { loadSession, type User } from "../lib/api.ts";
import {
  appendAssistantNote,
  appendAssistantPlaceholder,
  appendTokenToLastAssistant,
  appendToolChip,
  appendUserTurn,
  finalizeLastAssistant,
  formatMessageTime,
  formatMessageTimestamp,
  fromStoredMessages,
  markLastUserDelivered,
  removeEmptyTrailingAssistant,
  streamChatTurn,
  type ChatMessage,
  type PendingConfirmation,
} from "../lib/chatStream.ts";

type ChatState =
  | { stage: "idle" }
  | { stage: "streaming" }
  | { stage: "awaiting_confirmation"; pending: PendingConfirmation }
  | { stage: "confirming"; pending: PendingConfirmation }
  | { stage: "failed"; error: string };

type HistoryState = "loading" | "ready" | "error";

function MessageMeta({ message }: { message: ChatMessage }) {
  if (!message.ts) return null;
  const delivered = message.status === "delivered";
  const receipt = delivered ? "Delivered" : "Sent";
  return (
    <div className="msg-meta">
      <time dateTime={message.ts} title={formatMessageTimestamp(message.ts)}>
        {formatMessageTime(message.ts)}
      </time>
      {message.role === "user" && (
        <span
          className={`ticks ${delivered ? "delivered" : "sent"}`}
          role="img"
          aria-label={receipt}
          title={receipt}
        >
          {delivered ? "✓✓" : "✓"}
        </span>
      )}
    </div>
  );
}

export default function Chat({
  sessionId,
  user,
  onLogout,
}: {
  sessionId: string;
  user: User;
  onLogout: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<HistoryState>("loading");
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [chat, setChat] = useState<ChatState>({ stage: "idle" });

  const busy = chat.stage === "streaming" || chat.stage === "confirming";
  const canCompose = chat.stage === "idle" || chat.stage === "failed";

  const lastMessage = messages[messages.length - 1];
  const waitingForFirstToken =
    chat.stage === "streaming" &&
    lastMessage !== undefined &&
    lastMessage.role === "assistant" &&
    lastMessage.content === "" &&
    (lastMessage.toolTrace?.length ?? 0) === 0;
  const streamHasStarted =
    chat.stage === "streaming" &&
    lastMessage !== undefined &&
    lastMessage.role === "assistant" &&
    (lastMessage.content.length > 0 || (lastMessage.toolTrace?.length ?? 0) > 0);

  useEffect(() => {
    let cancelled = false;
    setHistory("loading");
    setMessages([]);
    setChat({ stage: "idle" });
    loadSession(sessionId)
      .then((body) => {
        if (cancelled) return;
        setMessages(fromStoredMessages(body.messages));
        setHistory("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setHistoryError((err as Error).message);
        setHistory("error");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || !canCompose || history !== "ready") return;
    const text = input.trim();
    setInput("");
    setChat({ stage: "streaming" });
    setMessages((m) => appendAssistantPlaceholder(appendUserTurn(m, text)));
    try {
      await streamChatTurn({ sessionId, message: text }, (event) => {
        switch (event.type) {
          case "token":
            setMessages((m) => appendTokenToLastAssistant(m, event.text));
            break;
          case "tool":
            setMessages((m) => appendToolChip(m, event));
            break;
          case "confirm":
            setChat({ stage: "awaiting_confirmation", pending: event.pending });
            break;
          case "done":
            setMessages((m) =>
              finalizeLastAssistant(
                markLastUserDelivered(m),
                event.reply,
                event.toolTrace,
              ),
            );
            setChat((c) =>
              c.stage === "awaiting_confirmation"
                ? c
                : event.pendingConfirmation
                  ? { stage: "awaiting_confirmation", pending: event.pendingConfirmation }
                  : { stage: "idle" },
            );
            break;
          case "error":
            console.error("[chat] stream error", { sessionId, error: event.error });
            throw new Error(event.error);
          case "typing":
            break;
        }
      });
      setChat((c) => (c.stage === "streaming" ? { stage: "idle" } : c));
    } catch (err) {
      console.error("[chat] turn failed", { sessionId, message: text, err });
      setMessages((m) => removeEmptyTrailingAssistant(m));
      setChat({ stage: "failed", error: (err as Error).message });
    }
  }

  async function decide(confirm: boolean) {
    if (chat.stage !== "awaiting_confirmation") return;
    const pending = chat.pending;
    if (!confirm) {
      setChat({ stage: "idle" });
      setMessages((m) => appendAssistantNote(m, "Declined — no changes were made."));
      return;
    }
    setChat({ stage: "confirming", pending });
    try {
      const res = await fetch(`/api/tools/${pending.tool}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          confirmationId: pending.id,
          args: pending.args,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setMessages((m) =>
        appendAssistantNote(
          m,
          `Confirmed: ${pending.tool} → ${JSON.stringify(body.result)}`,
          [{ name: pending.tool, status: "ok", summary: "confirmed & executed" }],
        ),
      );
      setChat({ stage: "idle" });
    } catch (err) {
      setMessages((m) =>
        appendAssistantNote(m, `Confirmation failed: ${(err as Error).message}`),
      );
      setChat({ stage: "failed", error: (err as Error).message });
    }
  }

  return (
    <div className="chat">
      <header>
        <Link className="back" href="/">
          ← Conversations
        </Link>
        <span className="muted">
          {user.display_name} ({user.user_ref})
        </span>
        <button className="logout" onClick={onLogout}>
          Log out
        </button>
      </header>

      <div className="messages">
        {/*
         * The container is `column-reverse`, so DOM order is the reverse of the
         * visual order: the newest message is first in the DOM and therefore
         * pinned at the bottom. New tokens keep the view anchored there without
         * any scrollTop juggling.
         */}
        {chat.stage === "awaiting_confirmation" && (
          <div className="msg assistant">
            <div className="bubble confirm-card">
              <strong>Confirm write:</strong> {chat.pending.tool}{" "}
              <code>{JSON.stringify(chat.pending.args)}</code>
              <div className="confirm-actions">
                <button onClick={() => decide(true)} disabled={busy}>
                  Confirm
                </button>
                <button className="decline" onClick={() => decide(false)} disabled={busy}>
                  Decline
                </button>
              </div>
            </div>
          </div>
        )}
        {[...messages].reverse().map((m) => {
          // While waiting, the placeholder itself becomes the typing bubble —
          // no empty message with a timestamp next to the dots.
          if (waitingForFirstToken && m.id === lastMessage?.id) {
            return (
              <div
                key={m.id}
                className="msg assistant typing-row"
                role="status"
                aria-label="Agent is thinking"
              >
                <div className="bubble typing-bubble" aria-hidden="true">
                  <span className="typing-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              </div>
            );
          }
          return (
            <div key={m.id} className={`msg ${m.role}`}>
              <div className="bubble">
                <div className="bubble-body">
                  {m.role === "assistant" ? <Markdown>{m.content}</Markdown> : m.content}
                  {streamHasStarted && m.id === lastMessage?.id && (
                    <span className="thinking-inline" role="status" aria-label="Still thinking">
                      thinking…
                    </span>
                  )}
                </div>
                <MessageMeta message={m} />
              </div>
              {m.toolTrace && m.toolTrace.length > 0 && (
                <div className="chips">
                  {m.toolTrace.map((t, j) => (
                    <span key={j} className={`chip ${t.status}`}>
                      {t.name} · {t.summary}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {history === "loading" && <p className="muted">Loading conversation…</p>}
        {history === "error" && (
          <p className="error">Could not load this conversation: {historyError}</p>
        )}
        {history === "ready" && messages.length === 0 && (
          <p className="muted">
            Try: &ldquo;flights from London to Lisbon tomorrow&rdquo; or &ldquo;what are my
            bookings?&rdquo;
          </p>
        )}
      </div>

      {chat.stage === "failed" && <p className="error">{chat.error}</p>}
      <form className="composer" onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            chat.stage === "awaiting_confirmation"
              ? "Resolve the confirmation above first…"
              : "Ask about flights or your bookings…"
          }
          disabled={!canCompose || history !== "ready"}
        />
        <button
          type="submit"
          disabled={!canCompose || history !== "ready" || !input.trim()}
        >
          Send
        </button>
      </form>
    </div>
  );
}
