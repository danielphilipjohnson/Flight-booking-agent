"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  createConversation,
  listConversations,
  type ConversationSummary,
  type User,
} from "../lib/api.ts";

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Conversations({
  user,
  onLogout,
}: {
  user: User;
  onLogout: () => void;
}) {
  const router = useRouter();
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    try {
      const body = await listConversations(user.user_ref);
      setItems(body.conversations);
      setError(null);
    } catch (err) {
      setItems([]);
      setError((err as Error).message);
    }
  }, [user.user_ref]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function startConversation() {
    setCreating(true);
    setError(null);
    try {
      const body = await createConversation(user.user_ref);
      router.push(`/chat/${body.sessionId}`);
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  }

  return (
    <div className="conversations">
      <header className="topbar">
        <h1>Conversations</h1>
        <span className="muted">
          {user.display_name} ({user.user_ref})
        </span>
        <button className="logout" onClick={onLogout}>
          Log out
        </button>
      </header>

      <div className="conv-actions">
        <button onClick={startConversation} disabled={creating}>
          {creating ? "Starting…" : "New conversation"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {items === null ? (
        <p className="muted">Loading conversations…</p>
      ) : items.length === 0 ? (
        <p className="empty-state">
          No conversations yet. Start one to ask about flights or your bookings.
        </p>
      ) : (
        <ul className="conv-list">
          {items.map((c) => (
            <li key={c.id} className="conv-item">
              <Link href={`/chat/${c.id}`}>
                <div className="conv-title">{c.title || "New conversation"}</div>
                {c.preview && <div className="conv-preview">{c.preview}</div>}
                <div className="conv-meta">
                  <span>{formatWhen(c.updated_at)}</span>
                  <span>
                    {c.message_count}{" "}
                    {c.message_count === 1 ? "message" : "messages"}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
