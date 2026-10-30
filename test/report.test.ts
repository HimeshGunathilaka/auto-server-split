import { describe, expect, it } from "vitest";
import { compareReports } from "../src/report/compare.js";
import { githubAnnotations } from "../src/report/github.js";
import { findings } from "../src/report/sarif.js";
import { markdownReport } from "../src/report/markdown.js";
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
      "::notice file=web/app/(shop)%2Ca.tsx,line=7,title=Split available::75%25 static, 1 island (CardButton <button>), ~2.1 KB gzip saved. Apply with: npx auto-server-split 'app/(shop),a.tsx' --write",
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
    // B removes a directive, so the command has to say so.
    expect(text).toContain("Apply with `npx auto-server-split --remove-unused-directives --write`");
  });

  it("names the changes a chained change needs", () => {
    const text = markdownReport(
      [base("Shelf.tsx", {}), base("Book.tsx", { requires: ["Shelf.tsx"] })],
      2,
      false,
    );
    expect(text).toContain("| `Book.tsx` | split (needs `Shelf.tsx`) | `CardButton` | – |");
    expect(text).toContain(
      "Apply with `npx auto-server-split --write` (or pass the files to change, with the files they need).",
    );
  });
});

describe("apply commands in annotations", () => {
  it("include the changes a file needs, quote paths, and add --remove-unused-directives", () => {
    const [, book] = githubAnnotations([
      base("components/Shelf Host.tsx", { status: "directive-removed", islands: [] }),
      base("components/Book.tsx", { requires: ["components/Shelf Host.tsx"] }),
    ]);
    expect(book).toContain(
      "Apply with: npx auto-server-split 'components/Shelf Host.tsx' components/Book.tsx --remove-unused-directives --write",
    );
  });
});

describe("compareReports", () => {
  const skipped = (file: string, code: "fully-interactive" | "context-provider"): FileResult =>
    base(file, { status: "skipped", islands: [], skipped: { code, message: code } });

  it("treats a change as moved only when the earlier file is gone, once per earlier change", () => {
    const card = base("components/Card.tsx", { fingerprint: "fp" });
    const before = { files: [card] };
    // A second Card with the same fingerprint, while the first is still there: new.
    const added = compareReports(before, { files: [card, { ...card, file: "shop/Card.tsx" }] });
    expect(added.added.map((a) => a.file)).toEqual(["shop/Card.tsx"]);
    // The first one moved: not new, and not resolved.
    const moved = compareReports(before, { files: [{ ...card, file: "ui/Card.tsx" }] });
    expect(moved.added).toEqual([]);
    expect(moved.resolved).toEqual([]);
    // Moved and copied: one of the two is new.
    const both = compareReports(before, {
      files: [
        { ...card, file: "a/Card.tsx" },
        { ...card, file: "b/Card.tsx" },
      ],
    });
    expect(both.added).toHaveLength(1);
    expect(both.resolved).toEqual([]);
  });

  it("lists a skip whose reason changed once", () => {
    const c = compareReports(
      { files: [skipped("Banner.tsx", "fully-interactive")] },
      { files: [skipped("Banner.tsx", "context-provider")] },
    );
    expect(c.newSkips).toEqual([]);
    expect(c.goneSkips).toEqual([]);
    expect(c.changedSkips).toEqual([
      { file: "Banner.tsx", before: "fully-interactive", after: "context-provider" },
    ]);
  });
});

describe("findings", () => {
  it("gives identical copies of a component distinct fingerprints", () => {
    const copy = (file: string) => base(file, { fingerprint: "same" });
    const prints = findings([copy("a/Card.tsx"), copy("b/Card.tsx")]).map((f) => f.fingerprint);
    expect(new Set(prints).size).toBe(2);
    // The first keeps the plain fingerprint, so existing alerts still match.
    expect(prints[0]).toBe(findings([copy("a/Card.tsx")])[0]?.fingerprint);
  });
});
