import type { AppleCatalogConfig } from "@tunelynk/connectors";
import type { LlmConfig } from "../llm/index";

export type CliConfig = { apple: AppleCatalogConfig; llm: LlmConfig };

// Mirrors the env names apps/api will validate in slice C.
export function loadCliConfig(
  env: Record<string, string | undefined>,
): CliConfig {
  const provider = env.LLM_PROVIDER ?? "anthropic";
  if (provider !== "anthropic" && provider !== "openai") {
    throw new Error('LLM_PROVIDER must be "anthropic" or "openai"');
  }
  const keyName =
    provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const required = [
    "APPLE_TEAM_ID",
    "APPLE_KEY_ID",
    "APPLE_PRIVATE_KEY",
    keyName,
  ];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Missing env: ${missing.join(", ")}`);

  const positive = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number`);
    }
    return value;
  };

  return {
    apple: {
      teamId: env.APPLE_TEAM_ID ?? "",
      keyId: env.APPLE_KEY_ID ?? "",
      privateKey: env.APPLE_PRIVATE_KEY ?? "",
      storefront: env.APPLE_STOREFRONT || "us",
      rps: positive("APPLE_CATALOG_RPS", 8),
      burst: positive("APPLE_CATALOG_BURST", 10),
      concurrency: positive("APPLE_CATALOG_CONCURRENCY", 4),
    },
    llm: {
      provider,
      apiKey: env[keyName] ?? "",
      model: env.LLM_MODEL_GUEST || "claude-haiku-4-5",
      maxTokens: positive("LLM_MAX_TOKENS", 2000),
    },
  };
}
