import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.ts";
import { pgQueryable } from "../db/postgres.ts";
import { sessions, type StoredMessage } from "../db/mongo.ts";
import { createToolRegistry } from "../tools/registry.ts";

const confirmBody = z.object({
  sessionId: z.string().uuid(),
  args: z.record(z.string(), z.unknown()),
});

export async function confirmRoutes(app: FastifyInstance): Promise<void> {
  const registry = createToolRegistry(pgQueryable, { holdMinutes: config.holdMinutes });

  app.post("/api/tools/:name/confirm", async (req, reply) => {
    const { name } = req.params as { name: string };
    const parsed = confirmBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "sessionId (uuid) and args are required" });
    }
    const session = await sessions().findOne({ _id: parsed.data.sessionId });
    if (!session) {
      return reply.code(404).send({ error: "unknown session — log in first" });
    }
    const outcome = await registry.executeConfirmed(name, parsed.data.args, {
      userRef: session.user_ref,
      displayName: session.display_name,
    });
    if (!outcome.ok) {
      return reply.code(400).send({ error: outcome.error });
    }
    const now = new Date();
    const persisted: StoredMessage[] = [
      { role: "tool", name, content: JSON.stringify(outcome.result), ts: now },
      {
        role: "assistant",
        content: `Confirmed and executed ${name}: ${JSON.stringify(outcome.result)}`,
        ts: now,
      },
    ];
    await sessions().updateOne(
      { _id: session._id },
      { $push: { messages: { $each: persisted } } },
    );
    return { ok: true, tool: name, result: outcome.result };
  });
}
