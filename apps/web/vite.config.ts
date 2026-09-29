import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  // Same PORT the API uses: shell env wins, then the root .env, then 3000.
  const { PORT = "3000" } = loadEnv(mode, repoRoot, "");

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: { "/api": `http://localhost:${PORT}` },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
    },
  };
});
