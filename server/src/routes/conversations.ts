import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/postgres.ts";
import { sessions } from "../db/mongo.ts";
import { summarizeConversation } from "../db/conversations.ts";

const createBody = z.object({
  user_ref: z.string().min(1).max(40),
});

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  // All conversations for one user, newest activity first.
  app.get("/api/users/:userRef/conversations", async (req, reply) => {
    const { userRef } = req.params as { userRef: string };
    const docs = await sessions().find({ user_ref: userRef }).toArray();
    const conversations = docs
      .map(summarizeConversation)
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );
    return { user_ref: userRef, conversations };
  });

  // Start a fresh conversation for a user.
  app.post("/api/conversations", async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "user_ref is required" });
    }
    const { user_ref } = parsed.data;
    const { rows } = await pool.query(
      "SELECT display_name FROM app_user WHERE user_ref = $1",
      [user_ref],
    );
    if (rows.length === 0) {
      return reply.code(404).send({ error: "unknown user" });
    }
    const sessionId = randomUUID();
    const now = new Date();
    await sessions().insertOne({
      _id: sessionId,
      user_ref,
      display_name: String(rows[0]!.display_name),
      created_at: now,
      updated_at: now,
      title: "",
      messages: [],
    });
    return {
      sessionId,
      user_ref,
      display_name: String(rows[0]!.display_name),
      title: "New conversation",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
  });
}
