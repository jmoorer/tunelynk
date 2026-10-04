import { describe, expect, it, vi } from "vitest";
import {
  createConsoleMailer,
  createMailer,
  createResendMailer,
  loginEmail,
} from "./mailer";

const url = "https://tunelynk.bytmoor.com/signin/verify#t=abc_DEF-123";
const EXPIRY =
  "This link expires in 15 minutes. If you didn't ask for it, ignore this email.";

describe("loginEmail", () => {
  it("has the subject, the link, and the expiry line", () => {
    const mail = loginEmail(url);
    expect(mail.subject).toBe("Your Tunelynk sign-in link");
    expect(mail.text).toContain(url);
    expect(mail.text).toContain(EXPIRY);
    expect(mail.html).toContain(`href="${url}"`);
    expect(mail.html).toContain(EXPIRY.replace("'", "&#39;"));
  });

  it("escapes HTML in the link", () => {
    expect(loginEmail('https://x.co/"><script>').html).not.toContain(
      "<script>",
    );
  });
});

describe("createResendMailer", () => {
  it("posts the email to Resend with the API key", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    await createResendMailer({
      apiKey: "re_123",
      from: "Tunelynk <login@bytmoor.com>",
      fetch,
    }).sendLoginLink({ to: "a@b.co", url });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(endpoint).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer re_123",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      from: "Tunelynk <login@bytmoor.com>",
      to: "a@b.co",
      ...loginEmail(url),
    });
  });

  it("throws on a non-2xx response without leaking the key", async () => {
    const fetch = vi.fn(
      async () =>
        new Response('{"message":"domain not verified"}', { status: 403 }),
    );
    const send = createResendMailer({
      apiKey: "re_secret",
      from: "x <a@b.co>",
      fetch,
    }).sendLoginLink({ to: "a@b.co", url });
    await expect(send).rejects.toThrow(/403/);
    await expect(send).rejects.not.toThrow(/re_secret/);
  });
});

describe("createConsoleMailer", () => {
  it("logs the recipient and the link", async () => {
    const logger = { log: vi.fn() };
    await createConsoleMailer(logger).sendLoginLink({ to: "a@b.co", url });
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("a@b.co"));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining(url));
  });
});

describe("createMailer", () => {
  it("picks the adapter from the config", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    await createMailer(
      { provider: "resend", apiKey: "k", from: "x <a@b.co>" },
      fetch,
    ).sendLoginLink({ to: "a@b.co", url });
    expect(fetch).toHaveBeenCalled();

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createMailer({ provider: "console" }).sendLoginLink({
      to: "a@b.co",
      url,
    });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
