"use client";

import { useEffect, useState } from "react";
import { listUsers, login, type User } from "../lib/api.ts";

const FALLBACK_USERS: User[] = [
  { user_ref: "ava", display_name: "Ava" },
  { user_ref: "ben", display_name: "Ben" },
  { user_ref: "chloe", display_name: "Chloe" },
  { user_ref: "dan", display_name: "Dan" },
  { user_ref: "elena", display_name: "Elena" },
];

export default function Login({
  onLoggedIn,
}: {
  onLoggedIn: (user: User) => void;
}) {
  const [users, setUsers] = useState<User[]>(FALLBACK_USERS);
  const [userRef, setUserRef] = useState("ava");
  const [pin, setPin] = useState("4321");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listUsers()
      .then((body) => {
        if (body.users?.length) setUsers(body.users);
      })
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(await login(userRef, pin));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
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
      <button type="submit" disabled={busy}>
        {busy ? "Logging in…" : "Log in"}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
