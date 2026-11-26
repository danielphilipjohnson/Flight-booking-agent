import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/postgres.ts";

const verifyBody = z.object({
  user_ref: z.string().min(1),
  pin: z.string().min(1),
});

interface LookupRow {
  display_name: string;
}

export async function verifyCredentials(userRef: string, pin: string): Promise<string | null> {
  const result = await pool.query<LookupRow>(
    "SELECT display_name FROM app_user WHERE user_ref = $1 AND pin = $2",
    [userRef, pin],
  );
  return result.rows[0]?.display_name ?? null;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/verify", async (request, reply) => {
    const parsed = verifyBody.safeParse(request.body);
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
