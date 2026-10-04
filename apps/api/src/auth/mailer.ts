export type EmailConfig =
  | { provider: "console" }
  | { provider: "resend"; apiKey: string; from: string };
