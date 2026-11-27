import { pingMongo, connectMongo, sessions } from "../db/mongo.ts";
import { pingPostgres } from "../db/postgres.ts";
import { mulberry32 } from "../seed/generate.ts";
import { isoDay } from "./dates.ts";
import { loadHistory } from "./history.ts";
import { runAgent } from "./loop.ts";
import { buildToolDefs } from "./tools.ts";

const SEED = Number.parseInt(process.env.FUZZ_SEED ?? "42", 10) || 42;
const USER_REF = process.env.FUZZ_USER ?? "dan";
const PIN = process.env.FUZZ_PIN ?? "4321";

const rng = mulberry32(SEED);

const DESTINATIONS = ["Lisbon", "Paris", "Amsterdam", "Barcelona", "Madrid", "Tokyo", "anywhere warm"];
const ORIGINS = ["London", "Manchester", "", "from Gatwick"];
const DATE_PHRASES = ["tomorrow", "next week", "on the 14th", "next month", isoDay(new Date(Date.now() + 86_400_000)), ""];
const PARTY = ["", " for two", " for 4 people", " business class", " cheapest option"];

const KNOWN_TOOLS = new Set(buildToolDefs().map((t) => t.name));

function userMessage(): string {
  const parts = ["Flights to", "What's available to", "I want to fly to", "Show me flights to"];
  const destination = DESTINATIONS[randInt(0, DESTINATIONS.length - 1)]!;
  const date = DATE_PHRASES[randInt(0, DATE_PHRASES.length - 1)]!;
  const party = PARTY[randInt(0, PARTY.length - 1)]!;
  return `${parts[randInt(0, parts.length - 1)]!} ${destination}${date ? ` ${date}` : ""}${party}`;
}

function randInt(min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

interface ScenarioResult {
  sessionId: string;
  toolCalls: string[];
  warnings: string[];
  reply: string;
  rounds: number;
}

async function converse(sessionId: string, message: string): Promise<ScenarioResult> {
  const toolCalls: string[] = [];
  const warnings: string[] = [];
  let reply = "";

  for await (const event of runAgent({ sessionId, userRef: USER_REF, pin: PIN, message })) {
    if (event.type === "tool") {
      if (!KNOWN_TOOLS.has(event.name)) {
        warnings.push(`turn invoked unknown tool "${event.name}" (loop recovered)`);
      } else {
        toolCalls.push(event.name);
      }
    } else {
      reply = event.content;
    }
  }

  return { sessionId, toolCalls, warnings, reply, rounds: toolCalls.length };
}

async function main(): Promise<void> {
  if (!(await pingPostgres())) {
    console.error("Postgres not reachable — start the stack first: docker compose up -d && npm run seed");
    process.exit(1);
  }
  if (!(await pingMongo())) {
    console.error("MongoDB not reachable — start the stack first: docker compose up -d");
    process.exit(1);
  }
  await connectMongo();

  const scenarios: { sessionId: string; turns: string[] }[] = [];
  for (let i = 0; i < 4; i++) {
    scenarios.push({ sessionId: `fuzz-agent-${SEED}-${i}`, turns: [userMessage()] });
  }
  scenarios.push({
    sessionId: `fuzz-agent-${SEED}-5`,
    turns: ["flights to Lisbon tomorrow", "actually the second one", "book the cheapest one for me"],
  });
  scenarios.push({
    sessionId: `fuzz-agent-${SEED}-6`,
    turns: ["what's cheap to anywhere warm in February?", "not before noon", "show me the cheapest"],
  });

  let failures = 0;
  for (const scenario of scenarios) {
    process.stdout.write(`\n# session ${scenario.sessionId}\n`);
    for (const [turn, message] of scenario.turns.entries()) {
      process.stdout.write(`user> ${message}\n`);
      try {
        const result = await converse(scenario.sessionId, message);
        if (result.reply.trim().length === 0) {
          throw new Error("agent returned an empty reply");
        }
        if (result.toolCalls.length > 8) {
          throw new Error(`agent exceeded the tool-round cap (${result.toolCalls.length} calls)`);
        }
        const history = await loadHistory(scenario.sessionId, USER_REF);
        const lastUser = history[history.length - 2];
        const lastAssistant = history[history.length - 1];
        if (lastUser?.role !== "user" || lastUser.content !== message) {
          throw new Error("user turn missing from persisted history");
        }
        if (lastAssistant?.role !== "assistant" || lastAssistant.content !== result.reply) {
          throw new Error("assistant reply missing from persisted history");
        }
        process.stdout.write(
          `agent> ${result.reply.replace(/\s+/g, " ").slice(0, 140)}${result.reply.length > 140 ? "…" : ""}\n`,
        );
        for (const warning of result.warnings) process.stdout.write(`warn> ${warning}\n`);
        process.stdout.write(`tools> ${result.toolCalls.join(", ") || "(none)"}\n`);
      } catch (err) {
        failures++;
        console.error(`FAIL turn ${turn}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  const docs = await sessions().countDocuments({ user_ref: USER_REF });
  console.log(`\nagent fuzz: ${scenarios.reduce((n, s) => n + s.turns.length, 0)} turns, ${failures} failures, ${docs} sessions for ${USER_REF}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
