"use client";

import { useParams, useRouter } from "next/navigation";
import Chat from "../../../components/Chat";

export default function ChatPage() {
  const params = useParams<{ sessionId: string }>();
  const router = useRouter();

  return (
    <main>
      <Chat sessionId={params.sessionId} onLogout={() => router.replace("/")} />
    </main>
  );
}
