import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyCredentials } from "../db/users.ts";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/verify", async (request, reply) => {
    const parsed = z
      .object({ user_ref: z.string().min(1), pin: z.string().min(1) })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "user_ref and pin are required" });
    }
    const displayName = await verifyCredentials(parsed.data.user_ref, parsed.data.pin);
    if (!displayName) {
      return reply.code(401).send({ error: "Unknown user or wrong PIN" });
    }
    return { user_ref: parsed.data.user_ref, display_name: displayName };
  });
}
