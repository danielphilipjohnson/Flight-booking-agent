import cors from "@fastify/cors";
import Fastify from "fastify";
import { config } from "./config.ts";
import { connectMongo } from "./db/mongo.ts";
import { authRoutes } from "./routes/auth.ts";
import { chatRoutes } from "./routes/chat.ts";
import { healthRoutes } from "./routes/health.ts";
import { sessionRoutes } from "./routes/sessions.ts";

const app = Fastify({ logger: true });

await app.register(cors, { origin: config.webOrigin });
await app.register(healthRoutes);
await app.register(authRoutes);
await app.register(chatRoutes);
await app.register(sessionRoutes);

try {
  await connectMongo();
} catch (err) {
  app.log.warn({ err }, "MongoDB not reachable yet — chat history will fail until it is up");
}

app.listen({ port: config.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
