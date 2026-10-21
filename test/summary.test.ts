import { describe, expect, it } from "vitest";
import { summaryLines } from "../src/summary.js";
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
    expect(text).toContain("files declined: 1 (proposed splits not accepted)");
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
});
