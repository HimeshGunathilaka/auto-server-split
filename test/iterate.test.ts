import path from "node:path";
import { describe, expect, it } from "vitest";
import { runSplit } from "../src/split.js";

const fixtures = path.resolve(import.meta.dirname, "fixtures");
const cascade = path.join(fixtures, "36-iterate-cascade/input");
const unusedDirective = path.join(fixtures, "35-remove-unused-directive/input");

const statusOf = (files: { file: string; status: string; skipped?: { code: string } }[]) =>
  Object.fromEntries(files.map((f) => [f.file, f.skipped?.code ?? f.status]));

describe("passes", () => {
  it("splits a component in a later pass once its client importer is split", async () => {
    const result = await runSplit({
      root: cascade,
      measure: false,
      noConfigFile: true,
      config: { minBytesSaved: 0 },
    });
    expect(statusOf(result.files)).toEqual({
      "components/PostCard.tsx": "split",
      "components/Shelf.tsx": "split",
    });
    await expect(result.rerun("components/Shelf.tsx", {})).rejects.toThrow(/single-pass/);
  });

  it("makes one pass with iterate: false", async () => {
    const result = await runSplit({
      root: cascade,
      measure: false,
      noConfigFile: true,
      iterate: false,
      config: { minBytesSaved: 0 },
    });
    expect(statusOf(result.files)).toEqual({
      "components/PostCard.tsx": "imported-by-client",
      "components/Shelf.tsx": "split",
    });
  });

  it("reports each file once, with its final result", async () => {
    const reported: string[] = [];
    await runSplit({
      root: cascade,
      measure: false,
      noConfigFile: true,
      config: { minBytesSaved: 0 },
      onFile: (f) => reported.push(`${f.file}:${f.status}`),
    });
    expect(reported.sort()).toEqual([
      "components/PostCard.tsx:split",
      "components/Shelf.tsx:split",
    ]);
  });
});

describe("removeUnusedDirectives", () => {
  it("removes a directive whatever minBytesSaved says, and reports the saving", async () => {
    const result = await runSplit({
      root: unusedDirective,
      noConfigFile: true,
      config: { removeUnusedDirectives: true, minBytesSaved: 2048 },
    });
    const sidebar = result.files.find((f) => f.file === "components/Sidebar.tsx");
    expect(sidebar).toMatchObject({ status: "directive-removed", islands: [] });
    expect(sidebar?.bytesSaved?.conservative).toBeGreaterThan(0);
    expect(sidebar?.bytesSaved?.conservative).toBeLessThan(2048);
    expect(Object.keys(sidebar?.outputs ?? {})).toEqual(["components/Sidebar.tsx"]);
    expect(sidebar?.diff).toContain('-"use client";');
  });

  it("leaves the directive alone by default", async () => {
    const result = await runSplit({ root: unusedDirective, noConfigFile: true, measure: false });
    expect(statusOf(result.files)["components/Sidebar.tsx"]).toBe("no-islands");
  });
});
