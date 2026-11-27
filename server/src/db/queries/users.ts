import type { Queryable } from "../types.ts";

export async function findUserByCredentials(
  q: Queryable,
  userRef: string,
  pin: string,
): Promise<Record<string, unknown> | undefined> {
  const { rows } = await q.query(
    "SELECT user_ref, display_name FROM app_user WHERE user_ref = $1 AND pin = $2",
    [userRef, pin],
  );
  return rows[0];
}

export async function listUsers(q: Queryable): Promise<Record<string, unknown>[]> {
  return (await q.query("SELECT user_ref, display_name FROM app_user ORDER BY display_name")).rows;
}

export async function getDisplayName(q: Queryable, userRef: string): Promise<string | null> {
  const { rows } = await q.query("SELECT display_name FROM app_user WHERE user_ref = $1", [userRef]);
  const name = rows[0]?.display_name;
  return name === undefined ? null : String(name);
}
