import type { User } from "./api.ts";
import {
  appendAssistantNote,
  appendAssistantPlaceholder,
  appendTokenToLastAssistant,
  appendToolChip,
  appendUserTurn,
  finalizeLastAssistant,
  markLastUserDelivered,
  removeEmptyTrailingAssistant,
  type ChatMessage,
  type PendingConfirmation,
  type ToolChip,
} from "./chatStream.ts";

export type HistoryState = "loading" | "ready" | "error";

/**
 * The #14 stage union: the chat process is exactly one stage at a time, so
 * invalid combinations (error + live confirm card, busy + pending) are
 * unrepresentable.
 */
export type ChatStage =
  | { stage: "idle" }
  | { stage: "streaming" }
  | { stage: "awaiting_confirmation"; pending: PendingConfirmation }
  | { stage: "confirming"; pending: PendingConfirmation }
  | { stage: "failed"; error: string };

export interface ChatStateBase {
  user: User | null;
  messages: ChatMessage[];
  input: string;
  history: HistoryState;
  historyError: string | null;
}

export type ChatState = ChatStateBase & ChatStage;

export type ChatAction =
  | { type: "input_changed"; text: string }
  | { type: "history_load_started" }
  | { type: "session_restored"; user: User; messages: ChatMessage[] }
  | { type: "session_load_failed"; error: string }
  | { type: "login_succeeded"; user: User; messages: ChatMessage[] }
  | { type: "logout" }
  | { type: "send_started"; text: string }
  | { type: "token"; text: string }
  | { type: "tool"; chip: ToolChip }
  | { type: "confirm_received"; pending: PendingConfirmation }
  | {
      type: "done";
      reply: string;
      toolTrace: ToolChip[];
      pendingConfirmation: PendingConfirmation | null;
    }
  | { type: "stream_finished" }
  | { type: "failed"; error: string }
  | { type: "confirm_started" }
  | { type: "confirm_succeeded"; result: unknown }
  | { type: "confirm_failed"; error: string }
  | { type: "declined" };

export function initialChatState(): ChatState {
  return {
    user: null,
    messages: [],
    input: "",
    history: "loading",
    historyError: null,
    stage: "idle",
  };
}

/**
 * The non-stage fields, rebuilt field-by-field so a stage change can never
 * leak the previous stage's payload (`error` surviving into `streaming`,
 * `pending` surviving into `idle`).
 */
function baseOf(state: ChatState): ChatStateBase {
  return {
    user: state.user,
    messages: state.messages,
    input: state.input,
    history: state.history,
    historyError: state.historyError,
  };
}

/** True while a request is in flight — the composer and confirm card lock. */
export function isBusy(state: ChatState): boolean {
  return state.stage === "streaming" || state.stage === "confirming";
}

/** True when the composer accepts a new turn (idle/failed with history ready). */
export function canCompose(state: ChatState): boolean {
  return (state.stage === "idle" || state.stage === "failed") && state.history === "ready";
}

export function waitingForFirstToken(state: ChatState): boolean {
  if (state.stage !== "streaming") return false;
  const last = state.messages[state.messages.length - 1];
  return (
    last !== undefined &&
    last.role === "assistant" &&
    last.content === "" &&
    (last.toolTrace?.length ?? 0) === 0
  );
}

export function streamHasStarted(state: ChatState): boolean {
  if (state.stage !== "streaming") return false;
  const last = state.messages[state.messages.length - 1];
  return (
    last !== undefined &&
    last.role === "assistant" &&
    (last.content.length > 0 || (last.toolTrace?.length ?? 0) > 0)
  );
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "input_changed":
      return { ...state, input: action.text };

    case "history_load_started":
      return {
        ...baseOf(state),
        messages: [],
        history: "loading",
        historyError: null,
        stage: "idle",
      };

    case "session_restored":
      return {
        ...baseOf(state),
        user: action.user,
        messages: action.messages,
        history: "ready",
        historyError: null,
        stage: "idle",
      };

    case "session_load_failed":
      // A dead session drops the credential back to the login form.
      return {
        ...baseOf(state),
        user: null,
        history: "error",
        historyError: action.error,
        stage: "idle",
      };

    case "login_succeeded":
      return {
        ...baseOf(state),
        user: action.user,
        messages: action.messages,
        history: "ready",
        historyError: null,
        stage: "idle",
      };

    case "logout":
      return {
        ...baseOf(state),
        user: null,
        messages: [],
        input: "",
        history: "loading",
        historyError: null,
        stage: "idle",
      };

    case "send_started": {
      // Composer gating: a send is only valid from idle/failed. While a
      // confirmation is pending the reducer ignores it (the write proposal
      // must be resolved, not silently dropped).
      if (state.stage !== "idle" && state.stage !== "failed") return state;
      return {
        ...baseOf(state),
        input: "",
        messages: appendAssistantPlaceholder(appendUserTurn(state.messages, action.text)),
        stage: "streaming",
      };
    }

    case "token":
      return { ...state, messages: appendTokenToLastAssistant(state.messages, action.text) };

    case "tool":
      return { ...state, messages: appendToolChip(state.messages, action.chip) };

    case "confirm_received":
      return {
        ...baseOf(state),
        stage: "awaiting_confirmation",
        pending: action.pending,
      };

    case "done": {
      const messages = finalizeLastAssistant(
        markLastUserDelivered(state.messages),
        action.reply,
        action.toolTrace,
      );
      // #17: a confirm received mid-stream wins over the done event — the
      // pending card must not be clobbered.
      if (state.stage === "awaiting_confirmation") {
        return { ...state, messages };
      }
      return {
        ...baseOf(state),
        messages,
        ...(action.pendingConfirmation
          ? { stage: "awaiting_confirmation" as const, pending: action.pendingConfirmation }
          : { stage: "idle" as const }),
      };
    }

    case "stream_finished":
      return state.stage === "streaming"
        ? { ...baseOf(state), stage: "idle" }
        : state;

    case "failed":
      // #13: never leave an empty placeholder bubble behind on failure.
      return {
        ...baseOf(state),
        messages: removeEmptyTrailingAssistant(state.messages),
        stage: "failed",
        error: action.error,
      };

    case "confirm_started":
      if (state.stage !== "awaiting_confirmation") return state;
      return { ...baseOf(state), stage: "confirming", pending: state.pending };

    case "confirm_succeeded": {
      if (state.stage !== "confirming") return state;
      const pending = state.pending;
      return {
        ...baseOf(state),
        messages: appendAssistantNote(
          state.messages,
          `Confirmed: ${pending.tool} → ${JSON.stringify(action.result)}`,
          [{ name: pending.tool, status: "ok", summary: "confirmed & executed" }],
        ),
        stage: "idle",
      };
    }

    case "confirm_failed": {
      if (state.stage !== "confirming") return state;
      return {
        ...baseOf(state),
        messages: appendAssistantNote(
          state.messages,
          `Confirmation failed: ${action.error}`,
        ),
        stage: "failed",
        error: action.error,
      };
    }

    case "declined": {
      if (state.stage !== "awaiting_confirmation") return state;
      return {
        ...baseOf(state),
        messages: appendAssistantNote(state.messages, "Declined — no changes were made."),
        stage: "idle",
      };
    }

    default:
      return state;
  }
}
