export const CONVERSATION_TITLE_MAX = 60;
const CONVERSATION_PREVIEW_MAX = 140;

export interface ConversationSource {
  _id: string;
  messages: { role: string; content: string }[];
  created_at: Date;
  updated_at?: Date;
  title?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  preview: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Derives a short conversation title from the first user message. */
export function titleFromUserMessage(text: string): string {
  const cleaned = collapse(text);
  if (!cleaned) return "New conversation";
  return cleaned.length > CONVERSATION_TITLE_MAX
    ? `${cleaned.slice(0, CONVERSATION_TITLE_MAX - 1).trimEnd()}…`
    : cleaned;
}

function previewFrom(text: string): string {
  const cleaned = collapse(text);
  return cleaned.length > CONVERSATION_PREVIEW_MAX
    ? `${cleaned.slice(0, CONVERSATION_PREVIEW_MAX - 1).trimEnd()}…`
    : cleaned;
}

/** Shapes a stored session into the list row shown on the conversations page. */
export function summarizeConversation(session: ConversationSource): ConversationSummary {
  const firstUser = session.messages.find((m) => m.role === "user");
  const lastReply = [...session.messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content.trim().length > 0);
  const updated = session.updated_at ?? session.created_at;
  return {
    id: session._id,
    title:
      session.title?.trim() ||
      (firstUser ? titleFromUserMessage(firstUser.content) : "New conversation"),
    preview: lastReply ? previewFrom(lastReply.content) : "",
    // Empty assistant rows are tool-call scaffolding, not user-visible turns.
    message_count: session.messages.filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        m.content.trim().length > 0,
    ).length,
    created_at: session.created_at.toISOString(),
    updated_at: updated.toISOString(),
  };
}
