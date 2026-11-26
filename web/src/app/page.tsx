"use client";

import { useEffect, useState } from "react";
import Login from "../components/Login";
import Conversations from "../components/Conversations";
import { loadSession, type User } from "../lib/api.ts";
import {
  clearUser,
  LEGACY_SESSION_KEY,
  loadUser,
  saveUser,
} from "../lib/user.ts";

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = loadUser();
    if (stored) {
      setUser(stored);
      setReady(true);
      return;
    }
    // Upgrade path: older builds stored only the active conversation id.
    const legacy = localStorage.getItem(LEGACY_SESSION_KEY);
    if (!legacy) {
      setReady(true);
      return;
    }
    loadSession(legacy)
      .then((body) => {
        const recovered: User = {
          user_ref: body.user_ref,
          display_name: body.display_name ?? body.user_ref,
        };
        saveUser(recovered);
        setUser(recovered);
      })
      .catch(() => {})
      .finally(() => {
        localStorage.removeItem(LEGACY_SESSION_KEY);
        setReady(true);
      });
  }, []);

  // Safety net: keep localStorage in sync so route navigations can recover the
  // identity (the chat page is a separate document load).
  useEffect(() => {
    if (ready && user) saveUser(user);
  }, [ready, user]);

  function loggedIn(next: User) {
    saveUser(next);
    setUser(next);
  }

  function logout() {
    clearUser();
    setUser(null);
  }

  if (!ready) return null;

  return (
    <main>
      {user ? (
        <Conversations user={user} onLogout={logout} />
      ) : (
        <Login onLoggedIn={loggedIn} />
      )}
    </main>
  );
}
