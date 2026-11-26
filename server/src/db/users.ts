import { pool } from "./postgres.ts";

interface LookupRow {
  display_name: string;
}

export async function verifyCredentials(userRef: string, pin: string): Promise<string | null> {
  const result = await pool.query<LookupRow>(
    "SELECT display_name FROM app_user WHERE user_ref = $1 AND pin = $2",
    [userRef, pin],
  );
  return result.rows[0]?.display_name ?? null;
}
