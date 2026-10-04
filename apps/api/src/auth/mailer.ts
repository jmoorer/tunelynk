export type EmailConfig =
  | { provider: "console" }
  | { provider: "resend"; apiKey: string; from: string };

export type Mailer = {
  sendLoginLink(args: { to: string; url: string }): Promise<void>;
};

const SUBJECT = "Your Tunelynk sign-in link";
const EXPIRY =
  "This link expires in 15 minutes. If you didn't ask for it, ignore this email.";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function loginEmail(url: string) {
  return {
    subject: SUBJECT,
    text: `Sign in to Tunelynk:\n\n${url}\n\n${EXPIRY}\n`,
    html: `<p>Sign in to Tunelynk:</p><p><a href="${escapeHtml(url)}">Sign in</a></p><p>${escapeHtml(EXPIRY)}</p>`,
  };
}

// Dev and tests: the link is printed instead of sent.
export function createConsoleMailer(
  logger: Pick<Console, "log"> = console,
): Mailer {
  return {
    async sendLoginLink({ to, url }) {
      logger.log(`[mail] sign-in link for ${to}: ${url}`);
    },
  };
}

export function createResendMailer({
  apiKey,
  from,
  fetch = globalThis.fetch,
}: {
  apiKey: string;
  from: string;
  fetch?: typeof globalThis.fetch;
}): Mailer {
  return {
    async sendLoginLink({ to, url }) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ from, to, ...loginEmail(url) }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `Resend responded ${res.status}: ${detail.slice(0, 200)}`,
        );
      }
    },
  };
}

export function createMailer(
  config: EmailConfig,
  fetchImpl?: typeof globalThis.fetch,
): Mailer {
  return config.provider === "resend"
    ? createResendMailer({
        apiKey: config.apiKey,
        from: config.from,
        fetch: fetchImpl,
      })
    : createConsoleMailer();
}
