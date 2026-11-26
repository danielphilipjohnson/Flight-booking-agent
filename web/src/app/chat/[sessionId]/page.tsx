"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Chat from "../../../components/Chat";
import type { User } from "../../../lib/api.ts";
import { clearUser, loadUser } from "../../../lib/user.ts";

export default function ChatPage() {
  const params = useParams<{ sessionId: string }>();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = loadUser();
    if (!stored) {
      router.replace("/");
      return;
    }
    setUser(stored);
    setReady(true);
  }, [router]);

  if (!ready || !user) return null;

  return (
    <main>
      <Chat
        sessionId={params.sessionId}
        user={user}
        onLogout={() => {
          clearUser();
          router.replace("/");
        }}
      />
    </main>
  );
}
