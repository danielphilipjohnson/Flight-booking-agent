import { useCallback, useEffect, useReducer } from "react";
import { loadSession, type SessionHistory, type User } from "./api.ts";
import {
  fromStoredMessages,
  streamChatTurn,
  type ChatStreamEvent,
} from "./chatStream.ts";
import { chatReducer, initialChatState, type ChatState } from "./chatReducer.ts";
import { clearUser, loadUser, saveUser, type StorageLike } from "./user.ts";

export interface UseChatOptions {
  sessionId: string;
  fetchImpl?: typeof fetch;
  streamTurn?: typeof streamChatTurn;
  storage?: StorageLike;
  loadSessionImpl?: (sessionId: string) => Promise<SessionHistory>;
}

export interface UseChatResult {
  state: ChatState;
  setInput: (text: string) => void;
  send: (text: string) => Promise<void>;
  decide: (confirm: boolean) => Promise<void>;
  login: (user: User) => Promise<void>;
  logout: () => void;
}

/**
 * Thin wiring over the pure `chatReducer`: dispatchers translate stream
 * events and fetch results into actions; all side effects (fetch, storage)
 * are injectable so hook tests can stub them.
 */
export function useChat(options: UseChatOptions): UseChatResult {
  const { sessionId } = options;
  const [state, dispatch] = useReducer(chatReducer, initialChatState());

  const storage = useCallback((): StorageLike => options.storage ?? localStorage, [
    options.storage,
  ]);
  const fetchFn = useCallback((): typeof fetch => options.fetchImpl ?? fetch, [
    options.fetchImpl,
  ]);
  const streamTurn = options.streamTurn ?? streamChatTurn;
  const loadSessionFn = options.loadSessionImpl ?? loadSession;

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: "history_load_started" });
    const stored = loadUser(storage());
    if (!stored) return;
    loadSessionFn(sessionId)
      .then((body) => {
        if (cancelled) return;
        dispatch({
          type: "session_restored",
          user: {
            user_ref: body.user_ref,
            display_name: body.display_name ?? body.user_ref,
          },
          messages: fromStoredMessages(body.messages),
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        dispatch({ type: "session_load_failed", error: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const setInput = useCallback((text: string) => {
    dispatch({ type: "input_changed", text });
  }, []);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      if (state.stage !== "idle" && state.stage !== "failed") return;
      if (state.history !== "ready" || !state.user) return;
      dispatch({ type: "send_started", text });
      try {
        await streamTurn(
          { sessionId, message: text, fetchImpl: options.fetchImpl },
          (event: ChatStreamEvent) => {
            switch (event.type) {
              case "token":
                dispatch({ type: "token", text: event.text });
                break;
              case "tool":
                dispatch({
                  type: "tool",
                  chip: { name: event.name, status: event.status, summary: event.summary },
                });
                break;
              case "confirm":
                dispatch({ type: "confirm_received", pending: event.pending });
                break;
              case "done":
                dispatch({
                  type: "done",
                  reply: event.reply,
                  toolTrace: event.toolTrace,
                  pendingConfirmation: event.pendingConfirmation,
                });
                break;
              case "error":
                throw new Error(event.error);
              case "typing":
                break;
            }
          },
        );
        dispatch({ type: "stream_finished" });
      } catch (err) {
        console.error("[chat] turn failed", { sessionId, message: text, err });
        dispatch({ type: "failed", error: (err as Error).message });
      }
    },
    [sessionId, state.stage, state.history, state.user, streamTurn, options.fetchImpl],
  );

  const decide = useCallback(
    async (confirm: boolean) => {
      if (state.stage !== "awaiting_confirmation") return;
      const pending = state.pending;
      if (!confirm) {
        dispatch({ type: "declined" });
        return;
      }
      dispatch({ type: "confirm_started" });
      try {
        const res = await fetchFn()(`/api/tools/${pending.tool}/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            confirmationId: pending.id,
            args: pending.args,
          }),
        });
        const body = (await res.json()) as { error?: string; result?: unknown };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        dispatch({ type: "confirm_succeeded", result: body.result });
      } catch (err) {
        dispatch({ type: "confirm_failed", error: (err as Error).message });
      }
    },
    [sessionId, state, fetchFn],
  );

  const login = useCallback(
    async (user: User) => {
      saveUser(user, storage());
      try {
        const body = await loadSessionFn(sessionId);
        dispatch({
          type: "login_succeeded",
          user,
          messages: fromStoredMessages(body.messages),
        });
      } catch (err) {
        dispatch({ type: "session_load_failed", error: (err as Error).message });
        throw err;
      }
    },
    [sessionId, loadSessionFn, storage],
  );

  const logout = useCallback(() => {
    clearUser(storage());
    dispatch({ type: "logout" });
  }, [storage]);

  return { state, setInput, send, decide, login, logout };
}
