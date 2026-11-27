import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canCompose,
  chatReducer,
  initialChatState,
  isBusy,
  streamHasStarted,
  waitingForFirstToken,
  type ChatState,
} from "./chatReducer.ts";
import type { ChatMessage, PendingConfirmation, ToolChip } from "./chatStream.ts";
import type { User } from "./api.ts";

const ava: User = { user_ref: "ava", display_name: "Ava" };
const pending: PendingConfirmation = {
  tool: "hold_seat",
  args: { flight_id: "F1", seat: "12A" },
  id: "conf-1",
};
const chip: ToolChip = { name: "search_flights", status: "ok", summary: "3 results" };

function readyState(messages: ChatMessage[] = []): ChatState {
  return chatReducer(initialChatState(), {
    type: "login_succeeded",
    user: ava,
    messages,
  });
}

function streamingState(): ChatState {
  return chatReducer(readyState(), { type: "send_started", text: "hello" });
}

test("initial state is logged out, loading, idle", () => {
  const s = initialChatState();
  assert.equal(s.stage, "idle");
  assert.equal(s.user, null);
  assert.equal(s.history, "loading");
  assert.deepEqual(s.messages, []);
  assert.equal(s.input, "");
  assert.equal(isBusy(s), false);
  assert.equal(canCompose(s), false);
});

test("input_changed only touches the composer text", () => {
  const s = chatReducer(readyState(), { type: "input_changed", text: "flights?" });
  assert.equal(s.input, "flights?");
  assert.equal(s.stage, "idle");
});

test("login_succeeded / session_restored hydrate user, messages, history", () => {
  const messages: ChatMessage[] = [{ id: "m1", role: "user", content: "hi" }];
  const restored = chatReducer(initialChatState(), {
    type: "session_restored",
    user: ava,
    messages,
  });
  assert.equal(restored.user?.user_ref, "ava");
  assert.equal(restored.history, "ready");
  assert.equal(restored.messages, messages);
  assert.equal(restored.stage, "idle");
  const loggedIn = chatReducer(initialChatState(), {
    type: "login_succeeded",
    user: ava,
    messages,
  });
  assert.deepEqual(loggedIn, restored);
});

test("session_load_failed drops to the login form with the error kept", () => {
  const s = chatReducer(readyState(), { type: "session_load_failed", error: "HTTP 404" });
  assert.equal(s.user, null);
  assert.equal(s.history, "error");
  assert.equal(s.historyError, "HTTP 404");
  assert.equal(s.stage, "idle");
});

test("logout clears user, messages and input", () => {
  let s = chatReducer(readyState([{ id: "m1", role: "user", content: "hi" }]), {
    type: "input_changed",
    text: "draft",
  });
  s = chatReducer(s, { type: "logout" });
  assert.equal(s.user, null);
  assert.deepEqual(s.messages, []);
  assert.equal(s.input, "");
  assert.equal(s.stage, "idle");
});

test("history_load_started resets the transcript but keeps the user", () => {
  const s = chatReducer(readyState([{ id: "m1", role: "user", content: "hi" }]), {
    type: "history_load_started",
  });
  assert.equal(s.user?.user_ref, "ava");
  assert.deepEqual(s.messages, []);
  assert.equal(s.history, "loading");
  assert.equal(s.stage, "idle");
});

test("send_started from idle appends user turn + assistant placeholder and clears input", () => {
  let s = chatReducer(readyState(), { type: "input_changed", text: "  hello  " });
  s = chatReducer(s, { type: "send_started", text: "hello" });
  assert.equal(s.stage, "streaming");
  assert.equal(s.input, "");
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[0]!.role, "user");
  assert.equal(s.messages[0]!.content, "hello");
  assert.equal(s.messages[0]!.status, "sent");
  assert.equal(s.messages[1]!.role, "assistant");
  assert.equal(s.messages[1]!.content, "");
  assert.equal(isBusy(s), true);
  assert.equal(canCompose(s), false);
  assert.equal(waitingForFirstToken(s), true);
  assert.equal(streamHasStarted(s), false);
});

test("send_started from failed clears the error and starts streaming", () => {
  let s = chatReducer(streamingState(), { type: "failed", error: "boom" });
  assert.equal(s.stage, "failed");
  s = chatReducer(s, { type: "send_started", text: "retry" });
  assert.equal(s.stage, "streaming");
  assert.equal("error" in s, false);
  assert.equal(s.messages[s.messages.length - 1]!.content, "");
});

test("send_started while awaiting_confirmation / streaming / confirming is a no-op", () => {
  let s = chatReducer(streamingState(), { type: "confirm_received", pending });
  assert.equal(s.stage, "awaiting_confirmation");
  const afterConfirm = chatReducer(s, { type: "send_started", text: "sneaky" });
  assert.equal(afterConfirm, s, "pending write must not be silently dropped");

  const streaming = streamingState();
  assert.equal(chatReducer(streaming, { type: "send_started", text: "x" }), streaming);

  const confirming = chatReducer(s, { type: "confirm_started" });
  assert.equal(chatReducer(confirming, { type: "send_started", text: "x" }), confirming);
});

test("token and tool events accumulate on the trailing assistant message", () => {
  let s = streamingState();
  s = chatReducer(s, { type: "token", text: "Hel" });
  s = chatReducer(s, { type: "token", text: "lo" });
  s = chatReducer(s, { type: "tool", chip });
  assert.equal(s.messages[1]!.content, "Hello");
  assert.deepEqual(s.messages[1]!.toolTrace, [chip]);
  assert.equal(waitingForFirstToken(s), false);
  assert.equal(streamHasStarted(s), true);
});

