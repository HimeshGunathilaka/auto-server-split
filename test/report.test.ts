import { describe, expect, it } from "vitest";
import { githubAnnotations, markdownReport } from "../src/report.js";
import type { FileResult } from "../src/types.js";

const base = (file: string, extra: Partial<FileResult>): FileResult => ({
  file,
  status: "split",
  islands: [{ name: "CardButton", rootTag: "button", props: [], line: 7 }],
  staticRatio: 0.75,
  diff: "",
  outputs: {},
  ...extra,
});

describe("githubAnnotations", () => {
  it("escapes properties and data, and maps paths to the repository", () => {
    const [notice, warning] = githubAnnotations(
      [
        base("app/(shop),a.tsx", {
          bytesSaved: { isolated: 3000, conservative: 2100 },
          warnings: [
            {
              code: "timezone-dependent",
              message: "50% sure\nreally",
              location: { line: 9, column: 3 },
            },
          ],
        }),
      ],
      (file) => `web/${file}`,
    );
    expect(notice).toBe(
      "::notice file=web/app/(shop)%2Ca.tsx,line=7,title=Split available::75%25 static, 1 island (CardButton <button>), ~2.1 KB gzip saved. Apply with: npx auto-server-split app/(shop),a.tsx --write",
    );
    expect(warning).toBe(
      "::warning file=web/app/(shop)%2Ca.tsx,line=9,title=timezone-dependent::50%25 sure%0Areally",
    );
  });

  it("only flags the tool's own failures among skips", () => {
    const out = githubAnnotations([
      base("A.tsx", {
        status: "skipped",
        islands: [],
        skipped: { code: "no-islands", message: "x" },
      }),
      base("B.tsx", {
        status: "skipped",
        islands: [],
        skipped: {
          code: "internal-error",
          message: "boom\n    at stack",
          location: { line: 2, column: 1 },
        },
      }),
    ]);
    expect(out).toEqual([
      "::warning file=B.tsx,line=2,title=auto-server-split internal-error::boom",
    ]);
  });
});

describe("markdownReport", () => {
  it("lists changes, warnings and grouped skips", () => {
    const text = markdownReport(
      [
        base("A.tsx", { bytesSaved: { isolated: 900, conservative: 800 } }),
        base("B.tsx", {
          status: "directive-removed",
          islands: [],
          warnings: [{ code: "timezone-dependent", message: "a | b" }],
        }),
        base("C.tsx", {
          status: "skipped",
          islands: [],
          skipped: { code: "no-islands", message: "x" },
        }),
      ],
      5,
      false,
    );
    expect(text).toContain(
      '2 changes available in 3 `"use client"` files (5 scanned), about 800 B gzip',
    );
    expect(text).toContain("| `A.tsx` | split | `CardButton` | ~800 B |");
    expect(text).toContain('| `B.tsx` | remove `"use client"` | – | – |');
    expect(text).toContain("- `B.tsx`: a \\| b");
    expect(text).toContain("| `no-islands`: no client-only code found");
    expect(text).toContain("Apply with `npx auto-server-split --write`");
  });
});
