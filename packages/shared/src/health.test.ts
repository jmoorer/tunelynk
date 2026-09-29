import { describe, expect, it } from "vitest";
import { HealthResponse } from "./index";

describe("HealthResponse", () => {
  it.each([
    { ok: true, db: "up" },
    { ok: true, db: "down" },
  ])("accepts %o", (payload) => {
    expect(HealthResponse.parse(payload)).toEqual(payload);
  });

  it.each([
    {},
    { ok: true },
    { ok: "yes", db: "up" },
    { ok: true, db: "sideways" },
    null,
    "ok",
  ])("rejects %o", (payload) => {
    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });
});
