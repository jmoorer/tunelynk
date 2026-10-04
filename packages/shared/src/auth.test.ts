import { describe, expect, it } from "vitest";
import {
  EmailStartRequest,
  EmailVerifyRequest,
  EmailVerifyResponse,
  MeResponse,
} from "./auth";

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

describe("EmailStartRequest", () => {
  it("trims and lowercases the email", () => {
    expect(EmailStartRequest.parse({ email: "  A@B.Co " })).toEqual({
      email: "a@b.co",
    });
  });

  it("keeps an optional returnTo", () => {
    expect(
      EmailStartRequest.parse({ email: "a@b.co", returnTo: "/x" }).returnTo,
    ).toBe("/x");
  });

  it.each([
    ["missing", {}],
    ["not an email", { email: "nope" }],
    ["empty", { email: "   " }],
    ["too long", { email: `${"a".repeat(250)}@b.co` }],
    ["not a string", { email: 42 }],
  ])("rejects %s", (_label, body) => {
    expect(EmailStartRequest.safeParse(body).success).toBe(false);
  });
});

describe("EmailVerifyRequest", () => {
  it("accepts a token", () => {
    expect(EmailVerifyRequest.parse({ token: "abc" })).toEqual({
      token: "abc",
    });
  });

  it.each([{}, { token: "" }, { token: "x".repeat(201) }])(
    "rejects %o",
    (body) => {
      expect(EmailVerifyRequest.safeParse(body).success).toBe(false);
    },
  );
});

describe("EmailVerifyResponse", () => {
  it("parses returnTo", () => {
    expect(EmailVerifyResponse.parse({ returnTo: "/" })).toEqual({
      returnTo: "/",
    });
  });
});
