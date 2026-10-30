import path from "node:path";
import type { Rule } from "eslint";
import { shellQuote } from "../../report/markdown.js";
import { analyzeForLint } from "../engine.js";

type Options = [{ minStaticRatio?: number; selfCheck?: boolean; measure?: boolean }?];

type ParserServicesWithProgram = {
  program?: { getCompilerOptions(): { configFilePath?: unknown } } | null;
};

/**
 * Reports `"use client"` files that `auto-server-split` can split. A split creates a new file, which
 * an ESLint fix can't do, so the CLI is the fixer (see docs/decisions.md). With the config's
 * `removeUnusedDirectives`, it also reports directives on files with no client-only code, and fixes
 * those by removing the directive, unless the change has a warning (date code that would render in
 * the server's timezone): then removing it is only a suggestion, so `--fix` and fix-on-save leave
 * it for someone to check. Messages name the change's first warning.
 */
export const preferServerSplit: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    fixable: "code",
    hasSuggestions: true,
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
      unusedDirective:
        '{{component}} uses no client-only code, and every importer is a Server Component, so "use client" is unnecessary.{{note}}',
      preferSplit:
        "{{component}} is {{ratio}}% static with {{count}} interactive island{{plural}} ({{tags}}).{{note}} Run: npx auto-server-split {{file}} --write",
      removeDirective: 'Remove "use client"',
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
        const { islands, staticRatio, componentName, warnings } = result.value;
        const [first] = warnings;
        const note = first
          ? ` Check first (line ${first.location?.line ?? 1}): ${first.message}${warnings.length > 1 ? ` (and ${warnings.length - 1} more warning${warnings.length > 2 ? "s" : ""})` : ""}.`
          : "";
        if (!result.value.island) {
          const text = context.sourceCode.text;
          const [start, directiveEnd] = directive.range ?? [0, 0];
          let end = directiveEnd;
          while (end < text.length && /\s/.test(text[end] ?? "")) end++;
          const fix = (fixer: Rule.RuleFixer) => fixer.removeRange([start, end]);
          context.report({
            node: directive,
            messageId: "unusedDirective",
            data: { component: componentName, note },
            ...(first ? { suggest: [{ messageId: "removeDirective", fix }] } : { fix }),
          });
          return;
        }
        const tags = [
          ...new Set(islands.map((i) => (i.effects ? "effects only" : `<${i.rootTag}>`))),
        ].join(", ");
        context.report({
          node: directive,
          messageId: "preferSplit",
          data: {
            component: componentName,
            ratio: String(Math.round(staticRatio * 100)),
            count: String(islands.length),
            plural: islands.length === 1 ? "" : "s",
            tags,
            file: shellQuote(path.relative(context.cwd, file).split(path.sep).join("/")),
            note,
          },
        });
      },
    };
  },
};
