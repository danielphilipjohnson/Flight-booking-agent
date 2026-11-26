import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createOllamaClient } from "../agent/ollama.ts";
import { driveLoop, type LoopEvent } from "../agent/loop.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";
import { config } from "../config.ts";
import { pgQueryable } from "../db/postgres.ts";
import { sessions, type StoredMessage, type SessionDoc } from "../db/mongo.ts";
import { titleFromUserMessage } from "../db/conversations.ts";
import { routeBriefLoader } from "../db/routes.ts";
import { createToolRegistry } from "../tools/registry.ts";
import { formatSse } from "./sse.ts";
import type { SummaryCache } from "../agent/context.ts";
import type { PendingProposal } from "../tools/proposal.ts";

async function saveProposal(sessionId: string, pending: { id?: string; tool: string; args: Record<string, unknown> }): Promise<void> {
  if (!pending.id) return;
  const proposal: PendingProposal = {
    id: pending.id,
    tool: pending.tool,
    args: pending.args,
    created_at: new Date(),
  };
  await sessions().updateOne({ _id: sessionId }, { $set: { pending_proposal: proposal } });
}

const chatBody = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(4000),
});

async function loadChatContext(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{
  session: SessionDoc;
  sessionId: string;
  message: string;
  systemPrompt: string;
  registry: ReturnType<typeof createToolRegistry>;
  persist: (messages: StoredMessage[]) => Promise<void>;
  summaryCache: SummaryCache;
} | null> {
  const parsed = chatBody.safeParse(req.body);
  if (!parsed.success) {
    await reply.code(400).send({ error: "sessionId (uuid) and message are required" });
    return null;
  }
  const { sessionId, message } = parsed.data;
  const session = await sessions().findOne({ _id: sessionId });
  if (!session) {
    await reply.code(404).send({ error: "unknown session — log in first" });
    return null;
  }
  const routeBrief = await routeBriefLoader.load();
  const systemPrompt = buildSystemPrompt({
    now: new Date(),
    routeBrief,
    holdMinutes: config.holdMinutes,
  });
  const registry = createToolRegistry(pgQueryable, { holdMinutes: config.holdMinutes });
  const persist = async (messages: StoredMessage[]) => {
    const set: Record<string, unknown> = { updated_at: new Date() };
    // Name the conversation after its first real user message, once.
    if (!session.title) {
      const firstUser =
        session.messages.find((m) => m.role === "user") ??
        messages.find((m) => m.role === "user");
      if (firstUser) set.title = titleFromUserMessage(firstUser.content);
    }
    await sessions().updateOne(
      { _id: sessionId },
      { $push: { messages: { $each: messages } }, $set: set },
    );
  };
  const summaryCache: SummaryCache = {
    get: () => session.context_summary ?? null,
    set: (value) => {
      void sessions().updateOne(
        { _id: sessionId },
        { $set: { context_summary: value } },
      );
    },
  };
  return { session, sessionId, message, systemPrompt, registry, persist, summaryCache };
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "access-control-allow-origin": config.webOrigin,
  "access-control-allow-credentials": "true",
} as const;

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/chat/stream", async (req, reply) => {
    const ctx = await loadChatContext(req, reply);
    if (!ctx) return reply;
    const { session, sessionId, message, systemPrompt, registry, persist } = ctx;

    reply.hijack();
    reply.raw.writeHead(200, SSE_HEADERS);
    const send = (event: string, data: unknown) => {
      reply.raw.write(formatSse(event, data));
    };
    const abort = new AbortController();
    req.raw.on("close", () => abort.abort());

    const started = Date.now();
    const onEvent = async (event: LoopEvent) => {
      if (event.type === "done") {
        send("done", {
          sessionId,
          reply: event.reply,
          toolTrace: event.toolTrace,
          pendingConfirmation: event.pendingConfirmation,
          stats: {
            iterations: event.iterations,
            evalCount: event.evalCount,
            promptEvalCount: event.promptEvalCount,
            compacted: event.compacted,
            latencyMs: Date.now() - started,
          },
        });
      } else if (event.type === "confirm") {
        await saveProposal(sessionId, event.pending);
        send(event.type, event);
      } else {
        send(event.type, event);
      }
    };

    try {
      await driveLoop({
        client: createOllamaClient(config.ollamaUrl),
        model: config.ollamaModel,
        systemPrompt,
        history: session.messages,
        userMessage: message,
        tools: registry.tools,
        ctx: { userRef: session.user_ref, displayName: session.display_name },
        maxIterations: 8,
        context: {
          maxMessages: config.maxHistoryMessages,
          compactThreshold: config.compactThreshold,
          summaryCache: ctx.summaryCache,
        },
        signal: abort.signal,
        onEvent,
        persist,
        makeProposalId: () => randomUUID(),
      });
    } catch (err) {
      req.log.error(err);
      if (!abort.signal.aborted) {
        send("error", { error: `agent backend failed: ${(err as Error).message}` });
      }
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  app.post("/api/chat", async (req, reply) => {
    const ctx = await loadChatContext(req, reply);
    if (!ctx) return reply;
    const { session, sessionId, message, systemPrompt, registry, persist } = ctx;

    try {
      const started = Date.now();
      const result = await driveLoop({
        client: createOllamaClient(config.ollamaUrl),
        model: config.ollamaModel,
        systemPrompt,
        history: session.messages,
        userMessage: message,
        tools: registry.tools,
        ctx: { userRef: session.user_ref, displayName: session.display_name },
        maxIterations: 8,
        context: {
          maxMessages: config.maxHistoryMessages,
          compactThreshold: config.compactThreshold,
          summaryCache: ctx.summaryCache,
        },
        persist,
        makeProposalId: () => randomUUID(),
      });
      if (result.pendingConfirmation?.id) {
        await saveProposal(sessionId, result.pendingConfirmation);
      }
      const stats = {
        iterations: result.iterations,
        evalCount: result.evalCount,
        promptEvalCount: result.promptEvalCount,
        compacted: result.compacted,
        latencyMs: Date.now() - started,
      };
      req.log.info({ sessionId, ...stats }, "chat turn");
      return {
        sessionId,
        reply: result.reply,
        toolTrace: result.toolTrace,
        pendingConfirmation: result.pendingConfirmation,
        stats,
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
    return {
      sessionId: session._id,
      user_ref: session.user_ref,
      display_name: session.display_name,
      title: session.title ?? "",
      updated_at: session.updated_at ?? session.created_at,
      messages: session.messages,
    };
  });
}
