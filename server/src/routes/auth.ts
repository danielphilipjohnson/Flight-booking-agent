import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgQueryable } from "../db/postgres.ts";
import { findUserByCredentials, listUsers } from "../db/queries/users.ts";

const loginBody = z.object({
  user_ref: z.string().min(1).max(40),
  pin: z.string().min(1).max(20),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Demo users for the login picker (never exposes PINs).
  app.get("/api/users", async () => {
    const users = await listUsers(pgQueryable);
    return { users };
  });

  // Mock auth: verifies the PIN and returns the user identity. Conversations
  // are separate resources created via POST /api/conversations.
  app.post("/api/login", async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "user_ref and pin are required" });
    }
    const { user_ref, pin } = parsed.data;
    const user = await findUserByCredentials(pgQueryable, user_ref, pin);
    if (!user) {
      return reply.code(401).send({ error: "invalid user_ref or pin" });
    }
    return {
      user_ref: String(user.user_ref),
      display_name: String(user.display_name),
    };
  });
}
