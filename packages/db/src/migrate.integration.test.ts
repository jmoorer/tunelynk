import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDb } from "./index";

const url = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const journal = JSON.parse(
  readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8"),
) as { entries: unknown[] };

// A throwaway database, so this proves a first deploy against an empty Postgres.
describe.skipIf(!url)("migrateDb against a fresh database", () => {
  const admin = postgres(url ?? "", { max: 1, onnotice: () => {} });
  const name = `tunelynk_migrate_test_${process.pid}_${Date.now()}`;
  let testUrl = "";

  beforeAll(async () => {
    await admin.unsafe(`create database "${name}"`);
    const u = new URL(url ?? "");
    u.pathname = `/${name}`;
    testUrl = u.toString();
  });

  afterAll(async () => {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end();
  });

  it("applies every migration, and a second run is a no-op", async () => {
    await migrateDb(testUrl, migrationsFolder);
    await migrateDb(testUrl, migrationsFolder);

    const check = postgres(testUrl, { max: 1 });
    try {
      const [migrations] = await check<{ n: number }[]>`
        select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(migrations?.n).toBe(journal.entries.length);
      const tables = await check<{ t: string | null }[]>`
        select to_regclass(name)::text as t from unnest(array[
          'public.users', 'public.playlists', 'public.generation_runs',
          'public.tracks', 'public.run_tracks', 'public.llm_usage',
          'public.auth_identities', 'public.login_tokens', 'public.sessions',
          'public.app_meta'
        ]) as name`;
      expect(tables.map((r) => r.t)).toEqual([
        "users",
        "playlists",
        "generation_runs",
        "tracks",
        "run_tracks",
        "llm_usage",
        "auth_identities",
        "login_tokens",
        "sessions",
        null,
      ]);
    } finally {
      await check.end();
    }
  });
});
