import { readFileSync } from "node:fs";
import path from "node:path";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";
import plugin from "../src/eslint/index.js";
import { clearLintCache } from "../src/eslint/engine.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const projectDir = path.resolve(import.meta.dirname, "eslint-project");
const file = (rel: string) => path.join(projectDir, rel);
const code = (rel: string) => readFileSync(file(rel), "utf8");
const rule = plugin.rules["prefer-server-split"];

afterAll(() => clearLintCache());

const cases = {
  valid: [
    // imported by a client module
    { code: code("components/Badge.tsx"), filename: file("components/Badge.tsx") },
    // no client-only code at all
    { code: code("components/Panel.tsx"), filename: file("components/Panel.tsx") },
    // only ~33% static: below the default minStaticRatio (0.5)
    { code: code("components/Mostly.tsx"), filename: file("components/Mostly.tsx") },
    // not a "use client" file
    { code: code("app/page.tsx"), filename: file("app/page.tsx") },
  ],
  invalid: [
    {
      code: code("components/PostCard.tsx"),
      filename: file("components/PostCard.tsx"),
      errors: [
        {
          message:
            "PostCard is 80% static with 1 interactive island (<button>). Run: npx auto-server-split test/eslint-project/components/PostCard.tsx --write",
          line: 1,
        },
      ],
    },
    {
      code: code("components/Mostly.tsx"),
      filename: file("components/Mostly.tsx"),
      options: [{ minStaticRatio: 0.3 }],
      errors: [
        {
          message:
            /^Mostly is 33% static with 1 interactive island \(<div>\)\. Run: npx auto-server-split /,
        },
      ],
    },
  ],
};

describe("prefer-server-split with typed linting", () => {
  const tester = new RuleTester({
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: projectDir,
        ecmaFeatures: { jsx: true },
      },
    },
  });
  tester.run("prefer-server-split", rule, cases);
});

describe("prefer-server-split without typed linting", () => {
  const tester = new RuleTester({
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
  });
  tester.run("prefer-server-split", rule, cases);
});

describe("recommended config", () => {
  it("enables the rule as a warning with minStaticRatio 0.5", async () => {
    const { expect } = await import("vitest");
    expect(plugin.configs.recommended.rules).toEqual({
      "auto-server-split/prefer-server-split": ["warn", { minStaticRatio: 0.5 }],
    });
  });
});
