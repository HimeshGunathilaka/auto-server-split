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

  it("estimates a chain's splits together, so a parent and child that share code both pass minBytesSaved", async () => {
    // Shelf's own saving is tiny while PostCard still ships marked and date-fns; with PostCard split
    // too, the two remove them together.
    const result = await runSplit({
      root: cascade,
      noConfigFile: true,
      config: { minBytesSaved: 2048 },
    });
    expect(statusOf(result.files)).toEqual({
      "components/PostCard.tsx": "split",
      "components/Shelf.tsx": "split",
    });
    const [postCard, shelf] = result.files;
    expect(postCard?.requires).toEqual(["components/Shelf.tsx"]);
    expect(shelf?.requires).toBeUndefined();
    expect(shelf?.bytesSaved?.conservative).toBeGreaterThanOrEqual(2048);
    expect(shelf?.bytesSaved?.sharedWith).toEqual(["components/PostCard.tsx"]);
  });

  it("drops a chained split when the change it needs is dropped, and says why", async () => {
    const result = await runSplit({
      root: cascade,
      noConfigFile: true,
      config: { minBytesSaved: 1_000_000 },
    });
    expect(statusOf(result.files)).toEqual({
      "components/PostCard.tsx": "imported-by-client",
      "components/Shelf.tsx": "below-threshold",
    });
    expect(result.files[0]?.skipped?.message).toBe(
      "imported by components/Shelf.tsx (client); it can be split along with components/Shelf.tsx (skipped: below-threshold), which isn't changed",
    );
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
    // One pass: the PostCard split a later pass finds would share Sidebar's saving.
    const result = await runSplit({
      root: unusedDirective,
      noConfigFile: true,
      iterate: false,
      config: { removeUnusedDirectives: true, minBytesSaved: 2048 },
    });
    const sidebar = result.files.find((f) => f.file === "components/Sidebar.tsx");
    expect(sidebar).toMatchObject({ status: "directive-removed", islands: [] });
    expect(sidebar?.bytesSaved?.conservative).toBeGreaterThan(0);
    expect(sidebar?.bytesSaved?.conservative).toBeLessThan(2048);
    expect(Object.keys(sidebar?.outputs ?? {})).toEqual(["components/Sidebar.tsx"]);
    expect(sidebar?.diff).toContain('-"use client";');
  });

  it("splits what a removed directive unblocks, at the default threshold", async () => {
    const result = await runSplit({
      root: unusedDirective,
      noConfigFile: true,
      config: { removeUnusedDirectives: true, minBytesSaved: 2048 },
    });
    expect(statusOf(result.files)).toEqual({
      "components/PostCard.tsx": "split",
      "components/Sidebar.tsx": "directive-removed",
    });
    expect(result.files.find((f) => f.file === "components/PostCard.tsx")?.requires).toEqual([
      "components/Sidebar.tsx",
    ]);
  });

  it("leaves the directive alone by default", async () => {
    const result = await runSplit({ root: unusedDirective, noConfigFile: true, measure: false });
    expect(statusOf(result.files)["components/Sidebar.tsx"]).toBe("no-islands");
  });
});
