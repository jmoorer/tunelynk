import { describe, expect, it } from "vitest";
import { MeResponse } from "./auth";

describe("MeResponse", () => {
  it.each([
    { user: null },
    {
      user: {
        id: "6f1c2a8e-3b7d-4c55-9a10-2f4e8d6b1c33",
        isGuest: true,
        label: null,
      },
    },
    {
      user: {
        id: "6f1c2a8e-3b7d-4c55-9a10-2f4e8d6b1c33",
        isGuest: false,
        label: "a@b.co",
      },
    },
  ])("accepts %o", (payload) => {
    expect(MeResponse.parse(payload)).toEqual(payload);
  });

  it.each([{}, { user: { id: "x", isGuest: true, label: null } }])(
    "rejects %o",
    (payload) => {
      expect(MeResponse.safeParse(payload).success).toBe(false);
    },
  );
});
