import type { DeveloperToken } from "./devToken";
import type { Limiter } from "./limiter";

const BASE_URL = "https://api.music.apple.com/v1";
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 4000;

export class AppleApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string) {
    super(`Apple Music API returned ${status} for ${path}`);
    this.name = "AppleApiError";
    this.status = status;
    this.path = path;
  }
}

// Exponential backoff with full jitter. Apple sends no Retry-After (spike #7).
export function backoffDelay(retry: number, random: () => number): number {
  return Math.floor(
    random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** retry),
  );
}

export type AppleClientOptions = {
  token: DeveloperToken;
  limiter: Limiter;
  storefront: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type AppleClient = {
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createAppleClient({
  token,
  limiter,
  storefront,
  fetch: fetchImpl = fetch,
  sleep = defaultSleep,
  random = Math.random,
}: AppleClientOptions): AppleClient {
  return {
    async get<T>(path: string, params: Record<string, string> = {}) {
      const url = new URL(`${BASE_URL}/catalog/${storefront}${path}`);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }

      let retries = 0;
      let resigned = false;
      for (;;) {
        // Each attempt, retries included, spends a limiter token.
        const result = await limiter
          .schedule(() =>
            fetchImpl(url, {
              headers: { Authorization: `Bearer ${token.get()}` },
            }),
          )
          .catch((err: unknown) => err);

        if (result instanceof Response) {
          if (result.ok) return (await result.json()) as T;
          if (result.status === 401 && !resigned) {
            resigned = true;
            token.invalidate();
            continue;
          }
          const retryable = result.status === 429 || result.status >= 500;
          if (!retryable || retries >= MAX_RETRIES) {
            throw new AppleApiError(result.status, path);
          }
          if (result.status === 429) limiter.drain();
        } else if (retries >= MAX_RETRIES) {
          throw result;
        }

        await sleep(backoffDelay(retries, random));
        retries++;
      }
    },
  };
}
