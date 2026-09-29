import { describe, expect, it } from "vitest";
import { createDb, type Db, ping } from "./index";

describe("ping", () => {
  it("rejects without throwing at construction when Postgres is unreachable", async () => {
    // Port 1 refuses connections; createDb must stay lazy so the API can boot with the DB down.
    const db = createDb("postgres://nobody:nobody@127.0.0.1:1/nothing");
    await expect(ping(db)).rejects.toThrow();
    await db.$client.end();
  }, 10_000);

  it("rejects when a query never answers (paused DB, dead socket)", async () => {
    const hung = { execute: () => new Promise(() => {}) } as unknown as Db;
    await expect(ping(hung, 50)).rejects.toThrow(/timed out/);
  });
});
