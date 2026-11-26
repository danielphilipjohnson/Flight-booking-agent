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
  fromStoredMessages,
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
              finalizeLastAssistant(m, event.reply, event.toolTrace),
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
            throw new Error(event.error);
          case "typing":
            break;
        }
      });
      setChat((c) => (c.stage === "streaming" ? { stage: "idle" } : c));
    } catch (err) {
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
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="bubble">
              {m.role === "assistant" ? <Markdown>{m.content}</Markdown> : m.content}
              {m.role === "assistant" &&
                chat.stage === "streaming" &&
                m.id === messages[messages.length - 1]!.id && (
                  <span className="caret">▌</span>
                )}
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
        ))}
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
