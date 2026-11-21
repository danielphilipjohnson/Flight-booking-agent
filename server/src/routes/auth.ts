import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/postgres.ts";
import { sessions } from "../db/mongo.ts";

const loginBody = z.object({
  user_ref: z.string().min(1).max(40),
  pin: z.string().min(1).max(20),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/login", async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "user_ref and pin are required" });
    }
    const { user_ref, pin } = parsed.data;
    const { rows } = await pool.query(
      "SELECT user_ref, display_name FROM app_user WHERE user_ref = $1 AND pin = $2",
      [user_ref, pin],
    );
    if (rows.length === 0) {
      return reply.code(401).send({ error: "invalid user_ref or pin" });
    }
    const sessionId = randomUUID();
    await sessions().insertOne({
      _id: sessionId,
      user_ref,
      display_name: String(rows[0]!.display_name),
      created_at: new Date(),
      messages: [],
    });
    return { sessionId, user_ref, display_name: rows[0]!.display_name };
  });
}
