import { describe, expect, it } from "vitest";
import { safeReturnTo } from "./returnTo";

describe("safeReturnTo", () => {
  it.each(["/", "/playlists/abc/runs/def?keep=1", "/signin?returnTo=%2F"])(
    "keeps the same-site path %s",
    (path) => {
      expect(safeReturnTo(path)).toBe(path);
    },
  );

  it.each([
    ["protocol-relative", "//evil.com"],
    ["backslash trick", "/\\evil.com"],
    ["absolute URL", "https://evil.com/"],
    ["relative path", "playlists"],
    ["empty", ""],
    ["control character", "/a\nb"],
    ["too long", `/${"a".repeat(512)}`],
    ["not a string", 42],
    ["undefined", undefined],
  ])("drops %s", (_label, value) => {
    expect(safeReturnTo(value)).toBeUndefined();
  });
});
