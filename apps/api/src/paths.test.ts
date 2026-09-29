import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimePaths } from "./paths";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

// Mimic the repo layout: <root>/apps/api/dist/index.js
function fakeRepo(withWebBuild: boolean) {
  tmp = mkdtempSync(join(tmpdir(), "tunelynk-paths-"));
  mkdirSync(join(tmp, "apps/api/dist"), { recursive: true });
  if (withWebBuild) {
    mkdirSync(join(tmp, "apps/web/dist"), { recursive: true });
    writeFileSync(join(tmp, "apps/web/dist/index.html"), "<!doctype html>");
  }
  return {
    root: tmp,
    moduleUrl: pathToFileURL(join(tmp, "apps/api/dist/index.js")).href,
  };
}

describe("resolveRuntimePaths", () => {
  it("finds the real migrations folder from the api source directory", () => {
    const { migrationsDir } = resolveRuntimePaths(import.meta.url);
    expect(existsSync(join(migrationsDir, "meta/_journal.json"))).toBe(true);
  });

  it("returns webDir when apps/web/dist/index.html exists", () => {
    const { root, moduleUrl } = fakeRepo(true);
    const { webDir, migrationsDir } = resolveRuntimePaths(moduleUrl);
    expect(webDir).toBe(join(root, "apps/web/dist"));
    expect(migrationsDir).toBe(join(root, "packages/db/migrations"));
  });

  it("returns webDir undefined when there is no web build", () => {
    const { moduleUrl } = fakeRepo(false);
    expect(resolveRuntimePaths(moduleUrl).webDir).toBeUndefined();
  });
});
