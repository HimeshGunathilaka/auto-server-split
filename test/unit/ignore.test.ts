import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { findIgnoreComment } from "../../src/analysis/directives.js";

const parse = (text: string) =>
  ts.createSourceFile("Comp.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const reasonOf = (text: string) => findIgnoreComment(parse(text))?.reason;

describe("findIgnoreComment", () => {
  it("finds a line comment before the directive, with or without a reason", () => {
    expect(reasonOf('// auto-server-split-ignore\n"use client";\nexport {};')).toBe("");
    expect(reasonOf('// auto-server-split-ignore: kept on purpose\n"use client";\n')).toBe(
      "kept on purpose",
    );
  });

  it("finds a comment on the directive's line or right after it", () => {
    expect(reasonOf('"use client"; // auto-server-split-ignore - heavy chart\nexport {};')).toBe(
      "heavy chart",
    );
    expect(reasonOf('"use client";\n\n/* auto-server-split-ignore */\nimport x from "x";')).toBe(
      "",
    );
  });

  it("joins a multi-line block comment's reason", () => {
    expect(
      reasonOf('/**\n * auto-server-split-ignore: needs\n * window at import\n */\n"use client";'),
    ).toBe("needs window at import");
    expect(reasonOf('/* auto-server-split-ignore: needs\n   window */\n"use client";')).toBe(
      "needs window",
    );
  });

  it("ignores comments in the body and other words", () => {
    expect(
      reasonOf('"use client";\nimport x from "x";\n// auto-server-split-ignore\nexport {};'),
    ).toBeUndefined();
    expect(reasonOf('// auto-server-split-ignored\n"use client";')).toBeUndefined();
  });
});
