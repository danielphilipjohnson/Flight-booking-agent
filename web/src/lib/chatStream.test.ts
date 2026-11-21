import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendAssistantNote,
  appendAssistantPlaceholder,
  appendTokenToLastAssistant,
  appendToolChip,
  appendUserTurn,
  createSseParser,
  finalizeLastAssistant,
  removeEmptyTrailingAssistant,
  streamChatTurn,
  type ChatMessage,
  type ChatStreamEvent,
  type SseFrame,
} from "./chatStream.ts";

test("SSE parser handles events split across chunk boundaries", () => {
  const frames: SseFrame[] = [];
  const parse = createSseParser((f) => frames.push(f));
  const wire =
    'event: token\ndata: {"text":"Hel"}\n\nevent: done\ndata: {"reply":"hi"}\n\n';
  parse(wire.slice(0, 10));
  parse(wire.slice(10, 25));
  parse(wire.slice(25));
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.event, "token");
  assert.equal(JSON.parse(frames[0]!.data).text, "Hel");
  assert.equal(frames[1]!.event, "done");
});

test("streamChatTurn emits the exact event sequence from a canned SSE stream", async () => {
  const sse =
    'event: typing\ndata: {}\n\n' +
    'event: token\ndata: {"text":"Hel"}\n\n' +
    'event: token\ndata: {"text":"lo"}\n\n' +
    'event: tool\ndata: {"name":"search_flights","status":"ok","summary":"3 results"}\n\n' +
    'event: done\ndata: {"reply":"Hello","toolTrace":[],"pendingConfirmation":null,"stats":{"latencyMs":5}}\n\n';
  const fetchImpl = (async () => new Response(sse, { status: 200 })) as typeof fetch;
  const events: ChatStreamEvent[] = [];
  await streamChatTurn({ sessionId: "s1", message: "hi", fetchImpl }, (e) => events.push(e));
  assert.deepEqual(
    events.map((e) => e.type),
    ["typing", "token", "token", "tool", "done"],
  );
  const done = events[4] as Extract<ChatStreamEvent, { type: "done" }>;
  assert.equal(done.reply, "Hello");
  assert.equal((done.stats as { latencyMs: number }).latencyMs, 5);
});

test("streamChatTurn emits a synthetic error when the stream ends without done (#17)", async () => {
  const sse = 'event: token\ndata: {"text":"partial"}\n\n';
  const fetchImpl = (async () => new Response(sse, { status: 200 })) as typeof fetch;
  const events: ChatStreamEvent[] = [];
  await streamChatTurn({ sessionId: "s1", message: "hi", fetchImpl }, (e) => events.push(e));
  const last = events[events.length - 1]!;
  assert.equal(last.type, "error");
  assert.match((last as { error: string }).error, /ended before/);
});

test("streamChatTurn surfaces server error events and does not double-report", async () => {
  const sse = 'event: error\ndata: {"error":"agent backend failed: boom"}\n\n';
  const fetchImpl = (async () => new Response(sse, { status: 200 })) as typeof fetch;
  const events: ChatStreamEvent[] = [];
  await streamChatTurn({ sessionId: "s1", message: "hi", fetchImpl }, (e) => events.push(e));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "error");
  assert.match((events[0] as { error: string }).error, /boom/);
});

test("streamChatTurn maps non-OK HTTP responses to an error event with the server message", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: "unknown session — log in first" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const events: ChatStreamEvent[] = [];
  await streamChatTurn({ sessionId: "nope", message: "hi", fetchImpl }, (e) => events.push(e));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "error");
  assert.match((events[0] as { error: string }).error, /unknown session/);
});

test("message updaters are named pure functions with explicit behavior", () => {
  let messages: ChatMessage[] = [];
  messages = appendUserTurn(messages, "hello");
  messages = appendAssistantPlaceholder(messages);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, "user");
  assert.equal(messages[1]!.role, "assistant");
  assert.notEqual(messages[0]!.id, messages[1]!.id);

  messages = appendTokenToLastAssistant(messages, "Hel");
  messages = appendTokenToLastAssistant(messages, "lo");
  assert.equal(messages[1]!.content, "Hello");

  messages = appendToolChip(messages, { name: "search_flights", status: "ok", summary: "3 results" });
  assert.equal(messages[1]!.toolTrace!.length, 1);

  messages = finalizeLastAssistant(messages, "final reply", []);
  assert.equal(messages[1]!.content, "final reply");
  assert.equal(messages[1]!.toolTrace!.length, 0);

  messages = appendAssistantNote(messages, "Declined — no changes were made.");
  assert.equal(messages[2]!.content, "Declined — no changes were made.");
});

test("updaters are safe on edge cases", () => {
  assert.deepEqual(appendTokenToLastAssistant([], "x"), []);
  assert.deepEqual(appendToolChip([], { name: "t", status: "ok", summary: "" }), []);
  assert.deepEqual(finalizeLastAssistant([], "r", []), []);
  const withPlaceholder = appendAssistantPlaceholder([]);
  assert.equal(removeEmptyTrailingAssistant(withPlaceholder).length, 0);
  const withText = appendUserTurn([], "hi");
  assert.equal(removeEmptyTrailingAssistant(withText).length, 1);
});
