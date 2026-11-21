"use client";

import { useEffect, useState } from "react";
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

const SESSION_KEY = "flight-agent.session";

const FALLBACK_USERS = [
  { user_ref: "ava", display_name: "Ava" },
  { user_ref: "ben", display_name: "Ben" },
  { user_ref: "chloe", display_name: "Chloe" },
  { user_ref: "dan", display_name: "Dan" },
  { user_ref: "elena", display_name: "Elena" },
];

type ChatState =
  | { stage: "idle" }
  | { stage: "streaming" }
  | { stage: "awaiting_confirmation"; pending: PendingConfirmation }
  | { stage: "confirming"; pending: PendingConfirmation }
  | { stage: "failed"; error: string };

export default function Chat() {
  const [users, setUsers] = useState(FALLBACK_USERS);
  const [userRef, setUserRef] = useState("ava");
  const [pin, setPin] = useState("4321");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [chat, setChat] = useState<ChatState>({ stage: "idle" });

  const busy = chat.stage === "streaming" || chat.stage === "confirming";
  const canCompose =
    chat.stage === "idle" || chat.stage === "failed";

  useEffect(() => {
    fetch("/api/users")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (body?.users?.length) setUsers(body.users);
      })
      .catch(() => {});
    const saved = localStorage.getItem(SESSION_KEY);
    if (!saved) return;
    fetch(`/api/sessions/${saved}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("gone"))))
      .then((body) => {
        setSessionId(body.sessionId);
        setUserRef(body.user_ref);
        setDisplayName(body.user_ref);
        setMessages(fromStoredMessages(body.messages));
      })
      .catch(() => localStorage.removeItem(SESSION_KEY));
  }, []);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setChat({ stage: "idle" });
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_ref: userRef, pin }),
    });
    if (!res.ok) {
      setChat({ stage: "failed", error: "Invalid user or PIN" });
      return;
    }
    const body = await res.json();
    localStorage.setItem(SESSION_KEY, body.sessionId);
    setSessionId(body.sessionId);
    setDisplayName(body.display_name);
    const history = await fetch(`/api/sessions/${body.sessionId}`);
    if (history.ok) {
      const hist = await history.json();
      setMessages(fromStoredMessages(hist.messages));
    }
  }

  function logout() {
    localStorage.removeItem(SESSION_KEY);
    setSessionId(null);
    setDisplayName(null);
    setMessages([]);
    setChat({ stage: "idle" });
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!sessionId || !input.trim() || !canCompose) return;
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
            setMessages((m) => finalizeLastAssistant(m, event.reply, event.toolTrace));
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
    if (chat.stage !== "awaiting_confirmation" || !sessionId) return;
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
        body: JSON.stringify({ sessionId, args: pending.args }),
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
      setMessages((m) => appendAssistantNote(m, `Confirmation failed: ${(err as Error).message}`));
      setChat({ stage: "failed", error: (err as Error).message });
    }
  }

  if (!sessionId) {
    return (
      <form className="login" onSubmit={login}>
        <h1>Flight Booking Agent</h1>
        <p className="muted">Mock login — demo PIN is 4321 for every user.</p>
        <select value={userRef} onChange={(e) => setUserRef(e.target.value)}>
          {users.map((u) => (
            <option key={u.user_ref} value={u.user_ref}>
              {u.display_name} ({u.user_ref})
            </option>
          ))}
        </select>
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="PIN"
          inputMode="numeric"
        />
        <button type="submit">Log in</button>
        {chat.stage === "failed" && <p className="error">{chat.error}</p>}
      </form>
    );
  }

  return (
    <div className="chat">
      <header>
        <h1>Flight Booking Agent</h1>
        <span className="muted">
          logged in as {displayName} ({userRef})
        </span>
        <button className="logout" onClick={logout}>
          Log out
        </button>
      </header>
      <div className="messages">
        {messages.length === 0 && (
          <p className="muted">
            Try: &ldquo;flights from London to Lisbon tomorrow&rdquo; or &ldquo;what are my
            bookings?&rdquo;
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="bubble">
              {m.content}
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
          disabled={!canCompose}
        />
        <button type="submit" disabled={!canCompose || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
