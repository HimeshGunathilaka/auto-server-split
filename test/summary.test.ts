import { describe, expect, it } from "vitest";
import { acceptedRoutes, summaryLines } from "../src/summary.js";
import type { FileResult } from "../src/types.js";

const result = (file: string, conservative: number): FileResult => ({
  file,
  status: "split",
  islands: [],
  staticRatio: 0.8,
  bytesSaved: { isolated: conservative, conservative },
  diff: "",
  outputs: {},
});

describe("CLI summary", () => {
  it("counts only accepted splits in interactive mode, and the declined ones apart", () => {
    const accepted = result("A.tsx", 100);
    const rejected = result("B.tsx", 5000);
    const text = summaryLines({
      files: [accepted, rejected],
      filesScanned: 2,
      mode: "interactive",
      splits: [accepted],
      declined: 1,
    }).join("\n");
    expect(text).toContain("files split:    1 (1 written)");
    expect(text).toContain("files declined: 1 (proposed changes not accepted)");
    expect(text).toContain("estimated saving: 100 B gzip");
  });

  it("has no declined line outside interactive mode", () => {
    const a = result("A.tsx", 100);
    const text = summaryLines({
      files: [a],
      filesScanned: 1,
      mode: "dry-run",
      splits: [a],
      declined: 0,
    }).join("\n");
    expect(text).toContain("files split:    1 (dry run, nothing written)");
    expect(text).not.toContain("declined");
  });

  it("counts removed directives apart from splits", () => {
    const a = result("A.tsx", 100);
    const b: FileResult = { ...result("B.tsx", 50), status: "directive-removed" };
    const text = summaryLines({
      files: [a, b],
      filesScanned: 2,
      mode: "write",
      splits: [a, b],
      declined: 0,
    }).join("\n");
    expect(text).toContain("files split:    1 (1 written)");
    expect(text).toContain("directives removed: 1 (1 written)");
    expect(text).toContain("estimated saving: 150 B gzip");
  });
});

describe("acceptedRoutes", () => {
  it("leaves out the changes declined in --interactive", () => {
    const on = (file: string, bytesSaved: number): FileResult => ({
      ...result(file, bytesSaved),
      routes: [{ route: "/", load: "initial", bytesSaved }],
    });
    const routes = [
      {
        route: "/",
        files: ["A.tsx", "B.tsx"],
        initialSaved: 900,
        lazySaved: 0,
        source: "esbuild" as const,
      },
      {
        route: "/b",
        files: ["B.tsx"],
        initialSaved: 500,
        lazySaved: 0,
        source: "esbuild" as const,
      },
    ];
    // Only A accepted: /b goes, / counts A's saving alone.
    expect(acceptedRoutes(routes, [on("A.tsx", 400)])).toEqual([
      { route: "/", files: ["A.tsx"], initialSaved: 400, lazySaved: 0, source: "esbuild" },
    ]);
    // Both accepted: the totals stay as computed.
    expect(acceptedRoutes(routes, [on("A.tsx", 400), on("B.tsx", 600)])).toEqual(routes);
  });
});
