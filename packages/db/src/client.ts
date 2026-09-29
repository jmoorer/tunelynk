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

// connect_timeout only covers new connections; a pooled socket to a paused or
// vanished DB can wait minutes, so bound the whole query.
export async function ping(db: Db, timeoutMs = 3000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`DB ping timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([db.execute(sql`select 1`), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
