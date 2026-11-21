"use client";

import { useState } from "react";

const MOCK_USERS = [
  { user_ref: "ava", display_name: "Ava" },
  { user_ref: "ben", display_name: "Ben" },
  { user_ref: "chloe", display_name: "Chloe" },
  { user_ref: "dan", display_name: "Dan" },
  { user_ref: "elena", display_name: "Elena" },
];

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolTrace?: { name: string; status: string; summary: string }[];
}

export default function Chat() {
  const [userRef, setUserRef] = useState("ava");
  const [pin, setPin] = useState("4321");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_ref: userRef, pin }),
    });
    if (!res.ok) {
      setError("Invalid user or PIN");
      return;
    }
    const body = await res.json();
    setSessionId(body.sessionId);
    setDisplayName(body.display_name);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!sessionId || !input.trim() || busy) return;
    const text = input.trim();
    setInput("");
    setBusy(true);
    setError(null);
    setMessages((m) => [...m, { role: "user", content: text }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, message: text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      setMessages((m) => [
        ...m,
        { role: "assistant", content: body.reply, toolTrace: body.toolTrace },
      ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!sessionId) {
    return (
      <form className="login" onSubmit={login}>
        <h1>Flight Booking Agent</h1>
        <p className="muted">Mock login — demo PIN is 4321 for every user.</p>
        <select value={userRef} onChange={(e) => setUserRef(e.target.value)}>
          {MOCK_USERS.map((u) => (
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
        {error && <p className="error">{error}</p>}
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
      </header>
      <div className="messages">
        {messages.length === 0 && (
          <p className="muted">
            Try: &ldquo;flights from London to Lisbon tomorrow&rdquo; or &ldquo;what are my
            bookings?&rdquo;
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">{m.content}</div>
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
        {busy && <div className="msg assistant"><div className="bubble muted">thinking…</div></div>}
      </div>
      {error && <p className="error">{error}</p>}
      <form className="composer" onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about flights or your bookings…"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
