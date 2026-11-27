import type { StoredMessage } from "./chatStream.ts";

export interface User {
  user_ref: string;
  display_name: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  preview: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface SessionHistory {
  sessionId: string;
  user_ref: string;
  display_name?: string;
  title?: string;
  updated_at?: string;
  messages: StoredMessage[];
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // fall through to the status
  }
  return `HTTP ${res.status}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function listUsers(): Promise<{ users: User[] }> {
  return request<{ users: User[] }>("/api/users");
}

export function login(user_ref: string, pin: string): Promise<User> {
  return post<User>("/api/login", { user_ref, pin });
}

export function listConversations(
  userRef: string,
): Promise<{ user_ref: string; conversations: ConversationSummary[] }> {
  return request(
    `/api/users/${encodeURIComponent(userRef)}/conversations`,
  );
}

export function createConversation(
  userRef: string,
): Promise<{ sessionId: string }> {
  return post<{ sessionId: string }>("/api/conversations", {
    user_ref: userRef,
  });
}

export function loadSession(sessionId: string): Promise<SessionHistory> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}`);
}
