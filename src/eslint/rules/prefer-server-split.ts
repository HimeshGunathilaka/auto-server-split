import path from "node:path";
import type { Rule } from "eslint";
import { analyzeForLint } from "../engine.js";

type Options = [{ minStaticRatio?: number; selfCheck?: boolean; measure?: boolean }?];

type ParserServicesWithProgram = {
  program?: { getCompilerOptions(): { configFilePath?: unknown } } | null;
};

/**
 * Reports `"use client"` files that `auto-server-split` can split. Report only: a split creates a
 * new file, which an ESLint fix can't do, so the CLI is the fixer (see docs/decisions.md).
 */
export const preferServerSplit: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        'Suggest splitting partly-interactive "use client" components into a Server Component plus client islands',
    },
    schema: [
      {
        type: "object",
        properties: {
          minStaticRatio: { type: "number", minimum: 0, maximum: 1 },
          selfCheck: { type: "boolean" },
          measure: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      preferSplit:
        "{{component}} is {{ratio}}% static with {{count}} interactive island{{plural}} ({{tags}}). Run: npx auto-server-split {{file}} --write",
    },
  },

  create(context) {
    const [options = {}] = context.options as Options;
    return {
      Program(program) {
        const directive = program.body.find(
          (statement) =>
            statement.type === "ExpressionStatement" &&
            "directive" in statement &&
            statement.directive === "use client",
        );
        if (!directive) return;
        const file = context.physicalFilename;
        if (!/\.(tsx|jsx|ts|js|mts|mjs)$/.test(file) || !path.isAbsolute(file)) return;

        const services = context.sourceCode.parserServices as ParserServicesWithProgram | undefined;
        const tsProgram = services?.program ?? undefined;
        const configFilePath = tsProgram?.getCompilerOptions().configFilePath;
        const result = analyzeForLint({
          file,
          text: context.sourceCode.text,
          typed: tsProgram !== undefined,
          tsconfig: typeof configFilePath === "string" ? configFilePath : undefined,
          options,
        });
        if (!result?.ok) return;
        const { islands, staticRatio, componentName } = result.value;
        const tags = [...new Set(islands.map((i) => `<${i.rootTag}>`))].join(", ");
        context.report({
          node: directive,
          messageId: "preferSplit",
          data: {
            component: componentName,
            ratio: String(Math.round(staticRatio * 100)),
            count: String(islands.length),
            plural: islands.length === 1 ? "" : "s",
            tags,
            file: path.relative(context.cwd, file).split(path.sep).join("/"),
          },
        });
      },
    };
  },
};
