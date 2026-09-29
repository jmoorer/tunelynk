import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrateDb } from "./index";

const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
// Port 1 refuses connections immediately.
const deadUrl = "postgres://nobody:nobody@127.0.0.1:1/nothing";

describe("migrateDb", () => {
  it("rejects when the migrations folder is missing", async () => {
    await expect(
      migrateDb(deadUrl, "/nonexistent/migrations"),
    ).rejects.toThrow();
  });

  it("rejects promptly when Postgres is unreachable", async () => {
    await expect(migrateDb(deadUrl, migrationsFolder)).rejects.toThrow();
  }, 15_000);
});
