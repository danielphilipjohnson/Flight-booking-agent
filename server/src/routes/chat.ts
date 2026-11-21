import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createOllamaClient } from "../agent/ollama.ts";
import { driveLoop } from "../agent/loop.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";
import { config } from "../config.ts";
import { pgQueryable } from "../db/postgres.ts";
import { sessions, type StoredMessage } from "../db/mongo.ts";
import { routeBriefLoader } from "../db/routes.ts";
import { createToolRegistry } from "../tools/registry.ts";

const chatBody = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(4000),
});

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/chat", async (req, reply) => {
    const parsed = chatBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "sessionId (uuid) and message are required" });
    }
    const { sessionId, message } = parsed.data;
    const session = await sessions().findOne({ _id: sessionId });
    if (!session) {
      return reply.code(404).send({ error: "unknown session — log in first" });
    }

    const routeBrief = await routeBriefLoader.load();
    const systemPrompt = buildSystemPrompt({
      now: new Date(),
      routeBrief,
      holdMinutes: config.holdMinutes,
    });
    const registry = createToolRegistry(pgQueryable, { holdMinutes: config.holdMinutes });
    const persist = async (messages: StoredMessage[]) => {
      await sessions().updateOne(
        { _id: sessionId },
        { $push: { messages: { $each: messages } } },
      );
    };

    try {
      const result = await driveLoop({
        client: createOllamaClient(config.ollamaUrl),
        model: config.ollamaModel,
        systemPrompt,
        history: session.messages,
        userMessage: message,
        tools: registry.tools,
        ctx: { userRef: session.user_ref, displayName: session.display_name },
        maxIterations: 8,
        persist,
      });
      return {
        sessionId,
        reply: result.reply,
        toolTrace: result.toolTrace,
        pendingConfirmation: result.pendingConfirmation,
        iterations: result.iterations,
      };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: `agent backend failed: ${(err as Error).message}` });
    }
  });

  app.get("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await sessions().findOne({ _id: id });
    if (!session) {
      return reply.code(404).send({ error: "unknown session" });
    }
    return { sessionId: session._id, user_ref: session.user_ref, messages: session.messages };
  });
}
