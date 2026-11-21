import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../config.ts";

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
  messages: StoredMessage[];
}

const client = new MongoClient(config.mongoUrl);
let db: Db | null = null;

export async function connectMongo(): Promise<Db> {
  if (!db) {
    await client.connect();
    db = client.db();
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
