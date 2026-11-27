import assert from "node:assert/strict";
import {
  CONVERSATION_TITLE_MAX,
  summarizeConversation,
  titleFromUserMessage,
  type ConversationSource,
} from "../db/conversations.ts";

let passed = 0;
function ok(condition: boolean, label: string): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

console.log("\n# titleFromUserMessage");
ok(
  titleFromUserMessage("  flights   from\nLondon to Lisbon tomorrow ") ===
    "flights from London to Lisbon tomorrow",
  "whitespace collapsed and trimmed",
);
const longTitle = titleFromUserMessage("a".repeat(CONVERSATION_TITLE_MAX + 20));
ok(longTitle.length === CONVERSATION_TITLE_MAX, "long titles truncated to the max");
ok(longTitle.endsWith("…"), "truncated titles end with an ellipsis");
ok(titleFromUserMessage("   ") === "New conversation", "blank messages fall back to a default title");

console.log("\n# summarizeConversation");
const base: ConversationSource = {
  _id: "conv-1",
  created_at: new Date("2026-11-20T10:00:00.000Z"),
  messages: [
    { role: "user", content: "flights from London to Lisbon tomorrow" },
    { role: "assistant", content: "" },
    { role: "tool", content: '{"results":[]}' },
    { role: "assistant", content: "Found 3 flights to Lisbon." },
    { role: "user", content: "book seat 4A" },
    { role: "assistant", content: "Ready to hold seat 4A." },
  ],
};
const summary = summarizeConversation(base);
ok(summary.title === "flights from London to Lisbon tomorrow", "title uses the first user message");
ok(summary.preview === "Ready to hold seat 4A.", "preview uses the latest assistant reply");
ok(summary.message_count === 4, "only user + assistant turns are counted");
ok(summary.updated_at === "2026-11-20T10:00:00.000Z", "falls back to created_at when updated_at is missing");

const titled = summarizeConversation({
  ...base,
  title: "Lisbon trip",
  updated_at: new Date("2026-11-21T09:30:00.000Z"),
});
ok(titled.title === "Lisbon trip", "stored title wins over the derived one");
ok(titled.updated_at === "2026-11-21T09:30:00.000Z", "updated_at is surfaced for sorting");

const empty = summarizeConversation({
  _id: "conv-2",
  created_at: new Date("2026-11-20T10:00:00.000Z"),
  messages: [],
});
ok(empty.title === "New conversation", "empty conversation gets a placeholder title");
ok(empty.preview === "" && empty.message_count === 0, "empty conversation has no preview or turns");

console.log(`\n${passed} assertions passed`);
