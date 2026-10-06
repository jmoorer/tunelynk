import { assertPricedModel } from "@tunelynk/engine";
import { z } from "zod";
import type { EmailConfig } from "./auth/mailer";

const DEFAULT_MODELS = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4.1-mini",
} as const;

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);
const positiveNumber = (fallback: number) =>
  z.coerce.number().positive().default(fallback);

const EnvSchema = z
  .object({
    DATABASE_URL: z.url(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    // Public origin for links and OAuth redirects, no trailing slash.
    APP_URL: z
      .url({ protocol: /^https?$/ })
      .transform((url) => url.replace(/\/+$/, "")),
    APPLE_TEAM_ID: z.string().min(1),
    APPLE_KEY_ID: z.string().min(1),
    APPLE_PRIVATE_KEY: z.string().min(1),
    APPLE_STOREFRONT: z.string().default("us"),
    APPLE_CATALOG_RPS: positiveNumber(8),
    APPLE_CATALOG_BURST: positiveInt(10),
    APPLE_CATALOG_CONCURRENCY: positiveInt(4),
    // Sign in with Apple: the Services ID; the key defaults to the MusicKit key.
    // Unset turns Apple sign-in off (it needs an active Apple Developer account).
    APPLE_SIGNIN_CLIENT_ID: z.string().min(1).optional(),
    APPLE_SIGNIN_KEY_ID: z.string().optional(),
    APPLE_SIGNIN_PRIVATE_KEY: z.string().optional(),
    SESSION_SECRET: z.string().min(32),
    COOKIE_SECURE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    LLM_PROVIDER: z.enum(["anthropic", "openai"]).default("anthropic"),
    LLM_MODEL_GUEST: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    LLM_MAX_TOKENS: positiveInt(2000),
    LLM_DAILY_BUDGET_USD: positiveNumber(2),
    // Unset means console, allowed only for local http (COOKIE_SECURE=false),
    // so production never logs live sign-in links by accident.
    EMAIL_PROVIDER: z.enum(["console", "resend"]).optional(),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
  })
  .transform((env, ctx) => {
    const keyName =
      env.LLM_PROVIDER === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    const apiKey = env[keyName];
    if (!apiKey) {
      ctx.addIssue({
        code: "custom",
        path: [keyName],
        message: `required when LLM_PROVIDER=${env.LLM_PROVIDER}`,
      });
      return z.NEVER;
    }
    const model = env.LLM_MODEL_GUEST ?? DEFAULT_MODELS[env.LLM_PROVIDER];
    try {
      assertPricedModel(model);
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        path: ["LLM_MODEL_GUEST"],
        message: err instanceof Error ? err.message : String(err),
      });
      return z.NEVER;
    }
    if (!env.EMAIL_PROVIDER && env.COOKIE_SECURE) {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_PROVIDER"],
        message:
          "required when COOKIE_SECURE=true (resend, or console to log links)",
      });
      return z.NEVER;
    }
    let email: EmailConfig = { provider: "console" };
    if (env.EMAIL_PROVIDER === "resend") {
      const { RESEND_API_KEY: resendKey, EMAIL_FROM: from } = env;
      if (!resendKey || !from) {
        for (const [name, value] of [
          ["RESEND_API_KEY", resendKey],
          ["EMAIL_FROM", from],
        ] as const) {
          if (!value) {
            ctx.addIssue({
              code: "custom",
              path: [name],
              message: "required when EMAIL_PROVIDER=resend",
            });
          }
        }
        return z.NEVER;
      }
      email = { provider: "resend", apiKey: resendKey, from };
    }
    const {
      ANTHROPIC_API_KEY: _anthropic,
      OPENAI_API_KEY: _openai,
      EMAIL_PROVIDER: _provider,
      RESEND_API_KEY: _resend,
      EMAIL_FROM: _from,
      APPLE_SIGNIN_CLIENT_ID: signinClientId,
      APPLE_SIGNIN_KEY_ID: signinKeyId,
      APPLE_SIGNIN_PRIVATE_KEY: signinPrivateKey,
      ...rest
    } = env;
    return {
      ...rest,
      LLM_MODEL_GUEST: model,
      LLM_API_KEY: apiKey,
      EMAIL: email,
      APPLE_SIGNIN: signinClientId
        ? {
            clientId: signinClientId,
            keyId: signinKeyId ?? rest.APPLE_KEY_ID,
            privateKey: signinPrivateKey ?? rest.APPLE_PRIVATE_KEY,
          }
        : null,
    };
  });

const MigrateEnvSchema = z.object({ DATABASE_URL: z.url() });

export type Env = z.infer<typeof EnvSchema>;

// `NAME=` in .env arrives as ""; treat it as unset so defaults apply.
function withoutEmpty(source: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== ""),
  );
}

function parseWith<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
): z.infer<T> {
  const result = schema.safeParse(withoutEmpty(source));
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return result.data;
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  return parseWith(EnvSchema, source);
}

export function parseMigrateEnv(source: Record<string, string | undefined>) {
  return parseWith(MigrateEnvSchema, source);
}

function loadOrExit<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

export function loadEnv(): Env {
  return loadOrExit(() => parseEnv(process.env));
}

export function loadMigrateEnv() {
  return loadOrExit(() => parseMigrateEnv(process.env));
}
