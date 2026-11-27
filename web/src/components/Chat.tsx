"use client";

import Link from "next/link";
import Login from "./Login.tsx";
import { Markdown } from "./Markdown.tsx";
import {
  canCompose,
  isBusy,
  streamHasStarted,
  waitingForFirstToken,
} from "../lib/chatReducer.ts";
import {
  formatMessageTime,
  formatMessageTimestamp,
  type ChatMessage,
} from "../lib/chatStream.ts";
import { useChat } from "../lib/useChat.ts";

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
  onLogout,
}: {
  sessionId: string;
  onLogout: () => void;
}) {
  const { state, setInput, send, decide, login, logout } = useChat({ sessionId });

  if (!state.user) {
    return <Login onLoggedIn={(user) => void login(user)} />;
  }

  const busy = isBusy(state);
  const compose = canCompose(state);
  const { stage } = state;

  const lastMessage = state.messages[state.messages.length - 1];
  const waiting = waitingForFirstToken(state);
  const started = streamHasStarted(state);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void send(state.input);
  }

  function handleLogout() {
    logout();
    onLogout();
  }

  return (
    <div className="chat">
      <header>
        <Link className="back" href="/">
          ← Conversations
        </Link>
        <span className="muted">
          {state.user.display_name} ({state.user.user_ref})
        </span>
        <button className="logout" onClick={handleLogout}>
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
        {stage === "awaiting_confirmation" && (
          <div className="msg assistant">
            <div className="bubble confirm-card">
              <strong>Confirm write:</strong> {state.pending.tool}{" "}
              <code>{JSON.stringify(state.pending.args)}</code>
              <div className="confirm-actions">
                <button onClick={() => void decide(true)} disabled={busy}>
                  Confirm
                </button>
                <button className="decline" onClick={() => void decide(false)} disabled={busy}>
                  Decline
                </button>
              </div>
            </div>
          </div>
        )}
        {[...state.messages].reverse().map((m) => {
          // While waiting, the placeholder itself becomes the typing bubble —
          // no empty message with a timestamp next to the dots.
          if (waiting && m.id === lastMessage?.id) {
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
                  {started && m.id === lastMessage?.id && (
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
        {state.history === "loading" && <p className="muted">Loading conversation…</p>}
        {state.history === "error" && (
          <p className="error">Could not load this conversation: {state.historyError}</p>
        )}
        {state.history === "ready" && state.messages.length === 0 && (
          <p className="muted">
            Try: &ldquo;flights from London to Lisbon tomorrow&rdquo; or &ldquo;what are my
            bookings?&rdquo;
          </p>
        )}
      </div>

      {stage === "failed" && <p className="error">{state.error}</p>}
      <form className="composer" onSubmit={handleSubmit}>
        <input
          value={state.input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            stage === "awaiting_confirmation"
              ? "Resolve the confirmation above first…"
              : "Ask about flights or your bookings…"
          }
          disabled={!compose}
        />
        <button type="submit" disabled={!compose || !state.input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
