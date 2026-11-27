import type { FastifyInstance } from "fastify";
import { sessions } from "../db/mongo.ts";
import { pgQueryable } from "../db/postgres.ts";
import { findUserByCredentials } from "../db/queries/users.ts";

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { user_ref?: string; pin?: string };
    if (!query.user_ref || !query.pin) {
      return reply.code(400).send({ error: "user_ref and pin query parameters are required" });
    }
    const user = await findUserByCredentials(pgQueryable, query.user_ref, query.pin);
    if (!user) return reply.code(401).send({ error: "Unknown user or wrong PIN" });

    const doc = await sessions().findOne({ _id: id, user_ref: query.user_ref });
    if (!doc) return reply.code(404).send({ error: "Session not found" });

    return {
      session_id: doc._id,
      user_ref: doc.user_ref,
      created_at: doc.created_at,
      messages: doc.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content, ts: m.ts })),
    };
  });
}
