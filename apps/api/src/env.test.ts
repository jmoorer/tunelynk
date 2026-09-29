import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const DATABASE_URL = "postgres://tunelynk:tunelynk@localhost:5432/tunelynk";

describe("parseEnv", () => {
  it("parses a valid environment and coerces PORT", () => {
    expect(parseEnv({ DATABASE_URL, PORT: "4000" })).toEqual({
      DATABASE_URL,
      PORT: 4000,
    });
  });

  it("defaults PORT to 3000", () => {
    expect(parseEnv({ DATABASE_URL }).PORT).toBe(3000);
  });

  it("fails naming DATABASE_URL when it is missing", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it("fails naming DATABASE_URL when it is not a URL", () => {
    expect(() => parseEnv({ DATABASE_URL: "not-a-url" })).toThrow(
      /DATABASE_URL/,
    );
  });

  it.each(["abc", "0", "70000", "3000.5"])(
    "fails naming PORT for %s",
    (PORT) => {
      expect(() => parseEnv({ DATABASE_URL, PORT })).toThrow(/PORT/);
    },
  );
});
