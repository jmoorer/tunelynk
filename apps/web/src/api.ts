import type { AppType } from "@tunelynk/api";
import { HealthResponse } from "@tunelynk/shared";
import { hc } from "hono/client";

// Same-origin: Vite proxies /api to the API in dev.
export const client = hc<AppType>(window.location.origin);

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await client.api.health.$get();
  if (!res.ok) throw new Error(`Health check failed with status ${res.status}`);
  return HealthResponse.parse(await res.json());
}
