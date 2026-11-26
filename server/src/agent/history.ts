import { sessions, type StoredMessage } from "../db/mongo.ts";

const HISTORY_WINDOW = 30;

export async function ensureSession(sessionId: string, userRef: string): Promise<void> {
  const collection = sessions();
  const existing = await collection.findOne({ _id: sessionId });
  if (existing) {
    if (existing.user_ref !== userRef) {
      throw new Error("Session belongs to a different user");
    }
    return;
  }
  await collection.insertOne({
    _id: sessionId,
    user_ref: userRef,
    created_at: new Date(),
    messages: [],
  });
}

export async function loadHistory(sessionId: string, userRef: string): Promise<StoredMessage[]> {
  const collection = sessions();
  const doc = await collection.findOne({ _id: sessionId, user_ref: userRef });
  if (!doc) return [];
  return doc.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-HISTORY_WINDOW);
}

export async function appendMessages(
  sessionId: string,
  userRef: string,
  messages: StoredMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  const collection = sessions();
  await collection.updateOne(
    { _id: sessionId, user_ref: userRef },
    { $push: { messages: { $each: messages } } },
  );
}