test("confirm_received moves to awaiting_confirmation carrying the pending write", () => {
  const s = chatReducer(streamingState(), { type: "confirm_received", pending });
  assert.equal(s.stage, "awaiting_confirmation");
  if (s.stage === "awaiting_confirmation") assert.deepEqual(s.pending, pending);
  assert.equal(isBusy(s), false);
  assert.equal(canCompose(s), false, "composer stays locked while a write is pending");
});

test("done finalizes the turn: reply, toolTrace, delivered tick, and idle", () => {
  let s = streamingState();
  s = chatReducer(s, { type: "token", text: "partial" });
  s = chatReducer(s, {
    type: "done",
    reply: "final reply",
    toolTrace: [chip],
    pendingConfirmation: null,
  });
  assert.equal(s.stage, "idle");
  assert.equal("pending" in s, false, "no stale pending payload after done");
  assert.equal(s.messages[1]!.content, "final reply");
  assert.deepEqual(s.messages[1]!.toolTrace, [chip]);
  assert.equal(s.messages[0]!.status, "delivered");
  assert.equal(canCompose(s), true);
});

test("done with pendingConfirmation opens the confirm gate (#14/#17)", () => {
  const s = chatReducer(streamingState(), {
    type: "done",
    reply: "want to hold a seat?",
    toolTrace: [],
    pendingConfirmation: pending,
  });
  assert.equal(s.stage, "awaiting_confirmation");
  if (s.stage === "awaiting_confirmation") assert.deepEqual(s.pending, pending);
});

test("done after a mid-stream confirm keeps awaiting_confirmation (#17)", () => {
  let s = streamingState();
  s = chatReducer(s, { type: "confirm_received", pending });
  s = chatReducer(s, {
    type: "done",
    reply: "still want it?",
    toolTrace: [],
    pendingConfirmation: { tool: "other", args: {} },
  });
  assert.equal(s.stage, "awaiting_confirmation");
  if (s.stage === "awaiting_confirmation") {
    assert.deepEqual(s.pending, pending, "mid-stream confirm wins over done's pendingConfirmation");
  }
  assert.equal(s.messages[1]!.content, "still want it?");
});

test("stream_finished only releases the streaming stage", () => {
  const streaming = streamingState();
  const idle = chatReducer(streaming, { type: "stream_finished" });
  assert.equal(idle.stage, "idle");
  const awaiting = chatReducer(streaming, { type: "confirm_received", pending });
  assert.equal(chatReducer(awaiting, { type: "stream_finished" }), awaiting);
});

test("failed removes the empty placeholder (#13) and records the error", () => {
  let s = streamingState();
  s = chatReducer(s, { type: "failed", error: "HTTP 502" });
  assert.equal(s.stage, "failed");
  if (s.stage === "failed") assert.equal(s.error, "HTTP 502");
  assert.equal(s.messages.length, 1, "empty assistant placeholder is removed");
  assert.equal(s.messages[0]!.role, "user");
  assert.equal(canCompose(s), true, "failed still allows composing a retry");
});

test("failed after tokens keeps the partial assistant message", () => {
  let s = streamingState();
  s = chatReducer(s, { type: "token", text: "partial" });
  s = chatReducer(s, { type: "failed", error: "stream ended before the turn finished" });
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[1]!.content, "partial");
});

test("confirm_started moves awaiting_confirmation to confirming", () => {
  const awaiting = chatReducer(streamingState(), { type: "confirm_received", pending });
  const s = chatReducer(awaiting, { type: "confirm_started" });
  assert.equal(s.stage, "confirming");
  if (s.stage === "confirming") assert.deepEqual(s.pending, pending);
  assert.equal(isBusy(s), true);
  assert.equal(chatReducer(readyState(), { type: "confirm_started" }).stage, "idle");
});

test("confirm_succeeded returns to idle with a result note and ok chip", () => {
  let s = chatReducer(streamingState(), { type: "confirm_received", pending });
  s = chatReducer(s, { type: "confirm_started" });
  s = chatReducer(s, { type: "confirm_succeeded", result: { booking_id: "B1" } });
  assert.equal(s.stage, "idle");
  const note = s.messages[s.messages.length - 1]!;
  assert.equal(note.role, "assistant");
  assert.match(note.content, /Confirmed: hold_seat/);
  assert.match(note.content, /booking_id/);
  assert.deepEqual(note.toolTrace, [
    { name: "hold_seat", status: "ok", summary: "confirmed & executed" },
  ]);
  assert.equal(canCompose(s), true);
});

test("confirm_failed keeps a note and lands on failed with the error", () => {
  let s = chatReducer(streamingState(), { type: "confirm_received", pending });
  s = chatReducer(s, { type: "confirm_started" });
  s = chatReducer(s, { type: "confirm_failed", error: "seat was just taken" });
  assert.equal(s.stage, "failed");
  if (s.stage === "failed") assert.equal(s.error, "seat was just taken");
  assert.match(s.messages[s.messages.length - 1]!.content, /Confirmation failed: seat was just taken/);
});

test("declined returns to idle with a declined note and no write", () => {
  let s = chatReducer(streamingState(), { type: "confirm_received", pending });
  s = chatReducer(s, { type: "declined" });
  assert.equal(s.stage, "idle");
  assert.equal(s.messages[s.messages.length - 1]!.content, "Declined — no changes were made.");
  assert.equal(chatReducer(readyState(), { type: "declined" }).stage, "idle", "no-op outside the gate");
});

test("confirm actions are no-ops outside their stages", () => {
  const idle = readyState();
  assert.equal(chatReducer(idle, { type: "confirm_succeeded", result: {} }), idle);
  assert.equal(chatReducer(idle, { type: "confirm_failed", error: "x" }), idle);
  const streaming = streamingState();
  assert.equal(chatReducer(streaming, { type: "confirm_succeeded", result: {} }), streaming);
});
