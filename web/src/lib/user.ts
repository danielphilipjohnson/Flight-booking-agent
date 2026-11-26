import type { User } from "./api.ts";

const USER_KEY = "flight-agent.user";

/** Pre-conversations builds stored the active session id here. */
export const LEGACY_SESSION_KEY = "flight-agent.session";

export function loadUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
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

export function saveUser(user: User): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearUser(): void {
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(LEGACY_SESSION_KEY);
}
