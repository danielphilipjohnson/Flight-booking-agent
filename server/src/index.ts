import cors from "@fastify/cors";
import Fastify from "fastify";
import { config } from "./config.ts";
import { connectMongo } from "./db/mongo.ts";
import { healthRoutes } from "./routes/health.ts";

const app = Fastify({ logger: true });

await app.register(cors, { origin: config.webOrigin });
await app.register(healthRoutes);

try {
  await connectMongo();
} catch (err) {
  app.log.warn({ err }, "MongoDB not reachable yet — /api/health will report degraded");
}

app.listen({ port: config.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
