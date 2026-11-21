import pg from "pg";
import { config } from "../config.ts";
import type { Queryable } from "./types.ts";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export const pgQueryable: Queryable = {
  query: (text, params) =>
    pool.query(text, params ?? []) as Promise<{ rows: Record<string, unknown>[] }>,
  tx: (fn) =>
    withTransaction((client) =>
      fn({
        query: (text, params) =>
          client.query(text, params ?? []) as Promise<{ rows: Record<string, unknown>[] }>,
      }),
    ),
};

export async function pingPostgres(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
