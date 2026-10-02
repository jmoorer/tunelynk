import { fileURLToPath } from "node:url";
import { createDb, type Db, migrateDb } from "@tunelynk/db";
import postgres from "postgres";

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/db/migrations", import.meta.url),
);

// A throwaway, fully migrated database per test file. Needs DATABASE_URL.
export async function createTestDatabase(): Promise<{
  db: Db;
  drop(): Promise<void>;
}> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL is required");
  const name = `tunelynk_api_test_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await migrateDb(url.toString(), migrationsFolder);
  const db = createDb(url.toString());
  return {
    db,
    async drop() {
      await db.$client.end();
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      await admin.end();
    },
  };
}
