import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDb(url: string) {
  // Short connect timeout so /health reports "down" quickly instead of hanging.
  const client = postgres(url, { connect_timeout: 5 });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;

export async function ping(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}
