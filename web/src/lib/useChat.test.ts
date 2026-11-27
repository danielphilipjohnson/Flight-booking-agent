import "./registerDom.ts";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { SessionHistory, User } from "./api.ts";
import type { ChatStreamEvent, StreamChatTurnOptions } from "./chatStream.ts";
import type { StorageLike } from "./user.ts";

// Imported dynamically so registerDom.ts has installed the DOM globals first.
const { act, cleanup, renderHook, waitFor } = await import("@testing-library/react");
const { useChat } = await import("./useChat.ts");

afterEach(() => cleanup());

const USER: User = { user_ref: "ava", display_name: "Ava" };
const USER_KEY = "flight-agent.user";
const LEGACY_KEY = "flight-agent.session";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  const storage: StorageLike & { map: Map<string, string> } = {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    map,
  };
  return storage;
}

function sessionHistory(messages: SessionHistory["messages"] = []): SessionHistory {
  return {
    sessionId: "s1",
    user_ref: USER.user_ref,
    display_name: USER.display_name,
    messages,
  };
}

function streamStub(events: ChatStreamEvent[]) {
  return async (_opts: StreamChatTurnOptions, onEvent: (e: ChatStreamEvent) => void) => {
    for (const event of events) onEvent(event);
  };
}

async function mountRestored(overrides: Partial<Parameters<typeof useChat>[0]> = {}) {
  const storage = memoryStorage({ [USER_KEY]: JSON.stringify(USER) });
  const loadSessionImpl = async () =>
    sessionHistory([
      { role: "user", content: "earlier question", ts: "2026-11-21T10:00:00Z" },
      { role: "assistant", content: "earlier answer", ts: "2026-11-21T10:00:03Z" },
    ]);
  const { result } = renderHook(() =>
    useChat({ sessionId: "s1", storage, loadSessionImpl, ...overrides }),
  );
  await waitFor(() => assert.equal(result.current.state.history, "ready"));
  return { result, storage, loadSessionImpl };
}

test("mount with saved session restores the user and hydrates history", async () => {
  const { result } = await mountRestored();
  const state = result.current.state;
  assert.equal(state.user?.user_ref, "ava");
  assert.equal(state.user?.display_name, "Ava");
  assert.equal(state.stage, "idle");
  assert.deepEqual(
    state.messages.map((m) => [m.role, m.content]),
    [
      ["user", "earlier question"],
      ["assistant", "earlier answer"],
    ],
  );
  assert.equal(state.messages[0]!.status, "delivered");
});

test("mount without a stored user shows the login form (user stays null)", async () => {
  const storage = memoryStorage();
  const { result } = renderHook(() =>
    useChat({ sessionId: "s1", storage, loadSessionImpl: async () => sessionHistory() }),
  );
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(result.current.state.user, null);
});

test("mount with a dead session drops back to the login form with the error", async () => {
  const storage = memoryStorage({ [USER_KEY]: JSON.stringify(USER) });
  const loadSessionImpl = async () => {
    throw new Error("HTTP 404");
  };
  const { result } = renderHook(() => useChat({ sessionId: "gone", storage, loadSessionImpl }));
  await waitFor(() => assert.equal(result.current.state.history, "error"));
  const state = result.current.state;
  assert.equal(state.user, null, "dead session -> login form");
  assert.equal(state.historyError, "HTTP 404");
});

