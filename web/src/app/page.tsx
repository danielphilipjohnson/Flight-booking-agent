"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const MOCK_USERS = ["ava", "ben", "chloe", "dan", "elena"];

interface ToolChip {
  kind: "tool";
  name: string;
  summary: string;
}

interface ChatMessage {
  kind: "message";
  role: "user" | "assistant";
  content: string;
}

type ChatEntry = ToolChip | ChatMessage;

export default function Home() {
  const [user, setUser] = useState<{ ref: string; name: string } | null>(null);
  const [userRef, setUserRef] = useState("dan");
  const [pin, setPin] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const entriesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSessionId(crypto.randomUUID());
  }, []);

  useEffect(() => {
    entriesRef.current?.scrollTo({ top: entriesRef.current.scrollHeight });
  }, [entries]);

  const signIn = useCallback(async () => {
    setAuthError(null);
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_ref: userRef, pin }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setAuthError(body?.error ?? "Sign-in failed");
        return;
      }
      const body = (await res.json()) as { display_name: string };
      setSessionId(crypto.randomUUID());
      setEntries([]);
      setUser({ ref: userRef, name: body.display_name });
    } catch {
      setAuthError("Could not reach the API. Is the server running on :3001?");
    }
  }, [pin, userRef]);

  const send = useCallback(
    async (text: string) => {
      if (!user || busy || text.trim().length === 0 || !sessionId) return;
      setBusy(true);
      setInput("");
      setEntries((prev) => [...prev, { kind: "message", role: "user", content: text }]);
      setEntries((prev) => [...prev, { kind: "message", role: "assistant", content: "" }]);

      const appendAssistant = (text_: string): void => {
        setEntries((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === "message" && last.role === "assistant" && last.content === "") {
            return [...prev.slice(0, -1), { ...last, content: text_ }];
          }
          return [...prev, { kind: "message", role: "assistant", content: text_ }];
        });
      };

      try {
        const res = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: sessionId,
            user_ref: user.ref,
            pin,
            message: text,
          }),
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const lines = frame.split("\n");
            const eventLine = lines.find((l) => l.startsWith("event: "));
            const dataLine = lines.find((l) => l.startsWith("data: "));
            if (!eventLine) continue;
            const event = eventLine.slice("event: ".length);
            const data = dataLine
              ? (JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>)
              : {};

            if (event === "tool") {
              setEntries((prev) => [
                ...prev.slice(0, -1),
                { kind: "tool", name: String(data.name), summary: String(data.summary) },
                { kind: "message", role: "assistant", content: "" },
              ]);
            } else if (event === "token") {
              setEntries((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.kind === "message" && last.role === "assistant") {
                  return [...prev.slice(0, -1), { ...last, content: last.content + String(data.text) }];
                }
                return prev;
              });
            } else if (event === "error") {
              appendAssistant(`Error: ${String(data.message)}`);
            }
          }
        }
      } catch (err) {
        appendAssistant(`Error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setEntries((prev) =>
          prev.filter((e) => e.kind !== "message" || e.role !== "assistant" || e.content !== ""),
        );
        setBusy(false);
      }
    },
    [busy, pin, sessionId, user],
  );

  if (!user) {
    return (
      <main className="gate">
        <h1>Flight Booking Agent</h1>
        <p>Sign in as a seeded demo user to start chatting.</p>
        <label>
          User
          <select value={userRef} onChange={(e) => setUserRef(e.target.value)}>
            {MOCK_USERS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
        <label>
          PIN
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && signIn()}
            placeholder="demo PIN"
          />
        </label>
        <button onClick={signIn}>Start chat</button>
        {authError && <p className="error">{authError}</p>}
      </main>
    );
  }

  return (
    <main className="chat">
      <header>
        <span>
          {user.name}
          {sessionId ? ` · session ${sessionId.slice(0, 8)}` : ""}
        </span>
        <button
          onClick={async () => {
            if (sessionId) {
              await fetch(`/api/chat/${sessionId}`, {
                method: "DELETE",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ session_id: sessionId, user_ref: user.ref, pin }),
              }).catch(() => undefined);
            }
            setSessionId(crypto.randomUUID());
            setEntries([]);
          }}
        >
          New session
        </button>
      </header>
      <div className="entries" ref={entriesRef}>
        {entries.map((entry, i) =>
          entry.kind === "tool" ? (
            <div key={i} className="chip">
              <code>{entry.name}</code> {entry.summary}
            </div>
          ) : (
            <div key={i} className={`bubble ${entry.role}`}>
              {entry.content || (busy && i === entries.length - 1 ? "…" : "")}
            </div>
          ),
        )}
      </div>
      <footer>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(input)}
          placeholder="e.g. flights to Lisbon tomorrow"
          disabled={busy}
        />
        <button onClick={() => send(input)} disabled={busy}>
          Send
        </button>
      </footer>
    </main>
  );
}
