import type { FastifyInstance } from "fastify";
import { pingMongo } from "../db/mongo.ts";
import { pingPostgres } from "../db/postgres.ts";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => {
    const [postgres, mongo] = await Promise.all([
      pingPostgres(),
      pingMongo(),
    ]);
    return { status: postgres && mongo ? "ok" : "degraded", postgres, mongo };
  });
}
