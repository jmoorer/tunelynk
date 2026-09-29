import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Own single connection, closed afterwards, so it never lingers in the app pool.
export async function migrateDb(
  url: string,
  migrationsFolder: string,
): Promise<void> {
  const client = postgres(url, {
    max: 1,
    connect_timeout: 10,
    onnotice: () => {},
  });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}
