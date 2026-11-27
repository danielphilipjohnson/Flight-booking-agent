export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  tx?<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}