test("send -> stream events -> confirm gate -> confirm -> idle", async () => {
  const pending = { tool: "hold_seat", args: { flight_id: "F1", seat: "12A" }, id: "c1" };
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body) });
    return new Response(JSON.stringify({ ok: true, result: { booking_id: "B1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const streamTurn = streamStub([
    { type: "typing" },
    { type: "token", text: "Let me " },
    { type: "token", text: "check 12A" },
    { type: "tool", name: "hold_seat", status: "pending", summary: "seat 12A" },
    { type: "confirm", pending },
    {
      type: "done",
      reply: "Want me to hold 12A?",
      toolTrace: [{ name: "hold_seat", status: "pending", summary: "seat 12A" }],
      pendingConfirmation: null,
    },
  ]);
  const { result } = await mountRestored({ streamTurn, fetchImpl });

  await act(async () => {
    await result.current.send("hold seat 12A on F1");
  });

  const gated = result.current.state;
  assert.equal(gated.stage, "awaiting_confirmation");
  if (gated.stage === "awaiting_confirmation") {
    assert.deepEqual(gated.pending, pending);
  }
  const last = gated.messages[gated.messages.length - 1]!;
  assert.equal(last.content, "Want me to hold 12A?");
  assert.equal(last.toolTrace!.length, 1);
  assert.equal(gated.messages[gated.messages.length - 2]!.status, "delivered");

  await act(async () => {
    await result.current.decide(true);
  });

  const done = result.current.state;
  assert.equal(done.stage, "idle");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/api/tools/hold_seat/confirm");
  assert.deepEqual(JSON.parse(calls[0]!.body), {
    sessionId: "s1",
    confirmationId: "c1",
    args: pending.args,
  });
  const note = done.messages[done.messages.length - 1]!;
  assert.match(note.content, /Confirmed: hold_seat/);
  assert.match(note.content, /B1/);
});

test("send -> server error -> failed with the placeholder removed (#13)", async () => {
  const streamTurn = streamStub([
    { type: "error", error: "HTTP 502: agent backend unreachable" },
  ]);
  const { result } = await mountRestored({ streamTurn });

  await act(async () => {
    await result.current.send("any flights?");
  });

  const state = result.current.state;
  assert.equal(state.stage, "failed");
  if (state.stage === "failed") assert.match(state.error, /502/);
  assert.equal(state.messages.length, 3, "restored pair + user turn, placeholder gone");
  assert.equal(state.messages[2]!.role, "user");
  assert.equal(state.messages[2]!.content, "any flights?");
  assert.ok(
    state.messages.every((m) => !(m.role === "assistant" && m.content === "")),
    "no empty assistant bubble remains",
  );
});

test("send is blocked while a confirmation is pending", async () => {
  const pending = { tool: "hold_seat", args: {}, id: "c9" };
  let sent = 0;
  const streamTurn = async (
    _opts: StreamChatTurnOptions,
    onEvent: (e: ChatStreamEvent) => void,
  ) => {
    sent += 1;
    onEvent({ type: "confirm", pending });
    onEvent({
      type: "done",
      reply: "confirm first",
      toolTrace: [],
      pendingConfirmation: null,
    });
  };
  const { result } = await mountRestored({ streamTurn });

  await act(async () => {
    await result.current.send("first");
  });
  const gated = result.current.state;
  assert.equal(gated.stage, "awaiting_confirmation");

  await act(async () => {
    await result.current.send("second");
  });
  assert.equal(sent, 1, "no second stream while the gate is open");
  const after = result.current.state;
  assert.equal(after.stage, "awaiting_confirmation");
  assert.equal(
    after.messages.filter((m) => m.role === "user").length,
    2,
    "one restored + one sent user turn; the blocked send appended nothing",
  );
});

test("decline resolves the gate without calling the confirm endpoint", async () => {
  const pending = { tool: "hold_seat", args: {}, id: "c2" };
  const streamTurn = streamStub([
    { type: "confirm", pending },
    { type: "done", reply: "ok?", toolTrace: [], pendingConfirmation: null },
  ]);
  let confirmCalls = 0;
  const fetchImpl = (async () => {
    confirmCalls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const { result } = await mountRestored({ streamTurn, fetchImpl });

  await act(async () => {
    await result.current.send("hold it");
  });
  const gated = result.current.state;
  assert.equal(gated.stage, "awaiting_confirmation");

  await act(async () => {
    await result.current.decide(false);
  });
  const declined = result.current.state;
  assert.equal(declined.stage, "idle");
  assert.equal(confirmCalls, 0);
  assert.equal(
    declined.messages[declined.messages.length - 1]!.content,
    "Declined — no changes were made.",
  );
});

test("logout clears the stored credential and resets state", async () => {
  const { result, storage } = await mountRestored();
  assert.ok(storage.getItem(USER_KEY));

  act(() => {
    result.current.logout();
  });

  const state = result.current.state;
  assert.equal(state.user, null);
  assert.equal(state.stage, "idle");
  assert.deepEqual(state.messages, []);
  assert.equal(storage.getItem(USER_KEY), null, "user key removed from storage");
  assert.equal(storage.getItem(LEGACY_KEY), null, "legacy key removed too");
});
