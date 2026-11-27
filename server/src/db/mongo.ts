import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../config.ts";
import type { PendingProposal } from "../tools/proposal.ts";

export interface StoredMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  ts: Date;
}

export interface SessionDoc {
  _id: string;
  user_ref: string;
  display_name: string;
  created_at: Date;
  /** Bumped on every turn so the conversation list can sort by recency. */
  updated_at?: Date;
  /** Short label derived from the first user message. */
  title?: string;
  messages: StoredMessage[];
  context_summary?: { summary: string; evictedCount: number };
  pending_proposal?: PendingProposal;
}

const client = new MongoClient(config.mongoUrl);
let db: Db | null = null;

export async function connectMongo(): Promise<Db> {
  if (!db) {
    await client.connect();
    db = client.db();
    // Backs the per-user conversation list (filter by user, sort by recency).
    await db
      .collection<SessionDoc>("sessions")
      .createIndex({ user_ref: 1, updated_at: -1 });
  }
  return db;
}

export function sessions(): Collection<SessionDoc> {
  if (!db) throw new Error("Mongo not connected — call connectMongo() first");
  return db.collection<SessionDoc>("sessions");
}

export async function pingMongo(): Promise<boolean> {
  try {
    const database = await connectMongo();
    await database.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}
