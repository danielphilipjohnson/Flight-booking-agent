import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/postgres.ts";

const loginBody = z.object({
  user_ref: z.string().min(1).max(40),
  pin: z.string().min(1).max(20),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Demo users for the login picker (never exposes PINs).
  app.get("/api/users", async () => {
    const { rows } = await pool.query(
      "SELECT user_ref, display_name FROM app_user ORDER BY display_name",
    );
    return { users: rows };
  });

  // Mock auth: verifies the PIN and returns the user identity. Conversations
  // are separate resources created via POST /api/conversations.
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
    return {
      user_ref: String(rows[0]!.user_ref),
      display_name: String(rows[0]!.display_name),
    };
  });
}
