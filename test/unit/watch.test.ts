import { describe, expect, it } from "vitest";
import { isWatchedPath } from "../../src/cli/watch.js";

describe("isWatchedPath", () => {
  it("watches source files, including routes named like output folders", () => {
    expect(isWatchedPath("components/Card.tsx")).toBe(true);
    expect(isWatchedPath("app/build/page.tsx")).toBe(true);
    expect(isWatchedPath("app/out/dist/page.tsx")).toBe(true);
    expect(isWatchedPath("auto-split.config.mjs")).toBe(true);
  });

  it("ignores output, dependencies and the compiled config each run writes", () => {
    expect(isWatchedPath("build/server.js")).toBe(false);
    expect(isWatchedPath("dist/index.js")).toBe(false);
    expect(isWatchedPath("packages/ui/node_modules/x/index.js")).toBe(false);
    expect(isWatchedPath("app/.next/types/page.ts")).toBe(false);
    expect(isWatchedPath(".auto-split.config.123.1730000000000.mjs")).toBe(false);
    expect(isWatchedPath("apps/web/.auto-split.config.9.17.mjs")).toBe(false);
    expect(isWatchedPath("README.md")).toBe(false);
  });
});
