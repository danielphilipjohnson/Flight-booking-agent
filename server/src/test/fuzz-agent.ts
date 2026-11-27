import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { driveLoop } from "../agent/loop.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";
import { createOllamaClient } from "../agent/ollama.ts";
import { connectMongo, pingMongo, sessions, type SessionDoc } from "../db/mongo.ts";
import { pgQueryable, pingPostgres } from "../db/postgres.ts";
import { routeBriefLoader } from "../db/routes.ts";
import { createToolRegistry } from "../tools/registry.ts";

const SEED = Number.parseInt(process.env.FUZZ_SEED ?? "42", 10) || 42;
const USER_REF = process.env.FUZZ_USER ?? "dan";
const PIN = process.env.FUZZ_PIN ?? "4321";

function randInt(seed: number, min: number, max: number, salt: number): number {
  let a = (seed + salt * 2654435761) >>> 0;
  a = Math.imul(a ^ (a >>> 15), 1 | a);
  a = (a + Math.imul(a ^ (a >>> 7), 61 | a)) ^ a;
  const unit = ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  return min + Math.floor(unit * (max - min + 1));
}

const DESTINATIONS = ["Lisbon", "Paris", "Amsterdam", "Barcelona", "Madrid", "Tokyo", "anywhere warm"];
const DATE_PHRASES = ["tomorrow", "next week", "on the 14th", "next month", ""];
const PARTY = ["", " for two", " business class", " cheapest option"];

function userMessage(seed: number, salt: number): string {
  const openers = ["Flights to", "What's available to", "I want to fly to", "Show me flights to"];
  const destination = DESTINATIONS[randInt(seed, 0, DESTINATIONS.length - 1, salt)]!;
  const date = DATE_PHRASES[randInt(seed, 0, DATE_PHRASES.length - 1, salt + 1)]!;
  const party = PARTY[randInt(seed, 0, PARTY.length - 1, salt + 2)]!;
  return `${openers[randInt(seed, 0, openers.length - 1, salt + 3)]!} ${destination}${date ? ` ${date}` : ""}${party}`;
}

async function main(): Promise<void> {
  if (!(await pingPostgres())) {
    console.error("Postgres not reachable - start the stack first: docker compose up -d && npm run seed");
    process.exit(1);
  }
  if (!(await pingMongo())) {
    console.error("MongoDB not reachable - start the stack first: docker compose up -d");
    process.exit(1);
  }
  await connectMongo();

  const client = createOllamaClient(config.ollamaUrl);
  const registry = createToolRegistry(pgQueryable, { holdMinutes: config.holdMinutes });
  const knownTools = new Set(registry.tools.map((t) => t.name));
  const routeBrief = await routeBriefLoader.load();

  const scenarios: { sessionId: string; turns: string[] }[] = [];
  for (let i = 0; i < 4; i++) {
    scenarios.push({ sessionId: randomUUID(), turns: [userMessage(SEED, i)] });
  }
  scenarios.push({
    sessionId: randomUUID(),
    turns: ["flights to Lisbon tomorrow", "actually the second one", "book the cheapest one for me"],
  });
  scenarios.push({
    sessionId: randomUUID(),
    turns: ["what's cheap to anywhere warm in February?", "not before noon", "is a carry-on included on the first one?"],
  });

  let failures = 0;
  let warnings = 0;
  for (const scenario of scenarios) {
    const session: SessionDoc = {
      _id: scenario.sessionId,
      user_ref: USER_REF,
      display_name: USER_REF,
      created_at: new Date(),
      messages: [],
    };
    await sessions().insertOne(session);
    console.log(`\n# session ${scenario.sessionId}`);

    for (const [turn, message] of scenario.turns.entries()) {
      process.stdout.write(`user> ${message}\n`);
      try {
        const persisted: { role: string; content: string }[] = [];
        const result = await driveLoop({
          client,
          model: config.ollamaModel,
          systemPrompt: buildSystemPrompt({ now: new Date(), routeBrief, holdMinutes: config.holdMinutes }),
          history: [],
          userMessage: message,
          tools: registry.tools,
          ctx: { userRef: USER_REF, displayName: USER_REF, sessionId: scenario.sessionId },
          persist: async (messages) => {
            for (const m of messages) persisted.push({ role: m.role, content: m.content });
            await sessions().updateOne(
              { _id: scenario.sessionId },
              { $push: { messages: { $each: messages } }, $set: { updated_at: new Date() } },
            );
          },
          onEvent: async (event) => {
            if (event.type === "tool" && !knownTools.has(event.name)) {
              warnings++;
              process.stdout.write(`warn> invoked unknown tool "${event.name}" (loop recovered)\n`);
            }
          },
        });
        if (result.reply.trim().length === 0) throw new Error("agent returned an empty reply");
        for (const entry of result.toolTrace) {
          if (!knownTools.has(entry.name)) throw new Error(`tool trace contains unknown tool ${entry.name}`);
        }
        let lastUser: { role: string; content: string } | undefined;
        let lastAssistant: { role: string; content: string } | undefined;
        for (const m of persisted) {
          if (m.role === "user") lastUser = m;
          if (m.role === "assistant") lastAssistant = m;
        }
        if (!lastUser || lastUser.content !== message) throw new Error("user turn missing from persisted history");
        if (!lastAssistant || lastAssistant.content !== result.reply) throw new Error("assistant reply missing from persisted history");
        process.stdout.write(`agent> ${result.reply.replace(/\s+/g, " ").slice(0, 140)}${result.reply.length > 140 ? "…" : ""}\n`);
        process.stdout.write(`tools> ${result.toolTrace.map((t) => t.name).join(", ") || "(none)"}\n`);
      } catch (err) {
        failures++;
        console.error(`FAIL turn ${turn}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  console.log(`\nagent fuzz: ${scenarios.reduce((n, s) => n + s.turns.length, 0)} turns, ${failures} failures, ${warnings} warnings`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
