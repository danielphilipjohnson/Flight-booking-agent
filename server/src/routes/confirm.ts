import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.ts";
import { pgQueryable } from "../db/postgres.ts";
import { sessions, type StoredMessage } from "../db/mongo.ts";
import { createToolRegistry } from "../tools/registry.ts";
import { matchProposal } from "../tools/proposal.ts";

const confirmBody = z.object({
  sessionId: z.string().uuid(),
  confirmationId: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

export async function confirmRoutes(app: FastifyInstance): Promise<void> {
  const registry = createToolRegistry(pgQueryable, { holdMinutes: config.holdMinutes });

  app.post("/api/tools/:name/confirm", async (req, reply) => {
    const { name } = req.params as { name: string };
    const parsed = confirmBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "sessionId (uuid) is required" });
    }
    const { sessionId, confirmationId, args } = parsed.data;
    const session = await sessions().findOne({ _id: sessionId });
    if (!session) {
      return reply.code(404).send({ error: "unknown session — log in first" });
    }

    const match = matchProposal(session.pending_proposal, {
      tool: name,
      ...(confirmationId !== undefined ? { confirmationId } : {}),
      ...(args !== undefined ? { args } : {}),
    });
    if (!match.ok) {
      if (match.expired) {
        await sessions().updateOne({ _id: sessionId }, { $unset: { pending_proposal: "" } });
      }
      return reply.code(400).send({ error: match.error });
    }
    const proposal = session.pending_proposal!;

    const outcome = await registry.executeConfirmed(name, proposal.args, {
      userRef: session.user_ref,
      displayName: session.display_name,
    });
    await sessions().updateOne({ _id: sessionId }, { $unset: { pending_proposal: "" } });
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
      { _id: sessionId },
      { $push: { messages: { $each: persisted } } },
    );
    return { ok: true, tool: name, confirmationId: proposal.id, result: outcome.result };
  });
}
