import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runAgent } from "../agent/loop.ts";
import { clearPinnedOffers, pinnedOfferCount } from "../agent/tools.ts";
import { verifyCredentials } from "./auth.ts";

const chatBody = z.object({
  session_id: z.string().min(1),
  user_ref: z.string().min(1),
  pin: z.string().min(1),
  message: z.string().min(1),
});

interface ParsedChat {
  sessionId: string;
  userRef: string;
  pin: string;
  message: string;
  displayName: string;
}

async function parseChatBody(request: { body: unknown }): Promise<ParsedChat | null> {
  const parsed = chatBody.safeParse(request.body);
  if (!parsed.success) return null;
  const displayName = await verifyCredentials(parsed.data.user_ref, parsed.data.pin);
  if (!displayName) return null;
  return {
    sessionId: parsed.data.session_id,
    userRef: parsed.data.user_ref,
    pin: parsed.data.pin,
    message: parsed.data.message,
    displayName,
  };
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/chat", async (request, reply) => {
    const parsed = await parseChatBody(request);
    if (!parsed) return reply.code(401).send({ error: "Unknown user, wrong PIN, or invalid body" });

    const result = { reply: "", tool_events: [] as { name: string; summary: string }[] };
    for await (const event of runAgent(parsed)) {
      if (event.type === "tool") result.tool_events.push({ name: event.name, summary: event.summary });
      else result.reply = event.content;
    }
    return result;
  });

  app.post("/api/chat/stream", async (request, reply) => {
    const parsed = await parseChatBody(request);
    if (!parsed) {
      return reply.code(401).send({ error: "Unknown user, wrong PIN, or invalid body" });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown): void => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send("start", { session_id: parsed.sessionId, user: parsed.displayName });
    try {
      for await (const event of runAgent(parsed)) {
        if (event.type === "tool") {
          send("tool", { name: event.name, summary: event.summary });
        } else {
          for (const token of event.content.match(/\S+\s*/g) ?? [event.content]) {
            send("token", { text: token });
          }
        }
      }
      send("done", { session_id: parsed.sessionId, pinned_offers: pinnedOfferCount(parsed.sessionId) });
    } catch (err) {
      send("error", { message: err instanceof Error ? err.message : String(err) });
    } finally {
      raw.end();
    }
  });

  app.delete("/api/chat/:sessionId", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).safeParse(request.params);
    const body = chatBody.omit({ message: true }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid body" });
    }
    const displayName = await verifyCredentials(body.data.user_ref, body.data.pin);
    if (!displayName) return reply.code(401).send({ error: "Unknown user or wrong PIN" });
    clearPinnedOffers(params.data.sessionId);
    return { ok: true };
  });
}
