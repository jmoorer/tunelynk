import type { CatalogSource } from "../types";
import { appleCatalog } from "./catalog";
import { createAppleClient } from "./client";
import { createDeveloperToken } from "./devToken";
import { createLimiter } from "./limiter";

export type AppleCatalogConfig = {
  teamId: string;
  keyId: string;
  privateKey: string;
  storefront: string;
  rps: number;
  burst: number;
  concurrency: number;
  fetch?: typeof fetch;
};

// Build once per process so every run shares one limiter and one token.
export function createAppleCatalog(config: AppleCatalogConfig): CatalogSource {
  const token = createDeveloperToken({
    teamId: config.teamId,
    keyId: config.keyId,
    privateKey: config.privateKey,
  });
  const limiter = createLimiter({
    rps: config.rps,
    burst: config.burst,
    concurrency: config.concurrency,
  });
  const client = createAppleClient({
    token,
    limiter,
    storefront: config.storefront,
    fetch: config.fetch,
  });
  return appleCatalog(client);
}

export { AppleApiError } from "./client";
export { loadPrivateKey } from "./devToken";
