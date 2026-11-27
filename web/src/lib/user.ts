import type { User } from "./api.ts";

const USER_KEY = "flight-agent.user";

/** Pre-conversations builds stored the active session id here. */
export const LEGACY_SESSION_KEY = "flight-agent.session";

/** Minimal subset of the Web Storage API, so tests can inject a stub. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike {
  return localStorage;
}

export function loadUser(storage: StorageLike = defaultStorage()): User | null {
  try {
    const raw = storage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<User> | null;
    if (!parsed?.user_ref) return null;
    return {
      user_ref: parsed.user_ref,
      display_name: parsed.display_name ?? parsed.user_ref,
    };
  } catch {
    return null;
  }
}

export function saveUser(user: User, storage: StorageLike = defaultStorage()): void {
  storage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearUser(storage: StorageLike = defaultStorage()): void {
  storage.removeItem(USER_KEY);
  storage.removeItem(LEGACY_SESSION_KEY);
}
